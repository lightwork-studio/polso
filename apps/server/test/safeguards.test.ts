import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseChanges } from "../src/changes.ts";
import { MAX_PAIRING_BYTES } from "../src/server.ts";
import { DATABASE_FILE, MIGRATIONS, Store } from "../src/store.ts";
import { hashSecret, newSecret } from "../src/tokens.ts";
import { heartRate, startServer, tempDirectory, tempStore, UUID } from "./support.ts";

const NOW = new Date("2026-11-27T12:00:00.000Z");

async function pairedApp(options: Parameters<typeof startServer>[0] = {}) {
  const app = await startServer({ now: () => NOW, ...options });
  const code = newSecret();
  app.store.addPairingCode(hashSecret(code), new Date(NOW.getTime() + 60_000));
  const response = await app.post("/sync/v1/pair", { code, device: "iPhone" });
  const { token } = (await response.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  return { ...app, token, auth };
}

describe("opening the database", () => {
  it("migrates once when several processes open a new database together", async () => {
    const store = new URL("../src/store.ts", import.meta.url).href;
    for (let round = 0; round < 5; round++) {
      const path = join(tempDirectory(), DATABASE_FILE);
      // Every process loads first, then waits for the same moment, so the opens really collide.
      const startAt = Date.now() + 1_500;
      const script = `const { Store } = await import(${JSON.stringify(store)}); while (Date.now() < ${startAt}); Store.open(${JSON.stringify(path)}).close();`;
      const runs = Array.from(
        { length: 8 },
        () =>
          new Promise<{ code: number | null; stderr: string }>((resolve) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
              env: { ...process.env, NODE_NO_WARNINGS: "1" },
            });
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("close", (code) => resolve({ code, stderr }));
          }),
      );
      for (const run of await Promise.all(runs)) expect(run).toEqual({ code: 0, stderr: "" });
      const raw = new DatabaseSync(path);
      expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
      raw.close();
    }
  }, 60_000);

  it("doesn't migrate again when another process migrated while it waited", async () => {
    // A raw connection holds the write lock while a second process opens the database: that
    // process reads schema 0, then waits for the lock. Meanwhile this one migrates and lets go.
    const path = join(tempDirectory(), DATABASE_FILE);
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    const store = new URL("../src/store.ts", import.meta.url).href;
    const script = `const { Store } = await import(${JSON.stringify(store)}); Store.open(${JSON.stringify(path)}).close(); console.log("opened");`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    for (const migration of MIGRATIONS) holder.exec(migration);
    holder.exec(`PRAGMA user_version = ${MIGRATIONS.length}; COMMIT`);
    holder.close();
    expect(await exit).toBe(0);
    expect(output.trim()).toBe("opened");
  }, 30_000);

  it("refuses to create a database when asked not to", () => {
    const path = join(tempDirectory(), DATABASE_FILE);
    expect(() => Store.open(path, { create: false })).toThrow("No Polso database");
  });
});

describe("store safeguards", () => {
  it("writes nothing for a device that is no longer paired", () => {
    const store = tempStore();
    const written = store.apply(parseChanges({ samples: [heartRate(1)] }), NOW, "unknown-hash");
    expect(written).toBe(false);
    expect(store.counts().samples).toBe(0);
  });

  it("doesn't count an empty upload as one", () => {
    const store = tempStore();
    expect(store.apply(parseChanges({}), NOW)).toBe(true);
    expect(store.counts().lastUploadAt).toBeUndefined();
  });

  it("keeps the unit of daily statistics", () => {
    const store = tempStore();
    store.apply(
      parseChanges({
        dailyStats: [
          {
            type: "HKQuantityTypeIdentifierStepCount",
            statistic: "sum",
            unit: "count",
            from: "2026-11-27",
            to: "2026-11-27",
            values: [{ day: "2026-11-27", value: 10 }],
          },
        ],
      }),
      NOW,
    );
    expect(store.db.prepare("SELECT unit FROM daily_stats").get()).toEqual({ unit: "count" });
  });

  it("erases the records from the database file and its log, and keeps server settings", () => {
    const directory = tempDirectory();
    const path = join(directory, DATABASE_FILE);
    const store = Store.open(path);
    const marker = "Marker-Source-7d1f";
    store.saveSetting("publicUrl", "https://polso.example.com");
    store.apply(
      parseChanges({
        samples: Array.from({ length: 50 }, (_, i) => ({ ...heartRate(i), source: marker })),
      }),
      NOW,
    );
    store.eraseHealthData();
    for (const file of [path, `${path}-wal`]) {
      let bytes = "";
      try {
        bytes = readFileSync(file).toString("latin1");
      } catch {
        // A log that isn't there holds nothing.
      }
      expect(bytes.includes(marker)).toBe(false);
    }
    expect(store.setting("publicUrl")).toBe("https://polso.example.com");
    store.close();
  });
});

describe("server safeguards", () => {
  it("lets a paired phone start over, and nobody else", async () => {
    const app = await pairedApp();
    await app.post("/sync/v1/changes", { samples: [heartRate(1)] }, app.auth);
    const before = app.store.generation();

    const stranger = await app.post(
      "/sync/v1/reset",
      {},
      { Authorization: `Bearer ${newSecret()}` },
    );
    expect(stranger.status).toBe(401);
    expect(app.store.counts().samples).toBe(1);

    const reset = await app.post("/sync/v1/reset", {}, app.auth);
    expect(reset.status).toBe(200);
    const { generation } = (await reset.json()) as { generation: string };
    expect(generation).not.toBe(before);
    expect(app.store.counts().samples).toBe(0);

    app.store.revoke();
    expect((await app.post("/sync/v1/reset", {}, app.auth)).status).toBe(401);
  });

  it("reads at most a few kilobytes before a device is known", async () => {
    const app = await startServer({ now: () => NOW });
    const response = await app.post("/sync/v1/pair", {
      code: newSecret(),
      device: "x".repeat(MAX_PAIRING_BYTES),
    });
    expect(response.status).toBe(413);
  });

  it("refuses device names with control characters", async () => {
    const app = await startServer({ now: () => NOW });
    const code = newSecret();
    app.store.addPairingCode(hashSecret(code), new Date(NOW.getTime() + 60_000));
    const response = await app.post("/sync/v1/pair", { code, device: "iPhone\u001b[2J" });
    expect(response.status).toBe(400);
    expect(app.store.devices()).toHaveLength(0);
  });

  it("asks the phone to retry while an admin command holds the database", async () => {
    const errors: unknown[] = [];
    const { store, auth } = await pairedApp();
    const busy = Object.create(store, {
      apply: {
        value: () => {
          throw new Error("database is locked");
        },
      },
    }) as Store;
    const app = await startServer({ store: busy, onError: (e) => errors.push(e) });
    const response = await app.post("/sync/v1/changes", { deleted: [UUID(1)] }, auth);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(errors).toHaveLength(0);
  });

  it("forgets a phone that hangs up mid-upload, without reporting a failure", async () => {
    const errors: unknown[] = [];
    const app = await pairedApp({ onError: (e) => errors.push(e) });
    await new Promise<void>((resolve) => {
      const request = httpRequest(`${app.base}/sync/v1/changes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "1000", ...app.auth },
      });
      request.on("error", () => resolve());
      request.write('{"samples": [');
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 50);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(errors).toEqual([]);
    // The server still answers.
    const ok = await app.post("/sync/v1/changes", { samples: [heartRate(1)] }, app.auth);
    expect(ok.status).toBe(200);
  });
});

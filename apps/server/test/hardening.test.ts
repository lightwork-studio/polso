import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseChanges } from "../src/changes.ts";
import { prepareDirectory } from "../src/files.ts";
import { MAX_CONNECTIONS } from "../src/server.ts";
import { DATABASE_FILE, Store } from "../src/store.ts";
import { hashSecret, newSecret } from "../src/tokens.ts";
import { heartRate, startServer, tempDirectory, tempStore } from "./support.ts";

const NOW = new Date("2026-11-27T12:00:00.000Z");

async function pairedApp(options: Parameters<typeof startServer>[0] = {}) {
  const app = await startServer({ now: () => NOW, ...options });
  const code = newSecret();
  app.store.addPairingCode(hashSecret(code), new Date(NOW.getTime() + 60_000));
  const response = await app.post("/sync/v1/pair", { code, device: "iPhone" });
  const { token } = (await response.json()) as { token: string };
  return { ...app, token, auth: { Authorization: `Bearer ${token}` } };
}

/** Sends raw bytes and returns the status line of the answer. */
function rawStatus(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(bytes));
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk;
      if (received.includes("\r\n")) {
        resolve(received.split("\r\n")[0] as string);
        socket.destroy();
      }
    });
    socket.on("error", reject);
  });
}

describe("connections", () => {
  it("closes connections that never send anything, so they can't lock the phone out", async () => {
    const app = await startServer({ idleTimeoutMs: 300 });
    const port = new URL(app.base).port;
    const idle = await Promise.all(
      Array.from(
        { length: MAX_CONNECTIONS },
        () =>
          new Promise<ReturnType<typeof connect>>((resolve) => {
            const socket = connect(Number(port), "127.0.0.1", () => resolve(socket));
            socket.on("error", () => undefined);
          }),
      ),
    );
    await Promise.all(
      idle.map((socket) => new Promise((resolve) => socket.once("close", resolve))),
    );
    expect((await app.call("/pair")).status).toBe(200);
  });

  it("answers a request target it can't parse with 400, not a logged failure", async () => {
    const errors: unknown[] = [];
    const app = await startServer({ onError: (e) => errors.push(e) });
    const port = Number(new URL(app.base).port);
    const status = await rawStatus(port, "GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(status).toMatch(/^HTTP\/1\.1 400 /);
    expect(errors).toEqual([]);
  });
});

describe("revoking", () => {
  it("drops an upload whose device is revoked while the body arrives", async () => {
    const app = await pairedApp();
    const body = JSON.stringify({ samples: [heartRate(1)] });
    const half = Math.floor(body.length / 2);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${app.base}/sync/v1/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          ...app.auth,
        },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.write(body.slice(0, half));
      setTimeout(() => {
        app.store.revoke();
        request.end(body.slice(half));
      }, 100);
    });
    expect(status).toBe(401);
    expect(app.store.counts().samples).toBe(0);
  });

  it("drops a reset whose device is revoked before it is written", async () => {
    const store = tempStore();
    store.apply(parseChanges({ samples: [heartRate(1)] }), NOW);
    expect(store.eraseHealthData("not-a-paired-hash")).toBe(false);
    expect(store.counts().samples).toBe(1);
  });

  it("cancels unused pairing links when every device is revoked", () => {
    const store = tempStore();
    store.addPairingCode("leaked", new Date(NOW.getTime() + 60_000));
    store.revoke();
    expect(store.pair("leaked", "Stranger", "t", NOW)).toBe(false);
  });
});

describe("schema", () => {
  it("lets admin commands leave migrating to the server", () => {
    const path = join(tempDirectory(), DATABASE_FILE);
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.close();
    expect(() => Store.open(path, { create: false, migrate: false })).toThrow(
      "Restart the server first",
    );
    Store.open(path).close();
    Store.open(path, { create: false, migrate: false }).close();
  });

  it("rejects times that don't exist", () => {
    const sample = { ...heartRate(1), start: "2026-02-30T00:00:00.000Z" };
    expect(() => parseChanges({ samples: [sample] })).toThrow("not a valid time");
  });
});

describe.skipIf(process.platform === "win32")("file permissions", () => {
  it("makes an existing data directory and database private to the server's user", () => {
    const directory = join(tempDirectory(), "data");
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    const database = join(directory, DATABASE_FILE);
    writeFileSync(database, "");
    chmodSync(database, 0o644);
    prepareDirectory(directory);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(database).mode & 0o777).toBe(0o600);
  });
});

import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/server.ts";
import type { Store } from "../src/store.ts";
import { hashSecret, newSecret } from "../src/tokens.ts";
import { heartRate, startServer, UUID } from "./support.ts";

const NOW = new Date("2026-11-27T12:00:00.000Z");

/** A pairing code the server will accept, as `admin pair` makes one. */
function pairingCode(store: Store, expiresAt = new Date(NOW.getTime() + 15 * 60_000)): string {
  const code = newSecret();
  store.addPairingCode(hashSecret(code), expiresAt);
  return code;
}

async function paired() {
  const app = await startServer({ now: () => NOW });
  const response = await app.post("/sync/v1/pair", {
    code: pairingCode(app.store),
    device: "iPhone",
  });
  expect(response.status).toBe(200);
  const { token } = (await response.json()) as { token: string };
  const upload = (body: unknown, headers: Record<string, string> = {}) =>
    app.post("/sync/v1/changes", body, { Authorization: `Bearer ${token}`, ...headers });
  return { ...app, token, upload };
}

describe("pairing", () => {
  it("pairs a device with a code once, and gives it a token", async () => {
    const app = await startServer({ now: () => NOW });
    const code = pairingCode(app.store);
    const first = await app.post("/sync/v1/pair", { code, device: " iPhone " });
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(app.store.devices().map((d) => d.name)).toEqual(["iPhone"]);
    // The database holds only the token's hash.
    const stored = app.store.db.prepare("SELECT token_hash FROM devices").get();
    expect(stored).toEqual({ token_hash: hashSecret(token) });

    const again = await app.post("/sync/v1/pair", { code, device: "Other" });
    expect(again.status).toBe(401);
    expect(app.store.devices()).toHaveLength(1);
  });

  it("refuses an expired, unknown or malformed code", async () => {
    const app = await startServer({ now: () => NOW });
    const expired = pairingCode(app.store, new Date(NOW.getTime() - 1));
    for (const code of [expired, newSecret(), "short", 42]) {
      const response = await app.post("/sync/v1/pair", { code, device: "iPhone" });
      expect(response.status).toBe(401);
    }
    expect(app.store.devices()).toHaveLength(0);
  });

  it("refuses pairing while it is switched off", async () => {
    const app = await startServer({ now: () => NOW, pairing: false });
    const response = await app.post("/sync/v1/pair", {
      code: pairingCode(app.store),
      device: "iPhone",
    });
    expect(response.status).toBe(403);
    expect(app.store.devices()).toHaveLength(0);
  });

  it("asks for a device name", async () => {
    const app = await startServer({ now: () => NOW });
    const response = await app.post("/sync/v1/pair", { code: pairingCode(app.store), device: "" });
    expect(response.status).toBe(400);
  });

  it("serves the pairing page with a strict policy", async () => {
    const app = await startServer();
    const response = await app.call("/pair");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain("polso-dev");
  });
});

describe("uploads", () => {
  it("stores an upload from a paired device and names the generation", async () => {
    const app = await paired();
    const response = await app.upload({ samples: [heartRate(1)] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, generation: app.store.generation() });
    expect(app.store.counts().samples).toBe(1);
  });

  it("reports a new generation after the data is erased", async () => {
    const app = await paired();
    const before = ((await (await app.upload({})).json()) as { generation: string }).generation;
    app.store.eraseHealthData();
    const after = ((await (await app.upload({})).json()) as { generation: string }).generation;
    expect(after).not.toBe(before);
  });

  it.each([
    ["no token", {}],
    ["another token", { Authorization: `Bearer ${newSecret()}` }],
    ["a malformed token", { Authorization: "Bearer not-a-token" }],
    ["another scheme", { Authorization: "Basic dXNlcjpwYXNz" }],
  ])("refuses an upload with %s and stores nothing", async (_, headers) => {
    const app = await startServer({ now: () => NOW });
    const response = await app.post("/sync/v1/changes", { samples: [heartRate(1)] }, headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(app.store.counts().samples).toBe(0);
  });

  it("locks out a revoked device at once", async () => {
    const app = await paired();
    expect((await app.upload({})).status).toBe(200);
    app.store.revoke();
    const response = await app.upload({ samples: [heartRate(1)] });
    expect(response.status).toBe(401);
    expect(app.store.counts().samples).toBe(0);
  });

  it("refuses requests from web pages, even with a valid token", async () => {
    const app = await paired();
    const response = await app.upload(
      { samples: [heartRate(1)] },
      { Origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
    expect(app.store.counts().samples).toBe(0);
  });

  it("rejects a malformed upload as a whole", async () => {
    const app = await paired();
    const response = await app.upload({
      samples: [heartRate(1), { ...heartRate(2), start: "yesterday" }],
      deleted: [UUID(3)],
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/samples\[1\]\.start/);
    expect(app.store.counts().samples).toBe(0);
  });

  it("rejects bodies that aren't JSON", async () => {
    const app = await paired();
    expect((await app.upload("{not json")).status).toBe(400);
    expect((await app.upload({}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(app.store.counts().lastUploadAt).toBeUndefined();
  });

  it.each([
    ["declares", true],
    ["streams", false],
  ])("stops reading a body that %s more than the limit", async (_, declared) => {
    const app = await paired();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${app.base}/sync/v1/changes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${app.token}`,
          ...(declared && { "Content-Length": String(MAX_BODY_BYTES + 1) }),
        },
      });
      let answered = false;
      request.on("response", (response) => {
        answered = true;
        response.resume();
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      request.on("error", (error) => {
        if (!answered) reject(error);
      });
      // Send far more than the limit, a chunk at a time, until the server answers.
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (!answered && sent <= 2 * MAX_BODY_BYTES) {
          sent += chunk.length;
          if (!request.write(chunk)) return void request.once("drain", pump);
        }
      };
      pump();
    });
    expect(status).toBe(413);
    expect(app.store.counts().lastUploadAt).toBeUndefined();
  });

  it("answers unknown paths and methods", async () => {
    const app = await startServer();
    expect((await app.call("/nope")).status).toBe(404);
    expect((await app.call("/sync/v1/changes")).status).toBe(405);
  });

  it("hides internal failures behind a generic error", async () => {
    const errors: unknown[] = [];
    const app = await paired();
    const broken = Object.create(app.store, {
      apply: {
        value: () => {
          throw new Error("disk full at /var/lib/polso");
        },
      },
    }) as Store;
    const failing = await startServer({ store: broken, onError: (e) => errors.push(e) });
    const response = await failing.post(
      "/sync/v1/changes",
      {},
      {
        Authorization: `Bearer ${app.token}`,
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal error." });
    expect(errors).toHaveLength(1);
  });
});

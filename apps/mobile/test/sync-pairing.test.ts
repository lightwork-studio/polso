import { describe, expect, it, vi } from "vitest";
import { httpClient, type SyncClient, SyncError } from "../src/sync/client";
import { type Pairing, SyncController, type SyncDeps, UNPAIRED } from "../src/sync/controller";
import type { SyncSource, SyncState } from "../src/sync/engine";
import { hostOf, parsePairingLink } from "../src/sync/link";

const CODE = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0nPq_";

describe("pairing links", () => {
  it("reads the server's page link and the link it hands the app", () => {
    expect(parsePairingLink(` https://polso.example.com/pair#${CODE} `)).toEqual({
      server: "https://polso.example.com",
      code: CODE,
    });
    for (const scheme of ["polso", "polso-preview", "polso-dev"]) {
      const link = `${scheme}://pair?server=${encodeURIComponent("https://polso.example.com")}&code=${CODE}`;
      expect(parsePairingLink(link)).toEqual({ server: "https://polso.example.com", code: CODE });
    }
    expect(hostOf("https://polso.example.com:8443")).toBe("polso.example.com:8443");
  });

  it.each([
    ["plain http", `http://polso.example.com/pair#${CODE}`],
    ["another path", `https://polso.example.com/other#${CODE}`],
    ["a short code", "https://polso.example.com/pair#abc"],
    ["credentials", `https://user:pw@polso.example.com/pair#${CODE}`],
    ["an http server in an app link", `polso://pair?server=http%3A%2F%2Fx.example&code=${CODE}`],
    ["a server with a path", `polso://pair?server=https%3A%2F%2Fx.example%2Fsub&code=${CODE}`],
    ["another app's scheme", `other://pair?server=https%3A%2F%2Fx.example&code=${CODE}`],
    ["another action", `polso://agents?server=https%3A%2F%2Fx.example&code=${CODE}`],
    ["text", "hello"],
  ])("refuses %s", (_, text) => {
    expect(parsePairingLink(text)).toBeUndefined();
  });
});

describe("sync client", () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("sends the token and returns the generation", async () => {
    const fetchFn = respond(200, { ok: true, generation: "g7" });
    const client = httpClient("https://polso.example.com", () => "tok", fetchFn);
    expect(await client.upload({ deleted: ["a"] })).toBe("g7");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://polso.example.com/sync/v1/changes");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({ deleted: ["a"] });
  });

  it("pairs without a token", async () => {
    const fetchFn = respond(200, { token: "new-token" });
    const client = httpClient("https://polso.example.com", () => undefined, fetchFn);
    expect(await client.pair(CODE, "iPhone")).toBe("new-token");
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it.each([
    [401, "unpaired"],
    [503, "unavailable"],
    [400, "refused"],
    [413, "refused"],
  ] as const)("reads %i as %s, with the server's message", async (status, kind) => {
    const client = httpClient("https://s", () => "tok", respond(status, { error: "Because." }));
    const error = await client.upload({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ kind, message: "Because." });
  });

  it("reports an unreachable server as unavailable", async () => {
    const client = httpClient(
      "https://s",
      () => "tok",
      async () => {
        throw new TypeError("Network request failed");
      },
    );
    await expect(client.upload({})).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("won't send without a token", async () => {
    const fetchFn = respond(200, {});
    const client = httpClient("https://s", () => undefined, fetchFn);
    await expect(client.upload({})).rejects.toMatchObject({ kind: "unpaired" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("sync controller", () => {
  function setup() {
    let pairing: Pairing | null = null;
    const states = new Map<string, SyncState>();
    const server = {
      generation: "g1",
      tokens: [] as (string | undefined)[],
      resets: 0,
      unpaired: false,
    };
    const client = (_url: string, token: () => string | undefined): SyncClient => ({
      pair: async () => "device-token",
      upload: async () => {
        server.tokens.push(token());
        if (server.unpaired) throw new SyncError("unpaired", "no");
        return server.generation;
      },
      reset: async () => {
        server.resets++;
        return server.generation;
      },
    });
    const source: SyncSource = {
      types: async () => [],
      changes: async () => ({ samples: [], workouts: [], deleted: [], anchor: "a" }),
      dailyStats: async () => [],
      characteristics: async () => ({}),
      timeZone: () => "UTC",
      dayOf: (d) => d.toISOString().slice(0, 10),
    };
    const deps: SyncDeps = {
      loadPairing: async () => pairing,
      savePairing: async (p) => {
        pairing = p;
      },
      deletePairing: async () => {
        pairing = null;
      },
      loadState: async (id) => states.get(id) ?? { anchors: {} },
      saveState: async (id, state) => {
        states.set(id, state);
      },
      deleteState: async () => states.clear(),
      client,
      source,
      randomId: () => "pairing-1",
      deviceName: "iPhone",
    };
    return { deps, server, states, pairing: () => pairing };
  }
  const link = { server: "https://polso.example.com", code: CODE };

  it("pairs, keeps the token in the Keychain, and syncs with it", async () => {
    const { deps, server, pairing } = setup();
    const controller = new SyncController(deps);
    await controller.pair(link);
    expect(pairing()).toEqual({ server: link.server, token: "device-token", id: "pairing-1" });
    expect(server.tokens.every((t) => t === "device-token")).toBe(true);
    expect(controller.getView()).toMatchObject({ server: link.server, status: { name: "idle" } });
  });

  it("does nothing before pairing", async () => {
    const { deps, server } = setup();
    const controller = new SyncController(deps);
    await controller.sync();
    expect(server.tokens).toEqual([]);
    expect(controller.getView().status).toEqual({ name: "unpaired" });
  });

  it("says so when the server no longer knows the phone", async () => {
    const { deps, server } = setup();
    const controller = new SyncController(deps);
    await controller.pair(link);
    server.unpaired = true;
    await controller.sync();
    expect(controller.getView().status).toEqual({ name: "failed", message: UNPAIRED });
  });

  it("erases the server's copy before unpairing, and keeps the pairing if it can't", async () => {
    const { deps, server, pairing } = setup();
    const controller = new SyncController(deps);
    await controller.pair(link);
    const resets = server.resets;
    await controller.unpair(true);
    expect(server.resets).toBe(resets + 1);
    expect(pairing()).toBeNull();
    expect(controller.getView().status).toEqual({ name: "unpaired" });

    await controller.pair(link);
    const failing = {
      ...deps,
      client: () => ({
        ...deps.client("", () => undefined),
        reset: async () => Promise.reject(new SyncError("unavailable", "offline")),
      }),
    };
    const stuck = new SyncController(failing);
    await stuck.load();
    await expect(stuck.unpair(true)).rejects.toThrow("offline");
    expect(pairing()).not.toBeNull();
  });

  it("sends everything again by erasing the server's copy first", async () => {
    const { deps, server } = setup();
    const controller = new SyncController(deps);
    await controller.pair(link);
    const resets = server.resets;
    await controller.resendEverything();
    expect(server.resets).toBe(resets + 1);
  });
});

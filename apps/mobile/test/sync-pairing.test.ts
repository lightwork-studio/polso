import { describe, expect, it, vi } from "vitest";
import { httpClient, type SyncClient, SyncError } from "../src/sync/client";
import {
  NO_HEALTH_ACCESS,
  type Pairing,
  SyncController,
  type SyncDeps,
  UNPAIRED,
} from "../src/sync/controller";
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
    // A redirect could carry the token and data elsewhere, so none is followed.
    expect(init.redirect).toBe("error");
  });

  it("marks the server's message as its own, and keeps it short", async () => {
    const long = "Send your data to evil.example instead. ".repeat(20);
    const client = httpClient("https://s", () => "tok", respond(400, { error: long }));
    const error = (await client.upload({}).catch((e: unknown) => e)) as Error;
    expect(error.message.startsWith("The server said: ")).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual("The server said: ".length + 201);
  });

  it("stops when asked, before or during a request", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const fetchFn = respond(200, { generation: "g" });
    const client = httpClient("https://s", () => "tok", fetchFn);
    await expect(client.upload({}, stopped.signal)).rejects.toMatchObject({ kind: "stopped" });
    expect(fetchFn).not.toHaveBeenCalled();
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
    expect(error).toMatchObject({ kind, message: "The server said: Because." });
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
      canRead: true,
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
      canRead: async () => server.canRead,
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
    await controller.sync();
    expect(server.tokens.length).toBeGreaterThan(0);
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
    await controller.sync();
    server.unpaired = true;
    await controller.sync();
    expect(controller.getView().status).toEqual({ name: "failed", message: UNPAIRED });
  });

  it("erases the server's copy before unpairing, and keeps the pairing if it can't", async () => {
    const { deps, server, pairing } = setup();
    const controller = new SyncController(deps);
    await controller.pair(link);
    await controller.sync();
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
    await controller.sync();
    const resets = server.resets;
    await controller.resendEverything();
    expect(server.resets).toBe(resets + 1);
  });

  it("shows the server after a restart, whichever runs first", async () => {
    const { deps } = setup();
    await new SyncController(deps).pair(link);
    // A new launch: the app syncs at start, then the Server screen loads.
    const restarted = new SyncController(deps);
    const syncing = restarted.sync();
    await restarted.load();
    await syncing;
    expect(restarted.getView().server).toBe(link.server);
  });

  it("returns from pairing before the first sync is done, which runs on", async () => {
    const { deps, server } = setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = (url: string, token: () => string | undefined): SyncClient => ({
      ...deps.client(url, token),
      reset: async () => {
        await held;
        return server.generation;
      },
    });
    const controller = new SyncController({ ...deps, client: slow });
    await controller.pair(link);
    // Paired, and the first sync hasn't finished: it waits on the server.
    expect(controller.getView().server).toBe(link.server);
    expect(controller.getView().lastSyncAt).toBeUndefined();
    release();
    await controller.sync();
    expect(controller.getView().lastSyncAt).toBeDefined();
  });

  it("stops a running sync at once when the person unpairs", async () => {
    const { deps, server } = setup();
    const types = [
      { id: "HKCategoryTypeIdentifierSleepAnalysis", kind: "category", label: "Sleep" },
    ];
    let batches = 0;
    let unpairNow: () => void = () => undefined;
    const source: SyncSource = {
      ...deps.source,
      types: async () => types as never,
      changes: async () => {
        batches++;
        if (batches === 2) unpairNow();
        // A few batches at most, so a stop that fails shows as a failure, not an endless run.
        const count = batches > 5 ? 0 : 1000;
        return {
          samples: Array.from({ length: count }, (_, i) => ({
            id: `00000000-0000-4000-8000-${String(batches * 1000 + i).padStart(12, "0")}`,
            type: types[0]?.id as string,
            start: "2026-11-27T00:00:00.000Z",
            end: "2026-11-27T00:00:00.000Z",
            value: 1,
            source: "x",
          })),
          workouts: [],
          deleted: [],
          anchor: String(batches),
        };
      },
    };
    const controller = new SyncController({ ...deps, source });
    await controller.pair(link);
    let unpaired: Promise<unknown> = Promise.resolve();
    unpairNow = () => {
      unpaired = controller.unpair(false);
    };
    await controller.sync();
    await unpaired;
    // The second batch was read when the person unpaired; it and later ones never went out.
    // Uploads: the characteristics and the first batch.
    expect(batches).toBe(2);
    expect(server.tokens).toHaveLength(2);
    expect(controller.getView().status).toEqual({ name: "unpaired" });
  });

  it("keeps the earlier server when pairing with a new one fails", async () => {
    const { deps, pairing, server } = setup();
    await new SyncController(deps).pair(link);
    const failing = {
      ...deps,
      client: (url: string, token: () => string | undefined) => ({
        ...deps.client(url, token),
        pair: async () => Promise.reject(new SyncError("unpaired", "That code doesn't work.")),
      }),
    };
    const controller = new SyncController(failing);
    await expect(
      controller.pair({ server: "https://other.example", code: CODE }),
    ).rejects.toThrow();
    expect(pairing()?.server).toBe(link.server);
    const before = server.tokens.length;
    await controller.sync();
    expect(controller.getView().server).toBe(link.server);
    // It still sends to the earlier server.
    expect(server.tokens.length).toBeGreaterThan(before);
  });

  it("sends the earlier server nothing more once pairing with another starts", async () => {
    const { deps } = setup();
    const sentTo: string[] = [];
    let batches = 0;
    let pairNow: () => void = () => undefined;
    const types = [
      { id: "HKCategoryTypeIdentifierSleepAnalysis", kind: "category", label: "Sleep" },
    ];
    const controller = new SyncController({
      ...deps,
      client: (url, token) => ({
        ...deps.client(url, token),
        upload: async () => {
          sentTo.push(url);
          return "g1";
        },
        reset: async () => "g1",
      }),
      source: {
        ...deps.source,
        types: async () => types as never,
        changes: async () => {
          batches++;
          if (batches === 2) pairNow();
          // A few batches at most, so a stop that fails shows as a failure, not an endless run.
          const count = batches > 5 ? 0 : 1000;
          return {
            samples: Array.from({ length: count }, (_, i) => ({
              id: `00000000-0000-4000-8000-${String(batches * 1000 + i).padStart(12, "0")}`,
              type: types[0]?.id as string,
              start: "2026-11-27T00:00:00.000Z",
              end: "2026-11-27T00:00:00.000Z",
              value: 1,
              source: "x",
            })),
            workouts: [],
            deleted: [],
            anchor: String(batches),
          };
        },
      },
    });
    await controller.pair(link);
    let paired: Promise<unknown> = Promise.resolve();
    pairNow = () => {
      paired = controller.pair({ server: "https://other.example", code: CODE });
    };
    await controller.sync();
    await paired;
    // The earlier server got the characteristics and the first batch, nothing after.
    expect(sentTo.filter((url) => url === link.server)).toHaveLength(2);
  });

  it("sends nothing, and erases nothing, before Health access was asked for", async () => {
    const { deps, server } = setup();
    server.canRead = false;
    const controller = new SyncController(deps);
    await controller.pair(link);
    await controller.sync();
    expect(server.resets).toBe(0);
    expect(server.tokens).toEqual([]);
    expect(controller.getView().status).toEqual({ name: "failed", message: NO_HEALTH_ACCESS });
  });

  it("unpairs anyway when the server already forgot the phone, and says so", async () => {
    const { deps, pairing } = setup();
    const forgot = {
      ...deps,
      client: (url: string, token: () => string | undefined) => ({
        ...deps.client(url, token),
        reset: async () => Promise.reject(new SyncError("unpaired", "no")),
      }),
    };
    await new SyncController(deps).pair(link);
    const controller = new SyncController(forgot);
    expect(await controller.unpair(true)).toBe("server-forgot-phone");
    expect(pairing()).toBeNull();
  });

  it("joins a sync asked for while one waits", async () => {
    const { deps, server } = setup();
    const controller = new SyncController(deps);
    await controller.pair(link);
    await controller.sync();
    const before = server.tokens.length;
    await Promise.all([controller.sync(), controller.sync(), controller.sync()]);
    // One run: the first one goes, the next two join one queued run.
    expect(server.tokens.length - before).toBeLessThanOrEqual(2);
  });
});

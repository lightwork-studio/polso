import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_TYPES } from "../src/health/catalog";
import type { HealthQueries } from "../src/health/queries";
import { type AccessDeps, AgentAccess } from "../src/mcp/access";
import { type Connection, endpointListener, type Listener } from "../src/mcp/listener";
import { decodeUtf8, encodeUtf8 } from "../src/mcp/utf8";

let counter = 0;
/** Different bytes on every call, like a real random source. */
const randomBytes = (count: number) => new Uint8Array(count).fill(++counter);

function fakeDeps(stored: string | null = null) {
  let saved = stored;
  const servers: { token: string; closed: boolean; fail: (e: Error) => void }[] = [];
  const deps = {
    loadToken: vi.fn(async () => saved),
    saveToken: vi.fn(async (token: string) => {
      saved = token;
    }),
    deleteToken: vi.fn(async () => {
      saved = null;
    }),
    randomBytes: vi.fn(randomBytes),
    listen: vi.fn(async (token: string, fail: (e: Error) => void) => {
      const server = { token, closed: false, fail };
      servers.push(server);
      return {
        close: () => {
          server.closed = true;
        },
      };
    }),
    keepAwake: vi.fn(),
  } satisfies AccessDeps;
  return { deps, servers, saved: () => saved };
}

const open = <T extends { closed: boolean }>(servers: T[]) => servers.filter((s) => !s.closed);

describe("agent access", () => {
  let f: ReturnType<typeof fakeDeps>;
  let access: AgentAccess;
  beforeEach(() => {
    f = fakeDeps();
    access = new AgentAccess(f.deps);
  });

  it("is off until switched on, and makes a token only when needed", async () => {
    await access.setForeground(true);
    expect(access.getState()).toMatchObject({ enabled: false, status: { name: "off" } });
    expect(f.deps.listen).not.toHaveBeenCalled();
    expect(f.deps.saveToken).not.toHaveBeenCalled();
  });

  it("serves with a new token from the Keychain and keeps the screen awake", async () => {
    await access.setEnabled(true);
    const token = access.getState().token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.saved()).toBe(token);
    expect(f.deps.listen).toHaveBeenCalledWith(token, expect.any(Function));
    expect(f.deps.keepAwake).toHaveBeenLastCalledWith(true);
    expect(access.getState().status).toEqual({ name: "on" });
  });

  it("reuses the stored token, and replaces one that's unusable", async () => {
    const stored = "s".repeat(43);
    f = fakeDeps(stored);
    await new AgentAccess(f.deps).setEnabled(true);
    expect(f.deps.listen).toHaveBeenCalledWith(stored, expect.any(Function));

    f = fakeDeps("short");
    const fresh = new AgentAccess(f.deps);
    await fresh.loadToken();
    expect(fresh.getState().token).not.toBe("short");
    expect(f.saved()).toBe(fresh.getState().token);
  });

  it("stops in the background and serves again in front", async () => {
    await access.setEnabled(true);
    await access.setForeground(false);
    expect(open(f.servers)).toHaveLength(0);
    expect(f.deps.keepAwake).toHaveBeenLastCalledWith(false);
    expect(access.getState()).toMatchObject({ enabled: true, status: { name: "paused" } });

    await access.setForeground(true);
    expect(open(f.servers)).toHaveLength(1);
    expect(access.getState().status).toEqual({ name: "on" });
  });

  it("stops serving and lets the screen sleep when switched off", async () => {
    await access.setEnabled(true);
    await access.setEnabled(false);
    expect(open(f.servers)).toHaveLength(0);
    expect(f.deps.keepAwake).toHaveBeenLastCalledWith(false);
    expect(access.getState().status).toEqual({ name: "off" });
  });

  it("doesn't start twice when switched on twice", async () => {
    await Promise.all([access.setEnabled(true), access.setEnabled(true)]);
    expect(f.deps.listen).toHaveBeenCalledTimes(1);
    expect(access.getState().status).toEqual({ name: "on" });
  });

  it("restarts with a new token when regenerated", async () => {
    await access.setEnabled(true);
    const old = access.getState().token;
    await access.regenerate();
    const token = access.getState().token;
    expect(token).not.toBe(old);
    expect(f.saved()).toBe(token);
    expect(open(f.servers).map((s) => s.token)).toEqual([token]);
  });

  it("switches off with the reason when it can't start", async () => {
    f.deps.listen.mockRejectedValueOnce(new Error("Address already in use"));
    await access.setEnabled(true);
    expect(access.getState()).toMatchObject({
      enabled: false,
      status: { name: "failed", message: "Address already in use" },
    });
    expect(f.deps.keepAwake).not.toHaveBeenCalledWith(true);
  });

  it("switches off when the server fails later", async () => {
    await access.setEnabled(true);
    f.servers[0]?.fail(new Error("Network went away"));
    await access.setForeground(true); // Waits for the queued failure.
    expect(access.getState()).toMatchObject({
      enabled: false,
      status: { name: "failed", message: "Network went away" },
    });
    expect(open(f.servers)).toHaveLength(0);
    expect(f.deps.keepAwake).toHaveBeenLastCalledWith(false);
  });

  it("stops serving the old token even when the new one can't be saved", async () => {
    await access.setEnabled(true);
    const old = access.getState().token;
    f.deps.saveToken.mockRejectedValueOnce(new Error("Keychain unavailable"));
    await access.regenerate();
    expect(open(f.servers)).toHaveLength(0);
    expect(f.deps.keepAwake).toHaveBeenLastCalledWith(false);
    expect(access.getState()).toMatchObject({
      enabled: false,
      status: { name: "failed", message: "Couldn't make a new token. Keychain unavailable" },
    });
    // The old token is gone, so switching on again makes a new one rather than reviving it.
    expect(f.saved()).toBeNull();
    await access.setEnabled(true);
    expect(access.getState().token).not.toBe(old);
    expect(open(f.servers).map((s) => s.token)).toEqual([access.getState().token]);
  });

  it("overwrites the old token when it can't be deleted", async () => {
    await access.setEnabled(true);
    f.deps.deleteToken.mockRejectedValueOnce(new Error("Keychain unavailable"));
    const old = f.saved();
    await access.regenerate();
    expect(access.getState()).toMatchObject({ enabled: true, status: { name: "on" } });
    expect(access.getState().token).not.toBe(old);
    expect(f.saved()).toBe(access.getState().token);
    expect(open(f.servers).map((s) => s.token)).toEqual([access.getState().token]);
  });

  it("never serves the old token when it can be neither deleted nor overwritten", async () => {
    await access.setEnabled(true);
    f.deps.deleteToken.mockRejectedValueOnce(new Error("Keychain unavailable"));
    f.deps.saveToken.mockRejectedValueOnce(new Error("Keychain unavailable"));
    const old = f.saved();
    await access.regenerate();
    expect(open(f.servers)).toHaveLength(0);
    expect(access.getState()).toMatchObject({ enabled: false, status: { name: "failed" } });
    expect(f.saved()).toBe(old); // Still stored, but this session won't use it.
    f.deps.saveToken.mockRejectedValueOnce(new Error("Keychain unavailable"));
    await access.setEnabled(true);
    expect(access.getState()).toMatchObject({ enabled: false, status: { name: "failed" } });
    await access.setEnabled(true);
    expect(f.servers.at(-1)?.token).not.toBe(old);
    expect(access.getState().token).not.toBe(old);
    expect(f.saved()).toBe(access.getState().token);
  });

  it("stops serving when a new token can't be made", async () => {
    await access.setEnabled(true);
    f.deps.randomBytes.mockImplementationOnce(() => {
      throw new Error("No randomness");
    });
    await access.regenerate();
    expect(open(f.servers)).toHaveLength(0);
    expect(access.getState()).toMatchObject({
      enabled: false,
      status: { name: "failed", message: "Couldn't make a new token. No randomness" },
    });
  });

  it("ignores a late failure from a server it already replaced", async () => {
    await access.setEnabled(true);
    const first = f.servers[0];
    const regenerating = access.regenerate();
    first?.fail(new Error("old server failed")); // Queued behind the regenerate.
    await regenerating;
    await access.setForeground(true);
    expect(access.getState()).toMatchObject({ enabled: true, status: { name: "on" } });
    expect(open(f.servers)).toHaveLength(1);
  });

  it("switches off when the Keychain can't be read", async () => {
    f.deps.loadToken.mockRejectedValueOnce(new Error("Keychain locked"));
    await access.setEnabled(true);
    expect(access.getState()).toMatchObject({ enabled: false, status: { name: "failed" } });
    expect(f.deps.listen).not.toHaveBeenCalled();
  });
});

describe("agent access end to end", () => {
  const queries: HealthQueries = {
    samples: vi.fn(async () => []),
    dailyStats: vi.fn(async () => []),
    workouts: vi.fn(async () => []),
    sleep: vi.fn(async () => []),
    characteristic: vi.fn(async () => undefined),
  };

  it("locks out the old token once a new one is made", async () => {
    let current: Listener | undefined;
    const f = fakeDeps();
    f.deps.listen.mockImplementation(async (token) => {
      const listener = endpointListener({
        token,
        server: { name: "polso", version: "0" },
        context: async () => ({ types: HEALTH_TYPES, queries, now: new Date() }),
      });
      current = listener;
      return { close: () => listener.stop() };
    });
    const access = new AgentAccess(f.deps);

    const ask = async (token: string) => {
      let sent = "";
      let data: (chunk: Uint8Array) => void = () => undefined;
      const connection: Connection = {
        onData: (listener) => (data = listener),
        onClose: () => undefined,
        endWith: (bytes) => (sent = decodeUtf8(bytes)),
        destroy: () => undefined,
      };
      current?.accept(connection);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      data(
        encodeUtf8(
          `POST /mcp HTTP/1.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        ),
      );
      await vi.waitFor(() => expect(sent).not.toBe(""));
      return Number(sent.split(" ")[1]);
    };

    await access.setEnabled(true);
    const old = access.getState().token as string;
    expect(await ask("x".repeat(43))).toBe(401);
    expect(await ask(old)).toBe(200);
    await access.regenerate();
    expect(await ask(old)).toBe(401);
    expect(await ask(access.getState().token as string)).toBe(200);
  });
});

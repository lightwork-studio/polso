import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Listener } from "../src/mcp/listener";
import { checkHead } from "../src/mcp/server";
import { LISTEN_TIMEOUT_MS, listenTcp } from "../src/mcp/tcp";
import { decodeUtf8 } from "../src/mcp/utf8";

const TOKEN = "k3J9vQ2mX7pL0sR4tW8yZ1aB5cD6eF4n";

// A stand-in for react-native-tcp-socket, shaped like the parts Polso uses.
const lib = vi.hoisted(() => ({
  servers: [] as unknown[],
  listen: "ok" as "ok" | "error" | "never",
}));
vi.mock("react-native-tcp-socket", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    destroyed = false;
    sent?: Uint8Array;
    closedUnder = false;
    end(bytes: Uint8Array) {
      if (this.closedUnder || this.destroyed) throw new Error("Socket is closed.");
      this.sent = bytes;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class Server extends EventEmitter {
    closed = false;
    options?: unknown;
    _listeningListener = { remove: vi.fn() };
    _errorListener = { remove: vi.fn() };
    _connectionsListener = { remove: vi.fn() };
    constructor(private readonly onConnection: (socket: Socket) => void) {
      super();
    }
    listen(options: unknown, callback: () => void) {
      this.options = options;
      if (lib.listen === "ok") queueMicrotask(callback);
      if (lib.listen === "error") queueMicrotask(() => this.emit("error", new Error("in use")));
      return this;
    }
    close() {
      this.closed = true;
      return this;
    }
    connect() {
      const socket = new Socket();
      this.onConnection(socket);
      return socket;
    }
  }
  return {
    default: {
      createServer: (onConnection: (socket: Socket) => void) => {
        const server = new Server(onConnection);
        lib.servers.push(server);
        return server;
      },
    },
  };
});

type FakeSocket = EventEmitter & { destroyed: boolean; sent?: Uint8Array; closedUnder: boolean };
type FakeServer = EventEmitter & {
  closed: boolean;
  options: unknown;
  connect(): FakeSocket;
  _listeningListener: { remove: () => void };
  _errorListener: { remove: () => void };
  _connectionsListener: { remove: () => void };
};
const lastServer = () => lib.servers.at(-1) as FakeServer;

const handle = vi.fn(async () => ({ status: 200, body: "answer" }));
const newListener = () => new Listener({ check: (head) => checkHead(head, TOKEN), handle });
const request = `POST /mcp HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 2\r\n\r\n{}`;

beforeEach(() => {
  lib.servers = [];
  lib.listen = "ok";
  handle.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("TCP adapter", () => {
  it("listens on every interface and serves connections", async () => {
    await listenTcp(8765, newListener(), vi.fn());
    const server = lastServer();
    expect(server.options).toEqual({ port: 8765, host: "0.0.0.0", reuseAddress: true });
    const socket = server.connect();
    socket.emit("data", request); // The library can also hand over strings.
    await vi.waitFor(() => expect(socket.sent).toBeDefined());
    expect(decodeUtf8(socket.sent as Uint8Array)).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("closes open connections and releases the library's listeners when closed", async () => {
    const listening = await listenTcp(8765, newListener(), vi.fn());
    const server = lastServer();
    const socket = server.connect();
    listening.close();
    expect(socket.destroyed).toBe(true);
    expect(server.closed).toBe(true);
    expect(server._listeningListener.remove).toHaveBeenCalled();
    expect(server._errorListener.remove).toHaveBeenCalled();
    expect(server._connectionsListener.remove).toHaveBeenCalled();
    expect(server.connect().destroyed).toBe(true);
  });

  it("rejects when the port can't be opened", async () => {
    lib.listen = "error";
    await expect(listenTcp(8765, newListener(), vi.fn())).rejects.toThrow("in use");
    expect(lastServer().closed).toBe(true);
  });

  it("rejects when the port doesn't open in time", async () => {
    vi.useFakeTimers();
    lib.listen = "never";
    const started = listenTcp(8765, newListener(), vi.fn());
    const outcome = expect(started).rejects.toThrow("didn't open in time");
    await vi.advanceTimersByTimeAsync(LISTEN_TIMEOUT_MS);
    await outcome;
    expect(lastServer().closed).toBe(true);
  });

  it("reports a later failure once and stops serving", async () => {
    const onFailure = vi.fn();
    await listenTcp(8765, newListener(), onFailure);
    const server = lastServer();
    const socket = server.connect();
    server.emit("error", new Error("network gone"));
    server.emit("error", new Error("again"));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "network gone" }));
    expect(socket.destroyed).toBe(true);
    expect(server.closed).toBe(true);
  });

  it("destroys a socket that closed before its answer could be written", async () => {
    await listenTcp(8765, newListener(), vi.fn());
    const socket = lastServer().connect();
    socket.closedUnder = true;
    socket.emit("data", Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    expect(socket.destroyed).toBe(true);
  });
});

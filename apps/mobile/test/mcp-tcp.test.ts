import type { EventEmitter } from "node:events";
import { checkHead } from "@polso/mcp/server";
import { decodeUtf8 } from "@polso/mcp/utf8";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Listener } from "../src/mcp/listener";
import { LISTEN_TIMEOUT_MS, listenTcp } from "../src/mcp/tcp";

const TOKEN = "k3J9vQ2mX7pL0sR4tW8yZ1aB5cD6eF4n";

// A stand-in for react-native-tcp-socket, shaped like the parts Polso uses and behaving like the
// library where it matters: close() does nothing until the server is listening, and writes to a
// socket the app destroyed throw.
const lib = vi.hoisted(() => ({
  servers: [] as unknown[],
  listen: "ok" as "ok" | "error" | "later",
  native: true,
}));
vi.mock("react-native", () => ({
  NativeModules: {
    get TcpSockets() {
      return lib.native ? {} : undefined;
    },
  },
}));
vi.mock("react-native-tcp-socket", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    destroyed = false;
    sent?: Uint8Array;
    end(bytes: Uint8Array) {
      if (this.destroyed) throw new Error("Socket is closed.");
      this.sent = bytes;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class Server extends EventEmitter {
    listening = false;
    closed = false;
    listenCallback?: () => void;
    _listeningListener = { remove: vi.fn() };
    _errorListener = { remove: vi.fn() };
    _connectionsListener = { remove: vi.fn() };
    constructor(
      readonly options: unknown,
      private readonly onConnection: (socket: Socket) => void,
    ) {
      super();
    }
    listen(options: unknown, callback: () => void) {
      this.listenOptions = options;
      this.listenCallback = callback;
      if (lib.listen === "ok") queueMicrotask(() => this.finishListening());
      if (lib.listen === "error") queueMicrotask(() => this.emit("error", new Error("in use")));
      return this;
    }
    listenOptions?: unknown;
    finishListening() {
      this.listening = true;
      this.listenCallback?.();
    }
    close() {
      if (this.listening) this.closed = true;
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
      createServer: (options: unknown, onConnection: (socket: Socket) => void) => {
        const server = new Server(options, onConnection);
        lib.servers.push(server);
        return server;
      },
    },
  };
});

type FakeSocket = EventEmitter & { destroyed: boolean; sent?: Uint8Array };
type Removable = { remove: ReturnType<typeof vi.fn> };
type FakeServer = EventEmitter & {
  closed: boolean;
  options: unknown;
  listenOptions: unknown;
  finishListening(): void;
  connect(): FakeSocket;
  _listeningListener: Removable;
  _errorListener: Removable;
  _connectionsListener: Removable;
};
const lastServer = () => lib.servers.at(-1) as FakeServer;

const handle = vi.fn(async () => ({ status: 200, body: "answer" }));
const newListener = () => new Listener({ check: (head) => checkHead(head, TOKEN), handle });
const request = `POST /mcp HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 2\r\n\r\n{}`;

beforeEach(() => {
  lib.servers = [];
  lib.listen = "ok";
  lib.native = true;
  handle.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("TCP adapter", () => {
  it("listens on every interface and serves connections", async () => {
    await listenTcp(8765, newListener(), vi.fn());
    const server = lastServer();
    expect(server.listenOptions).toEqual({ port: 8765, host: "0.0.0.0", reuseAddress: true });
    const socket = server.connect();
    socket.emit("data", request); // The library can also hand over strings.
    await vi.waitFor(() => expect(socket.sent).toBeDefined());
    expect(decodeUtf8(socket.sent as Uint8Array)).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("closes open and late connections, then releases the library's listeners", async () => {
    vi.useFakeTimers();
    const listening = await listenTcp(8765, newListener(), vi.fn());
    const server = lastServer();
    const socket = server.connect();
    listening.close();
    expect(socket.destroyed).toBe(true);
    expect(server.closed).toBe(true);
    expect(server._listeningListener.remove).toHaveBeenCalled();
    expect(server._errorListener.remove).toHaveBeenCalled();
    // A connection the phone accepted just before closing still arrives, and is closed.
    expect(server.connect().destroyed).toBe(true);
    expect(server._connectionsListener.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server._connectionsListener.remove).toHaveBeenCalled();
  });

  it("refuses to start without the native module, before loading the library", async () => {
    lib.native = false;
    await expect(listenTcp(8765, newListener(), vi.fn())).rejects.toThrow("latest build");
    expect(lib.servers).toHaveLength(0);
  });

  it("rejects when the port can't be opened", async () => {
    lib.listen = "error";
    await expect(listenTcp(8765, newListener(), vi.fn())).rejects.toThrow("in use");
    expect(lastServer()._connectionsListener.remove).not.toHaveBeenCalled(); // Not yet; later.
    expect(lastServer()._listeningListener.remove).toHaveBeenCalled();
  });

  it("shuts down a server whose port opens after it gave up", async () => {
    vi.useFakeTimers();
    lib.listen = "later";
    const started = listenTcp(8765, newListener(), vi.fn());
    const outcome = expect(started).rejects.toThrow("didn't open in time");
    await vi.advanceTimersByTimeAsync(LISTEN_TIMEOUT_MS);
    await outcome;
    const server = lastServer();
    expect(server.closed).toBe(false); // The library can't close it yet.
    server.finishListening();
    expect(server.closed).toBe(true);
    expect(server.connect().destroyed).toBe(true);
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

  it("destroys a socket the library won't write to", async () => {
    await listenTcp(8765, newListener(), vi.fn());
    const socket = lastServer().connect();
    const end = vi.spyOn(socket as unknown as { end: () => void }, "end");
    end.mockImplementation(() => {
      throw new Error("Socket is closed.");
    });
    socket.emit("data", Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    expect(end).toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../src/mcp/http";
import { type Connection, DEFAULT_LIMITS, endpointListener, Listener } from "../src/mcp/listener";
import { checkHead } from "../src/mcp/server";
import { decodeUtf8, encodeUtf8 } from "../src/mcp/utf8";

const TOKEN = "k3J9vQ2mX7pL0sR4tW8yZ1aB5cD6eF4n";

class FakeConnection implements Connection {
  private data?: (chunk: Uint8Array) => void;
  private closed?: () => void;
  sent?: string;
  destroyed = false;

  /** Like the real library: closing is reported later, and writes after destroy throw. */
  constructor(private readonly closesLater = false) {}

  onData(listener: (chunk: Uint8Array) => void) {
    this.data = listener;
  }
  onClose(listener: () => void) {
    this.closed = listener;
  }
  endWith(bytes: Uint8Array) {
    if (this.sent !== undefined) throw new Error("answered twice");
    if (this.destroyed) throw new Error("Socket is closed.");
    this.sent = decodeUtf8(bytes);
    if (!this.closesLater) this.closed?.();
  }
  destroy() {
    this.destroyed = true;
    if (!this.closesLater) this.closed?.();
  }
  /** The native side reports the close. */
  reportClosed() {
    this.closed?.();
  }
  send(text: string) {
    this.data?.(encodeUtf8(text));
  }
  /** The client hangs up. */
  hangUp() {
    this.closed?.();
  }
  get status(): number | undefined {
    return this.sent === undefined ? undefined : Number(this.sent.split(" ")[1]);
  }
  get body(): string | undefined {
    return this.sent?.split("\r\n\r\n")[1];
  }
}

const request = (body = "{}", token = TOKEN) =>
  `POST /mcp HTTP/1.1\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
const ok: HttpResponse = { status: 200, body: "answer" };

let handle: ReturnType<typeof vi.fn<(r: HttpRequest) => Promise<HttpResponse>>>;
let listener: Listener;
const connect = (closesLater = false) => {
  const connection = new FakeConnection(closesLater);
  listener.accept(connection);
  return connection;
};
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  handle = vi.fn(async () => ok);
  listener = new Listener({ check: (head) => checkHead(head, TOKEN), handle });
});
afterEach(() => vi.useRealTimers());

describe("listener", () => {
  it("answers one request and closes the connection", async () => {
    const c = connect();
    c.send(request('{"a":1}'));
    await settle();
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ path: "/mcp", body: '{"a":1}' }));
    expect(c.status).toBe(200);
    expect(c.body).toBe("answer");
    expect(listener.openConnections).toBe(0);
  });

  it("refuses a request without the token as soon as its head arrives", async () => {
    const c = connect();
    c.send(request("{}", "wrong").replace("{}", ""));
    await settle();
    expect(c.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it("checks the endpoint's token before any body arrives", () => {
    const endpoint = endpointListener({
      token: TOKEN,
      server: { name: "polso", version: "0" },
      context: async () => {
        throw new Error("Health data must not be read");
      },
    });
    const c = new FakeConnection();
    endpoint.accept(c);
    c.send("POST /mcp HTTP/1.1\r\nAuthorization: Bearer wrong\r\nContent-Length: 10\r\n\r\n");
    expect(c.status).toBe(401);
  });

  it("closes a connection whose head doesn't arrive in time", async () => {
    const c = connect();
    c.send("POST /mcp HTTP/1.1\r\n");
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.headMs - 1);
    expect(c.sent).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(c.status).toBe(408);
    expect(listener.openConnections).toBe(0);
  });

  it("closes a connection whose body doesn't arrive in time", async () => {
    const c = connect();
    const full = request('{"slow":true}');
    c.send(full.slice(0, -3));
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.headMs + 1);
    expect(c.sent).toBeUndefined(); // The head arrived in time; the body still may.
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.requestMs - DEFAULT_LIMITS.headMs);
    expect(c.status).toBe(408);
    c.send(full.slice(-3));
    await settle();
    expect(handle).not.toHaveBeenCalled();
  });

  it("gives a slow Health read the time it needs once the request is in", async () => {
    handle.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(ok), 45_000)),
    );
    const c = connect();
    c.send(request());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(c.status).toBe(200);
  });

  it("caps open connections and accepts more once one closes", async () => {
    const open = Array.from({ length: DEFAULT_LIMITS.connections }, connect);
    const extra = connect();
    expect(extra.status).toBe(503);
    expect(listener.openConnections).toBe(DEFAULT_LIMITS.connections);
    open[0]?.hangUp();
    const next = connect();
    expect(next.sent).toBeUndefined();
    expect(listener.openConnections).toBe(DEFAULT_LIMITS.connections);
  });

  it("answers requests one at a time", async () => {
    let release: () => void = () => undefined;
    handle.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ status: 200, body: "first" }))),
    );
    const [a, b] = [connect(), connect()];
    a.send(request('{"n":1}'));
    b.send(request('{"n":2}'));
    await settle();
    expect(handle).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(handle).toHaveBeenCalledTimes(2);
    expect([a.body, b.body]).toEqual(["first", "answer"]);
  });

  it("skips a queued request whose client hung up", async () => {
    let release: () => void = () => undefined;
    handle.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(ok))));
    const [a, b] = [connect(), connect()];
    a.send(request());
    b.send(request());
    b.hangUp();
    release();
    await settle();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(b.sent).toBeUndefined();
  });

  it("gives up on a slow Health read, and starts no other until it finishes", async () => {
    let release: () => void = () => undefined;
    handle.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(ok))));
    const [a, b] = [connect(), connect()];
    a.send(request());
    b.send(request());
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.handleMs - 1);
    expect(a.sent).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(a.status).toBe(504);
    // The slow read still runs, so reads can't pile up behind it.
    expect(b.status).toBe(503);
    expect(handle).toHaveBeenCalledTimes(1);
    release();
    await settle();
    const c = connect();
    c.send(request());
    await settle();
    expect(c.status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("serves again once a slow Health read that timed out fails", async () => {
    let reject: () => void = () => undefined;
    handle.mockImplementationOnce(
      () => new Promise((_, no) => (reject = () => no(new Error("read failed")))),
    );
    const a = connect();
    a.send(request());
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.handleMs);
    expect(a.status).toBe(504);
    reject();
    await settle();
    const b = connect();
    b.send(request());
    await settle();
    expect(b.status).toBe(200);
  });

  it("answers a failure with a generic error and keeps serving", async () => {
    handle.mockRejectedValueOnce(new Error("secret detail"));
    const a = connect();
    a.send(request());
    await settle();
    expect(a.status).toBe(500);
    expect(a.sent).not.toContain("secret detail");
    const b = connect();
    b.send(request());
    await settle();
    expect(b.status).toBe(200);
  });

  it("never reads bytes after the request as another request", async () => {
    const c = connect();
    c.send(`${request()}${request('{"smuggled":1}')}`);
    c.send(request('{"later":1}'));
    await settle();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0].body).toBe("{}");
  });

  it("ends a connection's deadlines and queued request when stopped", async () => {
    let release: () => void = () => undefined;
    handle.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(ok))));
    const [busy, queued, waiting] = [connect(true), connect(true), connect(true)];
    busy.send(request());
    queued.send(request());
    waiting.send("POST /mcp HTTP/1.1\r\n");
    await settle();
    listener.stop();
    // The native close arrives after the deadlines would have fired.
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.requestMs + 1);
    release();
    await settle();
    expect(handle).toHaveBeenCalledTimes(1);
    for (const c of [busy, queued, waiting]) {
      expect(c.destroyed).toBe(true);
      expect(c.sent).toBeUndefined();
    }
  });

  it("cuts off a client that doesn't take its answer", async () => {
    const c = connect(true);
    c.send(request());
    await settle();
    expect(c.status).toBe(200);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.sendMs - 1);
    expect(c.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.destroyed).toBe(true);
    c.reportClosed();
    expect(listener.openConnections).toBe(0);
  });

  it("doesn't cut off a connection that closed after its answer", async () => {
    const c = connect(true);
    c.send(request());
    await settle();
    c.reportClosed();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.sendMs);
    expect(c.destroyed).toBe(false);
  });

  it("closes open connections when stopped and refuses new ones", async () => {
    const open = connect();
    listener.stop();
    expect(open.destroyed).toBe(true);
    const later = connect();
    expect(later.destroyed).toBe(true);
    expect(later.sent).toBeUndefined();
  });
});

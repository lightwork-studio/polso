import {
  type HeadCheck,
  type HttpRequest,
  type HttpResponse,
  RequestReader,
  serializeResponse,
} from "./http";
import { checkHead, type EndpointOptions, handleHttp } from "./server";

/** One accepted TCP connection, as the listener sees it. The TCP adapter provides it. */
export interface Connection {
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Called once when the connection closes or fails. */
  onClose(listener: () => void): void;
  /** Sends the bytes, then closes the connection once they're written. */
  endWith(bytes: Uint8Array): void;
  /** Closes the connection at once. */
  destroy(): void;
}

/** A TCP server that is listening; closing it also closes its open connections. */
export interface Listening {
  close(): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Limits {
  /** Open connections at once; more are answered 503 and closed. */
  readonly connections: number;
  /** Time from connecting until the head has arrived. */
  readonly headMs: number;
  /** Time from connecting until the whole request has arrived. */
  readonly requestMs: number;
  /** Time to answer a complete request; the next request waits at most this long. */
  readonly handleMs: number;
  /** Time to send the answer; a client that stops reading is cut off after it. */
  readonly sendMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  connections: 8,
  headMs: 5_000,
  requestMs: 15_000,
  handleMs: 60_000,
  sendMs: 30_000,
};

export interface ListenerOptions {
  /** Runs on the head before any body is read: the endpoint's path, origin and token checks. */
  readonly check: HeadCheck;
  /** Answers a complete request. */
  readonly handle: (request: HttpRequest) => Promise<HttpResponse>;
  readonly limits?: Limits;
  readonly timers?: Timers;
}

const plain = (status: number, body: string): HttpResponse => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body,
});

/**
 * Serves HTTP over the connections a TCP server accepts: one request per connection, then the
 * connection closes, so bytes after a request are never read as another one. Requests must arrive
 * within the time limits, connections are capped, and requests are answered one at a time, so a
 * burst of large Health reads can't pile up on the phone.
 */
export class Listener {
  /** Open connections, each with the function that ends its work. */
  private readonly open = new Map<Connection, () => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly limits: Limits;
  private readonly timers: Timers;

  constructor(private readonly options: ListenerOptions) {
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.timers = options.timers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  get openConnections(): number {
    return this.open.size;
  }

  accept(connection: Connection): void {
    if (this.stopped) {
      connection.destroy();
      return;
    }
    if (this.open.size >= this.limits.connections) {
      connection.endWith(serializeResponse(plain(503, "Busy. Try again shortly.")));
      return;
    }

    const reader = new RequestReader(this.options.check);
    let done = false;
    let timers: unknown[] = [];
    const clearTimers = () => {
      for (const t of timers) this.timers.clearTimeout(t);
      timers = [];
    };
    const finish = () => {
      done = true;
      clearTimers();
    };
    this.open.set(connection, finish);
    const respond = (response: HttpResponse) => {
      if (done) return;
      finish();
      connection.endWith(serializeResponse(response));
      if (this.open.has(connection)) {
        timers.push(this.timers.setTimeout(() => connection.destroy(), this.limits.sendMs));
      }
    };
    const timeOut = () => respond(plain(408, "The request took too long."));

    timers.push(
      this.timers.setTimeout(() => {
        if (!reader.headRead) timeOut();
      }, this.limits.headMs),
      this.timers.setTimeout(timeOut, this.limits.requestMs),
    );

    connection.onClose(() => {
      finish();
      this.open.delete(connection);
    });
    connection.onData((chunk) => {
      if (done) return;
      const result = reader.push(chunk);
      if (result.state === "error") respond(result.response);
      if (result.state !== "complete") return;
      // The request is in; stop the clocks and wait for earlier requests to be answered.
      clearTimers();
      const answer = this.queue.then(() =>
        done ? undefined : this.handle(result.request).then(respond),
      );
      this.queue = answer.catch(() => undefined);
    });
  }

  /** Answers within handleMs, so a Health read that never settles can't hold up the queue. */
  private async handle(request: HttpRequest): Promise<HttpResponse> {
    let timer: unknown;
    const late = new Promise<HttpResponse>((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve(plain(504, "Health data took too long to read.")),
        this.limits.handleMs,
      );
    });
    try {
      return await Promise.race([this.options.handle(request), late]);
    } catch {
      return plain(500, "Internal error.");
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** Closes every open connection; connections accepted later are closed at once. */
  stop(): void {
    this.stopped = true;
    const open = [...this.open];
    this.open.clear();
    for (const [connection, finish] of open) {
      // Ends its timers and skips its queued request before the socket goes.
      finish();
      connection.destroy();
    }
  }
}

/**
 * The listener for the MCP endpoint: every request's head goes through `checkHead` before any of
 * its body is read, and complete requests go to `handleHttp`.
 */
export function endpointListener(options: EndpointOptions, limits?: Limits): Listener {
  return new Listener({
    check: (head) => checkHead(head, options.token),
    handle: (request) => handleHttp(request, options),
    limits,
  });
}

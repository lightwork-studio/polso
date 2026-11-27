import {
  type HeadCheck,
  type HttpRequest,
  type HttpResponse,
  RequestReader,
  serializeResponse,
} from "./http";

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
}

export const DEFAULT_LIMITS: Limits = { connections: 8, headMs: 5_000, requestMs: 15_000 };

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
  private readonly open = new Set<Connection>();
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
    this.open.add(connection);

    const reader = new RequestReader(this.options.check);
    let done = false;
    const timers: unknown[] = [];
    const finish = () => {
      done = true;
      for (const t of timers) this.timers.clearTimeout(t);
    };
    const respond = (response: HttpResponse) => {
      if (done) return;
      finish();
      connection.endWith(serializeResponse(response));
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
      for (const t of timers) this.timers.clearTimeout(t);
      const answer = this.queue.then(() =>
        done ? undefined : this.handle(result.request).then(respond),
      );
      this.queue = answer.catch(() => undefined);
    });
  }

  private async handle(request: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.options.handle(request);
    } catch {
      return plain(500, "Internal error.");
    }
  }

  /** Closes every open connection; connections accepted later are closed at once. */
  stop(): void {
    this.stopped = true;
    for (const connection of [...this.open]) connection.destroy();
    this.open.clear();
  }
}

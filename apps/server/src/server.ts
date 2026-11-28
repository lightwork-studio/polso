import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ChangesError, parseChanges } from "./changes.ts";
import { PAIR_PAGE, PAIR_PAGE_CSP } from "./pair-page.ts";
import type { Store } from "./store.ts";
import { hashSecret, looksLikeSecret, newSecret } from "./tokens.ts";

/** Largest request body the server reads. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DEVICE_NAME = 100;

export interface ServerOptions {
  readonly store: Store;
  /** When false, pairing answers 403 and paired devices keep syncing. */
  readonly pairing?: boolean;
  readonly now?: () => Date;
  /** Reports unexpected failures; the client only gets a generic 500. */
  readonly onError?: (error: unknown) => void;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  response.end(json);
}

/** Reads a JSON body, stopping as soon as it passes the limit. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new HttpError(415, "Send the body as application/json.");
  }
  const declared = Number(request.headers["content-length"]);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "The body is too large.");
  // Plain listeners rather than for-await: leaving that loop early would destroy the request,
  // and with it the socket the answer goes out on.
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const received: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        stop();
        reject(new HttpError(413, "The body is too large."));
        return;
      }
      received.push(chunk);
    };
    const onEnd = () => {
      stop();
      resolve(received);
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };
    const stop = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The body isn't valid JSON.");
  }
}

function bearer(request: IncomingMessage): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
  return match?.[1];
}

/** The sync server: pairing, uploads and the pairing page. */
export function createSyncServer(options: ServerOptions): Server {
  const { store } = options;
  const now = options.now ?? (() => new Date());

  async function pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (options.pairing === false) {
      throw new HttpError(403, "Pairing is switched off on this server.");
    }
    const body = await readJson(request);
    const { code, device } = (body ?? {}) as { code?: unknown; device?: unknown };
    if (typeof device !== "string" || device.trim() === "" || device.length > MAX_DEVICE_NAME) {
      throw new HttpError(400, "Name the device in 1 to 100 characters.");
    }
    if (typeof code !== "string" || !looksLikeSecret(code)) {
      throw new HttpError(401, "That pairing code doesn't work. Make a new one.");
    }
    const token = newSecret();
    if (!store.pair(hashSecret(code), device.trim(), hashSecret(token), now())) {
      throw new HttpError(401, "That pairing code doesn't work. Make a new one.");
    }
    send(response, 200, { token });
  }

  async function changes(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearer(request);
    const device =
      token !== undefined && looksLikeSecret(token)
        ? store.deviceFor(hashSecret(token), now())
        : undefined;
    if (!device) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="polso"');
      throw new HttpError(401, "This device isn't paired with the server. Pair it again.");
    }
    const body = await readJson(request);
    let parsed: ReturnType<typeof parseChanges>;
    try {
      parsed = parseChanges(body);
    } catch (error) {
      if (error instanceof ChangesError) throw new HttpError(400, error.message);
      throw error;
    }
    store.apply(parsed, now());
    send(response, 200, { ok: true, generation: store.generation() });
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://server").pathname;
    // Web pages can't reach the API with someone's token: browsers send Origin, phones don't.
    if (path.startsWith("/sync/") && request.headers.origin !== undefined) {
      throw new HttpError(403, "Requests from web pages aren't accepted.");
    }
    if (path === "/pair" && (request.method === "GET" || request.method === "HEAD")) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": PAIR_PAGE_CSP,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : PAIR_PAGE);
      return;
    }
    const routes: Record<string, typeof pair> = {
      "/sync/v1/pair": pair,
      "/sync/v1/changes": changes,
    };
    const handler = routes[path];
    if (!handler) throw new HttpError(404, "Not found.");
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      throw new HttpError(405, "Use POST.");
    }
    await handler(request, response);
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      // Discard the rest of a body the server stopped reading, rather than closing on it: a
      // socket closed with unread data resets, and the client could lose the answer. The
      // request timeout still bounds how long this takes.
      if (!request.complete) request.resume();
      if (error instanceof HttpError) {
        send(response, error.status, { error: error.message });
        return;
      }
      options.onError?.(error);
      send(response, 500, { error: "Internal error." });
    });
  });
  // Slow clients can't hold connections open indefinitely.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  return server;
}

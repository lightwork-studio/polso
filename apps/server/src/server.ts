import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ChangesError, parseChanges } from "./changes.ts";
import { PAIR_PAGE, PAIR_PAGE_CSP } from "./pair-page.ts";
import { isBusy, type Store } from "./store.ts";
import { hashSecret, looksLikeSecret, newSecret } from "./tokens.ts";

/** Largest upload body the server reads, from a paired device. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Largest body before a device is known: pairing needs a code and a name. */
export const MAX_PAIRING_BYTES = 4 * 1024;
/** Open connections at once; one person's phones need a handful. */
export const MAX_CONNECTIONS = 64;
/** How long a connection may stay silent, in either direction, before it is closed. */
export const IDLE_TIMEOUT_MS = 15_000;
const MAX_DEVICE_NAME = 100;

export interface ServerOptions {
  readonly store: Store;
  /** Overrides IDLE_TIMEOUT_MS, for tests. */
  readonly idleTimeoutMs?: number;
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

/** The client went away before its request arrived; there's no one to answer. */
class ClientGoneError extends Error {
  override name = "ClientGoneError";
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(json);
}

/** Reads a JSON body, stopping as soon as it passes `limit` bytes. */
async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new HttpError(415, "Send the body as application/json.");
  }
  const declared = Number(request.headers["content-length"]);
  if (declared > limit) throw new HttpError(413, "The body is too large.");
  // Plain listeners rather than for-await: leaving that loop early would destroy the request,
  // and with it the socket the answer goes out on.
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const received: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
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
    const onError = () => {
      stop();
      reject(new ClientGoneError());
    };
    const onClose = () => {
      if (request.complete) return;
      stop();
      reject(new ClientGoneError());
    };
    const stop = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
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

const NOT_PAIRED = "This device isn't paired with the server. Pair it again.";

/** The sync server: pairing, uploads, resets and the pairing page. */
export function createSyncServer(options: ServerOptions): Server {
  const { store } = options;
  const now = options.now ?? (() => new Date());

  /** The hash of the request's device token, when it belongs to a paired device. */
  function device(request: IncomingMessage, response: ServerResponse): string {
    const token = bearer(request);
    if (token !== undefined && looksLikeSecret(token)) {
      const tokenHash = hashSecret(token);
      if (store.deviceFor(tokenHash, now())) return tokenHash;
    }
    response.setHeader("WWW-Authenticate", 'Bearer realm="polso"');
    throw new HttpError(401, NOT_PAIRED);
  }

  async function pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (options.pairing === false) {
      throw new HttpError(403, "Pairing is switched off on this server.");
    }
    const body = await readJson(request, MAX_PAIRING_BYTES);
    const { code, device: name } = (body ?? {}) as { code?: unknown; device?: unknown };
    if (
      typeof name !== "string" ||
      name.trim() === "" ||
      name.length > MAX_DEVICE_NAME ||
      /\p{Cc}/u.test(name)
    ) {
      throw new HttpError(400, "Name the device in 1 to 100 characters.");
    }
    if (typeof code !== "string" || !looksLikeSecret(code)) {
      throw new HttpError(401, "That pairing code doesn't work. Make a new one.");
    }
    const token = newSecret();
    if (!store.pair(hashSecret(code), name.trim(), hashSecret(token), now())) {
      throw new HttpError(401, "That pairing code doesn't work. Make a new one.");
    }
    send(response, 200, { token });
  }

  async function changes(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const tokenHash = device(request, response);
    const body = await readJson(request, MAX_BODY_BYTES);
    let parsed: ReturnType<typeof parseChanges>;
    try {
      parsed = parseChanges(body);
    } catch (error) {
      if (error instanceof ChangesError) throw new HttpError(400, error.message);
      throw error;
    }
    // Checked again as it's written: the device may have been revoked while the body arrived.
    if (!store.apply(parsed, now(), tokenHash)) throw new HttpError(401, NOT_PAIRED);
    send(response, 200, { ok: true, generation: store.generation() });
  }

  async function reset(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const tokenHash = device(request, response);
    if (!store.eraseHealthData(tokenHash)) throw new HttpError(401, NOT_PAIRED);
    send(response, 200, { ok: true, generation: store.generation() });
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://server").pathname;
    } catch {
      throw new HttpError(400, "That isn't a request target the server understands.");
    }
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
      "/sync/v1/reset": reset,
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
      if (error instanceof ClientGoneError || response.headersSent || response.destroyed) {
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
      // An admin command (erase, say) holds the database; the phone retries later.
      if (isBusy(error)) {
        send(
          response,
          503,
          { error: "The server is busy. Try again shortly." },
          {
            "Retry-After": "5",
          },
        );
        return;
      }
      options.onError?.(error);
      send(response, 500, { error: "Internal error." });
    });
  });
  // Slow clients can't hold connections open indefinitely, nor open them without end.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.maxConnections = MAX_CONNECTIONS;
  // A connection that sends nothing for this long is closed. The request timeouts only start
  // with a request's first bytes, so without this, idle connections could fill the cap above
  // and lock the phone out.
  server.setTimeout(options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
  return server;
}

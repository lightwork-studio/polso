import { decodeUtf8, encodeUtf8 } from "./utf8";

/** The request line and headers, available before the body arrives. */
export interface HttpHead {
  readonly method: string;
  readonly path: string;
  /** Header names in lower case. Repeated headers are joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpRequest extends HttpHead {
  readonly body: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export const MAX_HEADER_BYTES = 16 * 1024;
/** MCP requests to Polso are small JSON messages. */
export const MAX_BODY_BYTES = 64 * 1024;

export type ParseResult =
  | { readonly state: "incomplete" }
  | { readonly state: "complete"; readonly request: HttpRequest }
  | { readonly state: "error"; readonly response: HttpResponse };

/**
 * Decides from the head alone whether to refuse a request, so a client without access can't make
 * Polso receive a body. Returns the refusal, or undefined to read on.
 */
export type HeadCheck = (head: HttpHead) => HttpResponse | undefined;

const plain = (status: number, message: string): HttpResponse => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: message,
});
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Control characters other than tab, which RFC 9112 doesn't allow in header values. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;

/**
 * Reads one HTTP/1.1 request from a connection's bytes as they arrive. The head is parsed once;
 * the body goes into a buffer sized from Content-Length. Chunked uploads and oversized requests
 * are refused. After a final result, further bytes are ignored.
 */
export class RequestReader {
  private pending?: { head: HttpHead; body: Uint8Array };
  private headBytes: number[] = [];
  private received = 0;
  private result?: ParseResult;

  constructor(private readonly check?: HeadCheck) {}

  /** Whether the head has arrived and passed the check, so only the body is outstanding. */
  get headRead(): boolean {
    return this.pending !== undefined;
  }

  push(chunk: Uint8Array): ParseResult {
    if (this.result) return this.result;
    let offset = 0;
    if (!this.pending) {
      // Collect bytes up to the blank line that ends the head, a byte at a time, without
      // re-reading what came before.
      for (; offset < chunk.length; offset++) {
        this.headBytes.push(chunk[offset] as number);
        const n = this.headBytes.length;
        if (n > MAX_HEADER_BYTES) return this.finish(plain(431, "Request headers are too large."));
        if (
          n >= 4 &&
          this.headBytes[n - 4] === 13 &&
          this.headBytes[n - 3] === 10 &&
          this.headBytes[n - 2] === 13 &&
          this.headBytes[n - 1] === 10
        ) {
          offset++;
          const refused = this.readHead();
          if (refused) return this.finish(refused);
          break;
        }
      }
    }
    if (!this.pending) return { state: "incomplete" };

    const { head, body } = this.pending;
    const take = Math.min(chunk.length - offset, body.length - this.received);
    if (take > 0) body.set(chunk.subarray(offset, offset + take), this.received);
    this.received += take;
    if (this.received < body.length) return { state: "incomplete" };

    const request = { ...head, body: decodeUtf8(body) };
    this.result = { state: "complete", request };
    return this.result;
  }

  private finish(response: HttpResponse): ParseResult {
    this.result = { state: "error", response };
    return this.result;
  }

  /** Parses the head; returns a refusal, or undefined once the body can be read. */
  private readHead(): HttpResponse | undefined {
    const lines = decodeUtf8(Uint8Array.from(this.headBytes.slice(0, -4))).split("\r\n");
    this.headBytes = [];
    const [method, target, version, extra] = (lines[0] ?? "").split(" ");
    if (!method || !TOKEN.test(method) || !target || extra !== undefined) {
      return plain(400, "Malformed request line.");
    }
    if (version !== "HTTP/1.1" && version !== "HTTP/1.0") {
      return plain(400, "Malformed request line.");
    }
    // No prototype, so header names like __proto__ are plain keys.
    const headers: Record<string, string> = Object.create(null);
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon);
      // Names are tokens with nothing before the colon; folded lines start with whitespace.
      if (colon <= 0 || !TOKEN.test(name)) return plain(400, "Malformed header.");
      const key = name.toLowerCase();
      const raw = line.slice(colon + 1);
      // A bare CR or LF would hide a second header inside this one; other controls are invalid.
      // Checked before trimming, since trim() would also strip them from the ends.
      if (CONTROL.test(raw)) return plain(400, "Malformed header.");
      const value = raw.replace(/^[ \t]+|[ \t]+$/g, "");
      headers[key] = key in headers ? `${headers[key]}, ${value}` : value;
    }

    if (headers["transfer-encoding"] !== undefined) {
      return plain(411, "Send the body with a Content-Length.");
    }
    const lengthHeader = headers["content-length"] ?? "0";
    if (!/^\d{1,9}$/.test(lengthHeader)) return plain(400, "Invalid Content-Length.");
    const length = Number(lengthHeader);
    if (length > MAX_BODY_BYTES) return plain(413, "Request body is too large.");

    const head: HttpHead = { method, path: target.split("?")[0] as string, headers };
    const refused = this.check?.(head);
    if (refused) return refused;
    this.pending = { head, body: new Uint8Array(length) };
    return undefined;
  }
}

const REASONS: Record<number, string> = {
  200: "OK",
  202: "Accepted",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  411: "Length Required",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** Serializes a response for a connection that closes after it. */
export function serializeResponse(response: HttpResponse): Uint8Array {
  const body = encodeUtf8(response.body ?? "");
  const headers: Record<string, string> = {
    ...response.headers,
    "content-length": String(body.length),
    "cache-control": "no-store",
    connection: "close",
  };
  const head = [
    `HTTP/1.1 ${response.status} ${REASONS[response.status] ?? "Status"}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
  const headBytes = encodeUtf8(head);
  const out = new Uint8Array(headBytes.length + body.length);
  out.set(headBytes);
  out.set(body, headBytes.length);
  return out;
}

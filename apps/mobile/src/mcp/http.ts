import { decodeUtf8, encodeUtf8 } from "./utf8";

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_BODY_BYTES = 1024 * 1024;

export type ParseResult =
  | { readonly state: "incomplete" }
  | { readonly state: "complete"; readonly request: HttpRequest }
  | { readonly state: "error"; readonly response: HttpResponse };

const fail = (status: number, message: string): ParseResult => ({
  state: "error",
  response: { status, headers: { "content-type": "text/plain; charset=utf-8" }, body: message },
});

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let i = 3; i < bytes.length; i++) {
    if (bytes[i - 3] === 13 && bytes[i - 2] === 10 && bytes[i - 1] === 13 && bytes[i] === 10) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Reads one HTTP/1.1 request from a connection's bytes as they arrive. Bodies need a
 * Content-Length; chunked uploads and oversized requests are refused.
 */
export class RequestReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): ParseResult {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const headerEnd = indexOfHeaderEnd(this.buffer);
    if (headerEnd < 0) {
      return this.buffer.length > MAX_HEADER_BYTES
        ? fail(431, "Request headers are too large.")
        : { state: "incomplete" };
    }
    if (headerEnd > MAX_HEADER_BYTES) return fail(431, "Request headers are too large.");

    // Header bytes are ASCII in practice; anything else is decoded leniently.
    const lines = decodeUtf8(this.buffer.subarray(0, headerEnd - 4)).split("\r\n");
    const [method, target, version] = (lines[0] ?? "").split(" ");
    if (!method || !target || !version?.startsWith("HTTP/1.")) {
      return fail(400, "Malformed request line.");
    }
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) return fail(400, "Malformed header.");
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    }

    if (headers["transfer-encoding"]) return fail(411, "Send the body with a Content-Length.");
    const lengthHeader = headers["content-length"] ?? "0";
    if (!/^\d+$/.test(lengthHeader)) return fail(400, "Invalid Content-Length.");
    const length = Number(lengthHeader);
    if (length > MAX_BODY_BYTES) return fail(413, "Request body is too large.");
    if (this.buffer.length < headerEnd + length) return { state: "incomplete" };

    const body = decodeUtf8(this.buffer.subarray(headerEnd, headerEnd + length));
    const path = target.split("?")[0] as string;
    return { state: "complete", request: { method, path, headers, body } };
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
  406: "Not Acceptable",
  411: "Length Required",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
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

import type { HttpHead, HttpRequest, HttpResponse } from "./http";
import {
  handleMessage,
  INVALID_REQUEST,
  PARSE_ERROR,
  PROTOCOL_VERSIONS,
  type ServerInfo,
} from "./protocol";
import type { ToolContext } from "./tools";

export const MCP_PATH = "/mcp";
/** Shorter tokens are refused outright, so a token that failed to generate can't open access. */
export const MIN_TOKEN_LENGTH = 32;

export interface EndpointOptions {
  /** The bearer token every request must carry. */
  readonly token: string;
  readonly server: ServerInfo;
  readonly context: () => Promise<ToolContext>;
}

const text = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  body,
});
const json = (status: number, value: unknown): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

/** Compares in time that depends only on the expected token's length. */
export function sameToken(given: string, expected: string): boolean {
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The checks that need only the request head: path, web-page origin and token. A listener runs
 * them as soon as the head arrives (see RequestReader), so a client without the token can't make
 * Polso receive a body. The texts don't say what the server is.
 *
 * Requests from web pages carry an Origin header and are refused, so a site the person visits
 * can't reach the endpoint through their browser.
 */
export function checkHead(head: HttpHead, token: string): HttpResponse | undefined {
  if (head.path !== MCP_PATH) return text(404, "Not found.");
  if (head.headers.origin !== undefined) return text(403, "Forbidden.");
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(head.headers.authorization ?? "");
  if (token.length < MIN_TOKEN_LENGTH || !match || !sameToken(match[1] as string, token)) {
    return text(401, "Unauthorized.", { "www-authenticate": 'Bearer realm="mcp"' });
  }
  return undefined;
}

/**
 * Answers one HTTP request to the MCP endpoint (Streamable HTTP, stateless, JSON responses).
 * It repeats the head checks, so it is safe to call without them.
 */
export async function handleHttp(
  request: HttpRequest,
  options: EndpointOptions,
): Promise<HttpResponse> {
  const refused = checkHead(request, options.token);
  if (refused) return refused;

  if (request.method !== "POST") {
    return text(405, "MCP requests are sent by POST.", { allow: "POST" });
  }
  const contentType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return text(415, "Send MCP messages as application/json.");
  }
  const version = request.headers["mcp-protocol-version"];
  if (version !== undefined && !PROTOCOL_VERSIONS.includes(version as never)) {
    return text(400, `Unsupported MCP protocol version: ${version}`);
  }

  let message: unknown;
  try {
    message = JSON.parse(request.body);
  } catch {
    return json(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: PARSE_ERROR, message: "Invalid JSON." },
    });
  }
  const response = await handleMessage(message, options.context, options.server);
  if (!response) return { status: 202 };
  return json(response.error?.code === INVALID_REQUEST ? 400 : 200, response);
}

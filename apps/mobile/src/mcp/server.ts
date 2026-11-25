import type { HttpRequest, HttpResponse } from "./http";
import {
  handleMessage,
  INVALID_REQUEST,
  PARSE_ERROR,
  PROTOCOL_VERSIONS,
  type ServerInfo,
} from "./protocol";
import type { ToolContext } from "./tools";

export const MCP_PATH = "/mcp";

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

/** Compares in time that depends only on the lengths, so timing doesn't reveal the token. */
export function sameToken(given: string, expected: string): boolean {
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Answers one HTTP request to the MCP endpoint (Streamable HTTP, stateless, JSON responses).
 * Requests need the bearer token. Requests from web pages, which carry an Origin header, are
 * refused, so a site the person visits can't reach the endpoint through their browser.
 */
export async function handleHttp(
  request: HttpRequest,
  options: EndpointOptions,
): Promise<HttpResponse> {
  if (request.path !== MCP_PATH) return text(404, "Not found. The MCP endpoint is /mcp.");
  if (request.headers.origin !== undefined) {
    return text(403, "Requests from web pages are not allowed.");
  }

  const auth = request.headers.authorization ?? "";
  const match = /^Bearer (.+)$/i.exec(auth);
  if (!options.token || !match || !sameToken(match[1] as string, options.token)) {
    return text(401, "A valid bearer token is required.", {
      "www-authenticate": 'Bearer realm="polso"',
    });
  }

  if (request.method !== "POST") {
    return text(405, "Polso answers MCP requests by POST only.", { allow: "POST" });
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

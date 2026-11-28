import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_TYPES } from "../src/health/catalog.ts";
import type { HealthQueries } from "../src/health/queries.ts";
import { type HttpHead, type HttpRequest, RequestReader } from "../src/http.ts";
import { PROTOCOL_VERSIONS } from "../src/protocol.ts";
import { checkHead, type EndpointOptions, handleHttp, sameToken } from "../src/server.ts";
import { encodeUtf8 } from "../src/utf8.ts";

const TOKEN = "k3J9vQ2mX7pL0sR4tW8yZ1aB5cD6eF4n";
const queries: HealthQueries = {
  samples: vi.fn(async () => []),
  dailyStats: vi.fn(async () => []),
  workouts: vi.fn(async () => []),
  sleep: vi.fn(async () => []),
  characteristic: vi.fn(async () => undefined),
};
const options: EndpointOptions = {
  token: TOKEN,
  server: { name: "polso", version: "0.1.0" },
  context: async () => ({ types: HEALTH_TYPES, queries, now: new Date(2026, 10, 25, 12) }),
};

function post(body: unknown, headers: Record<string, string> = {}): HttpRequest {
  return {
    method: "POST",
    path: "/mcp",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined && { params }),
});
beforeEach(() => vi.clearAllMocks());

const call = async (req: HttpRequest) => {
  const res = await handleHttp(req, options);
  const isJson = res.headers?.["content-type"] === "application/json";
  return { ...res, json: isJson && res.body ? JSON.parse(res.body) : undefined };
};

describe("access", () => {
  it.each([
    ["no token", {}],
    ["a wrong token", { authorization: "Bearer nope" }],
    ["the token with one character changed", { authorization: `Bearer ${TOKEN.slice(0, -1)}G` }],
    ["the token as a prefix", { authorization: `Bearer ${TOKEN}x` }],
    ["a basic credential", { authorization: `Basic ${TOKEN}` }],
  ])("refuses %s and reads no Health data", async (_, headers) => {
    const req = post(rpc("tools/call", { name: "get_latest", arguments: { type: "StepCount" } }));
    const withHeaders = { ...req, headers: { ...req.headers, authorization: "", ...headers } };
    const res = await handleHttp(withHeaders, options);
    expect(res.status).toBe(401);
    expect(res.headers?.["www-authenticate"]).toBe("Bearer");
    expect(queries.samples).not.toHaveBeenCalled();
  });

  it.each(["/", "/mcp", "/admin"])("answers %s alike without the token", async (path) => {
    const res = await handleHttp({ method: "GET", path, headers: {}, body: "" }, options);
    expect(res).toEqual({
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8", "www-authenticate": "Bearer" },
      body: "Unauthorized.",
    });
  });

  it.each(["", "short-token"])("refuses a missing or too-short configured token", async (token) => {
    const res = await handleHttp(post(rpc("ping"), { authorization: `Bearer ${token}` }), {
      ...options,
      token,
    });
    expect(res.status).toBe(401);
  });

  it.each([
    ["missing credentials", "", 401],
    [
      "repeated authorization",
      `Authorization: Bearer ${TOKEN}\r\nAuthorization: Bearer ${TOKEN}\r\n`,
      401,
    ],
    ["an empty origin", `Authorization: Bearer ${TOKEN}\r\nOrigin:\r\n`, 403],
    [
      "repeated origins",
      `Authorization: Bearer ${TOKEN}\r\nOrigin: null\r\nOrigin: https://example.test\r\n`,
      403,
    ],
    ["a folded header", `Authorization: Bearer ${TOKEN}\r\n Folded: value\r\n`, 400],
    ["space before the colon", `Authorization : Bearer ${TOKEN}\r\n`, 400],
    [
      "an origin hidden behind a bare line feed",
      `Authorization: Bearer ${TOKEN}\r\nX: a\nOrigin: https://example.test\r\n`,
      400,
    ],
    [
      "an origin behind a line feed right after the colon",
      `Authorization: Bearer ${TOKEN}\r\nX:\nOrigin: https://example.test\r\n`,
      400,
    ],
    ["control characters around the token", `Authorization:\x0bBearer ${TOKEN}\x0c\r\n`, 400],
    ["a NUL in a value", `Authorization: Bearer ${TOKEN}\r\nX: a\0b\r\n`, 400],
    ["a repeated Content-Length", `Authorization: Bearer ${TOKEN}\r\nContent-Length: 2\r\n`, 400],
    [
      "a Transfer-Encoding",
      `Authorization: Bearer ${TOKEN}\r\nTransfer-Encoding: chunked\r\n`,
      411,
    ],
    ["valid credentials", `Authorization: bearer ${TOKEN}\r\n`, null],
  ])("handles %s as soon as the headers finish", (_, headers, status) => {
    const reader = new RequestReader((head) => checkHead(head, TOKEN));
    const head = `POST /mcp HTTP/1.1\r\nHost: phone:8765\r\nContent-Length: 2\r\n${headers}\r\n`;
    expect(reader.push(encodeUtf8(head.slice(0, -1)))).toEqual({ state: "incomplete" });
    const result = reader.push(encodeUtf8(head.slice(-1)));
    if (status === null) {
      expect(result).toEqual({ state: "incomplete" });
      expect(reader.push(encodeUtf8("{}"))).toMatchObject({
        state: "complete",
        request: { body: "{}" },
      });
    } else {
      expect(result).toMatchObject({ state: "error", response: { status } });
    }
  });

  it("refuses requests from web pages even with the token", async () => {
    const res = await call(post(rpc("ping"), { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("checks the token before revealing anything about the request", async () => {
    const res = await handleHttp({ method: "GET", path: "/mcp", headers: {}, body: "" }, options);
    expect(res.status).toBe(401);
  });

  it("compares tokens fully", () => {
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken("", TOKEN)).toBe(false);
    expect(sameToken(TOKEN.slice(0, 10), TOKEN)).toBe(false);
  });
});

describe("HTTP", () => {
  it.each([
    ["another path", { path: "/" }, 404],
    ["GET (no server-sent streams)", { method: "GET" }, 405],
    ["DELETE", { method: "DELETE" }, 405],
  ])("answers %s", async (_, change, status) => {
    expect((await call({ ...post(rpc("ping")), ...change })).status).toBe(status);
  });

  it("wants JSON", async () => {
    const res = await call(post(rpc("ping"), { "content-type": "text/plain" }));
    expect(res.status).toBe(415);
  });

  it("refuses an unknown protocol version header", async () => {
    const res = await call(post(rpc("ping"), { "mcp-protocol-version": "1999-01-01" }));
    expect(res.status).toBe(400);
  });

  it("reports invalid JSON as a parse error", async () => {
    const res = await call(post("{not json"));
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe(-32700);
  });

  it("refuses batches", async () => {
    const res = await call(post([rpc("ping")]));
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe(-32600);
  });

  it("accepts notifications without a body", async () => {
    const res = await call(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res).toMatchObject({ status: 202 });
    expect(res.body).toBeUndefined();
  });
});

describe("MCP", () => {
  it("agrees on the client's protocol version when it knows it", async () => {
    const res = await call(post(rpc("initialize", { protocolVersion: "2025-06-18" })));
    expect(res.json.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "polso", version: "0.1.0" },
    });
  });

  it("offers its newest version for one it doesn't know", async () => {
    const res = await call(post(rpc("initialize", { protocolVersion: "2099-01-01" })));
    expect(res.json.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("lists six read-only tools", async () => {
    const res = await call(post(rpc("tools/list")));
    const tools = res.json.result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      "list_health_types",
      "get_latest",
      "get_samples",
      "get_daily_stats",
      "get_workouts",
      "get_sleep",
    ]);
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("answers ping and unknown methods by id", async () => {
    expect((await call(post(rpc("ping", undefined, "a")))).json).toEqual({
      jsonrpc: "2.0",
      id: "a",
      result: {},
    });
    expect((await call(post(rpc("resources/list")))).json.error.code).toBe(-32601);
  });

  it("calls a tool and returns its result as text and structured content", async () => {
    const res = await call(
      post(rpc("tools/call", { name: "list_health_types", arguments: { group: "Profile" } })),
    );
    const result = res.json.result;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent.types.map((t: { type: string }) => t.type)).toContain(
      "BloodType",
    );
  });

  it("refuses an unknown tool as a protocol error", async () => {
    const res = await call(post(rpc("tools/call", { name: "delete_everything" })));
    expect(res.json.error.code).toBe(-32602);
  });

  it.each([{ toString: 1 }, null, 7])("refuses a tool name that isn't a string: %j", async (n) => {
    const res = await call(post(rpc("tools/call", { name: n })));
    expect(res.json.error).toEqual({ code: -32602, message: "The tool name must be a string." });
  });

  it("answers an unexpected failure with a generic error", async () => {
    const server = {
      version: "0.1.0",
      get name(): string {
        throw new Error("secret detail");
      },
    };
    const res = await handleHttp(post(rpc("initialize")), { ...options, server });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("secret detail");
    expect(JSON.parse(res.body as string).error.code).toBe(-32603);
  });

  it("returns bad arguments to the agent as a tool error it can fix", async () => {
    const res = await call(
      post(rpc("tools/call", { name: "get_samples", arguments: { type: "Nonsense" } })),
    );
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toContain("list_health_types");
  });

  it("returns a HealthKit failure as a tool error, not a crash", async () => {
    vi.mocked(queries.samples).mockRejectedValueOnce(new Error("Protected data is unavailable"));
    const res = await call(
      post(rpc("tools/call", { name: "get_samples", arguments: { type: "StepCount" } })),
    );
    expect(res.status).toBe(200);
    expect(res.json.result).toMatchObject({ isError: true });
    expect(res.json.result.content[0].text).toBe(
      "Health data couldn't be read: Protected data is unavailable",
    );
  });

  it("works end to end from raw request bytes", async () => {
    const body = JSON.stringify(rpc("tools/list"));
    const text = `POST /mcp HTTP/1.1\r\nHost: phone:8765\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const parsed = new RequestReader((head) => checkHead(head, TOKEN)).push(encodeUtf8(text));
    if (parsed.state !== "complete") throw new Error(parsed.state);
    const res = await call(parsed.request);
    expect(res.status).toBe(200);
    expect(res.json.result.tools).toHaveLength(6);
  });

  it("reads one request per connection and ignores bytes after its body", () => {
    const reader = new RequestReader((head) => checkHead(head, TOKEN));
    const head = `POST /mcp HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 2\r\n\r\n`;
    const smuggled = `GET /other HTTP/1.1\r\n\r\n`;
    const first = reader.push(encodeUtf8(`${head}{}${smuggled}`));
    expect(first).toMatchObject({ state: "complete", request: { path: "/mcp", body: "{}" } });
    expect(reader.push(encodeUtf8(smuggled))).toBe(first);
  });
});

describe("token check by function", () => {
  const head = (authorization?: string): HttpHead => ({
    method: "POST",
    path: "/mcp",
    headers: authorization === undefined ? {} : { authorization },
  });
  const known = new Set(["agent-token-one", "agent-token-two"]);
  const check = (token: string) => known.has(token);

  it("lets in any token the function accepts", () => {
    expect(checkHead(head("Bearer agent-token-one"), check)).toBeUndefined();
    expect(checkHead(head("Bearer agent-token-two"), check)).toBeUndefined();
  });

  it("refuses other tokens, a missing one, and web pages", () => {
    expect(checkHead(head("Bearer someone-else"), check)?.status).toBe(401);
    expect(checkHead(head(), check)?.status).toBe(401);
    const fromPage = {
      ...head("Bearer agent-token-one"),
      headers: { authorization: "Bearer agent-token-one", origin: "https://x" },
    };
    expect(checkHead(fromPage, check)?.status).toBe(403);
  });
});

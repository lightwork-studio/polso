import { callTool, isTool, TOOLS, type ToolContext, ToolInputError } from "./tools.ts";

/** Newest first; the first is offered when a client asks for a version Polso doesn't know. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const INSTRUCTIONS =
  "Read-only access to the person's Apple Health data on their iPhone. Call list_health_types first to find type names. Returned times are ISO 8601 in UTC. Dates and times you send without an offset, and the days and nights in results, are in the phone's time zone, which list_health_types reports. Types the person didn't allow return no data.";

type Id = string | number;
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: Id | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const error = (id: Id | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const result = (id: Id, value: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result: value });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * Handles one JSON-RPC message. Returns the response for a request, or undefined for a
 * notification or a response from the client, which need no answer.
 */
export async function handleMessage(
  message: unknown,
  context: () => Promise<ToolContext>,
  server: ServerInfo,
): Promise<JsonRpcResponse | undefined> {
  if (Array.isArray(message)) return error(null, INVALID_REQUEST, "Batches are not supported.");
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return error(null, INVALID_REQUEST, "Not a JSON-RPC 2.0 message.");
  }
  const { id, method, params } = message;
  if (method === undefined && ("result" in message || "error" in message)) return undefined;
  if (typeof method !== "string") return error(null, INVALID_REQUEST, "Missing method.");
  if (id === undefined) return undefined; // A notification, such as notifications/initialized.
  if (typeof id !== "string" && typeof id !== "number") {
    return error(null, INVALID_REQUEST, "The id must be a string or a number.");
  }
  if (params !== undefined && !isObject(params)) {
    return error(id, INVALID_PARAMS, "Params must be an object.");
  }

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.find((v) => v === requested) ?? PROTOCOL_VERSIONS[0];
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, title: "Polso", version: server.version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== "string") {
        return error(id, INVALID_PARAMS, "The tool name must be a string.");
      }
      if (!isTool(name)) return error(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      if (!isObject(args)) return error(id, INVALID_PARAMS, "Arguments must be an object.");
      try {
        const value = await callTool(name, args, await context());
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (e) {
        // Bad arguments and HealthKit failures go back to the agent as a tool error it can read.
        const reason = e instanceof Error ? e.message : String(e);
        const text =
          e instanceof ToolInputError ? reason : `Health data couldn't be read: ${reason}`;
        return result(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

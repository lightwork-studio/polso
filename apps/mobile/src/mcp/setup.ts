import { MCP_PORT } from "./access";
import { MCP_PATH } from "./server";

/** Wi-Fi addresses iOS reports when there's none to use. */
const NO_ADDRESS = new Set(["", "0.0.0.0", "::"]);

/** The endpoint's URL, or undefined when the phone has no usable network address. */
export function endpointUrl(address: string | undefined): string | undefined {
  if (!address || NO_ADDRESS.has(address)) return undefined;
  const host = address.includes(":") ? `[${address}]` : address;
  return `http://${host}:${MCP_PORT}${MCP_PATH}`;
}

/** The command that adds Polso to Claude Code. */
export function claudeCodeCommand(url: string, token: string): string {
  return `claude mcp add --transport http polso ${url} --header "Authorization: Bearer ${token}"`;
}

/** The entry for clients configured with an `mcpServers` JSON file. */
export function jsonConfig(url: string, token: string): string {
  const entry = { type: "http", url, headers: { Authorization: `Bearer ${token}` } };
  return JSON.stringify({ mcpServers: { polso: entry } }, null, 2);
}

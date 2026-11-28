import { MIN_TOKEN_LENGTH } from "@polso/mcp/server";
import { describe, expect, it } from "vitest";
import { claudeCodeCommand, endpointUrl, jsonConfig } from "../src/mcp/setup";
import { isUsableToken, newToken, TOKEN_BYTES } from "../src/mcp/token";

describe("tokens", () => {
  it("encodes 32 random bytes as unpadded base64url", () => {
    for (const fill of [0, 0xfb, 0xff]) {
      const bytes = new Uint8Array(TOKEN_BYTES).map((_, i) => (fill + i * 37) & 0xff);
      const token = newToken(() => bytes);
      expect(token).toBe(Buffer.from(bytes).toString("base64url"));
      expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    }
  });

  it("refuses a random source that returns too few bytes", () => {
    expect(() => newToken(() => new Uint8Array(16))).toThrow();
  });

  it("accepts only stored tokens that are long enough and well formed", () => {
    expect(isUsableToken(newToken((n) => new Uint8Array(n).fill(7)))).toBe(true);
    expect(isUsableToken(null)).toBe(false);
    expect(isUsableToken("a".repeat(MIN_TOKEN_LENGTH - 1))).toBe(false);
    expect(isUsableToken(`${"a".repeat(MIN_TOKEN_LENGTH)} `)).toBe(false);
  });
});

describe("setup", () => {
  it("builds the endpoint URL from the phone's address", () => {
    expect(endpointUrl("192.168.2.40")).toBe("http://192.168.2.40:8765/mcp");
    expect(endpointUrl("fe80::1")).toBe("http://[fe80::1]:8765/mcp");
    for (const none of [undefined, "", "0.0.0.0"]) expect(endpointUrl(none)).toBeUndefined();
  });

  it("gives agents the URL and token", () => {
    const url = "http://192.168.2.40:8765/mcp";
    expect(claudeCodeCommand(url, "tok_en-1")).toBe(
      'claude mcp add --transport http polso http://192.168.2.40:8765/mcp --header "Authorization: Bearer tok_en-1"',
    );
    expect(JSON.parse(jsonConfig(url, "tok_en-1"))).toEqual({
      mcpServers: {
        polso: { type: "http", url, headers: { Authorization: "Bearer tok_en-1" } },
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, RequestReader, serializeResponse } from "../src/mcp/http";
import { decodeUtf8, encodeUtf8 } from "../src/mcp/utf8";

const bytes = (text: string) => encodeUtf8(text);
const raw = (body: string, headers = "") =>
  `POST /mcp HTTP/1.1\r\nHost: 192.168.2.10:8765\r\nContent-Type: application/json\r\nContent-Length: ${encodeUtf8(body).length}\r\n${headers}\r\n${body}`;

describe("utf8", () => {
  it("round-trips text with accents and emoji", () => {
    const text = 'Schlaf "tief" é 💤 中文';
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
    expect(encodeUtf8("é")).toEqual(Uint8Array.from([0xc3, 0xa9]));
  });

  it("replaces malformed bytes instead of failing", () => {
    expect(decodeUtf8(Uint8Array.from([0x61, 0xff, 0x62]))).toBe("a�b");
    expect(decodeUtf8(Uint8Array.from([0xe2, 0x82]))).toBe("�");
    // An overlong encoding of "/" must not decode to "/".
    expect(decodeUtf8(Uint8Array.from([0xc0, 0xaf]))).not.toContain("/");
  });
});

describe("reading requests", () => {
  it("reads a whole request", () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const result = new RequestReader().push(bytes(raw(body, "Authorization: Bearer abc\r\n")));
    expect(result).toEqual({
      state: "complete",
      request: {
        method: "POST",
        path: "/mcp",
        headers: {
          host: "192.168.2.10:8765",
          "content-type": "application/json",
          "content-length": String(body.length),
          authorization: "Bearer abc",
        },
        body,
      },
    });
  });

  it("waits for the rest of a request split across packets, even inside a character", () => {
    const body = '{"note":"Müdigkeit 😴"}';
    const all = bytes(raw(body));
    const reader = new RequestReader();
    const cut = all.length - 3; // inside the 4-byte emoji
    expect(reader.push(all.subarray(0, 20)).state).toBe("incomplete");
    expect(reader.push(all.subarray(20, cut)).state).toBe("incomplete");
    const done = reader.push(all.subarray(cut));
    expect(done.state === "complete" && done.request.body).toBe(body);
  });

  it("counts Content-Length in bytes, not characters", () => {
    const body = '{"a":"é"}'; // 9 characters, 10 bytes
    const result = new RequestReader().push(bytes(raw(body)));
    expect(result.state === "complete" && result.request.body).toBe(body);
  });

  it("drops the query string from the path", () => {
    const result = new RequestReader().push(bytes("GET /mcp?x=1 HTTP/1.1\r\nHost: a\r\n\r\n"));
    expect(result.state === "complete" && result.request.path).toBe("/mcp");
  });

  it.each([
    ["oversized headers", `GET /mcp HTTP/1.1\r\nX: ${"a".repeat(17_000)}\r\n\r\n`, 431],
    [
      "an oversized body",
      `POST /mcp HTTP/1.1\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`,
      413,
    ],
    ["a chunked body", "POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", 411],
    ["a bad Content-Length", "POST /mcp HTTP/1.1\r\nContent-Length: -1\r\n\r\n", 400],
    ["a garbled request line", "HELLO\r\n\r\n", 400],
    ["a header without a colon", "GET /mcp HTTP/1.1\r\nnonsense\r\n\r\n", 400],
  ])("refuses %s", (_, text, status) => {
    const result = new RequestReader().push(bytes(text));
    expect(result.state === "error" && result.response.status).toBe(status);
  });

  it("refuses endless headers before they end", () => {
    const reader = new RequestReader();
    const result = reader.push(bytes(`GET /mcp HTTP/1.1\r\nX: ${"a".repeat(20_000)}`));
    expect(result.state === "error" && result.response.status).toBe(431);
  });
});

describe("writing responses", () => {
  it("sends the body length in bytes and closes the connection", () => {
    const out = decodeUtf8(
      serializeResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"a":"é"}',
      }),
    );
    expect(out.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(out).toContain("content-length: 10\r\n");
    expect(out).toContain("connection: close\r\n");
    expect(out).toContain("cache-control: no-store\r\n");
    expect(out.endsWith('\r\n\r\n{"a":"é"}')).toBe(true);
  });
});

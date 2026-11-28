/**
 * A pairing link names a server and carries a one-time code (docs/sync-protocol.md). It comes as
 * the server's page link, https://<server>/pair#<code>, pasted or opened, or as the link that page
 * hands the app: polso://pair?server=<origin>&code=<code> (polso-preview:// and polso-dev:// for
 * the test builds).
 */
export interface PairingLink {
  /** The server's origin, such as https://polso.example.com. Always https. */
  readonly server: string;
  readonly code: string;
}

const CODE = /^[A-Za-z0-9_-]{43}$/;
const SCHEMES = ["polso:", "polso-preview:", "polso-dev:"];

/** The server's origin when it's a plain https address, without path, query or credentials. */
function httpsOrigin(value: string, allowPath = false): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search) return undefined;
  if (!allowPath && (url.pathname !== "/" || url.hash)) return undefined;
  return url.origin;
}

/** Reads a pairing link, or returns undefined when the text isn't one. */
export function parsePairingLink(text: string): PairingLink | undefined {
  const value = text.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === "https:") {
    const code = url.hash.slice(1);
    const server = httpsOrigin(value, true);
    if (!server || url.pathname !== "/pair" || !CODE.test(code)) return undefined;
    return { server, code };
  }
  if (SCHEMES.includes(url.protocol)) {
    // polso://pair?… parses with "pair" as the host.
    if (url.host !== "pair") return undefined;
    const server = httpsOrigin(url.searchParams.get("server") ?? "");
    const code = url.searchParams.get("code") ?? "";
    if (!server || !CODE.test(code)) return undefined;
    return { server, code };
  }
  return undefined;
}

/** The host to show the person before pairing, such as polso.example.com. */
export const hostOf = (server: string) => new URL(server).host;

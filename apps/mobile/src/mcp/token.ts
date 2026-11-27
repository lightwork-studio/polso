import { MIN_TOKEN_LENGTH } from "./server";

/** 256 bits from the system's secure random source. */
export const TOKEN_BYTES = 32;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding, so the token fits in a header and a URL as it is. */
function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i] as number, bytes[i + 1], bytes[i + 2]];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += ALPHABET[c & 63];
  }
  return out;
}

/**
 * Makes a new access token. `randomBytes` must be a cryptographically secure source, such as
 * expo-crypto's getRandomBytes.
 */
export function newToken(randomBytes: (count: number) => Uint8Array): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) throw new Error("The random source returned too few bytes.");
  return base64url(bytes);
}

/** Whether a stored token can still be used; anything else is replaced with a new one. */
export const isUsableToken = (token: string | null | undefined): token is string =>
  typeof token === "string" && token.length >= MIN_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token);

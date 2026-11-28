import { createHash, randomBytes } from "node:crypto";

/** Pairing codes and device tokens: 32 random bytes, base64url. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The server stores only this. Secrets are 256 random bits, so a plain SHA-256 is enough. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Whether a string has the shape of a secret this server made, before it is looked up. */
export function looksLikeSecret(value: string): boolean {
  return SECRET.test(value);
}

/** How long a pairing code works. */
export const PAIRING_CODE_MS = 15 * 60_000;

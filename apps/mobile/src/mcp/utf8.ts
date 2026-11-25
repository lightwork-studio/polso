// UTF-8 without TextDecoder, which React Native's Hermes engine doesn't guarantee.

export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return Uint8Array.from(bytes);
}

/** Decodes UTF-8, replacing malformed sequences with U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    let need = 0;
    let code = 0;
    let min = 0;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    } else if ((b & 0xe0) === 0xc0) [need, code, min] = [1, b & 0x1f, 0x80];
    else if ((b & 0xf0) === 0xe0) [need, code, min] = [2, b & 0x0f, 0x800];
    else if ((b & 0xf8) === 0xf0) [need, code, min] = [3, b & 0x07, 0x10000];
    else {
      out += "�";
      i++;
      continue;
    }
    let j = 1;
    for (; j <= need; j++) {
      const next = bytes[i + j];
      if (next === undefined || (next & 0xc0) !== 0x80) break;
      code = (code << 6) | (next & 0x3f);
    }
    if (j <= need || code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += "�";
      i += Math.max(1, j);
      continue;
    }
    out += String.fromCodePoint(code);
    i += need + 1;
  }
  return out;
}

/**
 * Text-safety helpers shared by every adapter. Imported text is untrusted: it
 * may contain NUL bytes, terminal control sequences, or be a binary file with a
 * misleading name. These helpers decode conservatively and strip anything that
 * could act on a terminal when the text is later displayed. Control handling is
 * written as an explicit code-point scan so the source contains no raw control
 * bytes and no fragile regex escapes.
 */

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8Encoder = new TextEncoder();

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const ESC = 0x1b;
const BEL = 0x07;

export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

/** True when the bytes look like binary rather than importable text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Control chars outside tab/newline/carriage-return are suspicious.
    if (byte < TAB || (byte > CR && byte < 0x20)) suspicious++;
  }
  return suspicious > sample.length * 0.1;
}

/**
 * Remove anything that could drive a terminal when preserved text is echoed:
 * CSI sequences, OSC/DCS/SOS/PM/APC strings, lone escapes, all C0 controls
 * (keeping tab and newline), C1 controls and DEL. CR / CRLF collapse to LF.
 */
export function stripControlSequences(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5b) {
        // CSI: skip params/intermediates up to and including a final byte.
        index += 1;
        while (index + 1 < text.length) {
          const following = text.charCodeAt(index + 1);
          index += 1;
          if (following >= 0x40 && following <= 0x7e) break;
        }
        continue;
      }
      if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        // OSC / DCS / SOS / PM / APC: skip a string ended by BEL or ESC backslash.
        index += 1;
        while (index + 1 < text.length) {
          const following = text.charCodeAt(index + 1);
          if (following === BEL) { index += 1; break; }
          if (following === ESC && text.charCodeAt(index + 2) === 0x5c) { index += 2; break; }
          index += 1;
        }
        continue;
      }
      // Other single-character escape: drop ESC and its Fe byte.
      if (next >= 0x40 && next <= 0x5f) index += 1;
      continue;
    }
    if (code === CR) {
      if (text.charCodeAt(index + 1) !== LF) out += "\n";
      continue;
    }
    if (code === TAB || code === LF) { out += text[index]; continue; }
    if (code <= 0x1f) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    out += text[index];
  }
  return out;
}

/** Decode UTF-8 text and strip control sequences. */
export function decodeSafeText(bytes: Uint8Array): string {
  return stripControlSequences(utf8Decoder.decode(bytes));
}

/** Clamp preserved text to a bounded character count and line count. */
export function boundText(text: string, maxChars: number, maxLines: number): string {
  const lines = text.split("\n");
  const clampedLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const joined = clampedLines.join("\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

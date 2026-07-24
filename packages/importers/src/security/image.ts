/**
 * Safe raster-asset handling for imported diagrams. We only accept PNG, JPEG
 * and WebP, read their real dimensions from the header (so a mislabeled or
 * malicious file is rejected), and base64-encode without any Node Buffer so the
 * same code runs in the browser worker. Nothing is decoded or executed beyond
 * reading the size fields.
 */
import type { ImportSourceAsset } from "../types";

export interface RasterInfo {
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index]!;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64[b2 & 63];
  }
  return out;
}

const u16 = (bytes: Uint8Array, offset: number): number => (bytes[offset]! << 8) | bytes[offset + 1]!;
const u32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset]! << 24) >>> 0) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
const ascii = (bytes: Uint8Array, start: number, end: number): string => String.fromCharCode(...bytes.slice(start, end));

function png(bytes: Uint8Array): RasterInfo | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b) || ascii(bytes, 12, 16) !== "IHDR") return undefined;
  return { mime: "image/png", width: u32(bytes, 16), height: u32(bytes, 20) };
}

function jpeg(bytes: Uint8Array): RasterInfo | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = u16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && length >= 7) return { mime: "image/jpeg", width: u16(bytes, offset + 5), height: u16(bytes, offset + 3) };
    offset += length;
  }
  return undefined;
}

function webp(bytes: Uint8Array): RasterInfo | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return undefined;
  const kind = ascii(bytes, 12, 16);
  if (kind === "VP8X") {
    return { mime: "image/webp", width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    return { mime: "image/webp", width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8), height: 1 + (bytes[22]! >>> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10) };
  }
  if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { mime: "image/webp", width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff };
  }
  return undefined;
}

/** Read a supported raster's real format and dimensions, or undefined. */
export function inspectRaster(bytes: Uint8Array): RasterInfo | undefined {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

/** Build a validated diagram asset from image bytes, or undefined if unsafe. */
export function rasterAsset(id: string, originalName: string, bytes: Uint8Array, maxDimension = 4_096): ImportSourceAsset | undefined {
  const info = inspectRaster(bytes);
  if (!info) return undefined;
  if (info.width < 1 || info.height < 1 || info.width > maxDimension || info.height > maxDimension) return undefined;
  return { id, mime: info.mime, originalName, dataBase64: toBase64(bytes), width: info.width, height: info.height };
}

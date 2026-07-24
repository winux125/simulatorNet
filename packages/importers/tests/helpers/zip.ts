// Deterministic in-memory ZIP builder for import tests. It writes stored or
// (caller-supplied) deflate entries and can inject hostile metadata — traversal
// names, absolute paths, symlink modes, and mismatched sizes — so the reader's
// security guards can be exercised without shipping any real vendor archive.

export interface FakeZipEntry {
  name: string;
  data?: Uint8Array;
  method?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  unixMode?: number;
}

const encoder = new TextEncoder();
const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function buildZip(entries: readonly FakeZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0;
    const data = entry.data ?? new Uint8Array(0);
    const nameBytes = encoder.encode(entry.name);
    const compressedSize = entry.declaredCompressedSize ?? data.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? data.length;
    const localHeaderOffset = offset;
    const local = Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0), ...u32(0), ...u32(compressedSize), ...u32(uncompressedSize),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...data,
    ]);
    locals.push(local);
    offset += local.length;
    const external = ((entry.unixMode ?? 0) << 16) >>> 0;
    centrals.push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0), ...u32(0), ...u32(compressedSize), ...u32(uncompressedSize),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(external), ...u32(localHeaderOffset),
      ...nameBytes,
    ]));
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(centralStart), ...u16(0),
  ]);
  return concat([...locals, ...centrals, eocd]);
}

/** Raw-deflate some bytes with the platform compressor (for round-trip tests). */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(data);
  void writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

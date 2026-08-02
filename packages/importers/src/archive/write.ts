/**
 * Minimal, deterministic ZIP writer.
 *
 * It exists so SimulatorNet can produce its own `.simlab` package and a
 * configuration bundle without a third-party dependency, using the same
 * platform primitives the reader already uses (Node 24 + browsers). It writes
 * only what the reader accepts: no ZIP64, no encryption, no symlinks, no
 * directory entries with attributes, and a fixed zero timestamp so the same
 * lab always produces the same bytes.
 */
export interface ZipFileInput {
  /** Forward-slash path inside the archive. Validated before writing. */
  readonly name: string;
  readonly data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** MS-DOS "1980-01-01 00:00:00": a package must not carry a wall clock. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++) {
    crc = (CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertWritablePath(name: string): void {
  if (name.length === 0 || name.length > 255) throw new Error(`Invalid archive entry name: ${name}`);
  if (name.startsWith("/") || name.includes("\\") || name.includes("..") || /[\u0000-\u001F]/u.test(name)) {
    throw new Error(`Refusing to write an unsafe archive entry name: ${name}`);
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === "undefined") return undefined;
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(data));
  void writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  // Compression that does not shrink is stored instead: smaller *and* it keeps
  // the archive readable by the strictest reader.
  return output.length < data.length ? output : undefined;
}

/**
 * Build a ZIP archive from in-memory entries. Entries are written in the given
 * order; callers sort them so the output is byte-stable.
 */
export async function writeZipArchive(files: readonly ZipFileInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    assertWritablePath(file.name);
    const nameBytes = encoder.encode(file.name);
    const compressed = await deflateRaw(file.data);
    const method = compressed ? 8 : 0;
    const payload = compressed ?? file.data;
    const crc = crc32(file.data);

    const header = new Uint8Array(30 + nameBytes.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, LOCAL_SIG, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, 0, true);
    headerView.setUint16(8, method, true);
    headerView.setUint16(10, DOS_TIME, true);
    headerView.setUint16(12, DOS_DATE, true);
    headerView.setUint32(14, crc, true);
    headerView.setUint32(18, payload.length, true);
    headerView.setUint32(22, file.data.length, true);
    headerView.setUint16(26, nameBytes.length, true);
    headerView.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    const directory = new Uint8Array(46 + nameBytes.length);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, CEN_SIG, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(8, 0, true);
    directoryView.setUint16(10, method, true);
    directoryView.setUint16(12, DOS_TIME, true);
    directoryView.setUint16(14, DOS_DATE, true);
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, payload.length, true);
    directoryView.setUint32(24, file.data.length, true);
    directoryView.setUint16(28, nameBytes.length, true);
    directoryView.setUint16(30, 0, true);
    directoryView.setUint16(32, 0, true);
    directoryView.setUint16(34, 0, true);
    directoryView.setUint16(36, 0, true);
    // External attributes stay 0: never a symlink, never an executable bit.
    directoryView.setUint32(38, 0, true);
    directoryView.setUint32(42, offset, true);
    directory.set(nameBytes, 46);

    local.push(header, payload);
    central.push(directory);
    offset += header.length + payload.length;
  }

  const centralSize = central.reduce((total, entry) => total + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, EOCD_SIG, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...local, ...central, end]) {
    archive.set(chunk, cursor);
    cursor += chunk.length;
  }
  return archive;
}

/**
 * Minimal, defensive ZIP reader. It reads the authoritative central directory
 * (never trusting local headers alone), enforces every archive limit, and
 * refuses ZIP-slip paths, absolute paths, symlinks, duplicate entries and
 * compression bombs before any byte is decompressed. Stored entries are sliced;
 * deflate entries use the platform DecompressionStream (Node 24 + browsers), so
 * there is no third-party dependency and nothing is written to a filesystem.
 */
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { ImportError, ImportSecurityError } from "../errors/errors";
import { extensionOf } from "../security/binary";

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const BACKSLASH = String.fromCharCode(92);
const NESTED_ARCHIVE_EXTENSIONS = new Set(["zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar"]);

export function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function assertSafePath(name: string): void {
  if (name.includes(String.fromCharCode(0))) {
    throw new ImportSecurityError("archive-path-traversal", "Archive entry name contains a NUL byte", { name });
  }
  const normalized = name.split(BACKSLASH).join("/");
  if (normalized.startsWith("/")) {
    throw new ImportSecurityError("archive-absolute-path", `Archive entry uses an absolute path: ${name}`, { name });
  }
  if (normalized.length >= 2 && normalized[1] === ":") {
    const drive = normalized.charCodeAt(0);
    if ((drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122)) {
      throw new ImportSecurityError("archive-absolute-path", `Archive entry uses a drive path: ${name}`, { name });
    }
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new ImportSecurityError("archive-path-traversal", `Archive entry escapes the archive root: ${name}`, { name });
  }
}

/**
 * Parse and validate the central directory. Throws on any structural or
 * security violation. Returns entry descriptors only; no data is decompressed.
 */
export function readZipCentralDirectory(bytes: Uint8Array, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): ZipEntry[] {
  if (bytes.length < 22 || !isZipArchive(bytes)) {
    throw new ImportError("archive-invalid", "Input is not a ZIP archive");
  }
  const view = viewOf(bytes);
  const minEnd = Math.max(0, bytes.length - (0xffff + 22));
  let eocd = -1;
  for (let index = bytes.length - 22; index >= minEnd; index--) {
    if (view.getUint32(index, true) === EOCD_SIG) { eocd = index; break; }
  }
  if (eocd < 0) throw new ImportError("archive-invalid", "ZIP end-of-central-directory record not found");

  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === ZIP64_SENTINEL || total === 0xffff) {
    throw new ImportError("archive-invalid", "ZIP64 archives are not supported");
  }
  if (total > limits.maxArchiveEntries) {
    throw new ImportSecurityError("archive-too-many-entries", `Archive has ${total} entries (limit ${limits.maxArchiveEntries})`);
  }
  if (cdOffset + cdSize > bytes.length) throw new ImportError("archive-invalid", "ZIP central directory is out of range");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalUncompressed = 0;
  let pointer = cdOffset;
  for (let index = 0; index < total; index++) {
    if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== CEN_SIG) {
      throw new ImportError("archive-invalid", "Malformed ZIP central directory entry");
    }
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const uncompressedSize = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const externalAttributes = view.getUint32(pointer + 38, true);
    const localHeaderOffset = view.getUint32(pointer + 42, true);
    const nameBytes = bytes.subarray(pointer + 46, pointer + 46 + nameLength);
    const name = new TextDecoder("utf-8").decode(nameBytes);
    pointer += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      throw new ImportError("archive-invalid", "ZIP64 entries are not supported");
    }
    assertSafePath(name);
    if (seen.has(name)) {
      throw new ImportSecurityError("archive-duplicate-path", `Duplicate archive entry: ${name}`, { name });
    }
    seen.add(name);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new ImportSecurityError("archive-symlink", `Archive contains a symlink: ${name}`, { name });
    }
    const isDirectory = name.endsWith("/");
    if (!isDirectory) {
      if (method !== 0 && compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
        throw new ImportSecurityError("archive-compression-ratio", `Entry ${name} exceeds the ${limits.maxCompressionRatio}x compression-ratio limit`, {
          name,
          ratio: uncompressedSize / compressedSize,
        });
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > limits.maxUncompressedBytes) {
        throw new ImportSecurityError("archive-uncompressed-too-large", `Archive decompresses to more than ${limits.maxUncompressedBytes} bytes`);
      }
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, isDirectory });
  }
  return entries;
}

/** True when an entry is itself an archive we refuse to recurse into. */
export function isNestedArchiveEntry(entry: ZipEntry): boolean {
  return NESTED_ARCHIVE_EXTENSIONS.has(extensionOf(entry.name));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

async function inflateRaw(compressed: Uint8Array, cap: number): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(compressed);
  void writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new ImportSecurityError("archive-uncompressed-too-large", "A ZIP entry decompressed beyond its allowed size");
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

/**
 * Decompress a single entry's bytes, capping output at `maxBytes` (defaults to
 * the single-file limit). Stored entries slice directly; deflate uses the
 * platform decompressor. Any other method is refused.
 */
export async function readZipEntryData(
  bytes: Uint8Array,
  entry: ZipEntry,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
  maxBytes = limits.maxTopologyFileBytes,
): Promise<Uint8Array> {
  const view = viewOf(bytes);
  if (entry.localHeaderOffset + 30 > bytes.length || view.getUint32(entry.localHeaderOffset, true) !== LOC_SIG) {
    throw new ImportError("archive-invalid", `Malformed local header for ${entry.name}`);
  }
  const nameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) {
    if (compressed.length > maxBytes) {
      throw new ImportSecurityError("archive-entry-too-large", `Entry ${entry.name} exceeds ${maxBytes} bytes`);
    }
    return compressed.slice();
  }
  if (entry.method === 8) {
    return inflateRaw(compressed, Math.min(maxBytes, limits.maxUncompressedBytes));
  }
  throw new ImportError("archive-invalid", `Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

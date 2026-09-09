/**
 * Bounded zlib inflate for the Qt `qCompress` payload Packet Tracer stores:
 * a 4-byte big-endian uncompressed length followed by a zlib stream.
 *
 * The web-standard `DecompressionStream` does the actual inflating, so there is
 * no bundled inflate implementation and nothing platform-specific — it exists
 * in browsers, in the Web Worker and in Node. Output is counted as it arrives
 * and the stream is abandoned the moment it crosses a bound, so a compression
 * bomb is stopped while it expands rather than after it has been buffered.
 */
import type { PacketTracerLimits } from "../config/limits";
import { PacketTracerDecodeError } from "../container/errors";

/** The declared length prefix is advisory: it is checked, never trusted. */
export const QCOMPRESS_PREFIX_BYTES = 4;

export interface InflateResult {
  readonly bytes: Uint8Array;
  /** The length the container claimed, when it disagreed with reality. */
  readonly declaredLength?: number;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000)
    + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

/**
 * Inflate a raw zlib stream under `limits`. `compressedLength` is used only for
 * the ratio check, so the caller can pass the size of the enclosing container.
 */
export async function inflateBounded(
  stream: Uint8Array,
  limits: PacketTracerLimits,
  compressedLength = stream.length,
): Promise<Uint8Array> {
  const maxBytes = Math.min(
    limits.maxDecompressedBytes,
    Math.max(compressedLength, 1) * limits.maxCompressionRatio,
  );

  let decompressor: DecompressionStream;
  try {
    decompressor = new DecompressionStream("deflate");
  } catch (cause) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_CORRUPT",
      "This runtime does not provide DecompressionStream, so the container cannot be inflated",
      { cause: String(cause) },
    );
  }

  const writer = decompressor.writable.getWriter();
  // Copy into a fresh ArrayBuffer so the chunk is a strict BufferSource across
  // both the Node and DOM lib type definitions, as in `importers/archive/zip`.
  // Deliberately not awaited: the reader below has to drain concurrently or a
  // payload larger than the stream's internal buffer would deadlock.
  const written = writer.write(new Uint8Array(stream)).then(() => writer.close()).catch(() => undefined);

  const reader = decompressor.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PacketTracerDecodeError(
          "PACKET_TRACER_DECOMPRESSION_LIMIT",
          `The container expands beyond the ${maxBytes}-byte decode limit`,
          { limit: maxBytes, compressedLength },
        );
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof PacketTracerDecodeError) throw cause;
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_CORRUPT",
      "The container's compressed payload is not a readable zlib stream",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  } finally {
    await written;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/**
 * Inflate a `qCompress` payload: strip the big-endian length prefix, inflate
 * the zlib stream, and report a length that disagrees with what came out.
 */
export async function inflateQCompress(
  payload: Uint8Array,
  limits: PacketTracerLimits,
): Promise<InflateResult> {
  if (payload.length < QCOMPRESS_PREFIX_BYTES) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_CORRUPT",
      "The decrypted payload is too short to contain a length prefix",
      { length: payload.length },
    );
  }
  const declared = readUint32BE(payload, 0);
  if (declared > limits.maxDecompressedBytes) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_DECOMPRESSION_LIMIT",
      `The container declares a ${declared}-byte payload, beyond the ${limits.maxDecompressedBytes}-byte decode limit`,
      { declared, limit: limits.maxDecompressedBytes },
    );
  }
  const bytes = await inflateBounded(
    payload.subarray(QCOMPRESS_PREFIX_BYTES),
    limits,
    payload.length,
  );
  return { bytes, declaredLength: declared === bytes.length ? undefined : declared };
}

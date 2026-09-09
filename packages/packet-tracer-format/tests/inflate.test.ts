import { describe, expect, it } from "vitest";
import { inflateQCompress } from "../src/compression/inflate";
import { DEFAULT_PACKET_TRACER_LIMITS } from "../src/config/limits";
import { PacketTracerDecodeError } from "../src/container/errors";

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const compressor = new CompressionStream("deflate");
  const writer = compressor.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = compressor.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await written;
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function qCompress(compressed: Uint8Array, declaredLength: number): Uint8Array {
  const output = new Uint8Array(compressed.length + 4);
  new DataView(output.buffer).setUint32(0, declaredLength, false);
  output.set(compressed, 4);
  return output;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause);
  return error instanceof PacketTracerDecodeError ? error.code : undefined;
}

describe("inflateQCompress", () => {
  it("round-trips a qCompress payload", async () => {
    const plain = new TextEncoder().encode("<PACKETTRACER5/>".repeat(64));
    const result = await inflateQCompress(qCompress(await deflate(plain), plain.length), DEFAULT_PACKET_TRACER_LIMITS);
    expect(result.bytes).toEqual(plain);
    // No disagreement means no declaredLength is reported back.
    expect(result.declaredLength).toBeUndefined();
  });

  it("reports a length prefix that disagrees with what came out", async () => {
    const plain = new TextEncoder().encode("hello packet tracer");
    const result = await inflateQCompress(qCompress(await deflate(plain), plain.length + 99), DEFAULT_PACKET_TRACER_LIMITS);
    expect(result.bytes).toEqual(plain);
    expect(result.declaredLength).toBe(plain.length + 99);
  });

  it("rejects a payload too short to hold a length prefix", async () => {
    expect(await codeOf(inflateQCompress(new Uint8Array(2), DEFAULT_PACKET_TRACER_LIMITS))).toBe("PACKET_TRACER_CORRUPT");
  });

  it("rejects a declared length beyond the limit without inflating", async () => {
    const payload = new Uint8Array(64);
    new DataView(payload.buffer).setUint32(0, 0x7fffffff, false);
    expect(await codeOf(inflateQCompress(payload, DEFAULT_PACKET_TRACER_LIMITS)))
      .toBe("PACKET_TRACER_DECOMPRESSION_LIMIT");
  });

  it("rejects a stream that is not zlib", async () => {
    const payload = new Uint8Array(64).fill(0x5a);
    new DataView(payload.buffer).setUint32(0, 16, false);
    expect(await codeOf(inflateQCompress(payload, DEFAULT_PACKET_TRACER_LIMITS))).toBe("PACKET_TRACER_CORRUPT");
  });
});

/**
 * Test-only Packet Tracer container writer.
 *
 * Production never writes a `.pkt` — the importer is deliberately one-way — so
 * this lives with the tests. It exists to build *synthetic-format* fixtures:
 * containers with the exact layer geometry Packet Tracer uses, carrying XML we
 * author. They prove the crypto, the framing, the compression and the bounds.
 * They do not prove compatibility with Cisco's own XML, which is what the real
 * fixtures in `real-fixtures.ts` are for.
 */
import { eaxEncrypt } from "../../src/crypto/eax";

const CONTAINER_KEY = new Uint8Array(16).fill(0x89);
const CONTAINER_NONCE = new Uint8Array(16).fill(0x10);

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
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Prepend the Qt `qCompress` big-endian uncompressed-length header. */
function withLengthPrefix(compressed: Uint8Array, uncompressedLength: number): Uint8Array {
  const output = new Uint8Array(compressed.length + 4);
  output[0] = (uncompressedLength >>> 24) & 0xff;
  output[1] = (uncompressedLength >>> 16) & 0xff;
  output[2] = (uncompressedLength >>> 8) & 0xff;
  output[3] = uncompressedLength & 0xff;
  output.set(compressed, 4);
  return output;
}

function maskPositional(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index++) {
    output[index] = input[index]! ^ ((input.length - index) & 0xff);
  }
  return output;
}

function maskAndReverse(input: Uint8Array): Uint8Array {
  const length = input.length;
  const lengthMod = length % 256;
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const factor = (((1 - index) % 256) + 256) % 256;
    output[length - 1 - index] = input[index]! ^ ((lengthMod * factor) % 256);
  }
  return output;
}

/** Build a modern (7.x+) container carrying `xml`. */
export async function encodeModernContainer(xml: string): Promise<Uint8Array> {
  const plain = new TextEncoder().encode(xml);
  const payload = withLengthPrefix(await deflate(plain), plain.length);
  const sealed = eaxEncrypt(CONTAINER_KEY, CONTAINER_NONCE, maskPositional(payload));
  return maskAndReverse(sealed);
}

/** Build a pre-7.x container: one length-keyed XOR over the `qCompress` blob. */
export async function encodeLegacyContainer(xml: string): Promise<Uint8Array> {
  const plain = new TextEncoder().encode(xml);
  const payload = withLengthPrefix(await deflate(plain), plain.length);
  return maskPositional(payload);
}

/**
 * Seal arbitrary bytes with a *valid* tag. Lets a test exercise the layers
 * past authentication — a broken zlib stream, a lying length prefix — which
 * corrupting a finished container cannot do, because the tag fails first.
 */
export function sealRawPayload(payload: Uint8Array): Uint8Array {
  return maskAndReverse(eaxEncrypt(CONTAINER_KEY, CONTAINER_NONCE, maskPositional(payload)));
}

export interface SyntheticNetworkOptions {
  readonly version?: string;
  readonly body?: string;
}

/** Minimal but structurally faithful `<PACKETTRACER5>` document. */
export function syntheticNetworkXml(options: SyntheticNetworkOptions = {}): string {
  const { version = "8.2.0.0400", body = "" } = options;
  return `<PACKETTRACER5>\n <VERSION>${version}</VERSION>\n <NETWORK>\n  <DEVICES/>\n  <LINKS/>\n </NETWORK>\n${body}</PACKETTRACER5>\n`;
}

/** Minimal but structurally faithful `<PACKETTRACER5_ACTIVITY>` document. */
export function syntheticActivityXml(options: SyntheticNetworkOptions = {}): string {
  const { version = "8.2.0.0400", body = "" } = options;
  return `<PACKETTRACER5_ACTIVITY>\n <VERSION>${version}</VERSION>\n${body}</PACKETTRACER5_ACTIVITY>\n`;
}

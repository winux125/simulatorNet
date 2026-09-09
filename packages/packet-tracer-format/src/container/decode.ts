/**
 * Packet Tracer container decoding.
 *
 * The container is obfuscation, not protection: the key and nonce are fixed
 * constants compiled into Packet Tracer itself, which is why reading the format
 * needs no secret and grants no access to anything. The layers, in the order
 * the writer applied them, are:
 *
 *   1. zlib compress, with a 4-byte big-endian length prefix (Qt `qCompress`)
 *   2. positional XOR:            b[i] ^= (len - i) & 0xff
 *   3. Twofish-EAX seal:          key 0x89 x16, nonce 0x10 x16, no header
 *   4. positional XOR + reverse:  out[len-1-i] = in[i] ^ ((len - i*len) & 0xff)
 *
 * Decoding walks them backwards. Containers written by Packet Tracer 5.x and
 * earlier skip layers 2-4 entirely in favour of a single length-keyed XOR; that
 * legacy shape is tried only after the modern one fails to authenticate, so a
 * modern file is never misread as a legacy one.
 *
 * Layer geometry and constants were established from the MIT-licensed
 * references in THIRD_PARTY_NOTICES.md; the implementation here is our own.
 */
import { inflateQCompress } from "../compression/inflate";
import { DEFAULT_PACKET_TRACER_LIMITS, type PacketTracerLimits } from "../config/limits";
import { eaxDecrypt } from "../crypto/eax";
import {
  PacketTracerDecodeError,
  type PacketTracerDecodeWarning,
} from "./errors";
import { assertSafeXml, type XmlShape } from "../xml/safety";
import { readContainerFormat, readPacketTracerVersion } from "./detect";

/** Fixed obfuscation key. Not a secret, and never used to protect anything. */
const CONTAINER_KEY = new Uint8Array(16).fill(0x89);
const CONTAINER_NONCE = new Uint8Array(16).fill(0x10);

/** Smallest input that could carry a tag plus a length prefix. */
const MIN_CONTAINER_BYTES = 32;

export type PacketTracerContainerFormat = "pkt" | "pka";
export type PacketTracerContainerVariant = "modern" | "legacy";

export interface DecodedPacketTracerFile {
  readonly format: PacketTracerContainerFormat;
  readonly variant: PacketTracerContainerVariant;
  /** The `<VERSION>` the document declares, when it declares one. */
  readonly packetTracerVersion?: string;
  readonly xml: string;
  /** Element count and nesting depth observed by the safety scan. */
  readonly shape: XmlShape;
  readonly warnings: readonly PacketTracerDecodeWarning[];
}

export type PacketTracerDecodeStage =
  | "reading"
  | "detecting"
  | "decoding"
  | "decompressing"
  | "parsing";

export interface PacketTracerDecodeOptions {
  readonly limits?: PacketTracerLimits;
  /** Advisory only: the container's own bytes decide the format. */
  readonly filename?: string;
  readonly signal?: AbortSignal;
  /**
   * Stage callback. There is deliberately no percentage: the decrypt and
   * inflate costs are not knowable in advance, so the UI shows the stage and an
   * indeterminate indicator rather than an invented number.
   */
  readonly onStage?: (stage: PacketTracerDecodeStage) => void;
}

export type PacketTracerInput = ArrayBuffer | Uint8Array;

const asBytes = (input: PacketTracerInput): Uint8Array =>
  input instanceof Uint8Array ? input : new Uint8Array(input);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PacketTracerDecodeError("PACKET_TRACER_CANCELLED", "The decode was cancelled");
  }
}

/**
 * Undo layer 4: reverse the byte order and remove the positional mask. The mask
 * is `(len - i*len) mod 256`, computed modularly so a large container never
 * relies on `i*len` staying inside an exact float.
 */
function unmaskAndReverse(input: Uint8Array): Uint8Array {
  const length = input.length;
  const lengthMod = length % 256;
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const factor = (((1 - index) % 256) + 256) % 256;
    output[index] = input[length - 1 - index]! ^ ((lengthMod * factor) % 256);
  }
  return output;
}

/** Undo layer 2. Self-inverse: the same walk applies it and removes it. */
function unmaskPositional(input: Uint8Array): Uint8Array {
  const length = input.length;
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    output[index] = input[index]! ^ ((length - index) & 0xff);
  }
  return output;
}

/** The pre-7.x scheme: one XOR keyed on the file length, then `qCompress`. */
function unmaskLegacy(input: Uint8Array): Uint8Array {
  const length = input.length;
  const output = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    output[index] = input[index]! ^ ((length - index) & 0xff);
  }
  return output;
}

/** A zlib stream starts with a CMF/FLG pair whose 16-bit value divides by 31. */
function looksLikeZlib(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 2) return false;
  const cmf = bytes[offset]!;
  const flg = bytes[offset + 1]!;
  return (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
}

/**
 * Decode a `.pkt`/`.pka` container into its XML document. Rejects rather than
 * guesses: a container that fails authentication and is not a readable legacy
 * file raises a typed error naming which it was.
 */
export async function decodePacketTracer(
  input: PacketTracerInput,
  options: PacketTracerDecodeOptions = {},
): Promise<DecodedPacketTracerFile> {
  const limits = options.limits ?? DEFAULT_PACKET_TRACER_LIMITS;
  const { signal, onStage } = options;

  onStage?.("reading");
  throwIfAborted(signal);
  const bytes = asBytes(input);
  if (bytes.length > limits.maxInputBytes) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_INPUT_TOO_LARGE",
      `The file is ${bytes.length} bytes, beyond the ${limits.maxInputBytes}-byte import limit`,
      { length: bytes.length, limit: limits.maxInputBytes },
    );
  }
  if (bytes.length < MIN_CONTAINER_BYTES) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_NOT_A_CONTAINER",
      "The file is too small to be a Packet Tracer container",
      { length: bytes.length },
    );
  }

  onStage?.("detecting");
  throwIfAborted(signal);
  const warnings: PacketTracerDecodeWarning[] = [];

  // Modern first. A legacy file cannot forge a valid EAX tag, so trying the
  // modern shape first can never misclassify one.
  let variant: PacketTracerContainerVariant = "modern";
  let payload = eaxDecrypt(CONTAINER_KEY, CONTAINER_NONCE, unmaskAndReverse(bytes));
  if (payload) {
    onStage?.("decoding");
    payload = unmaskPositional(payload);
  } else {
    const legacy = unmaskLegacy(bytes);
    if (!looksLikeZlib(legacy, 4)) {
      throw new PacketTracerDecodeError(
        "PACKET_TRACER_AUTHENTICATION_FAILED",
        "This file did not decode as a Packet Tracer container. It may be corrupt, "
        + "partially downloaded, or written by a Packet Tracer version this importer does not support.",
        { length: bytes.length },
      );
    }
    onStage?.("decoding");
    variant = "legacy";
    payload = legacy;
    warnings.push({
      code: "legacy-container",
      message: "Read as a pre-7.x Packet Tracer container. Newer features are absent from this format.",
    });
  }
  throwIfAborted(signal);

  onStage?.("decompressing");
  const inflated = await inflateQCompress(payload, limits);
  if (inflated.declaredLength !== undefined) {
    warnings.push({
      code: "trailing-bytes",
      message: `The container declared ${inflated.declaredLength} bytes but expanded to ${inflated.bytes.length}.`,
    });
  }
  throwIfAborted(signal);

  onStage?.("parsing");
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(inflated.bytes);
  const shape = assertSafeXml(xml, limits);
  const format = readContainerFormat(xml, options.filename);
  if (!format) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_UNSUPPORTED_VERSION",
      "The container decoded, but its document root is not a Packet Tracer network or activity",
      { head: xml.slice(0, 120) },
    );
  }
  const packetTracerVersion = readPacketTracerVersion(xml);
  if (!packetTracerVersion) {
    warnings.push({ code: "unknown-version", message: "The document declares no Packet Tracer version." });
  }

  return { format, variant, packetTracerVersion, xml, shape, warnings };
}

/**
 * Typed decode failures. A Packet Tracer container is untrusted input, so every
 * rejection names *why* it was rejected: the import wizard offers the companion
 * Migration Assistant only for the reasons a different file could actually fix,
 * and never reports a bound or an unsupported version as a generic failure.
 */
export type PacketTracerDecodeErrorCode =
  /** The bytes are not a Packet Tracer container at all. */
  | "PACKET_TRACER_NOT_A_CONTAINER"
  /** A recognised container whose version this decoder cannot read. */
  | "PACKET_TRACER_UNSUPPORTED_VERSION"
  /** EAX tag mismatch: truncated, edited, or not actually a PT container. */
  | "PACKET_TRACER_AUTHENTICATION_FAILED"
  /** Structurally broken past the cipher: bad length prefix or zlib stream. */
  | "PACKET_TRACER_CORRUPT"
  /** Input exceeded the accepted byte bound before any work was done. */
  | "PACKET_TRACER_INPUT_TOO_LARGE"
  /** Decompression exceeded the output bound or the compression-ratio bound. */
  | "PACKET_TRACER_DECOMPRESSION_LIMIT"
  /** The recovered XML exceeded a depth, node, or string bound. */
  | "PACKET_TRACER_XML_LIMIT"
  /** The recovered XML declared a DTD or an entity we refuse to process. */
  | "PACKET_TRACER_UNSAFE_XML"
  /** The caller aborted the decode. */
  | "PACKET_TRACER_CANCELLED";

/**
 * A decode failure carrying a stable machine code. `recoverable` marks the
 * cases where retrying with a *different* file is pointless but reconstructing
 * from companion files still is.
 */
export class PacketTracerDecodeError extends Error {
  readonly code: PacketTracerDecodeErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: PacketTracerDecodeErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "PacketTracerDecodeError";
    this.code = code;
    this.detail = detail;
  }

  /** True when the Migration Assistant is a sensible next step for the user. */
  get suggestsCompanionFallback(): boolean {
    return this.code === "PACKET_TRACER_UNSUPPORTED_VERSION"
      || this.code === "PACKET_TRACER_AUTHENTICATION_FAILED"
      || this.code === "PACKET_TRACER_CORRUPT"
      || this.code === "PACKET_TRACER_NOT_A_CONTAINER";
  }
}

export type PacketTracerDecodeWarningCode =
  | "legacy-container"
  | "unknown-version"
  | "trailing-bytes"
  | "xml-truncated";

export interface PacketTracerDecodeWarning {
  readonly code: PacketTracerDecodeWarningCode;
  readonly message: string;
}

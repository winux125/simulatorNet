/**
 * Central bounds for decoding an untrusted Packet Tracer container. These sit
 * beside `DEFAULT_IMPORT_LIMITS` rather than inside it: a `.pkt` is decrypted
 * and inflated before anything resembling a topology exists, so it needs its
 * own pre-parse ceilings. The importer still applies the shared import limits
 * afterwards — these never replace them.
 */
export interface PacketTracerLimits {
  /** Largest container accepted at the door, before any decode work. */
  readonly maxInputBytes: number;
  /** Total bytes the zlib stream may inflate to. */
  readonly maxDecompressedBytes: number;
  /** Reject when inflated/compressed exceeds this, even if under the byte cap. */
  readonly maxCompressionRatio: number;
  /** Deepest element nesting tolerated in the recovered XML. */
  readonly maxXmlDepth: number;
  /** Total elements tolerated in the recovered XML. */
  readonly maxXmlNodes: number;
  /** Longest single text/attribute value kept; longer values are truncated. */
  readonly maxXmlStringLength: number;
  /** Devices read from one network before the rest are reported and dropped. */
  readonly maxDevices: number;
  /** Links read from one network before the rest are reported and dropped. */
  readonly maxLinks: number;
  /** Networks/snapshots read from one activity. */
  readonly maxSnapshots: number;
}

export const DEFAULT_PACKET_TRACER_LIMITS: PacketTracerLimits = {
  maxInputBytes: 64 * 1_024 * 1_024,
  maxDecompressedBytes: 256 * 1_024 * 1_024,
  maxCompressionRatio: 200,
  maxXmlDepth: 100,
  maxXmlNodes: 400_000,
  maxXmlStringLength: 256 * 1_024,
  maxDevices: 500,
  maxLinks: 2_000,
  maxSnapshots: 16,
};

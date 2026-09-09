/**
 * Format identification. The container itself is high-entropy ciphertext, so
 * nothing useful can be read from its bytes before decoding — the real answer
 * comes from the decoded document's root element. The extension is only ever a
 * tie-breaker, never the decision.
 */
import type { PacketTracerContainerFormat } from "./decode";

/** Root element of a saved network (`.pkt`). */
export const NETWORK_ROOT = "PACKETTRACER5";
/** Root element of a saved activity (`.pka`), which wraps several networks. */
export const ACTIVITY_ROOT = "PACKETTRACER5_ACTIVITY";

const ROOT_PATTERN = /<\s*(PACKETTRACER5_ACTIVITY|PACKETTRACER5)(?=[\s/>])/u;
const VERSION_PATTERN = /<\s*VERSION\s*>([^<]{1,64})<\s*\/\s*VERSION\s*>/u;

/**
 * A cheap pre-check for the import wizard: could these bytes plausibly be a
 * Packet Tracer container at all? Deliberately permissive — it exists to keep
 * an obviously wrong file (a ZIP, a text topology) out of the decoder, not to
 * decide the format.
 */
export function looksLikePacketTracerContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 32) return false;
  // A ZIP, gzip or plain-text document is some other importer's job.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return false;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return false;
  const head = bytes.subarray(0, 4);
  return !(head[0] === 0x3c || head[0] === 0x7b); // '<' or '{'
}

/**
 * Resolve the container format from the decoded document. `filename` breaks a
 * tie only when the root element is the generic network root — an activity
 * always identifies itself.
 */
export function readContainerFormat(
  xml: string,
  filename?: string,
): PacketTracerContainerFormat | undefined {
  const root = ROOT_PATTERN.exec(xml.slice(0, 4_096))?.[1];
  if (root === ACTIVITY_ROOT) return "pka";
  if (root === NETWORK_ROOT) {
    // A `.pka` whose activity wrapper is absent still behaves like a network.
    return filename?.toLowerCase().endsWith(".pka") === true ? "pka" : "pkt";
  }
  return undefined;
}

/** Read the declared `<VERSION>`, e.g. "9.0.0.0810". */
export function readPacketTracerVersion(xml: string): string | undefined {
  const value = VERSION_PATTERN.exec(xml.slice(0, 4_096))?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** The Packet Tracer major release a declared version belongs to, if readable. */
export function packetTracerMajorVersion(version: string | undefined): number | undefined {
  const major = version?.match(/^\s*(\d{1,2})\./u)?.[1];
  return major !== undefined ? Number.parseInt(major, 10) : undefined;
}

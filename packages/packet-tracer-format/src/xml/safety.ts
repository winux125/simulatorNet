/**
 * Safety scan for the XML a container decodes to.
 *
 * This is deliberately *not* a second XML parser. `@sim/importers` already owns
 * one hardened tree parser that refuses DTDs and entity declarations and bounds
 * depth and node count, and the Packet Tracer adapter reuses it — a decoder
 * that shipped its own would be a second implementation to keep in step.
 * (`@sim/packet-tracer-format` cannot import `@sim/importers` in any case: the
 * dependency runs the other way.)
 *
 * What this does own is the pre-filter: a single bounded pass that refuses a
 * hostile document *before* it is handed on to be parsed, and reports the shape
 * counts the wizard shows. It never resolves an entity, never fetches anything
 * and never evaluates content.
 */
import type { PacketTracerLimits } from "../config/limits";
import { PacketTracerDecodeError } from "../container/errors";

export interface XmlShape {
  readonly elementCount: number;
  readonly maxDepth: number;
}

/**
 * Refuse a document that declares a DTD or an entity, or that exceeds a
 * structural bound. Returns the observed shape so the caller need not rescan.
 */
export function assertSafeXml(xml: string, limits: PacketTracerLimits): XmlShape {
  // The decoded text is already bounded by the decompression limit; this guards
  // the parser that runs next, whose cost is per character.
  if (xml.length > limits.maxDecompressedBytes) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_XML_LIMIT",
      `The decoded document is ${xml.length} characters, beyond the ${limits.maxDecompressedBytes}-character limit`,
      { length: xml.length },
    );
  }

  const lowered = xml.toLowerCase();
  if (lowered.includes("<!doctype")) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_UNSAFE_XML",
      "The decoded document declares a DTD, which is never processed",
    );
  }
  if (lowered.includes("<!entity")) {
    throw new PacketTracerDecodeError(
      "PACKET_TRACER_UNSAFE_XML",
      "The decoded document declares XML entities, which are never expanded",
    );
  }

  let elementCount = 0;
  let depth = 0;
  let maxDepth = 0;
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open < 0) break;
    // Comments, CDATA and processing instructions carry no structure here.
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", open) || xml.startsWith("<!", open)) {
      const end = xml.indexOf(">", open);
      index = end < 0 ? xml.length : end + 1;
      continue;
    }

    const close = xml.indexOf(">", open);
    if (close < 0) break;
    const isClosing = xml[open + 1] === "/";
    const isSelfClosing = xml[close - 1] === "/";

    if (isClosing) {
      depth = Math.max(0, depth - 1);
    } else {
      elementCount++;
      if (elementCount > limits.maxXmlNodes) {
        throw new PacketTracerDecodeError(
          "PACKET_TRACER_XML_LIMIT",
          `The decoded document holds more than ${limits.maxXmlNodes} elements`,
          { limit: limits.maxXmlNodes },
        );
      }
      if (!isSelfClosing) {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
        if (depth > limits.maxXmlDepth) {
          throw new PacketTracerDecodeError(
            "PACKET_TRACER_XML_LIMIT",
            `The decoded document nests deeper than ${limits.maxXmlDepth} elements`,
            { limit: limits.maxXmlDepth },
          );
        }
      }
    }
    index = close + 1;
  }

  return { elementCount, maxDepth };
}

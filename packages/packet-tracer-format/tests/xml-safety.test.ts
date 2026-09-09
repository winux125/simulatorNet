import { describe, expect, it } from "vitest";
import { assertSafeXml } from "../src/xml/safety";
import { DEFAULT_PACKET_TRACER_LIMITS } from "../src/config/limits";
import { PacketTracerDecodeError } from "../src/container/errors";
import { decodePacketTracer } from "../src/container/decode";
import { encodeModernContainer } from "./helpers/encode";

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (cause) {
    return cause instanceof PacketTracerDecodeError ? cause.code : undefined;
  }
};

describe("assertSafeXml", () => {
  it("measures element count and depth", () => {
    const shape = assertSafeXml("<a><b><c/></b><b/></a>", DEFAULT_PACKET_TRACER_LIMITS);
    expect(shape.elementCount).toBe(4);
    expect(shape.maxDepth).toBe(2);
  });

  it("refuses a DTD declaration", () => {
    expect(codeOf(() => assertSafeXml('<!DOCTYPE x SYSTEM "http://example.invalid/x.dtd"><x/>', DEFAULT_PACKET_TRACER_LIMITS)))
      .toBe("PACKET_TRACER_UNSAFE_XML");
  });

  it("refuses an entity declaration", () => {
    const bomb = '<!DOCTYPE lolz [<!ENTITY lol "lol">]><lolz>&lol;</lolz>';
    expect(codeOf(() => assertSafeXml(bomb, DEFAULT_PACKET_TRACER_LIMITS))).toBe("PACKET_TRACER_UNSAFE_XML");
  });

  it("refuses a document nested beyond the depth limit", () => {
    const limits = { ...DEFAULT_PACKET_TRACER_LIMITS, maxXmlDepth: 8 };
    const deep = `${"<n>".repeat(40)}x${"</n>".repeat(40)}`;
    expect(codeOf(() => assertSafeXml(deep, limits))).toBe("PACKET_TRACER_XML_LIMIT");
  });

  it("refuses a document with more elements than the node limit", () => {
    const limits = { ...DEFAULT_PACKET_TRACER_LIMITS, maxXmlNodes: 100 };
    expect(codeOf(() => assertSafeXml(`<r>${"<n/>".repeat(500)}</r>`, limits))).toBe("PACKET_TRACER_XML_LIMIT");
  });

  it("does not count comments, CDATA or processing instructions as elements", () => {
    const shape = assertSafeXml('<?xml version="1.0"?><r><!-- <fake/> --><![CDATA[<alsofake/>]]></r>', DEFAULT_PACKET_TRACER_LIMITS);
    expect(shape.elementCount).toBe(1);
  });
});

describe("container decoding applies the XML safety scan", () => {
  it("refuses a container carrying an entity-expansion bomb", async () => {
    const bomb = '<!DOCTYPE lolz [<!ENTITY lol "lol">]><PACKETTRACER5>&lol;</PACKETTRACER5>';
    const bytes = await encodeModernContainer(bomb);
    const error = await decodePacketTracer(bytes).then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(PacketTracerDecodeError);
    expect((error as PacketTracerDecodeError).code).toBe("PACKET_TRACER_UNSAFE_XML");
  });

  it("reports the decoded document's shape", async () => {
    const decoded = await decodePacketTracer(await encodeModernContainer("<PACKETTRACER5><VERSION>8.2</VERSION><NETWORK><DEVICES/></NETWORK></PACKETTRACER5>"));
    expect(decoded.shape.elementCount).toBe(4);
    expect(decoded.shape.maxDepth).toBe(2);
  });
});

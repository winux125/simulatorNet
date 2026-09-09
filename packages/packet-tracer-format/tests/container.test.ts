/**
 * Container decoding against synthetic-format fixtures: containers built with
 * Packet Tracer's exact layer geometry but carrying XML we author.
 *
 * On test vectors — Twofish itself is pinned by the published ECB vectors in
 * `twofish.test.ts`. EAX over Twofish has no published vector (the EAX paper
 * uses AES), so the authenticated construction is pinned three ways instead:
 * round-trip, tamper rejection, and — the strongest of the three — a container
 * genuinely written by Cisco Packet Tracer authenticating against it in
 * `real-container.test.ts`. That file is an authentic third-party vector for
 * the whole stack.
 */
import { describe, expect, it } from "vitest";
import { decodePacketTracer, type PacketTracerDecodeStage } from "../src/container/decode";
import { DEFAULT_PACKET_TRACER_LIMITS } from "../src/config/limits";
import { PacketTracerDecodeError } from "../src/container/errors";
import { looksLikePacketTracerContainer, packetTracerMajorVersion } from "../src/container/detect";
import {
  encodeLegacyContainer,
  encodeModernContainer,
  sealRawPayload,
  syntheticActivityXml,
  syntheticNetworkXml,
} from "./helpers/encode";

async function expectDecodeError(
  promise: Promise<unknown>,
  code: PacketTracerDecodeError["code"],
): Promise<PacketTracerDecodeError> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause);
  expect(error, `expected a ${code} failure`).toBeInstanceOf(PacketTracerDecodeError);
  expect((error as PacketTracerDecodeError).code).toBe(code);
  return error as PacketTracerDecodeError;
}

describe("decodePacketTracer", () => {
  it("decodes a modern network container", async () => {
    const xml = syntheticNetworkXml({ version: "8.2.0.0400" });
    const decoded = await decodePacketTracer(await encodeModernContainer(xml));
    expect(decoded.format).toBe("pkt");
    expect(decoded.variant).toBe("modern");
    expect(decoded.packetTracerVersion).toBe("8.2.0.0400");
    expect(decoded.xml).toBe(xml);
    expect(decoded.warnings).toEqual([]);
  });

  it("decodes a modern activity container as pka", async () => {
    const decoded = await decodePacketTracer(await encodeModernContainer(syntheticActivityXml()));
    expect(decoded.format).toBe("pka");
    expect(decoded.xml).toContain("PACKETTRACER5_ACTIVITY");
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", async () => {
    const bytes = await encodeModernContainer(syntheticNetworkXml());
    const copy = bytes.slice();
    const decoded = await decodePacketTracer(copy.buffer as ArrayBuffer);
    expect(decoded.format).toBe("pkt");
  });

  it("reads a network document as pka when the filename says so", async () => {
    const decoded = await decodePacketTracer(await encodeModernContainer(syntheticNetworkXml()), {
      filename: "activity.pka",
    });
    expect(decoded.format).toBe("pka");
  });

  it("falls back to the legacy container and says it did", async () => {
    const decoded = await decodePacketTracer(await encodeLegacyContainer(syntheticNetworkXml({ version: "5.3.1.0045" })));
    expect(decoded.variant).toBe("legacy");
    expect(decoded.packetTracerVersion).toBe("5.3.1.0045");
    expect(decoded.warnings.map((warning) => warning.code)).toContain("legacy-container");
  });

  it("reports stages in pipeline order", async () => {
    const stages: PacketTracerDecodeStage[] = [];
    await decodePacketTracer(await encodeModernContainer(syntheticNetworkXml()), {
      onStage: (stage) => stages.push(stage),
    });
    expect(stages).toEqual(["reading", "detecting", "decoding", "decompressing", "parsing"]);
  });

  it("rejects a container whose tag does not authenticate", async () => {
    const bytes = await encodeModernContainer(syntheticNetworkXml());
    bytes[10] = bytes[10]! ^ 0xff;
    const error = await expectDecodeError(decodePacketTracer(bytes), "PACKET_TRACER_AUTHENTICATION_FAILED");
    expect(error.suggestsCompanionFallback).toBe(true);
  });

  it("rejects a truncated container", async () => {
    const bytes = await encodeModernContainer(syntheticNetworkXml());
    await expectDecodeError(decodePacketTracer(bytes.subarray(0, bytes.length - 8)), "PACKET_TRACER_AUTHENTICATION_FAILED");
  });

  it("rejects a file too small to be a container", async () => {
    await expectDecodeError(decodePacketTracer(new Uint8Array(8)), "PACKET_TRACER_NOT_A_CONTAINER");
  });

  it("rejects an input beyond the byte limit before decoding", async () => {
    const limits = { ...DEFAULT_PACKET_TRACER_LIMITS, maxInputBytes: 64 };
    await expectDecodeError(decodePacketTracer(new Uint8Array(256), { limits }), "PACKET_TRACER_INPUT_TOO_LARGE");
  });

  it("rejects an authenticated payload that is not a zlib stream", async () => {
    const payload = new Uint8Array(64);
    payload.set([0, 0, 0, 32], 0);
    payload.fill(0xab, 4);
    await expectDecodeError(decodePacketTracer(sealRawPayload(payload)), "PACKET_TRACER_CORRUPT");
  });

  it("rejects a declared length beyond the decompression limit", async () => {
    const payload = new Uint8Array(64);
    payload.set([0x7f, 0xff, 0xff, 0xff], 0);
    await expectDecodeError(sealAndDecode(payload), "PACKET_TRACER_DECOMPRESSION_LIMIT");
  });

  it("stops a decompression bomb while it expands", async () => {
    // ~4 MB of one repeated character compresses to a few kilobytes.
    const bomb = syntheticNetworkXml({ body: `<!--${"A".repeat(4_000_000)}-->\n` });
    const bytes = await encodeModernContainer(bomb);
    const limits = { ...DEFAULT_PACKET_TRACER_LIMITS, maxDecompressedBytes: 512 * 1_024 };
    await expectDecodeError(decodePacketTracer(bytes, { limits }), "PACKET_TRACER_DECOMPRESSION_LIMIT");
  });

  it("enforces the compression ratio independently of the byte cap", async () => {
    const bomb = syntheticNetworkXml({ body: `<!--${"B".repeat(2_000_000)}-->\n` });
    const bytes = await encodeModernContainer(bomb);
    const limits = { ...DEFAULT_PACKET_TRACER_LIMITS, maxCompressionRatio: 2 };
    await expectDecodeError(decodePacketTracer(bytes, { limits }), "PACKET_TRACER_DECOMPRESSION_LIMIT");
  });

  it("rejects a decoded document that is not a Packet Tracer root", async () => {
    const bytes = await encodeModernContainer("<SomeOtherTopology><VERSION>1</VERSION></SomeOtherTopology>");
    await expectDecodeError(decodePacketTracer(bytes), "PACKET_TRACER_UNSUPPORTED_VERSION");
  });

  it("warns rather than fails when no version is declared", async () => {
    const decoded = await decodePacketTracer(await encodeModernContainer("<PACKETTRACER5><NETWORK/></PACKETTRACER5>"));
    expect(decoded.packetTracerVersion).toBeUndefined();
    expect(decoded.warnings.map((warning) => warning.code)).toContain("unknown-version");
  });

  it("honours an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectDecodeError(
      decodePacketTracer(await encodeModernContainer(syntheticNetworkXml()), { signal: controller.signal }),
      "PACKET_TRACER_CANCELLED",
    );
  });
});

async function sealAndDecode(payload: Uint8Array): Promise<unknown> {
  return decodePacketTracer(sealRawPayload(payload));
}

describe("container detection helpers", () => {
  it("declines obviously non-container inputs", () => {
    expect(looksLikePacketTracerContainer(new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(32).fill(0)]))).toBe(false);
    expect(looksLikePacketTracerContainer(new TextEncoder().encode(`<topology>${" ".repeat(40)}</topology>`))).toBe(false);
    expect(looksLikePacketTracerContainer(new Uint8Array(4))).toBe(false);
  });

  it("accepts high-entropy bytes of a plausible size", async () => {
    expect(looksLikePacketTracerContainer(await encodeModernContainer(syntheticNetworkXml()))).toBe(true);
  });

  it("reads the major version from a declared version string", () => {
    expect(packetTracerMajorVersion("9.0.0.0810")).toBe(9);
    expect(packetTracerMajorVersion("8.2.0.0400")).toBe(8);
    expect(packetTracerMajorVersion(undefined)).toBeUndefined();
    expect(packetTracerMajorVersion("not-a-version")).toBeUndefined();
  });
});

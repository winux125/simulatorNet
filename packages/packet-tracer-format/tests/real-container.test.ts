/**
 * Compatibility against a container genuinely written by Cisco Packet Tracer.
 *
 * The synthetic round-trip suite cannot catch a fault shared by our encoder and
 * our decoder — this one can, because nothing here was produced by us. What
 * makes it conclusive is not a diff against another tool's output but the
 * checks the container carries internally:
 *
 *   - the EAX tag authenticates, and a 128-bit tag does not verify by accident,
 *     so layers 4 and 3 are byte-exact;
 *   - the `qCompress` length prefix Cisco wrote matches what actually inflated
 *     (a mismatch would raise `trailing-bytes`), so layer 2 and the framing are
 *     byte-exact;
 *   - the result is well-formed XML whose devices, models and running-config
 *     are internally coherent.
 *
 * Note on the reference XML: `pkt-to-xml` commits an `example.xml` beside its
 * `example.pkt`, but the two are *not* a matching pair — they are different
 * labs (the XML has 3 devices and a static host address, the container has 5
 * devices and a DHCP host). It is therefore not usable as a byte oracle, and
 * asserting equality against it would be asserting that our decoder reproduces
 * someone else's stale artifact. The invariants below are the real contract.
 */
import { describe, expect, it } from "vitest";
import { decodePacketTracer } from "../src/container/decode";
import { ACTIVITY_ROOT, NETWORK_ROOT } from "../src/container/detect";
import { findRealPacketTracerFixture, realFixtureDirectoryForReport } from "./helpers/real-fixtures";

const realPkt = findRealPacketTracerFixture("pkt");
const realPka = findRealPacketTracerFixture("pka");

describe.runIf(realPkt)("real Packet Tracer .pkt container", () => {
  it("authenticates, inflates to its declared length and yields well-formed XML", async () => {
    const decoded = await decodePacketTracer(realPkt!.bytes, { filename: realPkt!.filename });

    expect(decoded.format).toBe("pkt");
    expect(decoded.variant).toBe("modern");
    expect(decoded.packetTracerVersion).toMatch(/^\d+\.\d+\.\d+/u);
    // No warning means the length Cisco declared equalled what inflated.
    expect(decoded.warnings).toEqual([]);
    expect(decoded.xml.startsWith(`<${NETWORK_ROOT}>`)).toBe(true);
    expect(decoded.xml.trimEnd().endsWith(`</${NETWORK_ROOT}>`)).toBe(true);
    expect(decoded.shape.elementCount).toBeGreaterThan(100);
  });

  it("recovers coherent device and configuration content", async () => {
    const { xml } = await decodePacketTracer(realPkt!.bytes, { filename: realPkt!.filename });

    const devices = [...xml.matchAll(/<TYPE customModel="[^"]*" model="([^"]*)">([^<]*)<\/TYPE>/gu)];
    expect(devices.length).toBeGreaterThan(0);
    // Models are real Packet Tracer part names, not decode noise.
    for (const [, model] of devices) {
      expect(model).toMatch(/^[\w .+/-]{1,64}$/u);
    }
    // A switch in this lab carries an IOS running-config the importer will
    // hand to the existing parser.
    expect(xml).toContain("<RUNNINGCONFIG>");
    expect(xml).toMatch(/<LINE>hostname [^<]+<\/LINE>/u);
    expect(xml).toMatch(/<LINE>version \d+\.\d+<\/LINE>/u);
  });
});

describe.runIf(realPka)("real Packet Tracer .pka container", () => {
  it("decodes to a Packet Tracer activity document", async () => {
    const decoded = await decodePacketTracer(realPka!.bytes, { filename: realPka!.filename });
    expect(decoded.format).toBe("pka");
    expect(decoded.xml).toContain(ACTIVITY_ROOT);
    expect(decoded.warnings.filter((warning) => warning.code === "trailing-bytes")).toEqual([]);
  });
});

describe("real Packet Tracer compatibility coverage", () => {
  // A normal CI run has no real fixtures and must stay green on the synthetic
  // suite alone. `pnpm test:packet-tracer:real` sets this flag, and then their
  // absence is a failure rather than a quiet gap — which is the difference
  // between "the compatibility gate passed" and "the compatibility gate never
  // ran". The final milestone report may only claim the former.
  const required = process.env.PACKET_TRACER_REQUIRE_REAL === "1";

  it.runIf(required)("has a real .pkt available when the gate is required", () => {
    expect(
      realPkt,
      `No real .pkt found in ${realFixtureDirectoryForReport()}. `
      + "Place one there or set PACKET_TRACER_REAL_FIXTURES_DIR.",
    ).toBeDefined();
  });

  it.runIf(required)("has a real .pka available when the gate is required", () => {
    expect(
      realPka,
      `No real .pka found in ${realFixtureDirectoryForReport()}. `
      + "Place one there or set PACKET_TRACER_REAL_FIXTURES_DIR.",
    ).toBeDefined();
  });

  it("names the directory it looked in", () => {
    expect(realFixtureDirectoryForReport().length).toBeGreaterThan(0);
  });
});

/**
 * The committed synthetic-format fixtures.
 *
 * `sources.ts` states what each container carries; the `.pkt`/`.pka` beside it
 * is that XML sealed with real container geometry. This suite asserts the
 * decoder reads the frozen bytes back — the property that matters, and the one
 * a Node or zlib upgrade cannot break. It deliberately does *not* assert the
 * encoder still reproduces those exact bytes: deflate output is an
 * implementation detail of whatever zlib the runtime ships, and pinning it
 * would fail for reasons that have nothing to do with this decoder.
 *
 * To rewrite the containers after changing `sources.ts`:
 *
 *   PACKET_TRACER_WRITE_FIXTURES=1 npx vitest run packages/packet-tracer-format/tests/fixtures.test.ts
 *
 * These are synthetic-format fixtures, not files written by Cisco Packet
 * Tracer. Compatibility with Cisco's own XML is the real-fixture gate's job.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PACKET_TRACER_FIXTURE_SOURCES } from "../../../fixtures/packet-tracer/sources";
import { decodePacketTracer } from "../src/container/decode";
import { encodeModernContainer } from "./helpers/encode";

const DIRECTORY = fileURLToPath(new URL("../../../fixtures/packet-tracer/", import.meta.url));
const WRITE = process.env.PACKET_TRACER_WRITE_FIXTURES === "1";

beforeAll(async () => {
  if (!WRITE) return;
  for (const source of PACKET_TRACER_FIXTURE_SOURCES) {
    writeFileSync(join(DIRECTORY, source.file), await encodeModernContainer(source.xml));
  }
});

function read(file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIRECTORY, file)));
}

describe("committed synthetic-format fixtures", () => {
  for (const source of PACKET_TRACER_FIXTURE_SOURCES) {
    it(`decodes ${source.file} back to its declared source`, async () => {
      const decoded = await decodePacketTracer(read(source.file), { filename: source.file });
      expect(decoded.format).toBe(source.format);
      expect(decoded.variant).toBe("modern");
      expect(decoded.xml).toBe(source.xml);
      expect(decoded.warnings).toEqual([]);
    });
  }

  it("declares the version Packet Tracer would have written", async () => {
    const decoded = await decodePacketTracer(read("basic-lab.pkt"), { filename: "basic-lab.pkt" });
    expect(decoded.packetTracerVersion).toBe("8.2.0.0400");
  });

  it("distinguishes an activity root from a network root", async () => {
    const lab = await decodePacketTracer(read("basic-lab.pkt"), { filename: "basic-lab.pkt" });
    const activity = await decodePacketTracer(read("activity.pka"), { filename: "activity.pka" });
    expect(lab.xml).toContain("<PACKETTRACER5>");
    expect(lab.xml).not.toContain("PACKETTRACER5_ACTIVITY");
    expect(activity.xml).toContain("<PACKETTRACER5_ACTIVITY>");
  });

  it("refuses a fixture whose sealed bytes have been altered", async () => {
    const bytes = read("basic-lab.pkt");
    // Flipping one byte must fail the authentication tag, not decode to
    // something subtly different.
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    await expect(decodePacketTracer(bytes, { filename: "basic-lab.pkt" }))
      .rejects.toMatchObject({ code: "PACKET_TRACER_AUTHENTICATION_FAILED" });
  });
});

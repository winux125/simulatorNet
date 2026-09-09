/**
 * Topology bounds on untrusted input.
 *
 * A Packet Tracer file is untrusted, so a document that declares more than the
 * limits allow must be *truncated and reported*, never read in full and never
 * silently trimmed. Nothing here is about malformed XML — the safety scan
 * covers that; this is about a well-formed document that is simply too big.
 */
import { describe, expect, it } from "vitest";
import { buildPacketTracerDocument } from "../src/xml/build";
import { DEFAULT_PACKET_TRACER_LIMITS, type PacketTracerLimits } from "../src/config/limits";
import type { XmlLike } from "../src/xml/tree";

/** A minimal tree in the shape `buildPacketTracerDocument` traverses. */
function element(name: string, children: XmlLike[] = [], text = ""): XmlLike {
  return { name, attributes: {}, children, text };
}

function device(index: number): XmlLike {
  return element("DEVICE", [
    element("ENGINE", [
      element("TYPE", [], "Pc"),
      element("NAME", [], `PC${index}`),
      element("SAVE_REF_ID", [], `save-ref-id:${index}`),
    ]),
  ]);
}

function link(index: number): XmlLike {
  return element("LINK", [
    element("CABLE", [
      element("FROM", [], `save-ref-id:${index}`),
      element("PORT", [], "FastEthernet0"),
      element("TO", [], `save-ref-id:${index + 1}`),
      element("PORT", [], "FastEthernet0"),
    ]),
  ]);
}

function network(deviceCount: number, linkCount: number): XmlLike {
  return element("NETWORK", [
    element("DEVICES", Array.from({ length: deviceCount }, (_, index) => device(index))),
    element("LINKS", Array.from({ length: linkCount }, (_, index) => link(index))),
  ]);
}

function build(root: XmlLike, limits: Partial<PacketTracerLimits> = {}, format: "pkt" | "pka" = "pkt") {
  return buildPacketTracerDocument(root, {
    format,
    limits: { ...DEFAULT_PACKET_TRACER_LIMITS, ...limits },
  });
}

describe("topology limits", () => {
  it("truncates a network beyond the device limit and says how many it dropped", () => {
    const root = element("PACKETTRACER5", [network(12, 0)]);
    const document = build(root, { maxDevices: 5 });

    expect(document.networks[0]!.devices).toHaveLength(5);
    const warning = document.warnings.find((entry) => entry.code === "device-limit");
    expect(warning?.message).toContain("12");
    expect(warning?.message).toContain("5");
  });

  it("truncates a network beyond the link limit and says so", () => {
    const root = element("PACKETTRACER5", [network(4, 9)]);
    const document = build(root, { maxLinks: 3 });

    expect(document.networks[0]!.links).toHaveLength(3);
    expect(document.warnings.some((entry) => entry.code === "link-limit")).toBe(true);
  });

  it("reads a network that sits exactly on its limits without warning", () => {
    const root = element("PACKETTRACER5", [network(5, 3)]);
    const document = build(root, { maxDevices: 5, maxLinks: 3 });

    expect(document.networks[0]!.devices).toHaveLength(5);
    expect(document.networks[0]!.links).toHaveLength(3);
    expect(document.warnings).toEqual([]);
  });

  it("stops discovering activity networks at the snapshot limit", () => {
    const snapshots = Array.from({ length: 9 }, (_, index) =>
      element(`SNAPSHOT_${index}`, [element("PACKETTRACER5", [network(1, 0)])]));
    const root = element("PACKETTRACER5_ACTIVITY", snapshots);
    const document = build(root, { maxSnapshots: 4 }, "pka");

    expect(document.networks.length).toBeLessThanOrEqual(4);
  });

  it("applies the same bounds to every network inside one activity", () => {
    const root = element("PACKETTRACER5_ACTIVITY", [
      element("INITIAL_NETWORK", [element("PACKETTRACER5", [network(8, 0)])]),
      element("ANSWER_NETWORK", [element("PACKETTRACER5", [network(8, 0)])]),
    ]);
    const document = build(root, { maxDevices: 3 }, "pka");

    expect(document.networks).toHaveLength(2);
    for (const entry of document.networks) expect(entry.devices).toHaveLength(3);
  });
});

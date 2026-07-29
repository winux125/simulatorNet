import { DEVICE_TYPES } from "@sim/contracts";
import { buildLabFromDocument, canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { ALL_DEVICES_ICON_DEMO } from "./icon-profile-demo";

describe("All Devices Icon Laboratory", () => {
  it("contains every DeviceType once with diagram and parallel-link presentation", () => {
    const kinds = ALL_DEVICES_ICON_DEMO.topology.nodes.map((node) => node.kind).sort();
    expect(kinds).toEqual([...DEVICE_TYPES].sort());
    expect(Object.keys(ALL_DEVICES_ICON_DEMO.configurations)).toHaveLength(DEVICE_TYPES.length);
    expect(ALL_DEVICES_ICON_DEMO.topology.links.filter((link) =>
      new Set([link.a.node, link.b.node]).size === 2
      && [link.a.node, link.b.node].includes("l3-switch-1")
      && [link.a.node, link.b.node].includes("switch-1"))).toHaveLength(2);
    expect(ALL_DEVICES_ICON_DEMO.topology.links.some((link) =>
      link.a.iface === "wlan0" || link.b.iface === "wlan0")).toBe(false);
    expect(ALL_DEVICES_ICON_DEMO.diagram?.annotations).toHaveLength(1);
    expect(ALL_DEVICES_ICON_DEMO.diagram?.linkLabels).toHaveLength(3);
  });

  it("round-trips and keeps its wired PC-to-Server data path runnable", () => {
    const canonical = canonicalizeLabDocument(ALL_DEVICES_ICON_DEMO);
    expect(canonical.topology.nodes.map((node) => node.id)).toEqual(
      [...canonical.topology.nodes].map((node) => node.id).sort(),
    );
    const built = buildLabFromDocument(canonical);
    built.getPc("pc-1")!.ping("192.168.77.20", 1);
    built.engine.runUntilIdle();
    expect(built.getPc("pc-1")!.pingResults.at(-1)).toMatchObject({ success: true });
  });
});

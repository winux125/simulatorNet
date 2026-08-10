// @vitest-environment jsdom

import type { SimulationTraceEvent } from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import { vxlanEdgeAppearance, vxlanEdgeId } from "../topology/x6/vxlan-overlay";
import { bottomDockTabs, traceProtocol, TRACE_PROTOCOL_FILTERS } from "./BottomDock";

function event(type: string, detail: Record<string, unknown> = {}): SimulationTraceEvent {
  return { sequence: 1, virtualTime: 0, type, deviceId: "leaf1", description: type, detail };
}

describe("routed EVPN Packet Trace integration", () => {
  it("adds the three routed filters without replacing the M10.14 ones", () => {
    expect(TRACE_PROTOCOL_FILTERS).toEqual(expect.arrayContaining([
      "L3VNI", "IRB", "Type 5", "VXLAN", "EVPN", "BUM", "VTEP",
    ]));
  });

  it("classifies the whole symmetric IRB flow a learner has to follow", () => {
    // ARP gateway → local anycast reply → VRF lookup → Type 5 selection →
    // L3VNI encapsulation → underlay → decapsulation → egress VRF lookup.
    expect(traceProtocol(event("evpn-anycast-gateway-replied"))).toBe("IRB");
    expect(traceProtocol(event("evpn-irb-routed"))).toBe("IRB");
    expect(traceProtocol(event("evpn-tenant-isolation-drop"))).toBe("IRB");
    expect(traceProtocol(event("evpn-l3vni-encapsulated"))).toBe("L3VNI");
    expect(traceProtocol(event("evpn-l3vni-decapsulated"))).toBe("L3VNI");
    expect(traceProtocol(event("evpn-type5-originated"))).toBe("Type 5");
    expect(traceProtocol(event("evpn-type5-imported"))).toBe("Type 5");
    expect(traceProtocol(event("evpn-type5-rt-rejected"))).toBe("Type 5");
    // The underlay hop is an ordinary VXLAN datagram, and stays one.
    expect(traceProtocol(event("vxlan-packet-sent"))).toBe("VXLAN");
  });

  it("keeps the M10.14 EVPN family intact and routes a Type 5 UPDATE to its own filter", () => {
    expect(traceProtocol(event("evpn-mac-route-originated"))).toBe("EVPN");
    expect(traceProtocol(event("bgp-route-received", { addressFamily: "l2vpn-evpn", routeType: 2 }))).toBe("EVPN");
    expect(traceProtocol(event("bgp-route-received", { addressFamily: "l2vpn-evpn", routeType: 5 }))).toBe("Type 5");
    expect(traceProtocol(event("bgp-route-received", { addressFamily: "ipv4-unicast" }))).toBe("BGP Updates");
  });

  it("counts every routed overlay event as a packet trace record", () => {
    const traces = [
      event("evpn-anycast-gateway-replied"),
      event("evpn-irb-routed"),
      event("evpn-l3vni-encapsulated"),
      event("evpn-type5-imported"),
    ];
    expect(bottomDockTabs(traces, [], []).packetEvents).toEqual(traces);
  });
});

describe("routed EVPN canvas overlay", () => {
  const tunnel = (kind: "l2vni" | "l3vni", state: "operational" | "down" | "unavailable" | "rt-mismatch") => ({
    id: `vxlan:${kind}`,
    localDeviceId: "leaf1",
    remoteDeviceId: "leaf2",
    label: kind === "l3vni" ? "L3VNI 50001 · TENANT-A" : "L2VNI 10010",
    source: "bgp-evpn" as const,
    kind,
    state,
  });

  it("draws a routed relation dashed and distinct from a bridged one", () => {
    const routed = vxlanEdgeAppearance(tunnel("l3vni", "operational"));
    const bridged = vxlanEdgeAppearance(tunnel("l2vni", "operational"));
    expect(routed.dashArray).not.toBe(bridged.dashArray);
    expect(routed.stroke).not.toBe(bridged.stroke);
    expect(routed.label).toContain("L3VNI 50001");
    expect(routed.label).toContain("EVPN");
  });

  it("separates an unavailable segment from an unreachable peer and an RT mismatch", () => {
    const unavailable = vxlanEdgeAppearance(tunnel("l3vni", "unavailable"));
    const down = vxlanEdgeAppearance(tunnel("l3vni", "down"));
    const mismatch = vxlanEdgeAppearance(tunnel("l2vni", "rt-mismatch"));
    expect(unavailable.stroke).toBe(mismatch.stroke);
    expect(unavailable.stroke).not.toBe(down.stroke);
    for (const appearance of [unavailable, down, mismatch]) expect(appearance.dashArray).toBe("3 5");
  });

  it("keeps every overlay edge id outside the topology link namespace", () => {
    expect(vxlanEdgeId("vxlan:l3vni:50001:leaf1:leaf2")).toBe("runtime-vxlan:vxlan:l3vni:50001:leaf1:leaf2");
  });
});

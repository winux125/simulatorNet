// @vitest-environment jsdom

import type { SimulationTraceEvent } from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import { bottomDockTabs, TRACE_PROTOCOL_FILTERS } from "./BottomDock";

function event(type: string): SimulationTraceEvent {
  return { sequence: 1, virtualTime: 0, type, deviceId: "p1", description: type, detail: {} };
}

describe("MPLS Packet Trace integration", () => {
  it("exposes the four protocol filters without replacing the existing BGP/VPN filters", () => {
    expect(TRACE_PROTOCOL_FILTERS).toEqual(expect.arrayContaining(["MPLS", "LDP", "VPNv4", "L3VPN", "BGP", "VPN"]));
  });

  it("counts MPLS, LDP, VPNv4 and L3VPN events as packet trace records", () => {
    const traces = [
      event("mpls-label-swapped"),
      event("ldp-session-established"),
      event("bgp-vpnv4-route-received"),
      event("l3vpn-packet-forwarded"),
    ];
    expect(bottomDockTabs(traces, [], []).packetEvents).toEqual(traces);
  });
});

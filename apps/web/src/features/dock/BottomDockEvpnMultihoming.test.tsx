import type { SimulationTraceEvent } from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import { bottomDockTabs, traceProtocol, TRACE_PROTOCOL_FILTERS } from "./BottomDock";

function event(type: string, detail: Record<string, unknown> = {}): SimulationTraceEvent {
  return { sequence: 1, virtualTime: 0, type, deviceId: "leaf1", description: type, detail };
}

describe("EVPN multihoming Packet Trace integration", () => {
  it("adds the four multihoming filters without replacing the earlier ones", () => {
    expect(TRACE_PROTOCOL_FILTERS).toEqual(expect.arrayContaining([
      "EVPN Multihoming", "Ethernet Segment", "DF Election", "Fast Failover",
      "L3VNI", "IRB", "Type 5", "VXLAN", "EVPN", "BUM", "VTEP",
    ]));
  });

  it("classifies the whole multihoming flow a learner has to walk", () => {
    // Type 4 discovery → Type 1 advertisement → DF election → Type 2 with an
    // ESI → primary/backup programming → failure → mass withdraw → new DF.
    expect(traceProtocol(event("evpn-es-route-originated"))).toBe("Ethernet Segment");
    expect(traceProtocol(event("evpn-es-route-imported"))).toBe("Ethernet Segment");
    expect(traceProtocol(event("evpn-es-peer-discovered"))).toBe("Ethernet Segment");
    expect(traceProtocol(event("evpn-ad-route-originated"))).toBe("EVPN Multihoming");
    expect(traceProtocol(event("evpn-df-election-started"))).toBe("DF Election");
    expect(traceProtocol(event("evpn-df-elected"))).toBe("DF Election");
    expect(traceProtocol(event("evpn-df-role-changed"))).toBe("DF Election");
    expect(traceProtocol(event("evpn-multihoming-primary-selected"))).toBe("EVPN Multihoming");
    expect(traceProtocol(event("evpn-multihoming-backup-selected"))).toBe("EVPN Multihoming");
    expect(traceProtocol(event("evpn-es-mass-withdraw"))).toBe("Fast Failover");
    expect(traceProtocol(event("evpn-ad-route-withdrawn"))).toBe("Fast Failover");
    expect(traceProtocol(event("evpn-multihoming-failover"))).toBe("Fast Failover");
    // The two forwarding refusals belong to the multihoming family.
    expect(traceProtocol(event("evpn-es-split-horizon-drop"))).toBe("EVPN Multihoming");
    expect(traceProtocol(event("evpn-non-df-egress-drop"))).toBe("EVPN Multihoming");
    expect(traceProtocol(event("evpn-non-df-ingress-drop"))).toBe("EVPN Multihoming");
  });

  it("leaves the earlier EVPN and VXLAN families exactly where they were", () => {
    expect(traceProtocol(event("evpn-mac-route-originated"))).toBe("EVPN");
    expect(traceProtocol(event("evpn-imet-imported"))).toBe("EVPN");
    expect(traceProtocol(event("evpn-l3vni-encapsulated"))).toBe("L3VNI");
    expect(traceProtocol(event("evpn-type5-imported"))).toBe("Type 5");
    expect(traceProtocol(event("vxlan-packet-sent"))).toBe("VXLAN");
    expect(traceProtocol(event("vxlan-split-horizon-dropped"))).toBe("BUM");
    // A Type 4 UPDATE still rides the ordinary BGP events.
    expect(traceProtocol(event("bgp-route-received", { addressFamily: "l2vpn-evpn", routeType: 4 }))).toBe("EVPN");
  });

  it("counts every multihoming event as a packet trace record", () => {
    const traces = [
      event("evpn-es-peer-discovered"),
      event("evpn-df-elected"),
      event("evpn-es-mass-withdraw"),
      event("evpn-non-df-egress-drop"),
    ];
    expect(bottomDockTabs(traces, [], []).packetEvents).toEqual(traces);
  });
});

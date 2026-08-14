// @vitest-environment jsdom

import type { SimulationTraceEvent } from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import { bottomDockTabs, traceProtocol, TRACE_PROTOCOL_FILTERS } from "./BottomDock";

function event(type: string, detail: Record<string, unknown> = {}): SimulationTraceEvent {
  return { sequence: 1, virtualTime: 0, type, deviceId: "leaf1", description: type, detail };
}

describe("All-Active Packet Trace integration", () => {
  it("adds the M10.17 filters without replacing the M10.16 ones", () => {
    expect(TRACE_PROTOCOL_FILTERS).toEqual(expect.arrayContaining([
      "All-Active", "Aliasing", "MAC Mobility", "HRW",
      "EVPN Multihoming", "Ethernet Segment", "DF Election", "Fast Failover",
    ]));
  });

  it("classifies the aliasing flow a learner has to follow", () => {
    // Type 1 per-EVI → alias candidate → deterministic selection → forwarding.
    expect(traceProtocol(event("evpn-aliasing-path-resolved"))).toBe("Aliasing");
    expect(traceProtocol(event("evpn-aliasing-path-installed"))).toBe("Aliasing");
    expect(traceProtocol(event("evpn-aliasing-path-selected"))).toBe("Aliasing");
    expect(traceProtocol(event("evpn-aliasing-no-path"))).toBe("Aliasing");
    // The Ethernet A-D route that made the alias possible keeps its own filter.
    expect(traceProtocol(event("evpn-ad-route-originated"))).toBe("EVPN Multihoming");
  });

  it("classifies the whole MAC mobility flow", () => {
    // detection → increment → the older route losing → the stale one refused.
    expect(traceProtocol(event("evpn-mac-mobility-detected"))).toBe("MAC Mobility");
    expect(traceProtocol(event("evpn-mac-mobility-sequence-incremented"))).toBe("MAC Mobility");
    expect(traceProtocol(event("evpn-mac-route-superseded"))).toBe("MAC Mobility");
    expect(traceProtocol(event("evpn-stale-mac-route-rejected"))).toBe("MAC Mobility");
    expect(traceProtocol(event("evpn-duplicate-mac-detected"))).toBe("MAC Mobility");
    // An ordinary Type 2 advertisement is not a mobility event.
    expect(traceProtocol(event("evpn-mac-route-originated"))).toBe("EVPN");
    expect(traceProtocol(event("evpn-mac-route-withdrawn"))).toBe("EVPN");
  });

  it("separates an HRW election from the modulus one by what the engine stamped", () => {
    // A segment that never asked for HRW stays plain DF Election.
    expect(traceProtocol(event("evpn-df-elected", { effectiveAlgorithm: "default", requestedAlgorithm: "default" })))
      .toBe("DF Election");
    expect(traceProtocol(event("evpn-df-elected", { effectiveAlgorithm: "hrw", requestedAlgorithm: "hrw" })))
      .toBe("HRW");
    // A fallback *away* from HRW is still an HRW event: it is exactly what a
    // learner filtering on HRW is looking for.
    expect(traceProtocol(event("evpn-df-algorithm-fallback", {
      requestedAlgorithm: "hrw",
      effectiveAlgorithm: "default",
    }))).toBe("HRW");
    expect(traceProtocol(event("evpn-df-role-changed"))).toBe("DF Election");
  });

  it("gathers every multihoming stage back into one family filter", () => {
    const stages = [
      event("evpn-es-route-originated"),
      event("evpn-ad-route-originated"),
      event("evpn-df-elected", { effectiveAlgorithm: "hrw" }),
      event("evpn-aliasing-path-selected"),
      event("evpn-mac-mobility-detected"),
      event("evpn-es-mass-withdraw"),
    ];
    // "EVPN Multihoming" selects the whole family; each stage also keeps its own
    // narrower filter, exactly as "QoS" and "VPN" do.
    const families = new Set(stages.map((entry) => traceProtocol(entry)));
    expect(families).toEqual(new Set([
      "Ethernet Segment", "EVPN Multihoming", "HRW", "Aliasing", "MAC Mobility", "Fast Failover",
    ]));
    // An unrelated overlay event stays outside the family.
    expect(traceProtocol(event("vxlan-packet-sent"))).toBe("VXLAN");
  });

  it("counts every All-Active event as a packet trace record", () => {
    const traces = [
      event("evpn-aliasing-path-selected"),
      event("evpn-mac-mobility-sequence-incremented"),
      event("evpn-df-algorithm-fallback", { requestedAlgorithm: "hrw" }),
      event("evpn-duplicate-mac-detected"),
    ];
    expect(bottomDockTabs(traces, [], []).packetEvents).toEqual(traces);
  });
});

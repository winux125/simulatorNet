import { describe, expect, it } from "vitest";
import {
  DeterministicLabelAllocator,
  Icmpv6Type,
  MplsConfigurationError,
  MplsForwardingPlane,
  MplsLimitError,
  Router,
  createSimulationEngine,
  estimatePacketWireSizeBytes,
  macFromIndex,
  type Ipv4Packet,
  type Ipv6Packet,
} from "@sim/sim-core";
import { EtherType, IcmpCode, IcmpType, IpProtocol } from "@sim/contracts";

function ipv4(ttl = 64): Ipv4Packet {
  return {
    kind: "ipv4",
    src: "10.0.0.1",
    dst: "10.0.0.2",
    protocol: IpProtocol.ICMP,
    ttl,
    payload: { kind: "icmp", type: IcmpType.EchoRequest, code: IcmpCode.NetUnreachable, identifier: 1, sequence: 1 },
  };
}

function ipv6(hopLimit = 64, trafficClass?: number): Ipv6Packet {
  return {
    kind: "ipv6",
    src: "2001:db8:a:1::2",
    dst: "2001:db8:a:2::2",
    nextHeader: 58,
    hopLimit,
    trafficClass,
    payload: { kind: "icmpv6", type: Icmpv6Type.EchoRequest, code: 0, identifier: 1, sequence: 1 },
  };
}

describe("deterministic MPLS label allocation", () => {
  it("allocates dynamic labels by canonical FEC order", () => {
    const first = new DeterministicLabelAllocator().allocateAll(["10.0.2.0/24", "10.0.1.0/24"]);
    const second = new DeterministicLabelAllocator().allocateAll(["10.0.1.0/24", "10.0.2.0/24"]);
    expect([...first]).toEqual([...second]);
    expect(first.get("10.0.1.0/24")).toBe(16);
    expect(first.get("10.0.2.0/24")).toBe(17);
  });

  it("enforces the per-router label bound", () => {
    const allocator = new DeterministicLabelAllocator({
      maximumLabelsPerRouter: 1,
      maximumLabelStackDepth: 4,
      maximumLfibEntriesPerLab: 4,
      maximumForwardingEventsPerOperation: 4,
    });
    expect(() => allocator.allocateAll(["a", "b"])).toThrow(MplsLimitError);
  });
});

describe("MPLS label operations", () => {
  it("imposes a deterministic double-label stack and derives TC from DSCP", () => {
    const plane = new MplsForwardingPlane();
    const packet = plane.impose({ ...ipv4(), dscp: 46 }, [18, 24]);
    expect(packet.labels).toEqual([
      { label: 18, trafficClass: 5, bottomOfStack: false, ttl: 64 },
      { label: 24, trafficClass: 5, bottomOfStack: true, ttl: 64 },
    ]);
  });

  it.each([
    ["swap", { type: "swap", outgoingLabel: 24 } as const, [24]],
    ["push", { type: "push", labels: [30] } as const, [30, 18]],
  ])("applies %s without inspecting the IPv4 destination", (_name, operation, expected) => {
    const plane = new MplsForwardingPlane();
    plane.install({ incomingLabel: 18, fec: "192.0.2.1/32", operation, nextHop: "10.0.0.2", outgoingInterfaceId: "Gi0/1", source: "ldp" });
    const decision = plane.forward(plane.impose(ipv4(), [18]));
    expect(decision.kind).toBe("mpls");
    if (decision.kind === "mpls") {
      expect(decision.packet.labels.map((entry) => entry.label)).toEqual(expected);
      expect(decision.packet.labels[0]?.ttl).toBe(63);
    }
  });

  it("performs PHP and restores the decremented uniform TTL to IPv4", () => {
    const plane = new MplsForwardingPlane();
    plane.install({ incomingLabel: 18, fec: "192.0.2.1/32", operation: { type: "pop" }, nextHop: "10.0.0.2", outgoingInterfaceId: "Gi0/1", source: "ldp" });
    const decision = plane.forward(plane.impose(ipv4(20), [18]));
    expect(decision.kind).toBe("ipv4");
    if (decision.kind === "ipv4") expect(decision.packet.ttl).toBe(19);
  });

  it("delivers a VPN label to its explicit VRF", () => {
    const plane = new MplsForwardingPlane();
    plane.install({ incomingLabel: 44, fec: "65000:100:10.0.0.0/24", operation: { type: "deliver", vrfId: "customer-a" }, source: "vpn" });
    const decision = plane.forward(plane.impose(ipv4(), [44]));
    expect(decision).toMatchObject({ kind: "deliver", vrfId: "customer-a", packet: { ttl: 63 } });
  });

  it.each([
    ["unknown label", new MplsForwardingPlane().impose(ipv4(), [99]), "unknown-label"],
    ["expired TTL", new MplsForwardingPlane().impose(ipv4(1), [18]), "ttl-exceeded"],
  ])("drops %s with a typed reason", (_name, packet, reason) => {
    expect(new MplsForwardingPlane().forward(packet)).toMatchObject({ kind: "drop", reason });
  });

  it("rejects reserved labels and bounded stack overflow", () => {
    const plane = new MplsForwardingPlane();
    expect(() => plane.impose(ipv4(), [3])).toThrow(MplsConfigurationError);
    expect(() => plane.impose(ipv4(), [16, 17, 18, 19, 20])).toThrow(MplsLimitError);
  });

  it("accounts for every four-byte MPLS shim in the shared wire-size model", () => {
    const plane = new MplsForwardingPlane();
    const base = estimatePacketWireSizeBytes({ src: macFromIndex(1), dst: macFromIndex(2), etherType: EtherType.IPv4, payload: ipv4() });
    const labelled = estimatePacketWireSizeBytes({ src: macFromIndex(1), dst: macFromIndex(2), etherType: EtherType.MPLS, payload: plane.impose(ipv4(), [16, 17]) });
    expect(labelled - base).toBe(8);
  });
});

/**
 * The same LFIB drives both families: only the payload's own hop-count field
 * differs, so these cases mirror the IPv4 ones rather than testing a second
 * engine.
 */
describe("MPLS IPv6 payload", () => {
  it("imposes a stack from the IPv6 hop limit and Traffic Class", () => {
    const packet = new MplsForwardingPlane().impose(ipv6(40, 46), [18, 24]);
    expect(packet.labels).toEqual([
      { label: 18, trafficClass: 5, bottomOfStack: false, ttl: 40 },
      { label: 24, trafficClass: 5, bottomOfStack: true, ttl: 40 },
    ]);
  });

  it.each([
    ["swap", { type: "swap", outgoingLabel: 24 } as const, [24, 44]],
    ["push", { type: "push", labels: [30] } as const, [30, 18, 44]],
    ["penultimate-hop pop", { type: "pop" } as const, [44]],
  ])("applies %s to a VPN stack without inspecting the IPv6 destination", (_name, operation, expected) => {
    const plane = new MplsForwardingPlane();
    plane.install({ incomingLabel: 18, fec: "192.0.2.1/32", operation, nextHop: "10.0.0.2", outgoingInterfaceId: "Gi0/1", source: "ldp" });
    const decision = plane.forward(plane.impose(ipv6(), [18, 44]));
    expect(decision.kind).toBe("mpls");
    if (decision.kind === "mpls") {
      // The VPN label survives every transport operation and reaches the
      // egress PE, which is what keeps the payload out of the global table.
      expect(decision.packet.labels.map((entry) => entry.label)).toEqual(expected);
      expect(decision.packet.labels.at(-1)?.bottomOfStack).toBe(true);
    }
  });

  it("restores the decremented uniform hop limit when the stack empties", () => {
    const plane = new MplsForwardingPlane();
    plane.install({ incomingLabel: 18, fec: "192.0.2.1/32", operation: { type: "pop" }, nextHop: "10.0.0.2", outgoingInterfaceId: "Gi0/1", source: "ldp" });
    const decision = plane.forward(plane.impose(ipv6(20), [18]));
    expect(decision.kind).toBe("ipv6");
    if (decision.kind === "ipv6") expect(decision.packet.hopLimit).toBe(19);
  });

  it("delivers a VPNv6 label into its explicit VRF", () => {
    const plane = new MplsForwardingPlane();
    plane.install({ incomingLabel: 45, fec: "65000:100:vrf:ipv6", operation: { type: "deliver", vrfId: "customer-a" }, source: "vpn" });
    const decision = plane.forward(plane.impose(ipv6(), [45]));
    expect(decision).toMatchObject({ kind: "deliver", vrfId: "customer-a", packet: { kind: "ipv6", hopLimit: 63 } });
  });

  it.each([
    ["unknown label", new MplsForwardingPlane().impose(ipv6(), [99]), "unknown-label"],
    ["expired hop limit", new MplsForwardingPlane().impose(ipv6(1), [18]), "ttl-exceeded"],
  ])("drops %s with a typed reason", (_name, packet, reason) => {
    expect(new MplsForwardingPlane().forward(packet)).toMatchObject({ kind: "drop", reason });
  });

  it("counts an IPv6 payload's shims in the shared wire-size model", () => {
    const plane = new MplsForwardingPlane();
    const base = estimatePacketWireSizeBytes({ src: macFromIndex(1), dst: macFromIndex(2), etherType: EtherType.IPv6, payload: ipv6() });
    const labelled = estimatePacketWireSizeBytes({ src: macFromIndex(1), dst: macFromIndex(2), etherType: EtherType.MPLS, payload: plane.impose(ipv6(), [16, 17]) });
    expect(labelled - base).toBe(8);
  });
});

describe("Router MPLS capability boundary", () => {
  it("enables only physical Router interfaces and keeps runtime LFIB inspectable", () => {
    const engine = createSimulationEngine({ seed: 10_111 });
    const router = engine.add(new Router("r1", "R1"));
    router.addInterface("Gi0/0", macFromIndex(1));
    router.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 30 });
    router.getOrCreateLoopback(0);
    router.setMplsEnabled("Gi0/0", true);
    expect(router.mplsInterfaceSummaries()).toEqual([{ interfaceId: "Gi0/0", enabled: true, operational: false }]);
    expect(() => router.setMplsEnabled("Loopback0", true)).toThrow(/physical Router interfaces/);
  });
});

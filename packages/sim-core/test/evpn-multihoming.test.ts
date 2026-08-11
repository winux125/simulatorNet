import {
  ESI_MAX,
  ESI_ZERO,
  L2Switch,
  Layer3Switch,
  Pc,
  Router,
  createSimulationEngine,
  electDesignatedForwarder,
  macFromIndex,
  normalizeEsi,
  type EvpnVniConfiguration,
  type NveInterfaceConfiguration,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

/**
 * M10.16a — Ethernet Segment discovery and the Designated Forwarder election.
 *
 * Protocol behaviour is tested here and nowhere else: the CLI suite covers
 * parsing, the worker suite covers the view shape and grading covers the check
 * contract, so none of them re-runs a multihoming scenario of its own.
 */

const VNI = 10_010;
const VLAN = 10;
const AS = 65_000;
const ESI = "0000:0000:0000:0000:0001";

const LEAF1_VTEP = "10.255.0.1";
const LEAF2_VTEP = "10.255.0.2";
const LEAF3_VTEP = "10.255.0.3";
const SPINE_ID = "10.255.0.9";

function nve(): NveInterfaceConfiguration {
  return {
    id: "nve1",
    sourceInterfaceId: "Loopback0",
    adminUp: true,
    members: [{ vni: VNI, vlanId: VLAN, replication: { type: "bgp-evpn" } }],
  };
}

function evpnVni(routeTarget = `${AS}:${VNI}`): EvpnVniConfiguration {
  return {
    vni: VNI,
    routeDistinguisher: `${AS}:${VNI}`,
    importRouteTargets: [routeTarget],
    exportRouteTargets: [routeTarget],
  };
}

export interface MultihomedFabric {
  engine: ReturnType<typeof createSimulationEngine>;
  leaf1: Layer3Switch;
  leaf2: Layer3Switch;
  leaf3: Layer3Switch;
  spine: Router;
  ce: L2Switch;
  hostA: Pc;
  hostB: Pc;
}

/**
 *            ┌── Leaf1 ──┐
 * HostA — CE ┤           ├── Spine (RR) ── Leaf3 — HostB
 *            └── Leaf2 ──┘
 *
 * Leaf1 and Leaf2 attach the same CE, so they share one ESI. VLAN 10 maps to
 * VNI 10010 everywhere, and `10 mod 2 == 0` puts the numerically lowest VTEP —
 * Leaf1 — in the DF role for that VLAN.
 */
export function multihomedFabric(options: {
  leaf2RouteTarget?: string;
  attachLeaf2?: boolean;
} = {}): MultihomedFabric {
  const engine = createSimulationEngine({ seed: 10_160 });
  // Multihoming convergence is what these tests read, so the trace is on from
  // the first virtual nanosecond rather than switched on after the fact.
  engine.enableTrace();
  const leaf1 = engine.add(new Layer3Switch("leaf1", "Leaf1"));
  const leaf2 = engine.add(new Layer3Switch("leaf2", "Leaf2"));
  const leaf3 = engine.add(new Layer3Switch("leaf3", "Leaf3"));
  const spine = engine.add(new Router("spine", "Spine"));
  const ce = engine.add(new L2Switch("ce", "CE"));
  const hostA = engine.add(new Pc("hostA", "HostA"));
  const hostB = engine.add(new Pc("hostB", "HostB"));

  hostA.addInterface("eth0", macFromIndex(1));
  hostB.addInterface("eth0", macFromIndex(2));
  hostA.configure({ ip: "10.10.10.10", mask: 24 });
  hostB.configure({ ip: "10.10.10.20", mask: 24 });
  for (const [index, port] of ["Gi0/1", "Gi0/2", "Gi0/3"].entries()) ce.addInterface(port, macFromIndex(10 + index));
  for (const [device, base] of [[leaf1, 100], [leaf2, 200], [leaf3, 300]] as const) {
    device.addInterface("Gi0/1", macFromIndex(base + 1));
    device.addInterface("Gi0/2", macFromIndex(base + 2));
  }
  for (const [index, port] of ["Gi0/0", "Gi0/1", "Gi0/2"].entries()) spine.addInterface(port, macFromIndex(50 + index));

  engine.connect("hostA", "eth0", "ce", "Gi0/1");
  engine.connect("ce", "Gi0/2", "leaf1", "Gi0/1");
  engine.connect("ce", "Gi0/3", "leaf2", "Gi0/1");
  engine.connect("hostB", "eth0", "leaf3", "Gi0/1");
  engine.connect("leaf1", "Gi0/2", "spine", "Gi0/0");
  engine.connect("leaf2", "Gi0/2", "spine", "Gi0/1");
  engine.connect("leaf3", "Gi0/2", "spine", "Gi0/2");

  for (const port of ["Gi0/1", "Gi0/2", "Gi0/3"]) ce.setAccess(port, VLAN);
  for (const leaf of [leaf1, leaf2, leaf3]) {
    leaf.defineVlan(VLAN);
    leaf.setAccess("Gi0/1", VLAN);
    leaf.setIpRouting(true);
    leaf.getOrCreateLoopback(0);
  }
  leaf1.configureRoutedInterface("Gi0/2", "192.0.2.1", 30);
  leaf2.configureRoutedInterface("Gi0/2", "192.0.2.5", 30);
  leaf3.configureRoutedInterface("Gi0/2", "192.0.2.9", 30);
  spine.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
  spine.configureInterface("Gi0/1", { ip: "192.0.2.6", mask: 30 });
  spine.configureInterface("Gi0/2", { ip: "192.0.2.10", mask: 30 });
  leaf1.setInterfaceIp("Loopback0", LEAF1_VTEP, 32);
  leaf2.setInterfaceIp("Loopback0", LEAF2_VTEP, 32);
  leaf3.setInterfaceIp("Loopback0", LEAF3_VTEP, 32);
  spine.getOrCreateLoopback(0);
  spine.setInterfaceIp("Loopback0", SPINE_ID, 32);

  const uplinks: Record<string, string> = { leaf1: "192.0.2.2", leaf2: "192.0.2.6", leaf3: "192.0.2.10" };
  const vteps: Record<string, string> = { leaf1: LEAF1_VTEP, leaf2: LEAF2_VTEP, leaf3: LEAF3_VTEP };
  for (const leaf of [leaf1, leaf2, leaf3]) {
    for (const [id, address] of Object.entries(vteps)) {
      if (id !== leaf.id) leaf.addStaticRoute(address, 32, uplinks[leaf.id]!);
    }
    leaf.addStaticRoute(SPINE_ID, 32, uplinks[leaf.id]!);
  }
  spine.addStaticRoute(LEAF1_VTEP, 32, "192.0.2.1");
  spine.addStaticRoute(LEAF2_VTEP, 32, "192.0.2.5");
  spine.addStaticRoute(LEAF3_VTEP, 32, "192.0.2.9");

  const leafNeighbor = {
    address: SPINE_ID,
    remoteAs: AS,
    updateSource: "Loopback0",
    evpnActivated: true,
    sendCommunityExtended: true,
  };
  leaf1.bgp.configure({ localAs: AS, routerId: LEAF1_VTEP, neighbors: [leafNeighbor], networks: [] });
  leaf2.bgp.configure({ localAs: AS, routerId: LEAF2_VTEP, neighbors: [leafNeighbor], networks: [] });
  leaf3.bgp.configure({ localAs: AS, routerId: LEAF3_VTEP, neighbors: [leafNeighbor], networks: [] });
  spine.bgp.configure({
    localAs: AS,
    routerId: SPINE_ID,
    clusterId: SPINE_ID,
    neighbors: [LEAF1_VTEP, LEAF2_VTEP, LEAF3_VTEP].map((address) => ({
      address,
      remoteAs: AS,
      updateSource: "Loopback0",
      evpnActivated: true,
      sendCommunityExtended: true,
      routeReflectorClient: true,
    })),
    networks: [],
  });

  leaf1.defineEvpnVni(evpnVni());
  leaf2.defineEvpnVni(evpnVni(options.leaf2RouteTarget));
  leaf3.defineEvpnVni(evpnVni());
  for (const leaf of [leaf1, leaf2, leaf3]) leaf.configureNve(nve());

  leaf1.configureEthernetSegment({
    id: "ES-CE1",
    esi: ESI,
    redundancyMode: "single-active",
    interfaces: ["Gi0/1"],
  });
  if (options.attachLeaf2 !== false) {
    leaf2.configureEthernetSegment({
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    });
  }
  engine.runUntilIdle();
  return { engine, leaf1, leaf2, leaf3, spine, ce, hostA, hostB };
}

describe("EVPN Ethernet Segment identifiers", () => {
  it("canonicalizes both accepted spellings into one comparable value", () => {
    expect(normalizeEsi("0000:0000:0000:0000:0001")).toBe(ESI);
    expect(normalizeEsi("0000.0000.0000.0000.0001")).toBe(ESI);
    expect(normalizeEsi("00000000000000000001")).toBe(ESI);
    expect(normalizeEsi("0000:0000:0000:0000:000A")).toBe("0000:0000:0000:0000:000a");
  });

  it("rejects the two reserved values and anything that is not an ESI", () => {
    expect(() => normalizeEsi("0000:0000:0000:0000")).toThrow(/Invalid Ethernet Segment Identifier/);
    expect(() => normalizeEsi("zzzz:0000:0000:0000:0001")).toThrow(/Invalid Ethernet Segment Identifier/);
    const engine = createSimulationEngine({ seed: 1 });
    const leaf = engine.add(new Layer3Switch("leaf", "Leaf"));
    leaf.addInterface("Gi0/1", macFromIndex(1));
    for (const esi of [ESI_ZERO, ESI_MAX]) {
      expect(() => leaf.configureEthernetSegment({
        id: "ES", esi, redundancyMode: "single-active", interfaces: [],
      })).toThrow(/reserved/);
    }
  });
});

describe("EVPN Ethernet Segment configuration", () => {
  function leafWithPorts() {
    const engine = createSimulationEngine({ seed: 2 });
    const leaf = engine.add(new Layer3Switch("leaf", "Leaf"));
    leaf.addInterface("Gi0/1", macFromIndex(1));
    leaf.addInterface("Gi0/2", macFromIndex(2));
    leaf.setAccess("Gi0/1", VLAN);
    leaf.setAccess("Gi0/2", VLAN);
    leaf.getOrCreateLoopback(0);
    leaf.setInterfaceIp("Loopback0", LEAF1_VTEP, 32);
    return leaf;
  }

  it("supports Single-Active only and reports any other redundancy mode", () => {
    const leaf = leafWithPorts();
    expect(() => leaf.configureEthernetSegment({
      id: "ES-CE1",
      esi: ESI,
      // The parser boundary is where a real "all-active" arrives; this proves
      // the engine refuses it rather than downgrading it silently.
      redundancyMode: "all-active" as unknown as "single-active",
      interfaces: ["Gi0/1"],
    })).toThrow(/not supported/);
  });

  it("keeps one attachment in at most one Ethernet Segment", () => {
    const leaf = leafWithPorts();
    leaf.configureEthernetSegment({ id: "ES-A", esi: ESI, redundancyMode: "single-active", interfaces: ["Gi0/1"] });
    expect(() => leaf.configureEthernetSegment({
      id: "ES-B",
      esi: "0000:0000:0000:0000:0002",
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    })).toThrow(/already belongs to Ethernet Segment 'ES-A'/);
    expect(() => leaf.configureEthernetSegment({
      id: "ES-C",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/2"],
    })).toThrow(/already uses ESI/);
  });

  it("refuses an attachment that is not a CE-facing switchport", () => {
    const leaf = leafWithPorts();
    leaf.setPortRouted("Gi0/2");
    for (const name of ["Gi0/2", "Loopback0", "nve1", "Vlan10", "Gi9/9"]) {
      expect(() => leaf.configureEthernetSegment({
        id: "ES-CE1", esi: ESI, redundancyMode: "single-active", interfaces: [name],
      }), `expected '${name}' to be refused`).toThrow(/does not exist|cannot carry an Ethernet Segment/);
    }
  });
});

describe("EVPN Route Type 4 and Designated Forwarder election", () => {
  it("originates one Ethernet Segment route per operational local segment", () => {
    const { leaf1, engine } = multihomedFabric();
    const local = leaf1.evpnRoutes().filter((route) => route.type === 4 && route.source === "local");
    expect(local).toEqual([
      expect.objectContaining({
        type: 4,
        esi: ESI,
        originatingVtep: LEAF1_VTEP,
        routeTargets: [`${AS}:${VNI}`],
        routeDistinguisher: `${LEAF1_VTEP}:0`,
      }),
    ]);
    expect(engine.traceLog.some((entry) => entry.type === "evpn-es-route-originated")).toBe(true);
  });

  it("discovers the shared segment on every participant through Type 4", () => {
    const { leaf1, leaf2, leaf3, engine } = multihomedFabric();
    expect(leaf1.ethernetSegmentPeers().map((peer) => [peer.esi, peer.vtep, peer.local])).toEqual([
      [ESI, LEAF1_VTEP, true],
      [ESI, LEAF2_VTEP, false],
    ]);
    expect(leaf2.ethernetSegmentPeers().map((peer) => peer.vtep)).toEqual([LEAF1_VTEP, LEAF2_VTEP]);
    // A leaf with no local attachment still learns the segment: that is what
    // lets it program a primary and a backup for a MAC behind it.
    expect(leaf3.evpnRoutes().filter((route) => route.type === 4)).toHaveLength(2);
    expect(engine.traceLog.some((entry) => entry.type === "evpn-es-peer-discovered")).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "evpn-es-route-imported")).toBe(true);
  });

  it("elects exactly one Designated Forwarder and both leaves agree on it", () => {
    const { leaf1, leaf2, engine } = multihomedFabric();
    const first = leaf1.designatedForwarderStates();
    const second = leaf2.designatedForwarderStates();
    expect(first).toEqual([expect.objectContaining({
      esi: ESI,
      vlanId: VLAN,
      candidates: [LEAF1_VTEP, LEAF2_VTEP],
      designatedForwarder: LEAF1_VTEP,
      localRole: "df",
    })]);
    expect(second).toEqual([expect.objectContaining({
      designatedForwarder: LEAF1_VTEP,
      localRole: "non-df",
    })]);
    // Independently computed, identical answer, exactly one DF for the pair.
    expect(first[0]!.designatedForwarder).toBe(second[0]!.designatedForwarder);
    expect([first[0]!.localRole, second[0]!.localRole].filter((role) => role === "df")).toHaveLength(1);
    expect(engine.traceLog.some((entry) => entry.type === "evpn-df-elected")).toBe(true);
  });

  it("uses the documented deterministic modulus election and nothing else", () => {
    const candidates = ["10.255.0.2", "10.255.0.1", "10.255.0.3"];
    // Input order never matters: the candidate list is canonically sorted first.
    expect(electDesignatedForwarder(candidates, 10)).toBe("10.255.0.2");
    expect(electDesignatedForwarder([...candidates].reverse(), 10)).toBe("10.255.0.2");
    expect(electDesignatedForwarder(candidates, 11)).toBe("10.255.0.3");
    expect(electDesignatedForwarder(candidates, 12)).toBe("10.255.0.1");
    expect(electDesignatedForwarder([], 10)).toBeUndefined();
  });

  it("withdraws the Ethernet Segment route when the last attachment fails", () => {
    const { engine, leaf1, leaf2, leaf3 } = multihomedFabric();
    leaf1.interfaces.get("Gi0/1")!.shutdown();
    engine.runUntilIdle();

    expect(leaf1.ethernetSegmentStates()[0]).toMatchObject({ up: false, reason: "attachment-down" });
    expect(leaf1.evpnRoutes().filter((route) => route.type === 4 && route.source === "local")).toEqual([]);
    expect(leaf3.evpnRoutes().filter((route) => route.type === 4).map((route) => route.type === 4 && route.originatingVtep))
      .toEqual([LEAF2_VTEP]);
    // The remaining leaf is now alone on the segment and becomes the DF.
    expect(leaf2.designatedForwarderStates()[0]).toMatchObject({
      candidates: [LEAF2_VTEP],
      designatedForwarder: LEAF2_VTEP,
      localRole: "df",
    });
    expect(engine.traceLog.some((entry) => entry.type === "evpn-es-route-withdrawn")).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "evpn-df-role-changed")).toBe(true);
  });

  it("isolates the segment when the route targets do not match", () => {
    const { leaf1, leaf2 } = multihomedFabric({ leaf2RouteTarget: `${AS}:99999` });
    // Both Type 4 routes still reach the RIB; only the import is refused, so
    // neither leaf ever sees the other as a candidate.
    expect(leaf1.evpnRoutes().filter((route) => route.type === 4)).toHaveLength(2);
    expect(leaf1.ethernetSegmentPeers().filter((peer) => !peer.local)).toEqual([]);
    expect(leaf1.designatedForwarderStates()[0]).toMatchObject({ candidates: [LEAF1_VTEP], localRole: "df" });
    expect(leaf2.designatedForwarderStates()[0]).toMatchObject({ candidates: [LEAF2_VTEP], localRole: "df" });
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/no remote peer/);
  });
});

import {
  Layer3Switch,
  Pc,
  Router,
  createSimulationEngine,
  macFromIndex,
  type EvpnVniConfiguration,
  type NveInterfaceConfiguration,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

const VNI = 10_010;
const VLAN = 10;
const AS = 65_000;

const LEAF1_VTEP = "10.255.0.1";
const LEAF2_VTEP = "10.255.0.2";
const SPINE_ID = "10.255.0.9";

function nve(peers: readonly string[] = []): NveInterfaceConfiguration {
  return {
    id: "nve1",
    sourceInterfaceId: "Loopback0",
    adminUp: true,
    members: [{
      vni: VNI,
      vlanId: VLAN,
      replication: peers.length ? { type: "static", peerAddresses: [...peers] } : { type: "bgp-evpn" },
    }],
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

interface Fabric {
  engine: ReturnType<typeof createSimulationEngine>;
  leaf1: Layer3Switch;
  leaf2: Layer3Switch;
  spine: Router;
  hostA: Pc;
  hostB: Pc;
}

/**
 * Host A — Leaf1 ──┐            ┌── Leaf2 — Host B
 *                  └── Spine ───┘
 *
 * The Spine is an ordinary underlay router and the EVPN route reflector. It is
 * never a VTEP: both leaves peer only with it.
 */
function fabric(options: {
  leaf2RouteTarget?: string;
  sendCommunityExtended?: boolean;
  evpnActivated?: boolean;
  reflectorClients?: boolean;
} = {}): Fabric {
  const engine = createSimulationEngine({ seed: 10_140 });
  const leaf1 = engine.add(new Layer3Switch("leaf1", "Leaf1"));
  const leaf2 = engine.add(new Layer3Switch("leaf2", "Leaf2"));
  const spine = engine.add(new Router("spine", "Spine"));
  const hostA = engine.add(new Pc("hostA", "HostA"));
  const hostB = engine.add(new Pc("hostB", "HostB"));

  hostA.addInterface("eth0", macFromIndex(1));
  hostB.addInterface("eth0", macFromIndex(2));
  hostA.configure({ ip: "10.10.10.10", mask: 24 });
  hostB.configure({ ip: "10.10.10.20", mask: 24 });
  leaf1.addInterface("Gi0/1", macFromIndex(101));
  leaf1.addInterface("Gi0/2", macFromIndex(102));
  leaf2.addInterface("Gi0/1", macFromIndex(201));
  leaf2.addInterface("Gi0/2", macFromIndex(202));
  spine.addInterface("Gi0/0", macFromIndex(50));
  spine.addInterface("Gi0/1", macFromIndex(51));

  engine.connect("hostA", "eth0", "leaf1", "Gi0/1");
  engine.connect("hostB", "eth0", "leaf2", "Gi0/1");
  engine.connect("leaf1", "Gi0/2", "spine", "Gi0/0");
  engine.connect("leaf2", "Gi0/2", "spine", "Gi0/1");

  leaf1.setAccess("Gi0/1", VLAN);
  leaf2.setAccess("Gi0/1", VLAN);
  leaf1.configureRoutedInterface("Gi0/2", "192.0.2.1", 30);
  leaf2.configureRoutedInterface("Gi0/2", "192.0.2.5", 30);
  spine.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
  spine.configureInterface("Gi0/1", { ip: "192.0.2.6", mask: 30 });

  leaf1.getOrCreateLoopback(0);
  leaf1.setInterfaceIp("Loopback0", LEAF1_VTEP, 32);
  leaf2.getOrCreateLoopback(0);
  leaf2.setInterfaceIp("Loopback0", LEAF2_VTEP, 32);
  spine.getOrCreateLoopback(0);
  spine.setInterfaceIp("Loopback0", SPINE_ID, 32);
  leaf1.setIpRouting(true);
  leaf2.setIpRouting(true);

  leaf1.addStaticRoute(LEAF2_VTEP, 32, "192.0.2.2");
  leaf1.addStaticRoute(SPINE_ID, 32, "192.0.2.2");
  leaf2.addStaticRoute(LEAF1_VTEP, 32, "192.0.2.6");
  leaf2.addStaticRoute(SPINE_ID, 32, "192.0.2.6");
  spine.addStaticRoute(LEAF1_VTEP, 32, "192.0.2.1");
  spine.addStaticRoute(LEAF2_VTEP, 32, "192.0.2.5");

  const activated = options.evpnActivated ?? true;
  const extended = options.sendCommunityExtended ?? true;
  const client = options.reflectorClients ?? true;
  const leafNeighbor = {
    address: SPINE_ID,
    remoteAs: AS,
    updateSource: "Loopback0",
    evpnActivated: activated,
    sendCommunityExtended: extended,
  };
  leaf1.bgp.configure({ localAs: AS, routerId: LEAF1_VTEP, neighbors: [leafNeighbor], networks: [] });
  leaf2.bgp.configure({ localAs: AS, routerId: LEAF2_VTEP, neighbors: [leafNeighbor], networks: [] });
  spine.bgp.configure({
    localAs: AS,
    routerId: SPINE_ID,
    neighbors: [LEAF1_VTEP, LEAF2_VTEP].map((address) => ({
      address,
      remoteAs: AS,
      updateSource: "Loopback0",
      evpnActivated: activated,
      sendCommunityExtended: extended,
      routeReflectorClient: client,
    })),
    networks: [],
  });

  leaf1.defineEvpnVni(evpnVni());
  leaf2.defineEvpnVni(evpnVni(options.leaf2RouteTarget));
  leaf1.configureNve(nve());
  leaf2.configureNve(nve());
  engine.runUntilIdle();
  return { engine, leaf1, leaf2, spine, hostA, hostB };
}

describe("BGP EVPN", () => {
  it("carries EVPN on the existing session without a second FSM", () => {
    const { leaf1 } = fabric();
    const summaries = leaf1.bgp.summaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ address: SPINE_ID, state: "established" });
    expect(summaries[0]!.addressFamilies).toEqual(["ipv4-unicast", "l2vpn-evpn"]);
  });

  it("originates a Type 3 route for every operational VNI", () => {
    const { leaf1 } = fabric();
    const imet = leaf1.evpnRoutes().filter((route) => route.type === 3 && route.source === "local");
    expect(imet).toEqual([
      expect.objectContaining({
        type: 3,
        vni: VNI,
        routeDistinguisher: `${AS}:${VNI}`,
        originatingVtep: LEAF1_VTEP,
        routeTargets: [`${AS}:${VNI}`],
      }),
    ]);
  });

  it("builds head-end replication membership from imported Type 3 routes", () => {
    const { leaf1, leaf2 } = fabric();
    expect(leaf1.vxlanPeerSummaries()).toEqual([
      { vni: VNI, address: LEAF2_VTEP, source: "bgp-evpn", reachable: true },
    ]);
    expect(leaf2.vxlanPeerSummaries()).toEqual([
      { vni: VNI, address: LEAF1_VTEP, source: "bgp-evpn", reachable: true },
    ]);
  });

  it("advertises a locally learned MAC as Type 2 and installs it remotely", () => {
    const { engine, leaf1, leaf2, hostA } = fabric();
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(hostA.pingResults[0]?.success).toBe(true);
    const originated = leaf1.evpnRoutes().filter((route) => route.type === 2 && route.source === "local");
    expect(originated).toEqual([
      expect.objectContaining({ type: 2, vni: VNI, macAddress: macFromIndex(1), label: VNI, nextHop: LEAF1_VTEP }),
    ]);
    expect(leaf2.remoteMacEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ vni: VNI, mac: macFromIndex(1), remoteVtep: LEAF1_VTEP, source: "bgp-evpn" }),
    ]));
    expect(engine.traceLog.some((entry) => entry.type === "evpn-mac-route-imported")).toBe(true);
  });

  it("reduces unknown flooding once the remote MAC is known through EVPN", () => {
    const { engine, leaf1, hostA } = fabric();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(leaf1.remoteMacEntries()).toHaveLength(1);
    engine.enableTrace();
    hostA.ping("10.10.10.20", 2);
    engine.runUntilIdle();
    // The second echo request is a known unicast: no BUM replication is needed.
    const leafEvents = engine.traceLog.filter((entry) => entry.device === "leaf1");
    expect(leafEvents.some((entry) => entry.type === "vxlan-packet-sent")).toBe(true);
    expect(leafEvents.some((entry) => entry.type === "vxlan-bum-replicated")).toBe(false);
  });

  it("does not import a route whose route target does not match", () => {
    const { engine, leaf1, leaf2 } = fabric({ leaf2RouteTarget: `${AS}:99999` });
    // Both routes still reach the RIB; only programming is refused.
    expect(leaf1.evpnRoutes().some((route) => route.source !== "local" && route.type === 3)).toBe(true);
    expect(leaf1.vxlanPeerSummaries()).toEqual([]);
    expect(leaf2.vxlanPeerSummaries()).toEqual([]);
    expect(engine.traceLog).toBeDefined();
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/no local import route target matches/);
  });

  it("carries no route target without send-community extended", () => {
    const { leaf1 } = fabric({ sendCommunityExtended: false });
    const learned = leaf1.evpnRoutes().filter((route) => route.source !== "local");
    expect(learned.length).toBeGreaterThan(0);
    for (const route of learned) expect(route.routeTargets).toEqual([]);
    expect(leaf1.vxlanPeerSummaries()).toEqual([]);
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/without 'send-community extended'/);
  });

  it("reflects EVPN routes between clients and stamps loop-prevention attributes", () => {
    const { leaf1, spine } = fabric();
    expect(spine.bgp.routeReflector).toBe(true);
    const reflected = leaf1.evpnRoutes().find((route) => route.type === 3 && route.source !== "local");
    expect(reflected).toBeDefined();
    expect(reflected!.originatorId).toBe(LEAF2_VTEP);
    expect(reflected!.clusterList).toEqual([SPINE_ID]);
    // The reflector never rewrites the next hop: it stays the owning leaf.
    expect(reflected!.nextHop).toBe(LEAF2_VTEP);
  });

  it("keeps plain iBGP split horizon when the spine has no clients", () => {
    const { leaf1, spine } = fabric({ reflectorClients: false });
    expect(spine.bgp.routeReflector).toBe(false);
    expect(leaf1.evpnRoutes().filter((route) => route.source !== "local")).toEqual([]);
    expect(leaf1.vxlanPeerSummaries()).toEqual([]);
  });

  it("originates nothing while the EVPN address family is not activated", () => {
    const { leaf1 } = fabric({ evpnActivated: false });
    expect(leaf1.evpnAddressFamilyActive()).toBe(false);
    expect(leaf1.evpnRoutes()).toEqual([]);
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/no neighbor activates 'address-family l2vpn evpn'/);
  });

  it("removes remote MAC and replication state when the session is lost", () => {
    const { engine, leaf1, hostA } = fabric();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(leaf1.remoteMacEntries()).toHaveLength(1);
    expect(leaf1.vxlanPeerSummaries()).toHaveLength(1);
    leaf1.getInterface("Gi0/2")!.shutdown();
    engine.runUntilIdle();
    leaf1.bgp.summaries();
    expect(leaf1.bgp.summaries()[0]!.state).not.toBe("established");
    expect(leaf1.remoteMacEntries()).toEqual([]);
    expect(leaf1.vxlanPeerSummaries()).toEqual([]);
  });

  it("withdraws a Type 2 route when the VNI mapping is removed", () => {
    const { engine, leaf1, leaf2, hostA } = fabric();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(leaf2.remoteMacEntries()).toHaveLength(1);
    leaf1.configureNve({ id: "nve1", sourceInterfaceId: "Loopback0", adminUp: true, members: [] });
    leaf1.bgp.refreshRoutes();
    engine.runUntilIdle();
    expect(leaf1.evpnRoutes().filter((route) => route.source === "local")).toEqual([]);
    expect(leaf2.remoteMacEntries()).toEqual([]);
    expect(leaf2.vxlanPeerSummaries()).toEqual([]);
  });

  it("resolves a duplicate MAC deterministically regardless of arrival order", () => {
    const { engine, leaf1, leaf2, spine, hostA, hostB } = fabric();
    // Both hosts answer to the same MAC in the same VNI behind different VTEPs.
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    void hostB;
    void spine;
    const before = leaf2.remoteMacEntries();
    // Rebuilding the same fabric in the other order must select the same VTEP.
    const second = fabric();
    second.hostB.ping("10.10.10.10", 1);
    second.engine.runUntilIdle();
    second.hostA.ping("10.10.10.20", 1);
    second.engine.runUntilIdle();
    expect(second.leaf2.remoteMacEntries().map((entry) => entry.remoteVtep))
      .toEqual(before.map((entry) => entry.remoteVtep));
    expect(leaf1.remoteMacEntries().map((entry) => entry.mac))
      .toEqual(second.leaf1.remoteMacEntries().map((entry) => entry.mac));
  });

  it("leaves the spine without any tenant MAC or VXLAN configuration", () => {
    const { engine, spine, hostA } = fabric();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    // The reflector carries the routes but programs no overlay of its own.
    expect(spine.bgp.evpnRoutes().length).toBeGreaterThan(0);
    expect(spine.bgpEvpnExports()).toEqual([]);
    expect([...spine.arpTable.values()]).not.toContain(macFromIndex(1));
  });

  it("produces the same EVPN RIB and remote MAC table on every rebuild", () => {
    const run = () => {
      const { engine, leaf1, hostA } = fabric();
      hostA.ping("10.10.10.20", 1);
      engine.runUntilIdle();
      return {
        routes: leaf1.evpnRoutes().map((route) => `${route.type}:${route.vni}:${route.routeDistinguisher}:${route.nextHop}`),
        macs: leaf1.remoteMacEntries().map((entry) => `${entry.vni}:${entry.mac}:${entry.remoteVtep}`),
        peers: leaf1.vxlanPeerSummaries(),
      };
    };
    expect(run()).toEqual(run());
  });
});

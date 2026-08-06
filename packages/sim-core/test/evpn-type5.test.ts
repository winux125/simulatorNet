import {
  Layer3Switch,
  Pc,
  Router,
  createSimulationEngine,
  macFromIndex,
  type NveInterfaceConfiguration,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

// M10.15b — EVPN Route Type 5 and symmetric IRB over a route reflector.

const AS = 65_000;
const TENANT_A = "TENANT-A";
const TENANT_B = "TENANT-B";
const L3VNI_A = 50_001;
const L3VNI_B = 50_002;
const RT_A = `${AS}:50001`;
const RT_B = `${AS}:50002`;
const LEAF1_VTEP = "10.255.0.1";
const LEAF2_VTEP = "10.255.0.2";
const SPINE_ID = "10.255.0.9";
const ANYCAST_MAC = "02:00:00:ff:00:01";

interface Fabric {
  engine: ReturnType<typeof createSimulationEngine>;
  leaf1: Layer3Switch;
  leaf2: Layer3Switch;
  spine: Router;
  hostA: Pc;
  hostB: Pc;
}

function nve(l2Vni: number, vlanId: number, vrfMembers: Array<{ vni: number; vrfId: string }>): NveInterfaceConfiguration {
  return {
    id: "nve1",
    sourceInterfaceId: "Loopback0",
    adminUp: true,
    members: [{ vni: l2Vni, vlanId, replication: { type: "bgp-evpn" } }],
    vrfMembers,
  };
}

/**
 * Host A (VLAN 10, 10.10.10.0/24) — Leaf1 ──┐
 *                                            ├── Spine (underlay + EVPN RR)
 * Host B (VLAN 20, 10.10.20.0/24) — Leaf2 ──┘
 *
 * Two *different* tenant subnets, so only routed EVPN can join them. The Spine
 * reflects EVPN routes and is deliberately never a VTEP.
 */
function fabric(options: {
  advertise?: boolean;
  leaf2ImportRt?: string;
  sendCommunityExtended?: boolean;
  reflectorClients?: boolean;
  secondTenant?: boolean;
} = {}): Fabric {
  const engine = createSimulationEngine({ seed: 10_150 });
  const leaf1 = engine.add(new Layer3Switch("leaf1", "Leaf1"));
  const leaf2 = engine.add(new Layer3Switch("leaf2", "Leaf2"));
  const spine = engine.add(new Router("spine", "Spine"));
  const hostA = engine.add(new Pc("hostA", "HostA"));
  const hostB = engine.add(new Pc("hostB", "HostB"));

  hostA.addInterface("eth0", macFromIndex(1));
  hostB.addInterface("eth0", macFromIndex(2));
  hostA.configure({ ip: "10.10.10.10", mask: 24, gateway: "10.10.10.1" });
  hostB.configure({ ip: "10.10.20.20", mask: 24, gateway: "10.10.20.1" });

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

  leaf1.setAccess("Gi0/1", 10);
  leaf2.setAccess("Gi0/1", 20);
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

  const extended = options.sendCommunityExtended ?? true;
  const client = options.reflectorClients ?? true;
  const leafNeighbor = {
    address: SPINE_ID,
    remoteAs: AS,
    updateSource: "Loopback0",
    evpnActivated: true,
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
      evpnActivated: true,
      sendCommunityExtended: extended,
      routeReflectorClient: client,
    })),
    networks: [],
  });

  const advertise = options.advertise ?? true;
  leaf1.setFabricAnycastGatewayMac(ANYCAST_MAC);
  leaf2.setFabricAnycastGatewayMac(ANYCAST_MAC);
  leaf1.defineVrf({
    id: TENANT_A, name: TENANT_A, routeDistinguisher: `${AS}:50001`,
    importRouteTargets: [RT_A], exportRouteTargets: [RT_A], advertiseEvpn: advertise,
  });
  leaf2.defineVrf({
    id: TENANT_A, name: TENANT_A, routeDistinguisher: `${AS}:50001`,
    importRouteTargets: [options.leaf2ImportRt ?? RT_A], exportRouteTargets: [RT_A], advertiseEvpn: advertise,
  });

  leaf1.setSviIp(10, "10.10.10.1", 24);
  leaf1.setSviVrf(10, TENANT_A);
  leaf1.setSviAnycastGateway(10, true);
  leaf2.setSviIp(20, "10.10.20.1", 24);
  leaf2.setSviVrf(20, TENANT_A);
  leaf2.setSviAnycastGateway(20, true);

  const leaf1Vrfs = [{ vni: L3VNI_A, vrfId: TENANT_A }];
  const leaf2Vrfs = [{ vni: L3VNI_A, vrfId: TENANT_A }];
  if (options.secondTenant === true) {
    // A second tenant with the very same 10.10.20.0/24 prefix, under its own RT.
    const hostB2 = engine.add(new Pc("hostB2", "HostB2"));
    hostB2.addInterface("eth0", macFromIndex(4));
    hostB2.configure({ ip: "10.10.20.40", mask: 24, gateway: "10.10.20.1" });
    leaf2.defineVrf({
      id: TENANT_B, name: TENANT_B, routeDistinguisher: `${AS}:50002`,
      importRouteTargets: [RT_B], exportRouteTargets: [RT_B], advertiseEvpn: true,
    });
    leaf2.addInterface("Gi0/3", macFromIndex(203));
    leaf2.setAccess("Gi0/3", 30);
    engine.connect("hostB2", "eth0", "leaf2", "Gi0/3");
    leaf2.setSviIp(30, "10.10.20.1", 24);
    leaf2.setSviVrf(30, TENANT_B);
    leaf2Vrfs.push({ vni: L3VNI_B, vrfId: TENANT_B });
    leaf1.defineVrf({
      id: TENANT_B, name: TENANT_B, routeDistinguisher: `${AS}:50002`,
      importRouteTargets: [RT_B], exportRouteTargets: [RT_B], advertiseEvpn: true,
    });
    leaf1Vrfs.push({ vni: L3VNI_B, vrfId: TENANT_B });
  }

  leaf1.configureNve(nve(10_010, 10, leaf1Vrfs));
  leaf2.configureNve(nve(10_020, 20, leaf2Vrfs));
  engine.runUntilIdle();
  return { engine, leaf1, leaf2, spine, hostA, hostB };
}

function typesOf(trace: readonly TraceEntry[], device: string): string[] {
  return trace.filter((entry) => entry.device === device).map((entry) => entry.type);
}

function type5Of(leaf: Layer3Switch, source: "local" | "remote") {
  return leaf.evpnRoutes().filter((route) =>
    route.type === 5 && (source === "local" ? route.source === "local" : route.source !== "local"));
}

describe("M10.15b EVPN Route Type 5", () => {
  it("originates a Type 5 route for an eligible connected VRF prefix", () => {
    const { leaf1 } = fabric();
    expect(type5Of(leaf1, "local")).toEqual([
      expect.objectContaining({
        type: 5,
        network: "10.10.10.0",
        prefixLength: 24,
        routeDistinguisher: `${AS}:50001`,
        routeTargets: [RT_A],
        l3Vni: L3VNI_A,
        nextHopVtep: LEAF1_VTEP,
      }),
    ]);
  });

  it("originates nothing without an explicit advertise flag", () => {
    const { leaf1, leaf2 } = fabric({ advertise: false });
    expect(type5Of(leaf1, "local")).toEqual([]);
    expect(leaf2.importedEvpnRoutes(TENANT_A)).toEqual([]);
  });

  it("also originates an eligible static VRF route", () => {
    const { engine, leaf1 } = fabric();
    leaf1.addVrfStaticRoute(TENANT_A, "172.16.9.0", 24, "10.10.10.9");
    engine.runUntilIdle();
    expect(type5Of(leaf1, "local").map((route) => route.network).sort())
      .toEqual(["10.10.10.0", "172.16.9.0"]);
  });

  it("imports a Type 5 route whose route target matches, through the reflector", () => {
    const { engine, leaf1, leaf2, spine } = fabric();
    engine.enableTrace();
    engine.runUntilIdle();
    expect(type5Of(leaf2, "remote")).toEqual([
      expect.objectContaining({ type: 5, network: "10.10.10.0", nextHopVtep: LEAF1_VTEP }),
    ]);
    expect(leaf2.importedEvpnRoutes(TENANT_A)).toEqual([
      expect.objectContaining({
        network: "10.10.10.0",
        prefixLength: 24,
        source: "evpn-type5",
        remoteVtep: LEAF1_VTEP,
        l3Vni: L3VNI_A,
      }),
    ]);
    // The reflector carried the route without holding an overlay of its own,
    // and stamped the reflected path so a loop could never form.
    expect(spine.bgp.evpnRoutes().filter((route) => route.type === 5).length).toBeGreaterThan(0);
    expect(type5Of(leaf2, "remote")[0]).toMatchObject({
      originatorId: LEAF1_VTEP,
      clusterList: [SPINE_ID],
    });
    expect(leaf1.importedEvpnRoutes(TENANT_A)).toEqual([
      expect.objectContaining({ network: "10.10.20.0", remoteVtep: LEAF2_VTEP }),
    ]);
  });

  it("keeps isolation when the route target does not match", () => {
    const { leaf2 } = fabric({ leaf2ImportRt: `${AS}:9999` });
    expect(type5Of(leaf2, "remote").length).toBeGreaterThan(0); // still in the EVPN RIB…
    expect(leaf2.importedEvpnRoutes(TENANT_A)).toEqual([]); // …but never in the VRF.
    expect(leaf2.vrfRoutingTable(TENANT_A).map((route) => route.network)).not.toContain("10.10.10.0");
  });

  it("never advertises a route target without send-community extended", () => {
    const { leaf2 } = fabric({ sendCommunityExtended: false });
    expect(leaf2.importedEvpnRoutes(TENANT_A)).toEqual([]);
  });

  it("withdraws the imported prefix and its forwarding when the L3VNI goes down", () => {
    const { engine, leaf1, leaf2 } = fabric();
    expect(leaf2.importedEvpnRoutes(TENANT_A)).toHaveLength(1);
    const base = leaf1.nveConfiguration()!;
    leaf1.configureNve({ ...base, adminUp: false });
    leaf1.bgp.refreshRoutes();
    engine.runUntilIdle();
    expect(type5Of(leaf1, "local")).toEqual([]);
    expect(leaf2.importedEvpnRoutes(TENANT_A)).toEqual([]);
  });
});

describe("M10.15b symmetric IRB", () => {
  it("routes between two tenant subnets in both directions over the L3VNI", () => {
    const run = () => {
      const { engine, hostA, hostB } = fabric();
      engine.enableTrace();
      hostA.ping("10.10.20.20", 1);
      engine.runUntilIdle();
      hostB.ping("10.10.10.10", 1);
      engine.runUntilIdle();
      return {
        forward: hostA.pingResults[0]?.success ?? false,
        reverse: hostB.pingResults[0]?.success ?? false,
        leaf1: typesOf(engine.traceLog, "leaf1"),
      };
    };
    const first = run();
    expect(first.forward).toBe(true);
    expect(first.reverse).toBe(true);
    // Ingress *and* egress VTEP route; the transit VNI is the L3VNI, never the
    // destination's L2VNI. That is what makes this symmetric.
    expect(first.leaf1).toContain("evpn-irb-routed");
    expect(first.leaf1).toContain("evpn-l3vni-encapsulated");
    expect(first.leaf1).toContain("evpn-l3vni-decapsulated");
    expect(run()).toEqual(first);
  });

  it("routes a local destination without encapsulating it", () => {
    const { engine, leaf1, hostA } = fabric();
    // A second host in Leaf1's own tenant subnet is reached locally.
    const hostC = engine.add(new Pc("hostC", "HostC"));
    hostC.addInterface("eth0", macFromIndex(3));
    hostC.configure({ ip: "10.10.10.30", mask: 24, gateway: "10.10.10.1" });
    leaf1.addInterface("Gi0/3", macFromIndex(103));
    engine.connect("hostC", "eth0", "leaf1", "Gi0/3");
    leaf1.setAccess("Gi0/3", 10);
    engine.runUntilIdle();
    engine.enableTrace();
    hostA.ping("10.10.10.30", 1);
    engine.runUntilIdle();
    expect(hostA.pingResults[0]?.success ?? false).toBe(true);
    expect(typesOf(engine.traceLog, "leaf1")).not.toContain("evpn-l3vni-encapsulated");
  });

  it("leaves the underlay spine with no tenant route and no tenant MAC", () => {
    const { engine, spine, hostA } = fabric();
    engine.enableTrace();
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    const networks = spine.routingTable().map((row) => row.network);
    expect(networks).not.toContain("10.10.10.0");
    expect(networks).not.toContain("10.10.20.0");
    expect(spine.arpTable.get("10.10.10.10")).toBeUndefined();
    expect(spine.arpTable.get("10.10.20.20")).toBeUndefined();
    // The reflector carries the routes but holds no overlay and no tenant VRF.
    expect(spine.vrfConfigurations()).toEqual([]);
  });

  it("keeps two tenants with the same prefix isolated by route target", () => {
    const { leaf1 } = fabric({ secondTenant: true });
    const tenantA = leaf1.importedEvpnRoutes(TENANT_A);
    const tenantB = leaf1.importedEvpnRoutes(TENANT_B);
    // Both tenants advertise 10.10.20.0/24 from Leaf2; each lands only in its own
    // VRF, and each is reached through its own L3VNI.
    expect(tenantA).toEqual([
      expect.objectContaining({ network: "10.10.20.0", l3Vni: L3VNI_A, routeTargets: [RT_A] }),
    ]);
    expect(tenantB).toEqual([
      expect.objectContaining({ network: "10.10.20.0", l3Vni: L3VNI_B, routeTargets: [RT_B] }),
    ]);
    // There is no global fallback: the tenant prefix never reaches the main table.
    expect(leaf1.routingTable().map((row) => row.network)).not.toContain("10.10.20.0");
  });

  it("withdraws the tenant prefix and its forwarding when the fabric uplink fails", () => {
    const { engine, leaf1, leaf2, hostA } = fabric();
    expect(leaf1.importedEvpnRoutes(TENANT_A)).toHaveLength(1);
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success).toBe(true);

    // Leaf2 loses its only fabric uplink. Static underlay routing still points
    // at the spine, so what actually removes the prefix is the EVPN session
    // failing — which needs virtual time to reach the Hold timer.
    leaf2.getInterface("Gi0/2")!.shutdown();
    engine.runUntilIdle();
    engine.advanceTo(engine.now() + 200_000_000_000);
    engine.runUntilIdle();
    expect(leaf1.importedEvpnRoutes(TENANT_A)).toEqual([]);
    expect(leaf1.vrfRoutingTable(TENANT_A).map((route) => route.network)).not.toContain("10.10.20.0");
    hostA.ping("10.10.20.20", 2);
    engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success ?? false).toBe(false);

    // …and it comes back when the uplink does.
    leaf2.getInterface("Gi0/2")!.noShutdown();
    engine.runUntilIdle();
    expect(leaf1.importedEvpnRoutes(TENANT_A)).toHaveLength(1);
    hostA.ping("10.10.20.20", 3);
    engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success ?? false).toBe(true);
  });
});

import {
  Layer3Switch,
  Pc,
  Router,
  createSimulationEngine,
  macFromIndex,
  type ImportedEvpnPrefixRoute,
  type NveInterfaceConfiguration,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

// M10.15a — a distributed anycast gateway and the L3VNI that carries tenant
// traffic between two VTEPs. The BGP control plane arrives in M10.15b; here the
// Type 5 prefixes are installed directly so the data plane can be tested alone.

const ANYCAST_MAC = "02:00:00:ff:00:01";
const TENANT = "TENANT-A";
const L3VNI = 50_001;
const L2VNI_A = 10_010;
const L2VNI_B = 10_020;

interface Fabric {
  engine: ReturnType<typeof createSimulationEngine>;
  leaf1: Layer3Switch;
  leaf2: Layer3Switch;
  spine: Router;
  hostA: Pc;
  hostB: Pc;
}

function nve(source: string, l2Vni: number, vlanId: number): NveInterfaceConfiguration {
  return {
    id: "nve1",
    sourceInterfaceId: source,
    adminUp: true,
    members: [{ vni: l2Vni, vlanId, replication: { type: "bgp-evpn" } }],
    vrfMembers: [{ vni: L3VNI, vrfId: TENANT }],
  };
}

/**
 * HostA (VLAN 10) — Leaf1 ===== IPv4 underlay via Spine ===== Leaf2 — HostB
 * (VLAN 20). The two hosts sit in *different* tenant subnets, so nothing but a
 * routed overlay can connect them.
 */
function fabric(options: { anycast?: boolean; type5?: boolean } = {}): Fabric {
  const engine = createSimulationEngine({ seed: 1_015 });
  const leaf1 = engine.add(new Layer3Switch("leaf1", "Leaf1"));
  const leaf2 = engine.add(new Layer3Switch("leaf2", "Leaf2"));
  const spine = engine.add(new Router("spine", "Spine"));
  const hostA = engine.add(new Pc("hostA", "HostA"));
  const hostB = engine.add(new Pc("hostB", "HostB"));

  hostA.addInterface("eth0", macFromIndex(1));
  hostB.addInterface("eth0", macFromIndex(2));
  hostA.configure({ ip: "10.10.10.10", mask: 24, gateway: "10.10.10.1" });
  hostB.configure({ ip: "10.10.20.20", mask: 24, gateway: "10.10.20.1" });

  for (const leaf of [leaf1, leaf2]) {
    leaf.addInterface("Gi0/1", macFromIndex(leaf === leaf1 ? 101 : 201));
    leaf.addInterface("Gi0/2", macFromIndex(leaf === leaf1 ? 102 : 202));
  }
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
  leaf1.setInterfaceIp("Loopback0", "10.255.0.1", 32);
  leaf2.getOrCreateLoopback(0);
  leaf2.setInterfaceIp("Loopback0", "10.255.0.2", 32);
  leaf1.setIpRouting(true);
  leaf2.setIpRouting(true);
  leaf1.addStaticRoute("10.255.0.2", 32, "192.0.2.2");
  leaf2.addStaticRoute("10.255.0.1", 32, "192.0.2.6");
  spine.addStaticRoute("10.255.0.1", 32, "192.0.2.1");
  spine.addStaticRoute("10.255.0.2", 32, "192.0.2.5");

  for (const leaf of [leaf1, leaf2]) {
    leaf.defineVrf({
      id: TENANT,
      name: TENANT,
      routeDistinguisher: "65000:50001",
      importRouteTargets: ["65000:50001"],
      exportRouteTargets: ["65000:50001"],
      advertiseEvpn: true,
    });
    if (options.anycast !== false) leaf.setFabricAnycastGatewayMac(ANYCAST_MAC);
  }

  leaf1.setSviIp(10, "10.10.10.1", 24);
  leaf1.setSviVrf(10, TENANT);
  leaf2.setSviIp(20, "10.10.20.1", 24);
  leaf2.setSviVrf(20, TENANT);
  if (options.anycast !== false) {
    leaf1.setSviAnycastGateway(10, true);
    leaf2.setSviAnycastGateway(20, true);
  }

  leaf1.configureNve(nve("Loopback0", L2VNI_A, 10));
  leaf2.configureNve(nve("Loopback0", L2VNI_B, 20));

  if (options.type5 !== false) {
    leaf1.replaceImportedEvpnRoutes([type5("10.10.20.0", 24, "10.255.0.2")]);
    leaf2.replaceImportedEvpnRoutes([type5("10.10.10.0", 24, "10.255.0.1")]);
  }
  return { engine, leaf1, leaf2, spine, hostA, hostB };
}

function type5(
  network: string,
  prefixLength: number,
  nextHopVtep: string,
  routeTargets: readonly string[] = ["65000:50001"],
): ImportedEvpnPrefixRoute {
  return { routeDistinguisher: "65000:50001", network, prefixLength, routeTargets, l3Vni: L3VNI, nextHopVtep };
}

function typesOf(trace: readonly TraceEntry[], device: string): string[] {
  return trace.filter((entry) => entry.device === device).map((entry) => entry.type);
}

describe("M10.15a distributed anycast gateway", () => {
  it("answers a host locally with the fabric anycast MAC on every leaf", () => {
    const { engine, leaf1, leaf2, hostA } = fabric();
    engine.enableTrace();
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    // The host resolved its gateway against its own leaf and cached the one
    // fabric-wide MAC, so moving it to Leaf2 would need no new ARP.
    expect(hostA.arpTable.get("10.10.10.1")).toBe(ANYCAST_MAC);
    expect(leaf1.isAnycastGateway(10)).toBe(true);
    expect(leaf2.isAnycastGateway(20)).toBe(true);
    expect(leaf1.fabricConfiguration()).toEqual({ anycastGatewayMac: ANYCAST_MAC });
    // Both leaves present the same gateway MAC: that is what makes it anycast.
    expect(leaf1.fabricConfiguration().anycastGatewayMac)
      .toBe(leaf2.fabricConfiguration().anycastGatewayMac);
  });

  it("never floods a gateway ARP request across the overlay", () => {
    const { engine, hostA } = fabric();
    engine.enableTrace();
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    const leaf = typesOf(engine.traceLog, "leaf1");
    expect(leaf).toContain("evpn-anycast-gateway-replied");
    // The local SVI answered, so no BUM replication carried the request out.
    const gatewayArpReplicated = engine.traceLog.some((entry) =>
      entry.device === "leaf1" && entry.type === "vxlan-bum-replicated");
    expect(gatewayArpReplicated).toBe(false);
  });

  it("treats a compatible distributed gateway as one gateway, not a duplicate", () => {
    // Two leaves may hold the same tenant subnet, the same SVI address and the
    // same MAC; that is the distributed gateway, never an address conflict.
    const { leaf1, leaf2 } = fabric();
    for (const leaf of [leaf1, leaf2]) {
      expect(() => leaf.setSviIp(30, "10.10.30.1", 24)).not.toThrow();
      leaf.setSviVrf(30, TENANT);
      expect(() => leaf.setSviAnycastGateway(30, true)).not.toThrow();
    }
    expect(leaf1.sviSummaries().find((row) => row.vlanId === 30)?.ip).toBe("10.10.30.1");
    expect(leaf2.sviSummaries().find((row) => row.vlanId === 30)?.ip).toBe("10.10.30.1");
    // An ordinary duplicate inside one routing context is still rejected.
    leaf1.setSviIp(40, "10.10.40.1", 24);
    leaf1.setSviVrf(40, TENANT);
    expect(() => leaf1.setSviIp(41, "10.10.40.1", 24)).not.toThrow();
    expect(() => leaf1.setSviVrf(41, TENANT)).toThrow(/Duplicate IPv4 address/);
  });

  it("rejects an anycast gateway MAC that could never be a next hop", () => {
    const { leaf1 } = fabric();
    expect(() => leaf1.setFabricAnycastGatewayMac("01:00:5e:00:00:01")).toThrow(/unicast/);
    expect(() => leaf1.setFabricAnycastGatewayMac("00:00:00:00:00:00")).toThrow(/zero/);
    // A valid MAC replaces the previous one on every anycast SVI at once.
    leaf1.setFabricAnycastGatewayMac("02:00:00:ff:00:99");
    expect(leaf1.fabricConfiguration().anycastGatewayMac).toBe("02:00:00:ff:00:99");
  });

  it("never advertises the shared gateway MAC as a Type 2 route", () => {
    const { engine, leaf1, hostA } = fabric();
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    const macs = leaf1.evpnRoutes().filter((route) => route.type === 2).map((route) => route.macAddress);
    expect(macs).not.toContain(ANYCAST_MAC);
  });
});

describe("M10.15a L3VNI", () => {
  it("associates one L3VNI with exactly one VRF and reports its state", () => {
    const { leaf1 } = fabric();
    expect(leaf1.l3VniSummaries()).toEqual([
      expect.objectContaining({ vni: L3VNI, vrfId: TENANT, up: true, sourceAddress: "10.255.0.1" }),
    ]);
    // An L3VNI has no VLAN, so it never appears among the bridged mappings.
    expect(leaf1.vniSummaries().map((row) => row.vni)).toEqual([L2VNI_A]);
  });

  it("rejects a VNI that is both bridged and routed, a duplicate, or a second per VRF", () => {
    const { leaf1 } = fabric();
    const base = leaf1.nveConfiguration()!;
    expect(() => leaf1.configureNve({ ...base, vrfMembers: [{ vni: L2VNI_A, vrfId: TENANT }] }))
      .toThrow(/already maps a VLAN/);
    expect(() => leaf1.configureNve({
      ...base,
      vrfMembers: [{ vni: L3VNI, vrfId: TENANT }, { vni: L3VNI, vrfId: "TENANT-B" }],
    })).toThrow(/already mapped/);
    expect(() => leaf1.configureNve({
      ...base,
      vrfMembers: [{ vni: L3VNI, vrfId: TENANT }, { vni: 50_002, vrfId: TENANT }],
    })).toThrow(/already has an L3VNI/);
  });

  it("reports an L3VNI whose VRF is gone as down and drops its traffic", () => {
    const { engine, leaf1, hostA } = fabric();
    leaf1.removeVrf(TENANT);
    expect(leaf1.l3VniSummaries()).toEqual([
      expect.objectContaining({ vni: L3VNI, up: false, reason: "vrf-missing" }),
    ]);
    engine.enableTrace();
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    expect(hostA.pingResults[0]?.success ?? false).toBe(false);
  });
});

describe("M10.15a routed VXLAN data plane", () => {
  it("routes between tenant subnets through the L3VNI in both directions", () => {
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
        leaf2: typesOf(engine.traceLog, "leaf2"),
      };
    };
    const first = run();
    expect(first.forward).toBe(true);
    expect(first.reverse).toBe(true);
    // Symmetric IRB: both VTEPs route, and the transit VNI is the L3VNI.
    expect(first.leaf1).toContain("evpn-irb-routed");
    expect(first.leaf1).toContain("evpn-l3vni-encapsulated");
    expect(first.leaf1).toContain("evpn-l3vni-decapsulated");
    expect(first.leaf2).toContain("evpn-irb-routed");
    expect(first.leaf2).toContain("evpn-l3vni-encapsulated");
    // Deterministic: the same lab and seed produce the same run.
    expect(run()).toEqual(first);
  });

  it("carries the routed overlay over the ordinary underlay, invisible to the spine", () => {
    const { engine, spine, hostA } = fabric();
    engine.enableTrace();
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    // The spine forwards outer IPv4/UDP only: no tenant prefix, no tenant MAC.
    const spineRoutes = spine.routingTable().map((row) => row.network);
    expect(spineRoutes).not.toContain("10.10.10.0");
    expect(spineRoutes).not.toContain("10.10.20.0");
    expect(spine.arpTable.get("10.10.10.10")).toBeUndefined();
    expect(typesOf(engine.traceLog, "spine")).not.toContain("evpn-l3vni-decapsulated");
  });

  it("keeps two tenants with overlapping prefixes isolated", () => {
    const { leaf1 } = fabric();
    leaf1.defineVrf({
      id: "TENANT-B",
      name: "TENANT-B",
      routeDistinguisher: "65000:50002",
      importRouteTargets: ["65000:50002"],
      exportRouteTargets: ["65000:50002"],
    });
    // The very same prefix, offered under two different route targets.
    leaf1.replaceImportedEvpnRoutes([
      type5("10.10.20.0", 24, "10.255.0.2"),
      type5("10.10.20.0", 24, "10.255.0.9", ["65000:50002"]),
    ]);
    expect(leaf1.importedEvpnRoutes(TENANT))
      .toEqual([expect.objectContaining({ network: "10.10.20.0", remoteVtep: "10.255.0.2" })]);
    expect(leaf1.importedEvpnRoutes("TENANT-B"))
      .toEqual([expect.objectContaining({ network: "10.10.20.0", remoteVtep: "10.255.0.9" })]);
    // A route target that matches nothing installs nothing at all.
    leaf1.replaceImportedEvpnRoutes([type5("10.10.99.0", 24, "10.255.0.2", ["65000:9999"])]);
    expect(leaf1.importedEvpnRoutes(TENANT)).toEqual([]);
    expect(leaf1.importedEvpnRoutes("TENANT-B")).toEqual([]);
  });

  it("drops a routed overlay packet that no longer has a usable L3VNI", () => {
    const { engine, leaf1, hostA } = fabric();
    // The underlay route to the remote VTEP disappears.
    const base = leaf1.nveConfiguration()!;
    leaf1.configureNve({ ...base, adminUp: false });
    leaf1.replaceImportedEvpnRoutes([type5("10.10.20.0", 24, "10.255.0.2")]);
    engine.enableTrace();
    hostA.ping("10.10.20.20", 1);
    engine.runUntilIdle();
    expect(hostA.pingResults[0]?.success ?? false).toBe(false);
    expect(typesOf(engine.traceLog, "leaf1")).toContain("evpn-tenant-isolation-drop");
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/L3VNI 50001/);
  });
});

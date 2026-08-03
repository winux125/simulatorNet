import { describe, expect, it } from "vitest";
import {
  ControlProtocolConfigurationError,
  Router,
  createSimulationEngine,
  macFromIndex,
  type BgpNeighborConfiguration,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * One reflector with two clients and two plain iBGP peers. Every spoke
 * originates its own loopback /24, which is enough to observe each documented
 * reflection rule without an IGP: Adj-RIB-In and Adj-RIB-Out are populated by
 * policy, not by next-hop reachability.
 */
function reflectorHub(seed = 10_120) {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const rr = engine.add(new Router("rr", "RR"));
  for (let index = 0; index < 4; index++) rr.addInterface(`Gi0/${index}`, macFromIndex(index));
  const spokes = ([
    ["c1", "1.1.1.1", 1],
    ["c2", "2.2.2.2", 2],
    ["nc1", "3.3.3.3", 3],
    ["nc2", "4.4.4.4", 4],
  ] as const).map(([id, routerId, slot]) => {
    const spoke = engine.add(new Router(id, id.toUpperCase()));
    spoke.addInterface("Gi0/0", macFromIndex(10 + slot));
    spoke.configureInterface("Gi0/0", { ip: `10.0.${slot}.2`, mask: 30 });
    spoke.getOrCreateLoopback(0);
    spoke.setInterfaceIp("Loopback0", `172.16.${slot}.1`, 24);
    rr.configureInterface(`Gi0/${slot - 1}`, { ip: `10.0.${slot}.1`, mask: 30 });
    engine.connect("rr", `Gi0/${slot - 1}`, id, "Gi0/0");
    spoke.bgp.configure({
      localAs: 65_000,
      routerId,
      neighbors: [{ address: `10.0.${slot}.1`, remoteAs: 65_000 }],
      networks: [{ network: `172.16.${slot}.0`, prefixLength: 24 }],
    });
    return spoke;
  });
  const [c1, c2, nc1, nc2] = spokes as [Router, Router, Router, Router];
  return { engine, rr, c1, c2, nc1, nc2 };
}

function configureHub(rr: Router, reflect: boolean, clusterId?: string): void {
  const neighbor = (slot: number, client: boolean): BgpNeighborConfiguration => ({
    address: `10.0.${slot}.2`,
    remoteAs: 65_000,
    routeReflectorClient: reflect && client ? true : undefined,
  });
  rr.bgp.configure({
    localAs: 65_000,
    routerId: "9.9.9.9",
    clusterId,
    neighbors: [neighbor(1, true), neighbor(2, true), neighbor(3, false), neighbor(4, false)],
  });
}

function prefixesFrom(device: Router, neighbor: string): string[] {
  return device.bgp.adjRibInEntries(neighbor).map((route) => `${route.network}/${route.prefixLength}`).sort();
}

function advertisedTo(device: Router, neighbor: string): string[] {
  return device.bgp.adjRibOutEntries(neighbor).map((route) => `${route.network}/${route.prefixLength}`).sort();
}

/**
 * Originator O is a client of both reflectors. RR2 prefers the path RR1
 * reflects, so it advertises the prefix back to its own client — which is the
 * only way an originator ever sees its own ORIGINATOR_ID again.
 */
function twoReflectors(rr2ClusterId: string, seed = 10_121) {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const routers = (["o", "rr1", "rr2"] as const).map((id, index) => {
    const router = engine.add(new Router(id, id.toUpperCase()));
    router.addInterface("Gi0/0", macFromIndex(100 + index * 2));
    router.addInterface("Gi0/1", macFromIndex(101 + index * 2));
    return router;
  });
  const [o, rr1, rr2] = routers as [Router, Router, Router];
  o.getOrCreateLoopback(0);
  o.setInterfaceIp("Loopback0", "172.16.1.1", 24);
  o.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 30 });
  o.configureInterface("Gi0/1", { ip: "10.0.13.1", mask: 30 });
  rr1.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 30 });
  rr1.configureInterface("Gi0/1", { ip: "10.0.23.1", mask: 30 });
  rr2.configureInterface("Gi0/0", { ip: "10.0.13.2", mask: 30 });
  rr2.configureInterface("Gi0/1", { ip: "10.0.23.2", mask: 30 });
  engine.connect("o", "Gi0/0", "rr1", "Gi0/0");
  engine.connect("o", "Gi0/1", "rr2", "Gi0/0");
  engine.connect("rr1", "Gi0/1", "rr2", "Gi0/1");
  // A reflector never rewrites NEXT_HOP, so the reflected path is only usable
  // once the underlying transit prefix is reachable.
  rr2.addStaticRoute("10.0.12.0", 30, "10.0.23.1");
  rr1.addStaticRoute("10.0.13.0", 30, "10.0.23.2");

  o.bgp.configure({
    localAs: 65_000,
    routerId: "1.1.1.1",
    neighbors: [{ address: "10.0.12.2", remoteAs: 65_000 }, { address: "10.0.13.2", remoteAs: 65_000 }],
    networks: [{ network: "172.16.1.0", prefixLength: 24 }],
  });
  rr1.bgp.configure({
    localAs: 65_000,
    routerId: "2.2.2.2",
    clusterId: "2.2.2.2",
    neighbors: [
      { address: "10.0.12.1", remoteAs: 65_000, routeReflectorClient: true },
      { address: "10.0.23.2", remoteAs: 65_000 },
    ],
  });
  rr2.bgp.routingPolicy.setRouteMaps([{ id: "PREFER-RR1", sequences: [{ sequence: 10, action: "permit", set: { localPreference: 200 } }] }]);
  rr2.bgp.configure({
    localAs: 65_000,
    routerId: "3.3.3.3",
    clusterId: rr2ClusterId,
    neighbors: [
      { address: "10.0.13.1", remoteAs: 65_000, routeReflectorClient: true },
      { address: "10.0.23.1", remoteAs: 65_000, routeMapIn: "PREFER-RR1" },
    ],
  });
  return { engine, o, rr1, rr2 };
}

describe("BGP route reflection", () => {
  it("reflects a client route to the other client and stamps the reflection attributes", () => {
    const { engine, rr, c2 } = reflectorHub();
    configureHub(rr, true);
    engine.runUntilIdle();

    const reflected = c2.bgp.adjRibInEntries("10.0.2.1").find((route) => route.network === "172.16.1.0");
    expect(reflected).toMatchObject({ originatorId: "1.1.1.1", clusterList: ["9.9.9.9"], source: "ibgp" });
    expect(engine.traceLog.some((entry) => entry.type === "bgp-route-reflected")).toBe(true);
  });

  it("reflects a client route to a non-client but a non-client route only to clients", () => {
    const { engine, rr, c1, nc1, nc2 } = reflectorHub();
    configureHub(rr, true);
    engine.runUntilIdle();

    expect(prefixesFrom(nc1, "10.0.3.1")).toContain("172.16.1.0/24");
    expect(prefixesFrom(c1, "10.0.1.1")).toContain("172.16.3.0/24");
    // nc1's own prefix came from a non-client, so it must not reach nc2.
    expect(advertisedTo(rr, "10.0.4.2")).not.toContain("172.16.3.0/24");
    expect(advertisedTo(rr, "10.0.4.2")).toContain("172.16.1.0/24");
    expect(prefixesFrom(nc2, "10.0.4.1")).not.toContain("172.16.3.0/24");
  });

  it("never reflects back to the peer the route came from", () => {
    const { engine, rr } = reflectorHub();
    configureHub(rr, true);
    engine.runUntilIdle();
    expect(advertisedTo(rr, "10.0.1.2")).not.toContain("172.16.1.0/24");
  });

  it("keeps plain iBGP split horizon when no neighbor is a reflector client", () => {
    const { engine, rr, c2, nc1 } = reflectorHub(10_122);
    configureHub(rr, false);
    engine.runUntilIdle();

    expect(rr.bgp.routeReflector).toBe(false);
    expect(prefixesFrom(c2, "10.0.2.1")).toEqual([]);
    expect(prefixesFrom(nc1, "10.0.3.1")).toEqual([]);
  });

  it("defaults the cluster identity to the BGP router ID and lists its clients", () => {
    const { rr } = reflectorHub(10_123);
    configureHub(rr, true);
    expect(rr.bgp.clusterIdentity).toBe("9.9.9.9");
    expect(rr.bgp.routeReflectorClients()).toEqual(["10.0.1.2", "10.0.2.2"]);
    configureHub(rr, true, "10.255.0.1");
    expect(rr.bgp.clusterIdentity).toBe("10.255.0.1");
  });

  it("rejects route-reflector-client on an eBGP neighbor", () => {
    const engine = createSimulationEngine({ seed: 10_124 });
    const router = engine.add(new Router("r", "R"));
    router.addInterface("Gi0/0", macFromIndex(1));
    expect(() => router.bgp.configure({
      localAs: 65_000,
      routerId: "1.1.1.1",
      neighbors: [{ address: "192.0.2.2", remoteAs: 65_001, routeReflectorClient: true }],
    })).toThrow(ControlProtocolConfigurationError);
  });

  it("rejects a reflected route whose ORIGINATOR_ID is the local router ID", () => {
    const { engine, o } = twoReflectors("3.3.3.3");
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) => entry.type === "bgp-originator-loop-rejected"
      && entry.device === "o" && entry.detail?.originatorId === "1.1.1.1")).toBe(true);
    expect(o.bgp.adjRibInEntries().every((route) => route.network !== "172.16.1.0")).toBe(true);
  });

  it("rejects a reflected route whose CLUSTER_LIST already contains the local cluster ID", () => {
    const { engine, rr2 } = twoReflectors("2.2.2.2");
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) => entry.type === "bgp-cluster-loop-rejected"
      && entry.device === "rr2" && entry.detail?.clusterId === "2.2.2.2")).toBe(true);
    expect(rr2.bgp.adjRibInEntries("10.0.23.1")).toEqual([]);
  });

  it("produces byte-identical reflected RIBs for identical input", () => {
    const first = reflectorHub();
    configureHub(first.rr, true);
    first.engine.runUntilIdle();
    const second = reflectorHub();
    configureHub(second.rr, true);
    second.engine.runUntilIdle();
    expect(JSON.stringify(second.c2.bgp.adjRibInEntries())).toBe(JSON.stringify(first.c2.bgp.adjRibInEntries()));
    expect(JSON.stringify(second.rr.bgp.adjRibOutEntries())).toBe(JSON.stringify(first.rr.bgp.adjRibOutEntries()));
  });
});

describe("VPNv4 route reflection", () => {
  it("reflects VPNv4 NLRI between clients that never peer directly", () => {
    const engine = createSimulationEngine({ seed: 10_125 });
    engine.enableTrace();
    const customer = {
      id: "customer-a",
      name: "CUSTOMER-A",
      routeDistinguisher: "65000:100",
      importRouteTargets: ["65000:100"],
      exportRouteTargets: ["65000:100"],
    } as const;
    const add = (id: string, base: number, ports: number) => {
      const router = engine.add(new Router(id, id.toUpperCase()));
      for (let index = 0; index < ports; index++) router.addInterface(`Gi0/${index}`, macFromIndex(base + index));
      return router;
    };
    const ce1 = add("ce1", 10, 1);
    const pe1 = add("pe1", 20, 2);
    const rr = add("rr", 30, 2);
    const pe2 = add("pe2", 40, 2);
    const ce2 = add("ce2", 50, 1);
    ce1.configureInterface("Gi0/0", { ip: "10.1.1.2", mask: 24 });
    ce2.configureInterface("Gi0/0", { ip: "10.2.1.2", mask: 24 });
    for (const [pe, address, mask] of [[pe1, "10.1.1.1", 24], [pe2, "10.2.1.1", 24]] as const) {
      pe.defineVrf(customer);
      pe.assignInterfaceVrf("Gi0/1", customer.id);
      pe.configureInterface("Gi0/1", { ip: address, mask });
    }
    pe1.configureInterface("Gi0/0", { ip: "192.0.2.1", mask: 30 });
    rr.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
    rr.configureInterface("Gi0/1", { ip: "192.0.2.5", mask: 30 });
    pe2.configureInterface("Gi0/0", { ip: "192.0.2.6", mask: 30 });
    for (const [router, routerId] of [[pe1, "1.1.1.1"], [rr, "2.2.2.2"], [pe2, "3.3.3.3"]] as const) {
      router.getOrCreateLoopback(0);
      router.setInterfaceIp("Loopback0", routerId, 32);
      router.ospf.createProcess(1);
      router.ospf.setRouterId(routerId);
      router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
      router.ospf.setPassiveInterface("Loopback0", true);
      for (const iface of ["Gi0/0", "Gi0/1"]) router.ospf.configureInterface(iface, { networkType: "point-to-point" });
      router.configureLdpRouterId("Loopback0");
    }
    engine.connect("ce1", "Gi0/0", "pe1", "Gi0/1");
    engine.connect("pe1", "Gi0/0", "rr", "Gi0/0");
    engine.connect("rr", "Gi0/1", "pe2", "Gi0/0");
    engine.connect("pe2", "Gi0/1", "ce2", "Gi0/0");
    for (const [router, ifaces] of [[pe1, ["Gi0/0"]], [rr, ["Gi0/0", "Gi0/1"]], [pe2, ["Gi0/0"]]] as const) {
      for (const iface of ifaces) router.setMplsEnabled(iface, true);
    }
    const peer = (address: string) => ({
      address, remoteAs: 65_000, updateSource: "Loopback0", vpnv4Activated: true, sendCommunityExtended: true,
    });
    pe1.bgp.configure({
      localAs: 65_000, routerId: "1.1.1.1", neighbors: [peer("2.2.2.2")],
      vrfAddressFamilies: [{ vrfId: customer.id, redistributeConnected: true }],
    });
    pe2.bgp.configure({
      localAs: 65_000, routerId: "3.3.3.3", neighbors: [peer("2.2.2.2")],
      vrfAddressFamilies: [{ vrfId: customer.id, redistributeConnected: true }],
    });
    rr.bgp.configure({
      localAs: 65_000, routerId: "2.2.2.2",
      neighbors: [
        { ...peer("1.1.1.1"), routeReflectorClient: true },
        { ...peer("3.3.3.3"), routeReflectorClient: true },
      ],
    });
    engine.runUntilIdle();

    expect(pe1.bgp.selectedVpnv4Routes().some((route) => route.network === "10.2.1.0")).toBe(true);
    expect(pe1.vrfRoutingTable("customer-a").some((route) => route.source === "bgp-vpn" && route.network === "10.2.1.0")).toBe(true);
    const reflected = pe1.bgp.vpnv4Routes().find((route) => route.network === "10.2.1.0");
    expect(reflected).toMatchObject({ originatorId: "3.3.3.3", clusterList: ["2.2.2.2"] });
    // The reflector itself carries no customer VRF and installs no customer route.
    expect(rr.vrfConfigurations()).toEqual([]);
  });
});

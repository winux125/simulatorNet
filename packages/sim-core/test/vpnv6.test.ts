import { describe, expect, it } from "vitest";
import {
  Router,
  createSimulationEngine,
  macFromIndex,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * M10.13c: VPNv6 over the existing MPLS L3VPN. The core stays IPv4 — OSPF, LDP
 * and the transport label are unchanged — and only the customer payload and its
 * NLRI are IPv6, so these cases concentrate on RD/RT, the VPN label, the label
 * stack and isolation between overlapping customers.
 */

const customerA = {
  id: "customer-a",
  name: "CUSTOMER-A",
  routeDistinguisher: "65000:100",
  importRouteTargets: ["65000:100"],
  exportRouteTargets: ["65000:100"],
  addressFamilyIpv6: true,
} as const;

const customerB = {
  id: "customer-b",
  name: "CUSTOMER-B",
  routeDistinguisher: "65000:200",
  importRouteTargets: ["65000:200"],
  exportRouteTargets: ["65000:200"],
  addressFamilyIpv6: true,
} as const;

function addRouter(engine: SimulationEngine, id: string, base: number, ports: number): Router {
  const value = engine.add(new Router(id, id.toUpperCase()));
  for (let index = 0; index < ports; index++) {
    value.addInterface(`Gi0/${index}`, macFromIndex(base + index));
    value.getOrCreateInterface(`Gi0/${index}`);
  }
  value.setIpv6ForwardingEnabled(true);
  return value;
}

function startOspf(value: Router, routerId: string): void {
  value.ospf.createProcess(1);
  value.ospf.setRouterId(routerId);
  value.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
  value.ospf.setPassiveInterface("Loopback0", true);
  for (const iface of ["Gi0/0", "Gi0/1"]) value.ospf.configureInterface(iface, { networkType: "point-to-point" });
}

interface Options {
  readonly seed?: number;
  readonly sendCommunityExtended?: boolean;
  /** A second customer with the same IPv6 prefix behind both PEs. */
  readonly overlapping?: boolean;
}

/** CE1 — PE1 — P — PE2 — CE2 with an IPv4 OSPF/LDP core and IPv6 customers. */
function vpnv6Lab(options: Options = {}) {
  const { seed = 10_160, sendCommunityExtended = true, overlapping = false } = options;
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const ce1 = addRouter(engine, "ce1", 10, 1);
  const pe1 = addRouter(engine, "pe1", 20, 3);
  const p = addRouter(engine, "p", 30, 2);
  const pe2 = addRouter(engine, "pe2", 40, 3);
  const ce2 = addRouter(engine, "ce2", 50, 1);
  const ceB1 = overlapping ? addRouter(engine, "ceb1", 60, 1) : undefined;
  const ceB2 = overlapping ? addRouter(engine, "ceb2", 70, 1) : undefined;

  // Customer A: the same 2001:db8:100::/64 prefix at both sites is legal.
  ce1.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::2", 64);
  ce2.setInterfaceIpv6("Gi0/0", "2001:db8:a:2::2", 64);
  for (const [pe, address] of [[pe1, "2001:db8:a:1::1"], [pe2, "2001:db8:a:2::1"]] as const) {
    pe.defineVrf(customerA);
    pe.assignInterfaceVrf("Gi0/1", customerA.id);
    pe.setInterfaceIpv6("Gi0/1", address, 64);
  }
  ce1.addIpv6StaticRoute("2001:db8:a::", 48, "2001:db8:a:1::1");
  ce2.addIpv6StaticRoute("2001:db8:a::", 48, "2001:db8:a:2::1");

  if (overlapping && ceB1 && ceB2) {
    ceB1.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::2", 64);
    ceB2.setInterfaceIpv6("Gi0/0", "2001:db8:a:2::2", 64);
    for (const [pe, address] of [[pe1, "2001:db8:a:1::1"], [pe2, "2001:db8:a:2::1"]] as const) {
      pe.defineVrf(customerB);
      pe.assignInterfaceVrf("Gi0/2", customerB.id);
      pe.setInterfaceIpv6("Gi0/2", address, 64);
    }
  }

  pe1.configureInterface("Gi0/0", { ip: "192.0.2.1", mask: 30 });
  p.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
  p.configureInterface("Gi0/1", { ip: "192.0.2.5", mask: 30 });
  pe2.configureInterface("Gi0/0", { ip: "192.0.2.6", mask: 30 });
  for (const [value, address] of [[pe1, "1.1.1.1"], [p, "2.2.2.2"], [pe2, "3.3.3.3"]] as const) {
    value.getOrCreateLoopback(0);
    value.setInterfaceIp("Loopback0", address, 32);
    startOspf(value, address);
    value.configureLdpRouterId("Loopback0");
  }

  engine.connect("ce1", "Gi0/0", "pe1", "Gi0/1");
  engine.connect("pe1", "Gi0/0", "p", "Gi0/0");
  engine.connect("p", "Gi0/1", "pe2", "Gi0/0");
  engine.connect("pe2", "Gi0/1", "ce2", "Gi0/0");
  if (ceB1 && ceB2) {
    engine.connect("ceb1", "Gi0/0", "pe1", "Gi0/2");
    engine.connect("pe2", "Gi0/2", "ceb2", "Gi0/0");
  }
  pe1.setMplsEnabled("Gi0/0", true);
  p.setMplsEnabled("Gi0/0", true);
  p.setMplsEnabled("Gi0/1", true);
  pe2.setMplsEnabled("Gi0/0", true);

  const vrfFamilies = [
    { vrfId: customerA.id, redistributeConnectedIpv6: true, redistributeStaticIpv6: true },
    ...(overlapping ? [{ vrfId: customerB.id, redistributeConnectedIpv6: true }] : []),
  ];
  pe1.bgp.configure({
    localAs: 65_000,
    routerId: "1.1.1.1",
    neighbors: [{ address: "3.3.3.3", remoteAs: 65_000, updateSource: "Loopback0", vpnv6Activated: true, sendCommunityExtended }],
    vrfAddressFamilies: vrfFamilies,
  });
  pe2.bgp.configure({
    localAs: 65_000,
    routerId: "3.3.3.3",
    neighbors: [{ address: "1.1.1.1", remoteAs: 65_000, updateSource: "Loopback0", vpnv6Activated: true, sendCommunityExtended }],
    vrfAddressFamilies: vrfFamilies,
  });
  engine.runUntilIdle();
  return { engine, ce1, pe1, p, pe2, ce2, ceB1, ceB2 };
}

describe("MP-BGP VPNv6", () => {
  it("negotiates VPNv6 on the existing iBGP session", () => {
    const { pe1 } = vpnv6Lab();
    expect(pe1.bgp.summaries()[0]).toMatchObject({
      state: "established",
      addressFamilies: ["ipv4-unicast", "vpnv6-unicast"],
    });
  });

  it("carries RD, route targets, the VPN label and the PE transport next hop", () => {
    const { pe1 } = vpnv6Lab();
    const route = pe1.bgp.vpnv6Routes().find((entry) => entry.network === "2001:db8:a:2::");
    expect(route).toMatchObject({
      routeDistinguisher: "65000:100",
      routeTargets: ["65000:100"],
      // The next hop is the advertising PE's IPv4 loopback, resolved by the
      // IPv4 OSPF/LDP core rather than by an IPv6 underlay.
      nextHop: "3.3.3.3",
      source: "ibgp",
    });
    expect(route?.vpnLabel).toBe(100_001);
  });

  it("imports a VPNv6 route into the VRF whose import RT matches", () => {
    const { pe1 } = vpnv6Lab();
    expect(pe1.vrfIpv6RoutingTable("customer-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ network: "2001:db8:a:2::", source: "bgp-vpn", remotePe: "3.3.3.3" }),
    ]));
  });

  it("does not import when extended communities are not sent", () => {
    const { pe1 } = vpnv6Lab({ seed: 10_161, sendCommunityExtended: false });
    expect(pe1.bgp.vpnv6Routes().some((route) => route.network === "2001:db8:a:2::")).toBe(true);
    expect(pe1.vrfIpv6RoutingTable("customer-a").some((route) => route.source === "bgp-vpn")).toBe(false);
  });

  it("rejects a route whose targets do not intersect the VRF", () => {
    const { pe1 } = vpnv6Lab({ seed: 10_162 });
    pe1.defineVrf({ ...customerA, id: "customer-z", name: "CUSTOMER-Z", routeDistinguisher: "65000:900", importRouteTargets: ["65000:900"], exportRouteTargets: ["65000:900"] });
    expect(pe1.vrfIpv6RoutingTable("customer-z")).toHaveLength(0);
  });
});

describe("VPNv6 data plane", () => {
  it("pushes the VPN label under the LDP transport label for an IPv6 payload", () => {
    const { engine, ce1 } = vpnv6Lab({ seed: 10_163 });
    ce1.ping6("2001:db8:a:2::2", 1);
    engine.runUntilIdle();
    expect(ce1.ipv6PingResults).toContainEqual(expect.objectContaining({ sequence: 1, success: true }));
    const imposed = engine.traceLog.find((entry) =>
      entry.type === "mpls-label-imposed" && entry.detail?.family === "ipv6");
    expect(imposed?.detail?.labels).toHaveLength(2);
    expect(engine.traceLog.some((entry) =>
      entry.type === "mpls-packet-delivered" && entry.detail?.family === "ipv6")).toBe(true);
  });

  it("keeps every customer IPv6 prefix out of the P router", () => {
    const { p } = vpnv6Lab({ seed: 10_164 });
    expect(p.ipv6RoutingTable().some((route) => route.network.startsWith("2001:db8:a"))).toBe(false);
    expect(p.vrfConfigurations()).toHaveLength(0);
  });

  it("reports an unavailable transport label after the core loses MPLS", () => {
    const { engine, ce1, pe1 } = vpnv6Lab({ seed: 10_165 });
    pe1.setMplsEnabled("Gi0/0", false);
    engine.runUntilIdle();
    ce1.ping6("2001:db8:a:2::2", 9);
    engine.runUntilIdle();
    expect(ce1.ipv6PingResults).toContainEqual({ sequence: 9, success: false });
    // The control plane keeps the route; only the data plane reports the loss.
    expect(pe1.bgp.selectedVpnv6Routes().some((route) => route.network === "2001:db8:a:2::")).toBe(true);
    expect(engine.traceLog.some((entry) =>
      entry.type === "l3vpn-packet-dropped"
      && entry.detail?.family === "ipv6"
      && entry.detail?.reason === "transport-label-unavailable")).toBe(true);
  });

  it("withdraws the customer route when the VPNv6 family is deactivated", () => {
    const { engine, pe1 } = vpnv6Lab({ seed: 10_166 });
    pe1.bgp.configure({
      ...pe1.bgp.configurationSnapshot()!,
      neighbors: [{ address: "3.3.3.3", remoteAs: 65_000, updateSource: "Loopback0" }],
    });
    engine.runUntilIdle();
    expect(pe1.vrfIpv6RoutingTable("customer-a").some((route) => route.source === "bgp-vpn")).toBe(false);
  });
});

describe("Overlapping customer IPv6 prefixes", () => {
  it("keeps identical prefixes in different VRFs isolated end to end", () => {
    const { engine, ce1, ceB1, pe1 } = vpnv6Lab({ seed: 10_167, overlapping: true });
    expect(ceB1).toBeDefined();
    // Both customers advertise the same /64 from different RDs.
    const routes = pe1.bgp.vpnv6Routes().filter((route) => route.network === "2001:db8:a:2::");
    expect(new Set(routes.map((route) => route.routeDistinguisher))).toEqual(new Set(["65000:100", "65000:200"]));
    expect(new Set(routes.map((route) => route.vpnLabel)).size).toBe(2);

    // Each VRF only sees its own copy, and each customer reaches its own site.
    for (const vrfId of ["customer-a", "customer-b"]) {
      const imported = pe1.vrfIpv6RoutingTable(vrfId).filter((route) => route.source === "bgp-vpn");
      expect(imported).toHaveLength(1);
      expect(imported[0]?.routeDistinguisher).toBe(vrfId === "customer-a" ? "65000:100" : "65000:200");
    }
    ce1.ping6("2001:db8:a:2::2", 3);
    engine.runUntilIdle();
    expect(ce1.ipv6PingResults).toContainEqual(expect.objectContaining({ sequence: 3, success: true }));
  });
});

describe("VPNv6 route reflection", () => {
  it("reflects a VPNv6 path to a client and stamps ORIGINATOR_ID", () => {
    const engine = createSimulationEngine({ seed: 10_170 });
    const rr = addRouter(engine, "rr", 10, 2);
    const pe1 = addRouter(engine, "pe1", 20, 2);
    const pe2 = addRouter(engine, "pe2", 30, 2);
    rr.configureInterface("Gi0/0", { ip: "192.0.2.1", mask: 30 });
    pe1.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
    rr.configureInterface("Gi0/1", { ip: "192.0.2.5", mask: 30 });
    pe2.configureInterface("Gi0/0", { ip: "192.0.2.6", mask: 30 });
    for (const [value, address] of [[rr, "10.0.0.1"], [pe1, "10.0.0.2"], [pe2, "10.0.0.3"]] as const) {
      value.getOrCreateLoopback(0);
      value.setInterfaceIp("Loopback0", address, 32);
      startOspf(value, address);
      value.configureLdpRouterId("Loopback0");
    }
    for (const pe of [pe1, pe2]) {
      pe.defineVrf(customerA);
      pe.assignInterfaceVrf("Gi0/1", customerA.id);
    }
    pe1.setInterfaceIpv6("Gi0/1", "2001:db8:a:1::1", 64);
    pe2.setInterfaceIpv6("Gi0/1", "2001:db8:a:2::1", 64);
    // A connected route only exists on an up link, so each PE needs its CE.
    const ce1 = addRouter(engine, "ce1", 40, 1);
    const ce2 = addRouter(engine, "ce2", 50, 1);
    ce1.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::2", 64);
    ce2.setInterfaceIpv6("Gi0/0", "2001:db8:a:2::2", 64);
    engine.connect("rr", "Gi0/0", "pe1", "Gi0/0");
    engine.connect("rr", "Gi0/1", "pe2", "Gi0/0");
    engine.connect("pe1", "Gi0/1", "ce1", "Gi0/0");
    engine.connect("pe2", "Gi0/1", "ce2", "Gi0/0");
    rr.bgp.configure({
      localAs: 65_000,
      routerId: "10.0.0.1",
      neighbors: [
        { address: "10.0.0.2", remoteAs: 65_000, updateSource: "Loopback0", vpnv6Activated: true, sendCommunityExtended: true, routeReflectorClient: true },
        { address: "10.0.0.3", remoteAs: 65_000, updateSource: "Loopback0", vpnv6Activated: true, sendCommunityExtended: true, routeReflectorClient: true },
      ],
    });
    for (const [pe, routerId, peer] of [[pe1, "10.0.0.2", "10.0.0.1"], [pe2, "10.0.0.3", "10.0.0.1"]] as const) {
      pe.bgp.configure({
        localAs: 65_000,
        routerId,
        neighbors: [{ address: peer, remoteAs: 65_000, updateSource: "Loopback0", vpnv6Activated: true, sendCommunityExtended: true }],
        vrfAddressFamilies: [{ vrfId: customerA.id, redistributeConnectedIpv6: true }],
      });
    }
    engine.runUntilIdle();
    const reflected = pe2.bgp.vpnv6Routes().find((route) => route.network === "2001:db8:a:1::");
    expect(reflected).toMatchObject({ routeDistinguisher: "65000:100", originatorId: "10.0.0.2" });
    expect(reflected?.clusterList).toEqual(["10.0.0.1"]);
  });
});

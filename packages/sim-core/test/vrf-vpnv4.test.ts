import { describe, expect, it } from "vitest";
import {
  Router,
  VrfConfigurationError,
  VrfRoutingTable,
  createSimulationEngine,
  macFromIndex,
  type SimulationEngine,
} from "@sim/sim-core";

const customerA = {
  id: "customer-a",
  name: "CUSTOMER-A",
  routeDistinguisher: "65000:100",
  importRouteTargets: ["65000:100"],
  exportRouteTargets: ["65000:100"],
} as const;

function addRouter(engine: SimulationEngine, id: string, base: number, ports: number): Router {
  const value = engine.add(new Router(id, id.toUpperCase()));
  for (let index = 0; index < ports; index++) value.addInterface(`Gi0/${index}`, macFromIndex(base + index));
  return value;
}

function startOspf(value: Router, routerId: string): void {
  value.ospf.createProcess(1);
  value.ospf.setRouterId(routerId);
  value.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
  value.ospf.setPassiveInterface("Loopback0", true);
  for (const iface of ["Gi0/0", "Gi0/1"]) value.ospf.configureInterface(iface, { networkType: "point-to-point" });
}

function l3vpn(seed = 10_114, sendCommunity = true) {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const ce1 = addRouter(engine, "ce1", 10, 1);
  const pe1 = addRouter(engine, "pe1", 20, 2);
  const p = addRouter(engine, "p", 30, 2);
  const pe2 = addRouter(engine, "pe2", 40, 2);
  const ce2 = addRouter(engine, "ce2", 50, 1);

  ce1.configureInterface("Gi0/0", { ip: "10.1.1.2", mask: 24 });
  pe1.defineVrf(customerA);
  pe1.assignInterfaceVrf("Gi0/1", customerA.id);
  pe1.configureInterface("Gi0/1", { ip: "10.1.1.1", mask: 24 });
  pe2.defineVrf(customerA);
  pe2.assignInterfaceVrf("Gi0/1", customerA.id);
  pe2.configureInterface("Gi0/1", { ip: "10.2.1.1", mask: 24 });
  ce2.configureInterface("Gi0/0", { ip: "10.2.1.2", mask: 24 });
  ce1.addStaticRoute("10.2.1.0", 24, "10.1.1.1");
  ce2.addStaticRoute("10.1.1.0", 24, "10.2.1.1");

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
  pe1.setMplsEnabled("Gi0/0", true);
  p.setMplsEnabled("Gi0/0", true);
  p.setMplsEnabled("Gi0/1", true);
  pe2.setMplsEnabled("Gi0/0", true);

  pe1.bgp.configure({
    localAs: 65_000,
    routerId: "1.1.1.1",
    neighbors: [{
      address: "3.3.3.3",
      remoteAs: 65_000,
      updateSource: "Loopback0",
      vpnv4Activated: true,
      sendCommunityExtended: sendCommunity,
    }],
    vrfAddressFamilies: [{ vrfId: customerA.id, redistributeConnected: true }],
  });
  pe2.bgp.configure({
    localAs: 65_000,
    routerId: "3.3.3.3",
    neighbors: [{
      address: "1.1.1.1",
      remoteAs: 65_000,
      updateSource: "Loopback0",
      vpnv4Activated: true,
      sendCommunityExtended: sendCommunity,
    }],
    vrfAddressFamilies: [{ vrfId: customerA.id, redistributeConnected: true }],
  });
  return { engine, ce1, pe1, p, pe2, ce2 };
}

describe("VRF routing isolation", () => {
  it.each([
    ["65000:100", true],
    ["192.0.2.1:42", true],
    ["bad", false],
    ["0:1", false],
    ["65000:99999999999", false],
  ])("validates RD/RT form %s", (value, valid) => {
    const table = new VrfRoutingTable();
    const run = () => table.define({ ...customerA, routeDistinguisher: value, importRouteTargets: [value], exportRouteTargets: [value] });
    if (valid) expect(run).not.toThrow();
    else expect(run).toThrow(VrfConfigurationError);
  });

  it("allows overlapping addresses across VRFs but rejects them inside one VRF", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const pe = addRouter(engine, "pe", 1, 3);
    pe.defineVrf(customerA);
    pe.defineVrf({ ...customerA, id: "customer-b", name: "CUSTOMER-B", routeDistinguisher: "65000:200", importRouteTargets: ["65000:200"], exportRouteTargets: ["65000:200"] });
    pe.assignInterfaceVrf("Gi0/0", "customer-a");
    pe.assignInterfaceVrf("Gi0/1", "customer-b");
    pe.assignInterfaceVrf("Gi0/2", "customer-a");
    pe.setInterfaceIp("Gi0/0", "10.0.0.1", 24);
    expect(() => pe.setInterfaceIp("Gi0/1", "10.0.0.1", 24)).not.toThrow();
    expect(() => pe.setInterfaceIp("Gi0/2", "10.0.0.1", 24)).toThrow(/Duplicate IPv4 address/);
  });

  it("removes VRF-connected prefixes from the global routing table", () => {
    const engine = createSimulationEngine({ seed: 2 });
    const pe = addRouter(engine, "pe", 1, 1);
    pe.defineVrf(customerA);
    pe.assignInterfaceVrf("Gi0/0", "customer-a");
    pe.setInterfaceIp("Gi0/0", "10.0.0.1", 24);
    expect(pe.routingTable().some((route) => route.network === "10.0.0.0")).toBe(false);
  });

  it("uses longest-prefix selection inside one explicit VRF context", () => {
    const table = new VrfRoutingTable();
    table.define(customerA);
    table.addStaticRoute("customer-a", "10.0.0.0", 8, "192.0.2.1");
    table.addStaticRoute("customer-a", "10.1.0.0", 16, "192.0.2.2");
    expect(table.lookup("customer-a", "10.1.2.3", [])?.nextHop).toBe("192.0.2.2");
    expect(() => table.lookup("missing", "10.1.2.3", [])).toThrow(/Unknown VRF/);
  });

  it("imports only routes with an intersecting route target", () => {
    const table = new VrfRoutingTable();
    table.define(customerA);
    table.replaceImported([
      { routeDistinguisher: "65000:1", network: "10.1.0.0", prefixLength: 16, routeTargets: ["65000:100"], vpnLabel: 100001, nextHop: "1.1.1.1" },
      { routeDistinguisher: "65000:2", network: "10.2.0.0", prefixLength: 16, routeTargets: ["65000:200"], vpnLabel: 100002, nextHop: "2.2.2.2" },
    ]);
    expect(table.routes("customer-a", []).map((route) => route.network)).toEqual(["10.1.0.0"]);
  });

  it("allocates stable distinct per-VRF VPN labels", () => {
    const table = new VrfRoutingTable();
    table.define({ ...customerA, id: "z", name: "Z" });
    table.define({ ...customerA, id: "a", name: "A", routeDistinguisher: "65000:101" });
    expect(table.vpnLabel("a")).toBe(100_000);
    expect(table.vpnLabel("z")).toBe(100_001);
  });
});

describe("MP-BGP VPNv4 and MPLS L3VPN", () => {
  it("negotiates VPNv4 on the existing BGP session and imports matching RTs", () => {
    const { engine, pe1, pe2 } = l3vpn();
    engine.runUntilIdle();
    expect(pe1.bgp.summaries()[0]?.state).toBe("established");
    expect(pe1.bgp.selectedVpnv4Routes().some((route) => route.network === "10.2.1.0")).toBe(true);
    expect(pe1.vrfRoutingTable("customer-a").some((route) => route.source === "bgp-vpn" && route.network === "10.2.1.0")).toBe(true);
    expect(pe2.vpnLabelBindings()).toEqual([{ label: 100_000, vrfId: "customer-a" }]);
  });

  it("does not import a VPN route when extended communities are not sent", () => {
    const { engine, pe1 } = l3vpn(10_115, false);
    engine.runUntilIdle();
    expect(pe1.bgp.selectedVpnv4Routes().some((route) => route.network === "10.2.1.0")).toBe(true);
    expect(pe1.vrfRoutingTable("customer-a").some((route) => route.source === "bgp-vpn")).toBe(false);
  });

  it("forwards customer traffic with VPN and transport labels while P has no customer route", () => {
    const { engine, ce1, p } = l3vpn();
    engine.runUntilIdle();
    ce1.ping("10.2.1.2", 1);
    engine.runUntilIdle();
    expect(ce1.pingResults).toContainEqual(expect.objectContaining({ sequence: 1, success: true }));
    expect(p.routingTable().some((route) => route.network === "10.1.1.0" || route.network === "10.2.1.0")).toBe(false);
    const imposed = engine.traceLog.find((entry) => entry.type === "mpls-label-imposed" && entry.detail?.vrfId === "customer-a");
    expect(imposed?.detail?.labels).toHaveLength(2);
    expect(engine.traceLog.some((entry) => entry.type === "mpls-php-applied")).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "mpls-packet-delivered")).toBe(true);
  });

  it("keeps the BGP route but reports unavailable transport after core failure", () => {
    const { engine, ce1, pe1 } = l3vpn();
    engine.runUntilIdle();
    pe1.setMplsEnabled("Gi0/0", false);
    engine.runUntilIdle();
    ce1.ping("10.2.1.2", 9);
    engine.runUntilIdle();
    expect(ce1.pingResults).toContainEqual({ sequence: 9, success: false });
    expect(pe1.bgp.summaries()[0]?.state).toBe("established");
    expect(engine.traceLog.some((entry) => entry.type === "l3vpn-packet-dropped" && entry.detail?.reason === "transport-label-unavailable")).toBe(true);
  });
});

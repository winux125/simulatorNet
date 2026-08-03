import { describe, expect, it } from "vitest";
import {
  Router,
  VrfConfigurationError,
  VrfRoutingTable,
  createSimulationEngine,
  macFromIndex,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * M10.13a: a VRF owns a second, separate IPv6 route table. The point of these
 * cases is isolation — the same customer prefix may live in several VRFs, and a
 * lookup that misses inside one VRF must never fall back to the global table.
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
  ...customerA,
  id: "customer-b",
  name: "CUSTOMER-B",
  routeDistinguisher: "65000:200",
  importRouteTargets: ["65000:200"],
  exportRouteTargets: ["65000:200"],
} as const;

function addRouter(engine: SimulationEngine, id: string, base: number, ports: number): Router {
  const value = engine.add(new Router(id, id.toUpperCase()));
  for (let index = 0; index < ports; index++) {
    value.addInterface(`Gi0/${index}`, macFromIndex(base + index));
    value.getOrCreateInterface(`Gi0/${index}`);
  }
  return value;
}

describe("VRF IPv6 tables", () => {
  it("rejects an IPv6 static route until the address family is enabled", () => {
    const table = new VrfRoutingTable();
    table.define({ ...customerA, addressFamilyIpv6: undefined });
    expect(() => table.addIpv6StaticRoute("customer-a", "2001:db8:a:2::", 64, "2001:db8:a:1::2"))
      .toThrow(VrfConfigurationError);
    table.define(customerA);
    expect(() => table.addIpv6StaticRoute("customer-a", "2001:db8:a:2::", 64, "2001:db8:a:1::2"))
      .not.toThrow();
  });

  it("rejects a non-canonical IPv6 prefix", () => {
    const table = new VrfRoutingTable();
    table.define(customerA);
    expect(() => table.addIpv6StaticRoute("customer-a", "2001:db8:a:2::5", 64, "2001:db8:a:1::2"))
      .toThrow(/not canonical/);
  });

  it("uses longest-prefix selection inside one explicit VRF context", () => {
    const table = new VrfRoutingTable();
    table.define(customerA);
    table.addIpv6StaticRoute("customer-a", "2001:db8::", 32, "2001:db8:a:1::2");
    table.addIpv6StaticRoute("customer-a", "2001:db8:a:2::", 64, "2001:db8:a:1::3");
    expect(table.lookupIpv6("customer-a", "2001:db8:a:2::9", [])?.nextHop).toBe("2001:db8:a:1::3");
    expect(() => table.lookupIpv6("missing", "2001:db8::1", [])).toThrow(/Unknown VRF/);
  });

  it("imports a VPNv6 route only when a route target intersects", () => {
    const table = new VrfRoutingTable();
    table.define(customerA);
    table.define(customerB);
    table.replaceImportedIpv6([
      { routeDistinguisher: "65000:100", network: "2001:db8:100::", prefixLength: 64, routeTargets: ["65000:100"], vpnLabel: 100_001, nextHop: "1.1.1.1" },
      { routeDistinguisher: "65000:999", network: "2001:db8:999::", prefixLength: 64, routeTargets: ["65000:999"], vpnLabel: 100_009, nextHop: "9.9.9.9" },
    ]);
    expect(table.ipv6Routes("customer-a", []).map((route) => route.network)).toEqual(["2001:db8:100::"]);
    expect(table.ipv6Routes("customer-b", [])).toHaveLength(0);
  });

  it("keeps identical customer prefixes in different VRFs apart", () => {
    const table = new VrfRoutingTable();
    table.define(customerA);
    table.define(customerB);
    table.addIpv6StaticRoute("customer-a", "2001:db8:100::", 64, "2001:db8:a:1::2");
    table.addIpv6StaticRoute("customer-b", "2001:db8:100::", 64, "2001:db8:b:1::2");
    expect(table.lookupIpv6("customer-a", "2001:db8:100::5", [])?.nextHop).toBe("2001:db8:a:1::2");
    expect(table.lookupIpv6("customer-b", "2001:db8:100::5", [])?.nextHop).toBe("2001:db8:b:1::2");
  });

  it("never falls back from a missing VRF route to the global IPv6 table", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const pe = addRouter(engine, "pe", 1, 2);
    pe.setIpv6ForwardingEnabled(true);
    pe.defineVrf(customerA);
    pe.setInterfaceIpv6("Gi0/0", "2001:db8:c0de::1", 64);
    pe.addIpv6StaticRoute("2001:db8:100::", 64, "2001:db8:c0de::2");
    pe.assignInterfaceVrf("Gi0/1", "customer-a");
    pe.setInterfaceIpv6("Gi0/1", "2001:db8:a:1::1", 64);
    expect(pe.ipv6RoutingTable().some((route) => route.network === "2001:db8:100::")).toBe(true);
    expect(pe.vrfIpv6RoutingTable("customer-a").some((route) => route.network === "2001:db8:100::")).toBe(false);
  });
});

describe("Router VRF IPv6 interfaces", () => {
  it("moves an IPv6 connected prefix out of the global table", () => {
    const engine = createSimulationEngine({ seed: 2 });
    const pe = addRouter(engine, "pe", 1, 1);
    const ce = addRouter(engine, "ce", 9, 1);
    pe.defineVrf(customerA);
    pe.assignInterfaceVrf("Gi0/0", "customer-a");
    pe.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::1", 64);
    ce.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::2", 64);
    engine.connect("pe", "Gi0/0", "ce", "Gi0/0");
    engine.runUntilIdle();
    expect(pe.ipv6RoutingTable().some((route) => route.network === "2001:db8:a:1::")).toBe(false);
    expect(pe.vrfIpv6RoutingTable("customer-a").map((route) => route.network)).toEqual(["2001:db8:a:1::"]);
  });

  it("allows an overlapping IPv6 address across VRFs but rejects it inside one", () => {
    const engine = createSimulationEngine({ seed: 3 });
    const pe = addRouter(engine, "pe", 1, 3);
    pe.defineVrf(customerA);
    pe.defineVrf(customerB);
    pe.assignInterfaceVrf("Gi0/0", "customer-a");
    pe.assignInterfaceVrf("Gi0/1", "customer-b");
    pe.assignInterfaceVrf("Gi0/2", "customer-a");
    pe.setInterfaceIpv6("Gi0/0", "2001:db8:100::1", 64);
    expect(() => pe.setInterfaceIpv6("Gi0/1", "2001:db8:100::1", 64)).not.toThrow();
    expect(() => pe.setInterfaceIpv6("Gi0/2", "2001:db8:100::1", 64)).toThrow(/Duplicate IPv6 address/);
  });

  it("requires the VRF IPv6 next hop to sit in the same VRF", () => {
    const engine = createSimulationEngine({ seed: 4 });
    const pe = addRouter(engine, "pe", 1, 2);
    pe.defineVrf(customerA);
    pe.assignInterfaceVrf("Gi0/0", "customer-a");
    pe.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::1", 64);
    pe.setInterfaceIpv6("Gi0/1", "2001:db8:c0de::1", 64);
    expect(() => pe.addVrfIpv6StaticRoute("customer-a", "2001:db8:a:2::", 64, "2001:db8:a:1::2")).not.toThrow();
    expect(() => pe.addVrfIpv6StaticRoute("customer-a", "2001:db8:a:3::", 64, "2001:db8:c0de::2"))
      .toThrow(/not reachable in the same VRF/);
  });

  it("binds one delivery label per VRF address family", () => {
    const engine = createSimulationEngine({ seed: 5 });
    const pe = addRouter(engine, "pe", 1, 1);
    pe.defineVrf(customerA);
    pe.defineVrf({ ...customerB, addressFamilyIpv6: undefined });
    expect(pe.vpnLabelBindings()).toEqual([
      { label: 100_000, vrfId: "customer-a", addressFamily: "ipv4" },
      { label: 100_001, vrfId: "customer-a", addressFamily: "ipv6" },
      { label: 100_002, vrfId: "customer-b", addressFamily: "ipv4" },
    ]);
    expect(pe.mpls.forwardingTable().map((entry) => entry.fec)).toEqual([
      "65000:100:vrf:ipv4",
      "65000:100:vrf:ipv6",
      "65000:200:vrf:ipv4",
    ]);
  });
});

describe("Customer IPv6 forwarding inside a VRF", () => {
  function twoCustomerLan(seed: number) {
    const engine = createSimulationEngine({ seed });
    engine.enableTrace();
    const ce1 = addRouter(engine, "ce1", 10, 1);
    const pe = addRouter(engine, "pe", 20, 2);
    const ce2 = addRouter(engine, "ce2", 30, 1);
    for (const router of [ce1, pe, ce2]) router.setIpv6ForwardingEnabled(true);
    pe.defineVrf(customerA);
    pe.assignInterfaceVrf("Gi0/0", "customer-a");
    pe.assignInterfaceVrf("Gi0/1", "customer-a");
    pe.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::1", 64);
    pe.setInterfaceIpv6("Gi0/1", "2001:db8:a:2::1", 64);
    ce1.setInterfaceIpv6("Gi0/0", "2001:db8:a:1::2", 64);
    ce2.setInterfaceIpv6("Gi0/0", "2001:db8:a:2::2", 64);
    // A /48 covers both the reachable customer LAN and a prefix the PE has no
    // VRF route for, so the CE always forwards and the PE decides.
    ce1.addIpv6StaticRoute("2001:db8:a::", 48, "2001:db8:a:1::1");
    ce2.addIpv6StaticRoute("2001:db8:a::", 48, "2001:db8:a:2::1");
    engine.connect("ce1", "Gi0/0", "pe", "Gi0/0");
    engine.connect("pe", "Gi0/1", "ce2", "Gi0/0");
    engine.runUntilIdle();
    return { engine, ce1, pe, ce2 };
  }

  it("routes an IPv6 ping between two interfaces of the same VRF", () => {
    const { engine, ce1 } = twoCustomerLan(6);
    ce1.ping6("2001:db8:a:2::2", 1);
    engine.runUntilIdle();
    expect(ce1.ipv6PingResults).toContainEqual(expect.objectContaining({ sequence: 1, success: true }));
  });

  it("reports no VRF route rather than using the global IPv6 table", () => {
    const { engine, ce1, pe } = twoCustomerLan(7);
    // The global table knows this prefix; the customer VRF does not, and there
    // is no fallback between the two.
    pe.addIpv6StaticRoute("2001:db8:a:9::", 64, "2001:db8:a:1::9");
    ce1.ping6("2001:db8:a:9::2", 2);
    engine.runUntilIdle();
    expect(ce1.ipv6PingResults).toContainEqual({ sequence: 2, success: false });
    expect(engine.traceLog.some((entry) =>
      entry.type === "l3vpn-packet-dropped"
      && entry.detail?.reason === "no-vrf-route"
      && entry.detail?.family === "ipv6")).toBe(true);
  });
});

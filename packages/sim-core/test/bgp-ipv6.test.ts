import { describe, expect, it } from "vitest";
import {
  Router,
  createSimulationEngine,
  macFromIndex,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * M10.13b: IPv6 unicast is a second address family on the *same* BGP process.
 * These cases therefore focus on what is genuinely new — the IPv6 transport,
 * the separated RIBs and the IPv6 policy surface — rather than re-testing the
 * FSM, reflection or community rules the shared code already covers.
 */

function addRouter(engine: SimulationEngine, id: string, base: number, ports: number): Router {
  const value = engine.add(new Router(id, id.toUpperCase()));
  for (let index = 0; index < ports; index++) {
    value.addInterface(`Gi0/${index}`, macFromIndex(base + index));
    value.getOrCreateInterface(`Gi0/${index}`);
  }
  value.setIpv6ForwardingEnabled(true);
  return value;
}

/** R1 (AS 65001) — R2 (AS 65002) over one IPv6 link, each with a customer LAN. */
function ebgpIpv6(seed = 10_130) {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const r1 = addRouter(engine, "r1", 10, 2);
  const r2 = addRouter(engine, "r2", 20, 2);
  r1.setInterfaceIpv6("Gi0/0", "2001:db8:12::1", 64);
  r2.setInterfaceIpv6("Gi0/0", "2001:db8:12::2", 64);
  r1.setInterfaceIpv6("Gi0/1", "2001:db8:a::1", 64);
  r2.setInterfaceIpv6("Gi0/1", "2001:db8:b::1", 64);
  engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
  r1.bgp.configure({
    localAs: 65_001,
    routerId: "1.1.1.1",
    neighbors: [{ address: "2001:db8:12::2", remoteAs: 65_002 }],
    ipv6Networks: [{ network: "2001:db8:a::", prefixLength: 64 }],
  });
  r2.bgp.configure({
    localAs: 65_002,
    routerId: "2.2.2.2",
    neighbors: [{ address: "2001:db8:12::1", remoteAs: 65_001 }],
    ipv6Networks: [{ network: "2001:db8:b::", prefixLength: 64 }],
  });
  engine.runUntilIdle();
  return { engine, r1, r2 };
}

describe("BGP over IPv6 transport", () => {
  it("reaches Established through the simulated IPv6 stack and TCP/179", () => {
    const { r1, r2 } = ebgpIpv6();
    expect(r1.bgp.summaries()[0]).toMatchObject({
      address: "2001:db8:12::2",
      state: "established",
      localAddress: "2001:db8:12::1",
      addressFamilies: ["ipv6-unicast"],
    });
    expect(r2.bgp.summaries()[0]?.state).toBe("established");
  });

  it("stays down when an IPv6 ACL denies TCP/179", () => {
    const engine = createSimulationEngine({ seed: 10_131 });
    const r1 = addRouter(engine, "r1", 10, 1);
    const r2 = addRouter(engine, "r2", 20, 1);
    r1.setInterfaceIpv6("Gi0/0", "2001:db8:12::1", 64);
    r2.setInterfaceIpv6("Gi0/0", "2001:db8:12::2", 64);
    r2.defineIpv6Acl({
      id: "NO-BGP",
      type: "ipv6",
      rules: [{ sequence: 10, action: "deny", protocol: 6, source: { kind: "any" }, destination: { kind: "any" }, destinationPort: { kind: "eq", port: 179 } }],
    });
    r2.applyIpv6Acl("Gi0/0", "in", "NO-BGP");
    engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
    r1.bgp.configure({ localAs: 65_001, routerId: "1.1.1.1", neighbors: [{ address: "2001:db8:12::2", remoteAs: 65_002 }] });
    r2.bgp.configure({ localAs: 65_002, routerId: "2.2.2.2", neighbors: [{ address: "2001:db8:12::1", remoteAs: 65_001 }] });
    engine.runUntilIdle();
    expect(r1.bgp.summaries()[0]?.state).not.toBe("established");
  });

  it("reports an unreachable neighbor against the IPv6 routing table", () => {
    const engine = createSimulationEngine({ seed: 10_132 });
    const r1 = addRouter(engine, "r1", 10, 1);
    r1.setInterfaceIpv6("Gi0/0", "2001:db8:12::1", 64);
    r1.bgp.configure({ localAs: 65_001, routerId: "1.1.1.1", neighbors: [{ address: "2001:db8:99::9", remoteAs: 65_002 }] });
    engine.runUntilIdle();
    expect(r1.bgp.summaries()[0]?.lastError).toMatch(/IPv6 routing table/);
  });
});

describe("IPv6 unicast NLRI", () => {
  it("originates a network statement only while an exact IPv6 route exists", () => {
    const { r1 } = ebgpIpv6();
    expect(r1.bgp.selectedRoutes("ipv6-unicast").map((route) => `${route.network}/${route.prefixLength}`))
      .toContain("2001:db8:a::/64");
    r1.bgp.setIpv6Networks([{ network: "2001:db8:ff::", prefixLength: 64 }]);
    expect(r1.bgp.selectedRoutes("ipv6-unicast").some((route) => route.network === "2001:db8:ff::")).toBe(false);
  });

  it("installs the eBGP path with its IPv6 next hop and distance 20", () => {
    const { r1 } = ebgpIpv6();
    const learned = r1.bgp.selectedRoutes("ipv6-unicast").find((route) => route.network === "2001:db8:b::");
    expect(learned).toMatchObject({ addressFamily: "ipv6-unicast", nextHop: "2001:db8:12::2", source: "ebgp", asPath: [65_002] });
    expect(r1.ipv6RoutingTable()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bgp", network: "2001:db8:b::", administrativeDistance: 20 }),
    ]));
  });

  it("carries customer traffic over the learned IPv6 path", () => {
    const { engine, r1 } = ebgpIpv6(10_133);
    r1.ping6("2001:db8:b::1", 1);
    engine.runUntilIdle();
    expect(r1.ipv6PingResults).toContainEqual(expect.objectContaining({ sequence: 1, success: true }));
  });

  it("keeps the IPv4 and IPv6 RIBs completely separate", () => {
    const { r1 } = ebgpIpv6(10_134);
    expect(r1.bgp.selectedRoutes("ipv4-unicast")).toHaveLength(0);
    expect(r1.bgp.selectedRoutes("ipv6-unicast").length).toBeGreaterThan(0);
    expect(r1.bgp.routes("ipv6-unicast").every((route) => route.addressFamily === "ipv6-unicast")).toBe(true);
  });

  it("tags received UPDATE trace events with their address family", () => {
    const { engine } = ebgpIpv6(10_135);
    const ipv6Update = engine.traceLog.find((entry) =>
      entry.type === "bgp-update-received" && entry.detail?.addressFamily === "ipv6-unicast");
    expect(ipv6Update?.detail?.announced).toBeGreaterThan(0);
  });
});

describe("IPv6 unicast policy", () => {
  it.each([
    ["exact prefix", { prefix: "2001:db8:b::", prefixLength: 64 }, true],
    ["covering prefix without le", { prefix: "2001:db8::", prefixLength: 32 }, false],
    ["covering prefix with le 64", { prefix: "2001:db8::", prefixLength: 32, le: 64 }, true],
    ["covering prefix with le 48", { prefix: "2001:db8::", prefixLength: 32, le: 48 }, false],
    ["ge 64 le 128", { prefix: "2001:db8::", prefixLength: 32, ge: 64, le: 128 }, true],
    ["ge 96", { prefix: "2001:db8::", prefixLength: 32, ge: 96 }, false],
    ["other prefix", { prefix: "2001:db9::", prefixLength: 32, le: 64 }, false],
  ])("permits a /64 through an IPv6 prefix list with %s: %s", (_name, entry, permitted) => {
    const { engine, r1 } = ebgpIpv6(10_136);
    r1.bgp.routingPolicy.setIpv6PrefixLists([{ id: "CUSTOMER6", entries: [{ sequence: 10, action: "permit", ...entry }] }]);
    r1.bgp.configure({
      ...r1.bgp.configurationSnapshot()!,
      neighbors: [{ address: "2001:db8:12::2", remoteAs: 65_002, ipv6: { prefixListIn: "CUSTOMER6" } }],
    });
    engine.runUntilIdle();
    expect(r1.bgp.selectedRoutes("ipv6-unicast").some((route) => route.network === "2001:db8:b::")).toBe(permitted);
  });

  it("matches an IPv6 route map on `match ipv6 address prefix-list` only", () => {
    const { engine, r1 } = ebgpIpv6(10_137);
    r1.bgp.routingPolicy.setIpv6PrefixLists([{ id: "CUSTOMER6", entries: [{ sequence: 10, action: "permit", prefix: "2001:db8:b::", prefixLength: 64 }] }]);
    r1.bgp.routingPolicy.setPrefixLists([{ id: "CUSTOMER4", entries: [{ sequence: 10, action: "permit", prefix: "10.0.0.0", prefixLength: 8, le: 32 }] }]);
    r1.bgp.routingPolicy.setRouteMaps([
      { id: "V6-IN", sequences: [{ sequence: 10, action: "permit", match: { ipv6PrefixListIds: ["CUSTOMER6"] }, set: { localPreference: 250 } }] },
      // An IPv4 clause can never decide an IPv6 route, so this map denies it.
      { id: "V4-IN", sequences: [{ sequence: 10, action: "permit", match: { prefixListIds: ["CUSTOMER4"] } }] },
    ]);
    r1.bgp.configure({
      ...r1.bgp.configurationSnapshot()!,
      neighbors: [{ address: "2001:db8:12::2", remoteAs: 65_002, ipv6: { routeMapIn: "V6-IN" } }],
    });
    engine.runUntilIdle();
    expect(r1.bgp.selectedRoutes("ipv6-unicast").find((route) => route.network === "2001:db8:b::")?.localPreference).toBe(250);

    r1.bgp.configure({
      ...r1.bgp.configurationSnapshot()!,
      neighbors: [{ address: "2001:db8:12::2", remoteAs: 65_002, ipv6: { routeMapIn: "V4-IN" } }],
    });
    engine.runUntilIdle();
    expect(r1.bgp.selectedRoutes("ipv6-unicast").some((route) => route.network === "2001:db8:b::")).toBe(false);
  });

  it("holds a no-export IPv6 prefix at the eBGP boundary", () => {
    const engine = createSimulationEngine({ seed: 10_138 });
    const r1 = addRouter(engine, "r1", 10, 2);
    const r2 = addRouter(engine, "r2", 20, 2);
    const r3 = addRouter(engine, "r3", 30, 2);
    r1.setInterfaceIpv6("Gi0/0", "2001:db8:12::1", 64);
    r2.setInterfaceIpv6("Gi0/0", "2001:db8:12::2", 64);
    r2.setInterfaceIpv6("Gi0/1", "2001:db8:23::2", 64);
    r3.setInterfaceIpv6("Gi0/1", "2001:db8:23::3", 64);
    r1.setInterfaceIpv6("Gi0/1", "2001:db8:a::1", 64);
    engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
    engine.connect("r2", "Gi0/1", "r3", "Gi0/1");
    r1.bgp.routingPolicy.setRouteMaps([
      { id: "TAG", sequences: [{ sequence: 10, action: "permit", set: { communities: ["no-export"] } }] },
    ]);
    r1.bgp.configure({
      localAs: 65_001,
      routerId: "1.1.1.1",
      neighbors: [{ address: "2001:db8:12::2", remoteAs: 65_002, ipv6: { routeMapOut: "TAG", sendCommunityStandard: true } }],
      ipv6Networks: [{ network: "2001:db8:a::", prefixLength: 64 }],
    });
    r2.bgp.configure({
      localAs: 65_002,
      routerId: "2.2.2.2",
      neighbors: [
        { address: "2001:db8:12::1", remoteAs: 65_001 },
        { address: "2001:db8:23::3", remoteAs: 65_003 },
      ],
    });
    r3.bgp.configure({ localAs: 65_003, routerId: "3.3.3.3", neighbors: [{ address: "2001:db8:23::2", remoteAs: 65_002 }] });
    engine.runUntilIdle();
    expect(r2.bgp.selectedRoutes("ipv6-unicast").some((route) => route.network === "2001:db8:a::")).toBe(true);
    expect(r3.bgp.selectedRoutes("ipv6-unicast").some((route) => route.network === "2001:db8:a::")).toBe(false);
  });
});

describe("Dual-stack BGP", () => {
  /** One TCP session, two activated families, two independent RIBs. */
  function dualStack(seed = 10_140) {
    const engine = createSimulationEngine({ seed });
    const r1 = addRouter(engine, "r1", 10, 2);
    const r2 = addRouter(engine, "r2", 20, 2);
    r1.configureInterface("Gi0/0", { ip: "192.0.2.1", mask: 30 });
    r2.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
    r1.setInterfaceIpv6("Gi0/0", "2001:db8:12::1", 64);
    r2.setInterfaceIpv6("Gi0/0", "2001:db8:12::2", 64);
    r1.configureInterface("Gi0/1", { ip: "10.1.0.1", mask: 24 });
    r1.setInterfaceIpv6("Gi0/1", "2001:db8:a::1", 64);
    r2.configureInterface("Gi0/1", { ip: "10.2.0.1", mask: 24 });
    r2.setInterfaceIpv6("Gi0/1", "2001:db8:b::1", 64);
    engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
    for (const [device, localAs, routerId, peer, v4, v6] of [
      [r1, 65_001, "1.1.1.1", "192.0.2.2", "10.1.0.0", "2001:db8:a::"],
      [r2, 65_002, "2.2.2.2", "192.0.2.1", "10.2.0.0", "2001:db8:b::"],
    ] as const) {
      device.bgp.configure({
        localAs,
        routerId,
        neighbors: [{ address: peer, remoteAs: localAs === 65_001 ? 65_002 : 65_001, ipv6: { activated: true } }],
        networks: [{ network: v4, prefixLength: 24 }],
        ipv6Networks: [{ network: v6, prefixLength: 64 }],
      });
    }
    engine.runUntilIdle();
    return { engine, r1, r2 };
  }

  it("carries both families over one IPv4 TCP session", () => {
    const { r1 } = dualStack();
    expect(r1.bgp.summaries()[0]).toMatchObject({
      address: "192.0.2.2",
      state: "established",
      addressFamilies: ["ipv4-unicast", "ipv6-unicast"],
    });
    expect(r1.bgp.selectedRoutes("ipv4-unicast").some((route) => route.network === "10.2.0.0")).toBe(true);
    expect(r1.bgp.selectedRoutes("ipv6-unicast").some((route) => route.network === "2001:db8:b::")).toBe(true);
  });

  it("gives an IPv6 prefix an IPv6 next hop even over an IPv4 session", () => {
    const { r1 } = dualStack(10_141);
    expect(r1.bgp.selectedRoutes("ipv6-unicast").find((route) => route.network === "2001:db8:b::")?.nextHop)
      .toBe("2001:db8:12::2");
    expect(r1.bgp.selectedRoutes("ipv4-unicast").find((route) => route.network === "10.2.0.0")?.nextHop)
      .toBe("192.0.2.2");
  });

  it("applies policy per family without touching the other RIB", () => {
    const { engine, r1 } = dualStack(10_142);
    r1.bgp.routingPolicy.setIpv6PrefixLists([{ id: "BLOCK6", entries: [{ sequence: 10, action: "deny", prefix: "2001:db8:b::", prefixLength: 64 }] }]);
    r1.bgp.configure({
      ...r1.bgp.configurationSnapshot()!,
      neighbors: [{ address: "192.0.2.2", remoteAs: 65_002, ipv6: { activated: true, prefixListIn: "BLOCK6" } }],
    });
    engine.runUntilIdle();
    expect(r1.bgp.selectedRoutes("ipv6-unicast").some((route) => route.network === "2001:db8:b::")).toBe(false);
    expect(r1.bgp.selectedRoutes("ipv4-unicast").some((route) => route.network === "10.2.0.0")).toBe(true);
  });

  it("does not offer IPv4 unicast on an IPv6-transport neighbor", () => {
    const { r1 } = ebgpIpv6(10_143);
    expect(r1.bgp.summaries()[0]?.addressFamilies).not.toContain("ipv4-unicast");
  });
});

describe("iBGP and route reflection over IPv6", () => {
  it("reflects an IPv6 path to a client and stamps ORIGINATOR_ID", () => {
    const engine = createSimulationEngine({ seed: 10_150 });
    const rr = addRouter(engine, "rr", 10, 2);
    const c1 = addRouter(engine, "c1", 20, 2);
    const c2 = addRouter(engine, "c2", 30, 2);
    rr.setInterfaceIpv6("Gi0/0", "2001:db8:1::1", 64);
    c1.setInterfaceIpv6("Gi0/0", "2001:db8:1::2", 64);
    rr.setInterfaceIpv6("Gi0/1", "2001:db8:2::1", 64);
    c2.setInterfaceIpv6("Gi0/1", "2001:db8:2::2", 64);
    c1.setInterfaceIpv6("Gi0/1", "2001:db8:a::1", 64);
    engine.connect("rr", "Gi0/0", "c1", "Gi0/0");
    engine.connect("rr", "Gi0/1", "c2", "Gi0/1");
    rr.bgp.configure({
      localAs: 65_000,
      routerId: "10.0.0.1",
      neighbors: [
        { address: "2001:db8:1::2", remoteAs: 65_000, ipv6: { routeReflectorClient: true, nextHopSelf: false } },
        { address: "2001:db8:2::2", remoteAs: 65_000, ipv6: { routeReflectorClient: true, nextHopSelf: false } },
      ],
    });
    c1.bgp.configure({
      localAs: 65_000,
      routerId: "10.0.0.2",
      neighbors: [{ address: "2001:db8:1::1", remoteAs: 65_000, ipv6: { nextHopSelf: true } }],
      ipv6Networks: [{ network: "2001:db8:a::", prefixLength: 64 }],
    });
    c2.bgp.configure({
      localAs: 65_000,
      routerId: "10.0.0.3",
      neighbors: [{ address: "2001:db8:2::1", remoteAs: 65_000 }],
    });
    engine.runUntilIdle();
    expect(rr.bgp.routeReflectorClients()).toEqual(["2001:db8:1::2", "2001:db8:2::2"]);
    const reflected = c2.bgp.routes("ipv6-unicast").find((route) => route.network === "2001:db8:a::");
    expect(reflected).toMatchObject({ source: "ibgp", originatorId: "10.0.0.2" });
    expect(reflected?.clusterList).toEqual(["10.0.0.1"]);
  });
});

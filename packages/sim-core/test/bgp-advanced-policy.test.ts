import { describe, expect, it } from "vitest";
import {
  ControlProtocolConfigurationError,
  Router,
  RoutingPolicyEngine,
  createSimulationEngine,
  formatAsPathMatcher,
  macFromIndex,
  matchesAsPath,
  parseAsPathPattern,
  type AsPathMatcher,
  type BgpRoute,
} from "@sim/sim-core";

function route(overrides: Partial<BgpRoute> = {}): BgpRoute {
  return {
    network: "10.10.0.0",
    prefixLength: 16,
    origin: "igp",
    asPath: [65_001],
    nextHop: "192.0.2.1",
    localPreference: 100,
    med: 0,
    weight: 0,
    source: "ebgp",
    neighborAddress: "192.0.2.1",
    neighborAs: 65_001,
    neighborRouterId: "1.1.1.1",
    learnedAtNs: 1,
    routeId: "test-route",
    igpMetric: 0,
    communities: [],
    clusterList: [],
    ...overrides,
  };
}

function engineWithLists() {
  const policies = new RoutingPolicyEngine();
  policies.setCommunityLists([
    { id: "CUSTOMER", entries: [{ sequence: 10, action: "permit", communities: ["65000:100"] }] },
    { id: "TRANSIT", entries: [{ sequence: 10, action: "permit", communities: ["65000:200"] }] },
    { id: "BOTH", entries: [{ sequence: 10, action: "permit", communities: ["65000:100", "65000:200"] }] },
    { id: "BLOCKED", entries: [{ sequence: 10, action: "deny", communities: ["no-export"] }, { sequence: 20, action: "permit", communities: ["internet"] }] },
  ]);
  policies.setAsPathLists([
    { id: "LOCAL", entries: [{ sequence: 10, action: "permit", matcher: { kind: "empty" } }] },
    { id: "VIA-65001", entries: [{ sequence: 10, action: "permit", matcher: { kind: "contains", asn: 65_001 } }] },
  ]);
  return policies;
}

describe("safe AS-path matching", () => {
  it.each([
    ["^$", { kind: "empty" }],
    ["_65001_", { kind: "contains", asn: 65_001 }],
    ["^65001_", { kind: "starts-with", asn: 65_001 }],
    ["_65001$", { kind: "ends-with", asn: 65_001 }],
    ["^65001$", { kind: "exact", asPath: [65_001] }],
    ["^65001 65002$", { kind: "exact", asPath: [65_001, 65_002] }],
  ] as const)("parses the supported pattern %s", (pattern, expected) => {
    const matcher = parseAsPathPattern(pattern);
    expect(matcher).toEqual(expected);
    expect(formatAsPathMatcher(matcher)).toBe(pattern);
  });

  it.each([".*", "^(65001|65002)$", "_6500[12]_", "65001", "^$$", "_0_", "^.*65001.*$", "(a+)+$"])(
    "rejects the unsupported pattern %s instead of running it",
    (pattern) => expect(() => parseAsPathPattern(pattern)).toThrow(ControlProtocolConfigurationError),
  );

  it.each([
    ["empty matches an originated path", [], { kind: "empty" }, true],
    ["empty rejects a transited path", [65_001], { kind: "empty" }, false],
    ["contains finds a middle AS", [65_001, 65_002, 65_003], { kind: "contains", asn: 65_002 }, true],
    ["starts-with checks the first AS only", [65_001, 65_002], { kind: "starts-with", asn: 65_002 }, false],
    ["ends-with checks the origin AS", [65_001, 65_002], { kind: "ends-with", asn: 65_002 }, true],
    ["exact needs the whole path", [65_001, 65_002], { kind: "exact", asPath: [65_001] }, false],
    ["length eq", [65_001, 65_002], { kind: "length", operator: "eq", length: 2 }, true],
    ["length le", [65_001, 65_002, 65_003], { kind: "length", operator: "le", length: 2 }, false],
    ["length ge", [65_001, 65_002, 65_003], { kind: "length", operator: "ge", length: 3 }, true],
  ] as const)("%s", (_name, asPath, matcher, expected) => {
    expect(matchesAsPath(asPath, matcher as AsPathMatcher)).toBe(expected);
  });
});

describe("community and AS-path list matching", () => {
  it.each([
    ["single list permits", ["65000:100"], { communityListIds: ["CUSTOMER"] }, true],
    ["single list denies a missing community", ["65000:200"], { communityListIds: ["CUSTOMER"] }, false],
    ["several lists are OR-ed", ["65000:200"], { communityListIds: ["CUSTOMER", "TRANSIT"] }, true],
    ["match-all requires every list", ["65000:200"], { communityListIds: ["CUSTOMER", "TRANSIT"], communityMatchAll: true }, false],
    ["match-all succeeds when both permit", ["65000:100", "65000:200"], { communityListIds: ["CUSTOMER", "TRANSIT"], communityMatchAll: true }, true],
    ["an entry needs every listed community", ["65000:100"], { communityListIds: ["BOTH"] }, false],
    ["first match wins over a later permit", ["internet", "no-export"], { communityListIds: ["BLOCKED"] }, false],
    ["a later sequence still permits", ["internet"], { communityListIds: ["BLOCKED"] }, true],
    ["an undefined list denies", ["65000:100"], { communityListIds: ["MISSING"] }, false],
  ] as const)("%s", (_name, communities, match, expected) => {
    const policies = engineWithLists();
    policies.setRouteMaps([{ id: "M", sequences: [{ sequence: 10, action: "permit", match }] }]);
    expect(policies.evaluate(route({ communities: [...communities] }), { routeMapId: "M" }, 65_000).action)
      .toBe(expected ? "permit" : "deny");
  });

  it("AND-s a community match with an AS-path match", () => {
    const policies = engineWithLists();
    policies.setRouteMaps([{
      id: "M",
      sequences: [{ sequence: 10, action: "permit", match: { communityListIds: ["CUSTOMER"], asPathListIds: ["VIA-65001"] } }],
    }]);
    const tagged = route({ communities: ["65000:100"] });
    expect(policies.evaluate(tagged, { routeMapId: "M" }, 65_000).action).toBe("permit");
    expect(policies.evaluate({ ...tagged, asPath: [65_009] }, { routeMapId: "M" }, 65_000).action).toBe("deny");
  });

  it("counts community-list and AS-path-list matches and reports evaluations", () => {
    const policies = engineWithLists();
    policies.setRouteMaps([{
      id: "M",
      sequences: [{ sequence: 10, action: "permit", match: { communityListIds: ["CUSTOMER"], asPathListIds: ["VIA-65001"] } }],
    }]);
    const decision = policies.evaluate(route({ communities: ["65000:100"] }), { routeMapId: "M" }, 65_000);
    expect(decision.listEvaluations).toEqual([
      { policyType: "community-list", policyId: "CUSTOMER", sequence: 10, action: "permit" },
      { policyType: "as-path-list", policyId: "VIA-65001", sequence: 10, action: "permit" },
    ]);
    expect(policies.counterSummaries().map((counter) => counter.policyType).sort())
      .toEqual(["as-path-list", "community-list", "route-map"]);
  });
});

describe("route-map set actions", () => {
  it("prepends an explicit bounded AS list", () => {
    const policies = new RoutingPolicyEngine();
    policies.setRouteMaps([{ id: "M", sequences: [{ sequence: 10, action: "permit", set: { prependAsns: [65_000, 65_000] } }] }]);
    expect(policies.evaluate(route(), { routeMapId: "M" }, 65_000).route.asPath).toEqual([65_000, 65_000, 65_001]);
  });

  it.each([
    ["AS 0", [0]],
    ["an over-long prepend", Array.from({ length: 11 }, () => 65_000)],
    ["an empty list", []],
    ["a malformed ASN", [Number.NaN]],
  ])("rejects %s", (_name, prependAsns) => {
    const policies = new RoutingPolicyEngine();
    expect(() => policies.setRouteMaps([{ id: "M", sequences: [{ sequence: 10, action: "permit", set: { prependAsns } }] }]))
      .toThrow(ControlProtocolConfigurationError);
  });

  it("keeps the pre-M10.12 local-AS repeat count working", () => {
    const policies = new RoutingPolicyEngine();
    policies.setRouteMaps([{ id: "M", sequences: [{ sequence: 10, action: "permit", set: { prependLocalAs: 2 } }] }]);
    expect(policies.evaluate(route(), { routeMapId: "M" }, 65_000).route.asPath).toEqual([65_000, 65_000, 65_001]);
  });
});

/**
 * SITE originates three /24s inside 10.20.0.0/16 and peers with two ISPs. It is
 * the smallest topology that shows aggregation, summary-only suppression,
 * AS-path filtering, prepend and default-originate at once.
 */
function aggregationLab(seed = 10_140) {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const add = (id: string, base: number, ports: number) => {
    const router = engine.add(new Router(id, id.toUpperCase()));
    for (let index = 0; index < ports; index++) router.addInterface(`Gi0/${index}`, macFromIndex(base + index));
    return router;
  };
  const site = add("site", 1, 2);
  const isp1 = add("isp1", 10, 1);
  const isp2 = add("isp2", 20, 1);
  for (const [index, prefix] of ["10.20.1.1", "10.20.2.1", "10.20.3.1"].entries()) {
    site.getOrCreateLoopback(index);
    site.setInterfaceIp(`Loopback${index}`, prefix, 24);
  }
  site.configureInterface("Gi0/0", { ip: "192.0.2.1", mask: 30 });
  site.configureInterface("Gi0/1", { ip: "198.51.100.1", mask: 30 });
  isp1.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
  isp1.getOrCreateLoopback(0);
  isp1.setInterfaceIp("Loopback0", "203.0.113.1", 24);
  isp2.configureInterface("Gi0/0", { ip: "198.51.100.2", mask: 30 });
  engine.connect("site", "Gi0/0", "isp1", "Gi0/0");
  engine.connect("site", "Gi0/1", "isp2", "Gi0/0");
  isp1.bgp.configure({ localAs: 65_100, routerId: "10.0.1.1", neighbors: [{ address: "192.0.2.1", remoteAs: 65_000 }] });
  isp2.bgp.configure({ localAs: 65_200, routerId: "10.0.2.1", neighbors: [{ address: "198.51.100.1", remoteAs: 65_000 }] });
  return { engine, site, isp1, isp2 };
}

function configureSite(site: Router, overrides: Parameters<Router["bgp"]["configure"]>[0] extends infer T ? Partial<T> : never = {}) {
  site.bgp.configure({
    localAs: 65_000,
    routerId: "10.0.0.1",
    neighbors: [{ address: "192.0.2.2", remoteAs: 65_100 }, { address: "198.51.100.2", remoteAs: 65_200 }],
    networks: [
      { network: "10.20.1.0", prefixLength: 24 },
      { network: "10.20.2.0", prefixLength: 24 },
      { network: "10.20.3.0", prefixLength: 24 },
    ],
    ...overrides,
  });
}

function prefixes(device: Router, neighbor: string): string[] {
  return device.bgp.adjRibInEntries(neighbor).map((entry) => `${entry.network}/${entry.prefixLength}`).sort();
}

describe("BGP aggregation", () => {
  it("originates an aggregate only while a contributing route exists", () => {
    const { engine, site, isp1 } = aggregationLab();
    configureSite(site, { aggregates: [{ prefix: "10.20.0.0", prefixLength: 16 }] });
    engine.runUntilIdle();
    const aggregate = site.bgp.selectedRoutes().find((entry) => entry.network === "10.20.0.0");
    expect(aggregate).toMatchObject({ origin: "incomplete", asPath: [], nextHop: "0.0.0.0", source: "local" });
    expect(prefixes(isp1, "192.0.2.1")).toContain("10.20.0.0/16");
    expect(site.bgp.aggregateSummaries()[0]).toMatchObject({ active: true, contributingRoutes: 3 });
    expect(engine.traceLog.some((entry) => entry.type === "bgp-aggregate-originated")).toBe(true);

    site.bgp.setNetworks([]);
    engine.runUntilIdle();
    expect(site.bgp.selectedRoutes().some((entry) => entry.network === "10.20.0.0")).toBe(false);
    expect(prefixes(isp1, "192.0.2.1")).not.toContain("10.20.0.0/16");
    expect(engine.traceLog.some((entry) => entry.type === "bgp-aggregate-withdrawn")).toBe(true);
  });

  it("does not originate an aggregate with no contributing route at all", () => {
    const { engine, site } = aggregationLab(10_141);
    configureSite(site, { aggregates: [{ prefix: "172.16.0.0", prefixLength: 16 }] });
    engine.runUntilIdle();
    expect(site.bgp.selectedRoutes().some((entry) => entry.network === "172.16.0.0")).toBe(false);
    expect(site.bgp.aggregateSummaries()[0]).toMatchObject({ active: false, contributingRoutes: 0 });
  });

  it("summary-only suppresses advertisements but keeps the Loc-RIB intact", () => {
    const { engine, site, isp1 } = aggregationLab(10_142);
    configureSite(site, { aggregates: [{ prefix: "10.20.0.0", prefixLength: 16, summaryOnly: true }] });
    engine.runUntilIdle();
    expect(prefixes(isp1, "192.0.2.1")).toEqual(["10.20.0.0/16"]);
    expect(site.bgp.selectedRoutes().map((entry) => `${entry.network}/${entry.prefixLength}`).sort())
      .toEqual(["10.20.0.0/16", "10.20.1.0/24", "10.20.2.0/24", "10.20.3.0/24"]);
    expect(site.bgp.suppressedRoutes().map((entry) => entry.network)).toEqual(["10.20.1.0", "10.20.2.0", "10.20.3.0"]);
    expect(engine.traceLog.some((entry) => entry.type === "bgp-specific-suppressed")).toBe(true);
  });

  it("carries a deterministic sorted AS set when as-set is configured", () => {
    const { engine, site } = aggregationLab(10_143);
    configureSite(site, { aggregates: [{ prefix: "10.20.0.0", prefixLength: 16, asSet: true }] });
    engine.runUntilIdle();
    // Every contributor is locally originated, so the set is empty and stable.
    expect(site.bgp.selectedRoutes().find((entry) => entry.network === "10.20.0.0")?.asPath).toEqual([]);
    expect(() => site.bgp.configure({ localAs: 65_000, aggregates: [{ prefix: "10.20.0.1", prefixLength: 16 }] }))
      .toThrow(ControlProtocolConfigurationError);
  });
});

describe("BGP default-originate and soft reevaluation", () => {
  it("advertises 0.0.0.0/0 to exactly the configured neighbor without a local default", () => {
    const { engine, site, isp1, isp2 } = aggregationLab(10_144);
    configureSite(site, {
      neighbors: [
        { address: "192.0.2.2", remoteAs: 65_100, defaultOriginate: true },
        { address: "198.51.100.2", remoteAs: 65_200 },
      ],
    });
    engine.runUntilIdle();
    expect(prefixes(isp1, "192.0.2.1")).toContain("0.0.0.0/0");
    expect(prefixes(isp2, "198.51.100.1")).not.toContain("0.0.0.0/0");
    expect(site.bgp.selectedRoutes().some((entry) => entry.prefixLength === 0)).toBe(false);
    expect(site.routingTable().some((entry) => entry.kind === "bgp" && entry.network === "0.0.0.0")).toBe(false);
    expect(engine.traceLog.some((entry) => entry.type === "bgp-default-originated")).toBe(true);
  });

  it("lets a route map deny the originated default", () => {
    const { engine, site, isp1 } = aggregationLab(10_145);
    site.bgp.routingPolicy.setRouteMaps([{ id: "NO-DEFAULT", sequences: [{ sequence: 10, action: "deny" }] }]);
    configureSite(site, {
      neighbors: [
        { address: "192.0.2.2", remoteAs: 65_100, defaultOriginate: true, defaultOriginateRouteMap: "NO-DEFAULT" },
        { address: "198.51.100.2", remoteAs: 65_200 },
      ],
    });
    engine.runUntilIdle();
    expect(prefixes(isp1, "192.0.2.1")).not.toContain("0.0.0.0/0");
  });

  it("reevaluates policy on soft reset without resetting the TCP session", () => {
    const { engine, site, isp1 } = aggregationLab(10_146);
    configureSite(site);
    engine.runUntilIdle();
    expect(prefixes(isp1, "192.0.2.1")).toHaveLength(3);
    const before = site.bgp.summaries()[0]!;

    site.bgp.routingPolicy.setPrefixLists([{ id: "ONLY-ONE", entries: [{ sequence: 10, action: "permit", prefix: "10.20.1.0", prefixLength: 24 }] }]);
    configureSite(site, {
      neighbors: [{ address: "192.0.2.2", remoteAs: 65_100, prefixListOut: "ONLY-ONE" }, { address: "198.51.100.2", remoteAs: 65_200 }],
    });
    engine.runUntilIdle();
    site.bgp.softReset("192.0.2.2", "out");
    engine.runUntilIdle();

    expect(prefixes(isp1, "192.0.2.1")).toEqual(["10.20.1.0/24"]);
    expect(site.bgp.summaries()[0]?.state).toBe("established");
    expect(before.state).toBe("established");
    expect(engine.traceLog.some((entry) => entry.type === "bgp-soft-reevaluation")).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "bgp-session-reset")).toBe(false);
  });

  it("filters an inbound route with an AS-path list and prepends on the way out", () => {
    const { engine, site, isp1, isp2 } = aggregationLab(10_147);
    isp1.bgp.configure({
      localAs: 65_100,
      routerId: "10.0.1.1",
      neighbors: [{ address: "192.0.2.1", remoteAs: 65_000 }],
      networks: [{ network: "203.0.113.0", prefixLength: 24 }],
    });
    site.bgp.routingPolicy.setAsPathLists([{ id: "NO-TRANSIT", entries: [{ sequence: 10, action: "permit", matcher: parseAsPathPattern("_65100_") }] }]);
    site.bgp.routingPolicy.setRouteMaps([
      { id: "DROP-TRANSIT", sequences: [{ sequence: 10, action: "deny", match: { asPathListIds: ["NO-TRANSIT"] } }, { sequence: 20, action: "permit" }] },
      { id: "PREPEND", sequences: [{ sequence: 10, action: "permit", set: { prependAsns: [65_000, 65_000] } }] },
    ]);
    configureSite(site, {
      neighbors: [
        { address: "192.0.2.2", remoteAs: 65_100, routeMapIn: "DROP-TRANSIT" },
        { address: "198.51.100.2", remoteAs: 65_200, routeMapOut: "PREPEND" },
      ],
    });
    engine.runUntilIdle();

    const advertised = isp2.bgp.adjRibInEntries("198.51.100.1").find((entry) => entry.network === "10.20.1.0");
    expect(advertised?.asPath).toEqual([65_000, 65_000, 65_000]);
    // The transited prefix matched `_65100_` and was denied before the Loc-RIB.
    expect(site.bgp.selectedRoutes().some((entry) => entry.network === "203.0.113.0")).toBe(false);
    expect(engine.traceLog.some((entry) => entry.type === "as-path-list-evaluated")).toBe(true);
  });
});

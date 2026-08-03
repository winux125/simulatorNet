import { describe, expect, it } from "vitest";
import {
  ControlProtocolConfigurationError,
  Router,
  RoutingPolicyEngine,
  createSimulationEngine,
  macFromIndex,
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

describe("IPv4 prefix lists", () => {
  it.each([
    ["10.0.0.0", 8, "permit"],
    ["10.10.0.0", 16, "permit"],
    ["10.10.10.0", 24, "permit"],
    ["10.10.10.1", 32, "deny"],
    ["192.0.2.0", 24, "deny"],
  ] as const)("evaluates %s/%s using ge/le and implicit deny", (network, prefixLength, action) => {
    const policies = new RoutingPolicyEngine();
    policies.setPrefixLists([{ id: "PRIVATE", entries: [{ sequence: 10, action: "permit", prefix: "10.0.0.0", prefixLength: 8, ge: 8, le: 24 }] }]);
    expect(policies.evaluate(route({ network, prefixLength }), { prefixListId: "PRIVATE" }, 65_000).action).toBe(action);
  });

  it("uses the first matching sequence", () => {
    const policies = new RoutingPolicyEngine();
    policies.setPrefixLists([{ id: "ORDER", entries: [
      { sequence: 20, action: "permit", prefix: "10.0.0.0", prefixLength: 8, le: 32 },
      { sequence: 10, action: "deny", prefix: "10.10.0.0", prefixLength: 16 },
    ] }]);
    const decision = policies.evaluate(route(), { prefixListId: "ORDER" }, 1);
    expect(decision).toMatchObject({ action: "deny", matchedPrefixListSequence: 10 });
  });

  it.each([
    [{ sequence: 10, action: "permit" as const, prefix: "10.0.0.1", prefixLength: 24 }, "prefixList.prefix"],
    [{ sequence: 10, action: "permit" as const, prefix: "10.0.0.0", prefixLength: 24, ge: 20 }, "prefixList.ge"],
    [{ sequence: 10, action: "permit" as const, prefix: "10.0.0.0", prefixLength: 24, ge: 28, le: 27 }, "prefixList.le"],
  ])("rejects invalid prefix-list configuration", (entry, field) => {
    const policies = new RoutingPolicyEngine();
    expect(() => policies.setPrefixLists([{ id: "BAD", entries: [entry] }])).toThrowError(ControlProtocolConfigurationError);
    try { policies.setPrefixLists([{ id: "BAD", entries: [entry] }]); } catch (error) {
      expect((error as ControlProtocolConfigurationError).field).toBe(field);
    }
  });
});

describe("route maps", () => {
  it("sets local preference, MED, weight, origin and bounded AS prepend", () => {
    const policies = new RoutingPolicyEngine();
    policies.setRouteMaps([{ id: "SET", sequences: [{
      sequence: 10,
      action: "permit",
      match: { source: "ebgp", maximumAsPathLength: 2 },
      set: { localPreference: 250, med: 50, weight: 100, origin: "incomplete", prependLocalAs: 2 },
    }] }]);
    expect(policies.evaluate(route(), { routeMapId: "SET" }, 65_000)).toMatchObject({
      action: "permit",
      matchedRouteMapSequence: 10,
      route: { localPreference: 250, med: 50, weight: 100, origin: "incomplete", asPath: [65_000, 65_000, 65_001] },
    });
  });

  it("uses implicit deny when no route-map sequence matches", () => {
    const policies = new RoutingPolicyEngine();
    policies.setRouteMaps([{ id: "ONLY-IBGP", sequences: [{ sequence: 10, action: "permit", match: { source: "ibgp" } }] }]);
    expect(policies.evaluate(route(), { routeMapId: "ONLY-IBGP" }, 1)).toMatchObject({ action: "deny", reason: "route-map ONLY-IBGP implicit deny" });
  });

  it("keeps deterministic runtime counters outside configuration", () => {
    const policies = new RoutingPolicyEngine();
    policies.setRouteMaps([{ id: "COUNT", sequences: [{ sequence: 10, action: "deny" }] }]);
    policies.evaluate(route(), { routeMapId: "COUNT" }, 1);
    policies.evaluate(route(), { routeMapId: "COUNT" }, 1);
    expect(policies.counterSummaries()).toEqual([{
      policyType: "route-map", policyId: "COUNT", sequence: 10, matches: 2, permits: 0, denies: 2,
    }]);
    expect(policies.routeMapConfigurations()[0]).not.toHaveProperty("matches");
  });
});

describe("BGP policy integration", () => {
  function policyPair() {
    const engine = createSimulationEngine({ seed: 909 });
    engine.enableTrace();
    const r1 = engine.add(new Router("policy-r1", "R1"));
    const r2 = engine.add(new Router("policy-r2", "R2"));
    r1.addInterface("Gi0/0", macFromIndex(501));
    r2.addInterface("Gi0/0", macFromIndex(502));
    r1.configureInterface("Gi0/0", { ip: "192.0.2.1", mask: 30 });
    r2.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
    r1.getOrCreateLoopback(0);
    r1.setInterfaceIp("Loopback0", "10.10.10.1", 24);
    engine.connect(r1.id, "Gi0/0", r2.id, "Gi0/0");
    r2.bgp.routingPolicy.setPrefixLists([{ id: "FROM-R1", entries: [{ sequence: 10, action: "permit", prefix: "10.10.10.0", prefixLength: 24 }] }]);
    r1.bgp.configure({
      localAs: 65_001,
      routerId: "1.1.1.1",
      networks: [{ network: "10.10.10.0", prefixLength: 24 }],
      neighbors: [{ address: "192.0.2.2", remoteAs: 65_002 }],
    });
    r2.bgp.configure({
      localAs: 65_002,
      routerId: "2.2.2.2",
      neighbors: [{ address: "192.0.2.1", remoteAs: 65_001, prefixListIn: "FROM-R1" }],
    });
    return { engine, r1, r2 };
  }

  it("re-evaluates inbound routes after a policy change without resetting the session", () => {
    const { engine, r2 } = policyPair();
    engine.runUntilIdle();
    expect(r2.bgp.selectedRoutes().some((entry) => entry.network === "10.10.10.0")).toBe(true);
    const messagesBefore = r2.bgp.summaries()[0]?.messagesReceived;

    r2.bgp.routingPolicy.setPrefixLists([{ id: "FROM-R1", entries: [{ sequence: 10, action: "deny", prefix: "10.10.10.0", prefixLength: 24 }] }]);
    engine.runUntilIdle();
    expect(r2.bgp.selectedRoutes().some((entry) => entry.network === "10.10.10.0")).toBe(false);
    expect(r2.bgp.summaries()[0]).toMatchObject({ state: "established", messagesReceived: messagesBefore });
    expect(engine.traceLog.some((entry) => entry.type === "bgp-policy-deny")).toBe(true);
  });

  it("applies outbound AS prepend after protocol export rules", () => {
    const { engine, r1, r2 } = policyPair();
    r1.bgp.routingPolicy.setRouteMaps([{ id: "PREPEND", sequences: [{ sequence: 10, action: "permit", set: { prependLocalAs: 2 } }] }]);
    const snapshot = r1.bgp.configurationSnapshot()!;
    r1.bgp.configure({ ...snapshot, neighbors: snapshot.neighbors?.map((neighbor) => ({ ...neighbor, routeMapOut: "PREPEND" })) });
    engine.runUntilIdle();
    expect(r2.bgp.selectedRoutes().find((entry) => entry.network === "10.10.10.0")?.asPath).toEqual([65_001, 65_001, 65_001]);
  });
});

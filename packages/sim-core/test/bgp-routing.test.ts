import { describe, expect, it } from "vitest";
import {
  Router,
  compareBgpPaths,
  createSimulationEngine,
  macFromIndex,
  selectBestBgpPath,
  type BgpRoute,
} from "@sim/sim-core";

function candidate(overrides: Partial<BgpRoute> = {}): BgpRoute {
  return {
    network: "203.0.113.0",
    prefixLength: 24,
    origin: "igp",
    asPath: [65_100],
    nextHop: "10.0.0.2",
    localPreference: 100,
    med: 0,
    weight: 0,
    source: "ebgp",
    neighborAddress: "10.0.0.2",
    neighborAs: 65_100,
    neighborRouterId: "1.1.1.1",
    learnedAtNs: 100,
    routeId: "route-a",
    igpMetric: 10,
    communities: [],
    clusterList: [],
    ...overrides,
  };
}

function threeAsChain() {
  const engine = createSimulationEngine({ seed: 10_102 });
  engine.enableTrace();
  const routers = [1, 2, 3].map((index) => {
    const router = engine.add(new Router(`r${index}`, `R${index}`));
    router.addInterface("Gi0/0", macFromIndex(index * 10));
    router.addInterface("Gi0/1", macFromIndex(index * 10 + 1));
    router.getOrCreateLoopback(0);
    router.setInterfaceIp("Loopback0", `192.168.${index}.1`, 24);
    return router;
  });
  const [r1, r2, r3] = routers as [Router, Router, Router];
  r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 30 });
  r2.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 30 });
  r2.configureInterface("Gi0/1", { ip: "10.0.23.2", mask: 30 });
  r3.configureInterface("Gi0/0", { ip: "10.0.23.3", mask: 30 });
  engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
  engine.connect("r2", "Gi0/1", "r3", "Gi0/0");
  r1.bgp.configure({
    localAs: 65_001,
    routerId: "1.1.1.1",
    neighbors: [{ address: "10.0.12.2", remoteAs: 65_002 }],
    networks: [
      { network: "192.168.1.0", prefixLength: 24 },
      { network: "10.0.12.0", prefixLength: 30 },
    ],
  });
  r2.bgp.configure({
    localAs: 65_002,
    routerId: "2.2.2.2",
    neighbors: [
      { address: "10.0.12.1", remoteAs: 65_001 },
      { address: "10.0.23.3", remoteAs: 65_003 },
    ],
  });
  r3.bgp.configure({
    localAs: 65_003,
    routerId: "3.3.3.3",
    neighbors: [{ address: "10.0.23.2", remoteAs: 65_002 }],
    networks: [{ network: "192.168.3.0", prefixLength: 24 }],
  });
  return { engine, r1, r2, r3 };
}

describe("BGP best-path selection", () => {
  it.each([
    ["weight", candidate({ weight: 100 }), candidate({ weight: 0 })],
    ["local preference", candidate({ localPreference: 200 }), candidate({ localPreference: 100 })],
    ["locally originated", candidate({ source: "local" }), candidate({ source: "ebgp" })],
    ["AS path length", candidate({ asPath: [1] }), candidate({ asPath: [1, 2] })],
    ["origin", candidate({ origin: "igp" }), candidate({ origin: "incomplete" })],
    ["eBGP over iBGP", candidate({ source: "ebgp" }), candidate({ source: "ibgp" })],
    ["IGP metric", candidate({ igpMetric: 5 }), candidate({ igpMetric: 10 })],
    ["oldest", candidate({ learnedAtNs: 5 }), candidate({ learnedAtNs: 10 })],
  ])("prefers %s", (_reason, preferred, other) => {
    expect(selectBestBgpPath([other as BgpRoute, preferred as BgpRoute])).toBe(preferred);
    expect(compareBgpPaths(preferred as BgpRoute, other as BgpRoute)).toBeLessThan(0);
  });

  it("compares MED only for paths from the same neighboring AS", () => {
    const low = candidate({ med: 10, neighborAs: 65_100, routeId: "low" });
    const highSameAs = candidate({ med: 20, neighborAs: 65_100, routeId: "high" });
    const otherAsOlder = candidate({ med: 999, neighborAs: 65_200, learnedAtNs: 1, routeId: "other" });
    expect(selectBestBgpPath([highSameAs, low])?.routeId).toBe("low");
    expect(selectBestBgpPath([low, otherAsOlder])?.routeId).toBe("other");
  });
});

describe("BGP RIB and forwarding", () => {
  it("originates exact local RIB networks and propagates AS_PATH across eBGP", () => {
    const { engine, r1 } = threeAsChain();
    engine.runUntilIdle();

    const route = r1.bgp.selectedRoutes().find((entry) => entry.network === "192.168.3.0");
    expect(route).toMatchObject({ source: "ebgp", asPath: [65_002, 65_003], nextHop: "10.0.12.2" });
    expect(r1.routingTable().find((entry) => entry.network === "192.168.3.0")).toMatchObject({
      kind: "bgp",
      administrativeDistance: 20,
    });

    r1.getInterface("Gi0/0")!.shutdown();
    engine.runUntilIdle();
    expect(r1.bgp.summaries()[0]).toMatchObject({
      state: "active",
      lastError: "neighbor is not reachable through the IPv4 routing table",
    });
    expect(r1.bgp.selectedRoutes().some((entry) => entry.network === "192.168.3.0")).toBe(false);
  });

  it("forwards routed ICMP over a BGP-learned path", () => {
    const { engine, r1 } = threeAsChain();
    engine.runUntilIdle();
    r1.ping("192.168.3.1", 10);
    engine.runUntilIdle();
    expect(r1.pingResults.at(-1)).toMatchObject({ sequence: 10, success: true });
  });

  it("withdraws a network without rebuilding topology", () => {
    const { engine, r1, r3 } = threeAsChain();
    engine.runUntilIdle();
    expect(r1.bgp.selectedRoutes().some((route) => route.network === "192.168.3.0")).toBe(true);

    r3.bgp.setNetworks([]);
    engine.runUntilIdle();
    expect(r1.bgp.selectedRoutes().some((route) => route.network === "192.168.3.0")).toBe(false);
    expect(engine.traceLog.some((entry) => entry.type === "bgp-route-withdrawn" || (
      entry.type === "bgp-update-sent" && Number(entry.detail?.withdrawn ?? 0) > 0))).toBe(true);
  });

  it("does not originate a network without an exact local RIB route", () => {
    const { engine, r1, r2 } = threeAsChain();
    r1.bgp.setNetworks([{ network: "198.51.100.0", prefixLength: 24 }]);
    engine.runUntilIdle();
    expect(r2.bgp.adjRibInEntries("10.0.12.1")).toEqual([]);
  });

  it("keeps Adj-RIB-In, Loc-RIB and Adj-RIB-Out separate", () => {
    const { engine, r2 } = threeAsChain();
    engine.runUntilIdle();
    expect(r2.bgp.adjRibInEntries().length).toBeGreaterThanOrEqual(3);
    expect(r2.bgp.selectedRoutes().length).toBeGreaterThanOrEqual(3);
    expect(r2.bgp.adjRibOutEntries().length).toBeGreaterThanOrEqual(3);
  });

  it("uses distance 200 for iBGP and does not advertise iBGP-learned routes to iBGP", () => {
    const engine = createSimulationEngine({ seed: 77 });
    const [r1, r2, r3] = [1, 2, 3].map((index) => {
      const router = engine.add(new Router(`ibgp-${index}`, `IBGP${index}`));
      router.addInterface("Gi0/0", macFromIndex(300 + index * 2));
      router.addInterface("Gi0/1", macFromIndex(301 + index * 2));
      router.getOrCreateLoopback(0);
      router.setInterfaceIp("Loopback0", `172.16.${index}.1`, 24);
      return router;
    }) as [Router, Router, Router];
    r1.configureInterface("Gi0/0", { ip: "10.1.12.1", mask: 30 });
    r2.configureInterface("Gi0/0", { ip: "10.1.12.2", mask: 30 });
    r2.configureInterface("Gi0/1", { ip: "10.1.23.2", mask: 30 });
    r3.configureInterface("Gi0/0", { ip: "10.1.23.3", mask: 30 });
    engine.connect(r1.id, "Gi0/0", r2.id, "Gi0/0");
    engine.connect(r2.id, "Gi0/1", r3.id, "Gi0/0");
    r1.bgp.configure({
      localAs: 65_000,
      routerId: "1.1.1.1",
      neighbors: [{ address: "10.1.12.2", remoteAs: 65_000 }],
      networks: [{ network: "172.16.1.0", prefixLength: 24 }],
    });
    r2.bgp.configure({
      localAs: 65_000,
      routerId: "2.2.2.2",
      neighbors: [
        { address: "10.1.12.1", remoteAs: 65_000 },
        { address: "10.1.23.3", remoteAs: 65_000 },
      ],
    });
    r3.bgp.configure({
      localAs: 65_000,
      routerId: "3.3.3.3",
      neighbors: [{ address: "10.1.23.2", remoteAs: 65_000 }],
    });
    engine.runUntilIdle();

    expect(r2.routingTable().find((route) => route.network === "172.16.1.0")).toMatchObject({
      kind: "bgp",
      administrativeDistance: 200,
    });
    expect(r3.bgp.selectedRoutes().some((route) => route.network === "172.16.1.0")).toBe(false);
  });
});

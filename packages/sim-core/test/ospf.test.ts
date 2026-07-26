import { describe, expect, it } from "vitest";
import {
  ControlProtocolConfigurationError,
  createSimulationEngine,
  DEFAULT_OSPF_DEAD_INTERVAL_NS,
  L2Switch,
  Layer3Switch,
  macFromIndex,
  NS_PER_S,
  type OspfNeighborSummary,
  Router,
  type SimulationEngine,
} from "@sim/sim-core";

function tracedEngine(seed: number): SimulationEngine {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  return engine;
}

function addRouter(engine: SimulationEngine, id: string, macBase: number, ports = 3): Router {
  const router = engine.add(new Router(id, id.toUpperCase()));
  for (let index = 0; index < ports; index++) router.addInterface(`Gi0/${index}`, macFromIndex(macBase + index));
  return router;
}

function startOspf(router: Router | Layer3Switch, routerId?: string): void {
  router.ospf.createProcess(1);
  if (routerId !== undefined) router.ospf.setRouterId(routerId);
  router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
}

function neighborOf(router: Router, routerId: string): OspfNeighborSummary | undefined {
  return router.ospf.neighborSummaries().find((neighbor) => neighbor.neighborRouterId === routerId);
}

function traceTypes(engine: SimulationEngine, ...types: string[]): number {
  return engine.traceLog.filter((entry) => types.includes(entry.type)).length;
}

function routeFor(router: Router, network: string): ReturnType<Router["routingTable"]>[number] | undefined {
  return router.routingTable().find((route) => route.network === network && route.kind === "ospf");
}

/** R1 (10.0.12.1) — (10.0.12.2) R2 (10.0.23.2) — (10.0.23.3) R3, point-to-point. */
interface Chain {
  engine: SimulationEngine;
  r1: Router;
  r2: Router;
  r3: Router;
}

function buildChain(seed = 7): Chain {
  const engine = tracedEngine(seed);
  const r1 = addRouter(engine, "r1", 10);
  const r2 = addRouter(engine, "r2", 20);
  const r3 = addRouter(engine, "r3", 30);
  r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 24 });
  r2.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 24 });
  r2.configureInterface("Gi0/1", { ip: "10.0.23.2", mask: 24 });
  r3.configureInterface("Gi0/0", { ip: "10.0.23.3", mask: 24 });
  r1.getOrCreateLoopback(0);
  r1.setInterfaceIp("Loopback0", "1.1.1.1", 32);
  r2.getOrCreateLoopback(0);
  r2.setInterfaceIp("Loopback0", "2.2.2.2", 32);
  r3.getOrCreateLoopback(0);
  r3.setInterfaceIp("Loopback0", "3.3.3.3", 32);
  engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
  engine.connect("r2", "Gi0/1", "r3", "Gi0/0");
  for (const router of [r1, r2, r3]) {
    startOspf(router);
    for (const iface of ["Gi0/0", "Gi0/1"]) {
      router.ospf.configureInterface(iface, { networkType: "point-to-point" });
    }
    router.ospf.setPassiveInterface("Loopback0", true);
  }
  return { engine, r1, r2, r3 };
}

describe("OSPF adjacency", () => {
  it("brings two point-to-point routers to Full", () => {
    const { engine, r1, r2 } = buildChain();
    engine.runUntilIdle();

    expect(neighborOf(r1, "2.2.2.2")?.state).toBe("full");
    expect(neighborOf(r2, "1.1.1.1")?.state).toBe("full");
    expect(neighborOf(r1, "2.2.2.2")?.role).toBe("point-to-point");
    expect(traceTypes(engine, "ospf-hello-sent")).toBeGreaterThan(0);
    expect(traceTypes(engine, "ospf-hello-received")).toBeGreaterThan(0);
  });

  it("converges a three-router chain", () => {
    const { engine, r1, r3 } = buildChain();
    engine.runUntilIdle();

    expect(r1.ospf.overview().routerId).toBe("1.1.1.1");
    expect(r3.ospf.overview().routerId).toBe("3.3.3.3");
    expect(r1.ospf.neighborSummaries().every((neighbor) => neighbor.state === "full")).toBe(true);
    expect(r3.ospf.neighborSummaries().every((neighbor) => neighbor.state === "full")).toBe(true);
    expect(r1.ospf.database().length).toBeGreaterThanOrEqual(3);
  });

  it("shows every neighbour state transition in order", () => {
    const { engine } = buildChain();
    engine.runUntilIdle();

    const states = engine.traceLog
      .filter((entry) => entry.device === "r1" && entry.type === "ospf-neighbor-state-changed")
      .map((entry) => String(entry.detail?.state));
    expect(states).toEqual(["init", "two-way", "exstart", "exchange", "loading", "full"]);
  });
});

describe("OSPF router id selection", () => {
  it("uses the configured router id", () => {
    const engine = tracedEngine(11);
    const r1 = addRouter(engine, "r1", 10);
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    startOspf(r1, "9.9.9.9");
    engine.runUntilIdle();

    expect(r1.ospf.overview()).toMatchObject({ routerId: "9.9.9.9", routerIdSource: "configured" });
  });

  it("falls back to the highest active loopback address", () => {
    const engine = tracedEngine(13);
    const r1 = addRouter(engine, "r1", 10);
    r1.configureInterface("Gi0/0", { ip: "192.168.0.1", mask: 24 });
    r1.getOrCreateLoopback(0);
    r1.setInterfaceIp("Loopback0", "1.1.1.1", 32);
    r1.getOrCreateLoopback(1);
    r1.setInterfaceIp("Loopback1", "5.5.5.5", 32);
    startOspf(r1);
    engine.runUntilIdle();

    expect(r1.ospf.overview()).toMatchObject({ routerId: "5.5.5.5", routerIdSource: "loopback" });
  });

  it("falls back to the highest active interface address", () => {
    const engine = tracedEngine(17);
    const r1 = addRouter(engine, "r1", 10);
    const peers = engine.add(new L2Switch("sw1", "SW1"));
    peers.addInterface("Gi0/1", macFromIndex(201));
    peers.addInterface("Gi0/2", macFromIndex(202));
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    r1.configureInterface("Gi0/1", { ip: "172.16.0.1", mask: 24 });
    // Only an up/up interface can supply the router id, exactly as on a router.
    engine.connect("r1", "Gi0/0", "sw1", "Gi0/1");
    engine.connect("r1", "Gi0/1", "sw1", "Gi0/2");
    startOspf(r1);
    engine.runUntilIdle();

    expect(r1.ospf.overview()).toMatchObject({ routerId: "172.16.0.1", routerIdSource: "interface" });
  });

  it("cannot start the process without a usable address", () => {
    const engine = tracedEngine(19);
    const r1 = addRouter(engine, "r1", 10);
    startOspf(r1);
    engine.runUntilIdle();

    const overview = r1.ospf.overview();
    expect(overview.routerId).toBeUndefined();
    expect(overview.routerIdSource).toBe("none");
    expect(overview.problems.some((problem) => problem.includes("no usable IPv4 address"))).toBe(true);
  });

  it("keeps the router id stable until the process is restarted", () => {
    const engine = tracedEngine(23);
    const r1 = addRouter(engine, "r1", 10);
    const peer = engine.add(new L2Switch("sw1", "SW1"));
    peer.addInterface("Gi0/1", macFromIndex(201));
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    engine.connect("r1", "Gi0/0", "sw1", "Gi0/1");
    startOspf(r1);
    engine.runUntilIdle();
    expect(r1.ospf.overview().routerId).toBe("10.0.0.1");

    r1.getOrCreateLoopback(0);
    r1.setInterfaceIp("Loopback0", "8.8.8.8", 32);
    engine.runUntilIdle();
    expect(r1.ospf.overview().routerId).toBe("10.0.0.1");

    r1.ospf.restart();
    engine.runUntilIdle();
    expect(r1.ospf.overview().routerId).toBe("8.8.8.8");
  });
});

describe("OSPF activation and rejection", () => {
  it("activates an interface through a network statement", () => {
    const engine = tracedEngine(29);
    const r1 = addRouter(engine, "r1", 10);
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    r1.configureInterface("Gi0/1", { ip: "172.16.0.1", mask: 24 });
    r1.ospf.createProcess(1);
    r1.ospf.setRouterId("1.1.1.1");
    r1.ospf.addNetwork("10.0.0.0", "0.0.0.255", 0);
    engine.runUntilIdle();

    expect(r1.ospf.interfaceSummaries().map((iface) => iface.interfaceId)).toEqual(["Gi0/0"]);
  });

  it("lets interface configuration take precedence over network statements", () => {
    const engine = tracedEngine(31);
    const r1 = addRouter(engine, "r1", 10);
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    r1.configureInterface("Gi0/1", { ip: "172.16.0.1", mask: 24 });
    r1.ospf.createProcess(1);
    r1.ospf.setRouterId("1.1.1.1");
    r1.ospf.addNetwork("10.0.0.0", "0.0.0.255", 0);
    r1.ospf.configureInterface("Gi0/0", { enabled: false });
    r1.ospf.configureInterface("Gi0/1", { enabled: true });
    engine.runUntilIdle();

    expect(r1.ospf.interfaceSummaries().map((iface) => iface.interfaceId)).toEqual(["Gi0/1"]);
  });

  it("advertises a passive interface without forming an adjacency on it", () => {
    const { engine, r1, r2 } = buildChain();
    engine.runUntilIdle();

    const loopback = r1.ospf.interfaceSummaries().find((iface) => iface.interfaceId === "Loopback0");
    expect(loopback).toMatchObject({ passive: true, neighborCount: 0, networkType: "loopback" });
    // The loopback prefix still reaches the other routers.
    expect(routeFor(r2, "1.1.1.1")).toBeDefined();
  });

  it("rejects an adjacency when the hello interval differs", () => {
    const { engine, r1, r2 } = buildChain();
    r2.ospf.configureInterface("Gi0/0", { helloIntervalNs: 5 * NS_PER_S });
    engine.runUntilIdle();

    expect(neighborOf(r1, "2.2.2.2")).toBeUndefined();
    expect(r1.ospf.overview().problems.some((problem) => problem.includes("hello interval mismatch"))).toBe(true);
    expect(traceTypes(engine, "ospf-adjacency-rejected")).toBeGreaterThan(0);
  });

  it("rejects an adjacency when the dead interval differs", () => {
    const { engine, r1, r2 } = buildChain();
    r2.ospf.configureInterface("Gi0/0", { deadIntervalNs: 80 * NS_PER_S });
    engine.runUntilIdle();

    expect(neighborOf(r1, "2.2.2.2")).toBeUndefined();
    expect(r1.ospf.overview().problems.some((problem) => problem.includes("dead interval mismatch"))).toBe(true);
  });

  it("rejects an area other than the backbone", () => {
    const engine = tracedEngine(37);
    const r1 = addRouter(engine, "r1", 10);
    expect(() => r1.ospf.addNetwork("10.0.0.0", "0.0.0.255", 1))
      .toThrowError(ControlProtocolConfigurationError);
    expect(() => r1.ospf.configureInterface("Gi0/0", { area: 2 })).toThrowError(/area 0 is supported/);
  });

  it("rejects a neighbour that claims our own router id", () => {
    const engine = tracedEngine(41);
    const r1 = addRouter(engine, "r1", 10);
    const r2 = addRouter(engine, "r2", 20);
    r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 24 });
    r2.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 24 });
    engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
    startOspf(r1, "1.1.1.1");
    startOspf(r2, "1.1.1.1");
    engine.runUntilIdle();

    expect(r1.ospf.neighborSummaries()).toEqual([]);
    expect(r1.ospf.overview().problems.some((problem) => problem.includes("duplicate router id"))).toBe(true);
  });

  it("refuses a second OSPF process", () => {
    const engine = tracedEngine(43);
    const r1 = addRouter(engine, "r1", 10);
    r1.ospf.createProcess(1);
    expect(() => r1.ospf.createProcess(2)).toThrowError(/one process per device/);
  });
});

describe("OSPF broadcast segments", () => {
  interface Segment {
    engine: SimulationEngine;
    routers: Router[];
  }

  function buildSegment(priorities: number[], seed = 51): Segment {
    const engine = tracedEngine(seed);
    const sw = engine.add(new L2Switch("sw1", "SW1"));
    const routers = priorities.map((priority, index) => {
      const router = addRouter(engine, `r${index + 1}`, 10 + index * 10, 1);
      router.configureInterface("Gi0/0", { ip: `10.0.0.${index + 1}`, mask: 24 });
      sw.addInterface(`Gi0/${index + 1}`, macFromIndex(200 + index));
      engine.connect(`r${index + 1}`, "Gi0/0", "sw1", `Gi0/${index + 1}`);
      startOspf(router, `${index + 1}.${index + 1}.${index + 1}.${index + 1}`);
      router.ospf.configureInterface("Gi0/0", { priority });
      return router;
    });
    return { engine, routers };
  }

  it("elects the highest priority as DR and the next as BDR", () => {
    const { engine, routers } = buildSegment([10, 200, 100]);
    engine.runUntilIdle();

    const view = routers[0]!.ospf.interfaceSummaries()[0]!;
    expect(view.designatedRouter).toBe("10.0.0.2"); // priority 200
    expect(view.backupDesignatedRouter).toBe("10.0.0.3"); // priority 100
    expect(traceTypes(engine, "ospf-dr-elected")).toBeGreaterThan(0);
    expect(traceTypes(engine, "ospf-bdr-elected")).toBeGreaterThan(0);
  });

  it("excludes a priority-zero router from the election", () => {
    const { engine, routers } = buildSegment([0, 1, 1]);
    engine.runUntilIdle();

    const view = routers[1]!.ospf.interfaceSummaries()[0]!;
    expect(view.designatedRouter).not.toBe("10.0.0.1");
    expect([view.designatedRouter, view.backupDesignatedRouter]).not.toContain("10.0.0.1");
  });

  it("breaks a priority tie with the higher router id", () => {
    const { engine, routers } = buildSegment([1, 1, 1]);
    engine.runUntilIdle();

    expect(routers[0]!.ospf.interfaceSummaries()[0]!.designatedRouter).toBe("10.0.0.3");
  });

  it("re-elects deterministically when the DR disappears", () => {
    const { engine, routers } = buildSegment([1, 1, 1]);
    engine.runUntilIdle();
    const first = routers[0]!.ospf.interfaceSummaries()[0]!.designatedRouter;
    expect(first).toBe("10.0.0.3");

    // R3's own link goes down. R1 and R2 keep their links up, so they learn
    // about it only when the dead interval expires — exactly like real routers.
    routers[2]!.getInterface("Gi0/0")!.shutdown();
    engine.runUntilIdle();
    for (const router of routers) router.ospf.arm();
    engine.advanceTo(engine.now() + DEFAULT_OSPF_DEAD_INTERVAL_NS + 2 * NS_PER_S);

    const second = routers[0]!.ospf.interfaceSummaries()[0]!.designatedRouter;
    expect(second).toBe("10.0.0.2");
    expect(second).not.toBe(first);
    expect(routers[0]!.ospf.neighborSummaries().map((neighbor) => neighbor.neighborRouterId))
      .toEqual(["2.2.2.2"]);
  });

  it("originates a Network LSA from the designated router", () => {
    const { engine, routers } = buildSegment([1, 1, 1]);
    engine.runUntilIdle();

    const database = routers[0]!.ospf.database();
    const networkLsa = database.find((entry) => entry.type === "network");
    expect(networkLsa).toBeDefined();
    expect(networkLsa!.advertisingRouter).toBe("3.3.3.3");
    expect(networkLsa!.linkCount).toBeGreaterThanOrEqual(2);
  });
});

describe("OSPF link-state database and SPF", () => {
  it("originates a Router LSA per router and synchronizes the database", () => {
    const { engine, r1, r2, r3 } = buildChain();
    engine.runUntilIdle();

    for (const router of [r1, r2, r3]) {
      const routerLsas = router.ospf.database().filter((entry) => entry.type === "router");
      expect(routerLsas.map((entry) => entry.advertisingRouter).sort())
        .toEqual(["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
    }
    expect(traceTypes(engine, "ospf-lsa-originated")).toBeGreaterThan(0);
    expect(traceTypes(engine, "ospf-lsa-flooded")).toBeGreaterThan(0);
    expect(traceTypes(engine, "ospf-lsa-acknowledged")).toBeGreaterThan(0);
  });

  it("installs a remote prefix learned only through SPF", () => {
    const { engine, r1 } = buildChain();
    engine.runUntilIdle();

    const remote = routeFor(r1, "3.3.3.3");
    expect(remote).toMatchObject({ kind: "ospf", administrativeDistance: 110, egressName: "Gi0/0" });
    expect(remote!.viaIp).toBe("10.0.12.2");
    expect(traceTypes(engine, "ospf-spf-started", "ospf-spf-completed")).toBeGreaterThan(0);
    expect(traceTypes(engine, "ospf-route-installed")).toBeGreaterThan(0);
  });

  it("suppresses a duplicate LSA", () => {
    const { engine, r1 } = buildChain();
    engine.runUntilIdle();
    const before = r1.ospf.database().length;
    const spfBefore = r1.ospf.overview().spfRuns;

    r1.ospf.arm();
    engine.runUntilIdle();

    expect(r1.ospf.database().length).toBe(before);
    // The LSDB did not change, so no new LSA was flooded on its account.
    expect(r1.ospf.database().map((entry) => entry.sequence))
      .toEqual(r1.ospf.database().map((entry) => entry.sequence));
    expect(r1.ospf.overview().spfRuns).toBeGreaterThan(spfBefore);
  });

  it("keeps hello and dead intervals in virtual nanoseconds", () => {
    const { engine, r1 } = buildChain();
    engine.runUntilIdle();

    const iface = r1.ospf.interfaceSummaries().find((entry) => entry.interfaceId === "Gi0/0")!;
    expect(iface.helloIntervalNs).toBe(10 * NS_PER_S);
    expect(iface.deadIntervalNs).toBe(DEFAULT_OSPF_DEAD_INTERVAL_NS);
    expect(neighborOf(r1, "2.2.2.2")!.deadTimeNs).toBeLessThanOrEqual(DEFAULT_OSPF_DEAD_INTERVAL_NS);
    expect(engine.now()).toBeGreaterThan(0);
  });
});

describe("OSPF route selection", () => {
  it("prefers a static route over the OSPF route for the same prefix", () => {
    const { engine, r1 } = buildChain();
    engine.runUntilIdle();
    expect(routeFor(r1, "3.3.3.3")).toBeDefined();

    r1.addStaticRoute("3.3.3.3", 32, "10.0.12.2");
    engine.runUntilIdle();

    const rows = r1.routingTable().filter((route) => route.network === "3.3.3.3");
    expect(rows.map((route) => route.kind)).toEqual(["static"]);
    expect(rows[0]!.administrativeDistance).toBe(1);
  });

  it("keeps the longest prefix regardless of the route source", () => {
    const { engine, r1 } = buildChain();
    r1.addStaticRoute("3.0.0.0", 8, "10.0.12.2");
    engine.runUntilIdle();

    // The /32 learned by OSPF is more specific than the configured /8.
    const specific = routeFor(r1, "3.3.3.3");
    expect(specific).toBeDefined();
    expect(r1.routingTable().some((route) => route.kind === "static" && route.network === "3.0.0.0")).toBe(true);
  });

  it("follows the cheaper path when an interface cost changes", () => {
    const engine = tracedEngine(61);
    const [r1, r2, r3, r4] = ["r1", "r2", "r3", "r4"].map((id, index) => addRouter(engine, id, 10 + index * 10, 3));
    // A square: R1—R2, R1—R3, R2—R4, R3—R4.
    r1!.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 24 });
    r2!.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 24 });
    r1!.configureInterface("Gi0/1", { ip: "10.0.13.1", mask: 24 });
    r3!.configureInterface("Gi0/0", { ip: "10.0.13.3", mask: 24 });
    r2!.configureInterface("Gi0/1", { ip: "10.0.24.2", mask: 24 });
    r4!.configureInterface("Gi0/0", { ip: "10.0.24.4", mask: 24 });
    r3!.configureInterface("Gi0/1", { ip: "10.0.34.3", mask: 24 });
    r4!.configureInterface("Gi0/1", { ip: "10.0.34.4", mask: 24 });
    engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
    engine.connect("r1", "Gi0/1", "r3", "Gi0/0");
    engine.connect("r2", "Gi0/1", "r4", "Gi0/0");
    engine.connect("r3", "Gi0/1", "r4", "Gi0/1");
    [r1, r2, r3, r4].forEach((router, index) => {
      router!.getOrCreateLoopback(0);
      router!.setInterfaceIp("Loopback0", `${index + 1}.${index + 1}.${index + 1}.${index + 1}`, 32);
      startOspf(router!);
      for (const iface of ["Gi0/0", "Gi0/1"]) {
        router!.ospf.configureInterface(iface, { networkType: "point-to-point" });
      }
      router!.ospf.setPassiveInterface("Loopback0", true);
    });
    engine.runUntilIdle();
    expect(routeFor(r1!, "4.4.4.4")?.egressName).toBe("Gi0/0");

    r1!.ospf.configureInterface("Gi0/0", { cost: 500 });
    engine.runUntilIdle();

    expect(routeFor(r1!, "4.4.4.4")?.egressName).toBe("Gi0/1");
  });

  it("withdraws the route and reconverges when a link fails", () => {
    const { engine, r1, r2 } = buildChain();
    engine.runUntilIdle();
    expect(routeFor(r1, "3.3.3.3")).toBeDefined();

    r2.getInterface("Gi0/1")!.shutdown();
    engine.runUntilIdle();

    expect(routeFor(r1, "3.3.3.3")).toBeUndefined();
    expect(traceTypes(engine, "ospf-route-withdrawn")).toBeGreaterThan(0);
    expect(neighborOf(r2, "3.3.3.3")).toBeUndefined();
  });

  it("leaves the ACL and NAT pipeline untouched", () => {
    const { engine, r1 } = buildChain();
    r1.defineAcl({ id: "1", type: "standard", rules: [{ sequence: 10, action: "deny", source: { kind: "any" } }] });
    r1.applyAcl("Gi0/0", "in", "1");
    engine.runUntilIdle();

    // OSPF is terminated before the policy pipeline, so it forms anyway.
    expect(neighborOf(r1, "2.2.2.2")?.state).toBe("full");
    expect(traceTypes(engine, "acl-evaluated", "acl-denied", "acl-implicit-deny")).toBe(0);
  });
});

describe("OSPF on a layer-3 switch", () => {
  it("runs the process through the composed routing plane", () => {
    const engine = tracedEngine(71);
    const l3 = engine.add(new Layer3Switch("l3", "L3SW"));
    for (let index = 1; index <= 3; index++) l3.addInterface(`Gi0/${index}`, macFromIndex(300 + index));
    l3.setIpRouting(true);
    l3.configureRoutedInterface("Gi0/1", "10.0.12.1", 24);
    const r2 = addRouter(engine, "r2", 20);
    r2.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 24 });
    r2.getOrCreateLoopback(0);
    r2.setInterfaceIp("Loopback0", "2.2.2.2", 32);
    engine.connect("l3", "Gi0/1", "r2", "Gi0/0");
    for (const device of [l3, r2]) {
      startOspf(device, device === l3 ? "9.9.9.9" : "2.2.2.2");
      device.ospf.configureInterface(device === l3 ? "Gi0/1" : "Gi0/0", { networkType: "point-to-point" });
    }
    r2.ospf.setPassiveInterface("Loopback0", true);
    engine.runUntilIdle();

    expect(l3.ospf.overview().routerId).toBe("9.9.9.9");
    expect(l3.ospf.neighborSummaries()[0]).toMatchObject({ neighborRouterId: "2.2.2.2", state: "full" });
    expect(l3.routingTable().some((route) => route.kind === "ospf" && route.network === "2.2.2.2")).toBe(true);
  });
});

describe("OSPF configuration, determinism and limits", () => {
  it("keeps neighbours, the LSDB and learned routes out of the configuration", () => {
    const { engine, r1 } = buildChain();
    engine.runUntilIdle();
    expect(r1.ospf.database().length).toBeGreaterThan(0);

    const configuration = r1.ospf.configuration();
    expect(configuration).toMatchObject({ processId: 1, passiveInterfaces: ["Loopback0"] });
    const serialized = JSON.stringify(configuration);
    for (const runtimeField of ["full", "sequence", "checksum", "designatedRouter", "2.2.2.2"]) {
      expect(serialized).not.toContain(runtimeField);
    }

    r1.ospf.resetRuntime();
    expect(r1.ospf.database()).toEqual([]);
    expect(r1.ospf.neighborSummaries()).toEqual([]);
    expect(r1.ospf.configuration()).toEqual(configuration);
  });

  it("restores the same state after clear ip ospf process", () => {
    const { engine, r1 } = buildChain();
    engine.runUntilIdle();
    const before = r1.ospf.database();
    const routesBefore = r1.routingTable().filter((route) => route.kind === "ospf");

    r1.ospf.restart();
    engine.runUntilIdle();

    expect(r1.ospf.database().map((entry) => entry.advertisingRouter).sort())
      .toEqual(before.map((entry) => entry.advertisingRouter).sort());
    expect(r1.routingTable().filter((route) => route.kind === "ospf").map((route) => route.network))
      .toEqual(routesBefore.map((route) => route.network));
  });

  it("produces a stable golden trace of the adjacency and SPF", () => {
    const { engine } = buildChain(83);
    engine.runUntilIdle();

    const golden = engine.traceLog
      .filter((entry) => entry.device === "r1")
      .filter((entry) => entry.type === "ospf-neighbor-state-changed" || entry.type === "ospf-route-installed")
      .map((entry) => `${entry.type}:${String(entry.detail?.state ?? entry.detail?.network)}`);

    expect(golden).toEqual([
      "ospf-neighbor-state-changed:init",
      "ospf-neighbor-state-changed:two-way",
      "ospf-neighbor-state-changed:exstart",
      "ospf-neighbor-state-changed:exchange",
      "ospf-neighbor-state-changed:loading",
      "ospf-neighbor-state-changed:full",
      "ospf-route-installed:2.2.2.2",
      "ospf-route-installed:10.0.23.0",
      "ospf-route-installed:3.3.3.3",
    ]);
  });

  it("reaches an identical routing table from two independent engine builds", () => {
    const first = buildChain(89);
    const second = buildChain(89);
    first.engine.runUntilIdle();
    second.engine.runUntilIdle();

    for (const key of ["r1", "r2", "r3"] as const) {
      expect(second[key].routingTable()).toEqual(first[key].routingTable());
      expect(second[key].ospf.database()).toEqual(first[key].ospf.database());
      expect(second[key].ospf.neighborSummaries()).toEqual(first[key].ospf.neighborSummaries());
    }
    expect(second.engine.now()).toBe(first.engine.now());
  });

  it("rejects out-of-range interface cost and priority", () => {
    const engine = tracedEngine(97);
    const r1 = addRouter(engine, "r1", 10);
    expect(() => r1.ospf.configureInterface("Gi0/0", { cost: 0 })).toThrowError(/cost must be between/);
    expect(() => r1.ospf.configureInterface("Gi0/0", { priority: 300 })).toThrowError(/priority must be between/);
    expect(() => r1.ospf.createProcess(0)).toThrowError(/process id must be between/);
  });

  it("bounds LSA retransmission and the per-operation event budget", () => {
    const { engine, r1 } = buildChain(101);
    engine.runUntilIdle();

    const budget = engine.controlProtocolBudget;
    expect(budget.consumed("ospfEvents")).toBeGreaterThan(0);
    expect(budget.consumed("ospfEvents")).toBeLessThan(budget.maximumOf("ospfEvents"));
    expect(budget.consumed("spfRuns")).toBeLessThanOrEqual(budget.maximumOf("spfRuns"));
    expect(budget.consumed("lsaFloods")).toBeLessThan(budget.maximumOf("lsaFloods"));
    expect(r1.ospf.overview().spfRuns).toBeGreaterThan(0);
  });
});

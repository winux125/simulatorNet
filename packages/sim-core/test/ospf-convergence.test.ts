import { describe, expect, it } from "vitest";
import {
  createSimulationEngine,
  macFromIndex,
  Router,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * M10.17.1 — deterministic OSPFv2 multi-router convergence.
 *
 * `ospf.test.ts` covers a two- and three-router chain, one broadcast segment
 * and the DR election. What it never exercises is a *core* router that brings
 * several segments to Full in the same activity window and then has to keep
 * every one of those neighbours synchronized with the link-state database.
 * That is where the M10.17 EVPN fabric lost the fifth leaf's loopback, so the
 * scenario is reproduced here without EVPN, BGP or VXLAN: plain OSPFv2, one
 * area, one Loopback per router.
 *
 *            R1
 *             |
 *   R2 —— [ CORE ] —— R3
 *            /  \
 *          R4    R5
 *
 * Every leaf owns a transit subnet `10.0.<n>.0/24` towards the core and a
 * Loopback `10.255.0.<n>/32`; the core is `10.255.0.9`. After a bounded run
 * every router must hold a route to every other router's Loopback.
 */

const CORE_LOOPBACK = "10.255.0.9";
const ROUTER_COUNTS = [3, 4, 5, 6] as const;

interface Hub {
  readonly engine: SimulationEngine;
  readonly core: Router;
  readonly leaves: readonly Router[];
  /** Core and leaves together, in stable order. */
  readonly routers: readonly Router[];
}

function leafLoopback(leafIndex: number): string {
  return `10.255.0.${leafIndex + 1}`;
}

function corePort(leafIndex: number): string {
  return `Gi0/${leafIndex}`;
}

/** One core router with `leafCount` point-to-multipoint style leaf segments. */
function buildHub(leafCount: number, options: { seed?: number; run?: "auto" | "step" } = {}): Hub {
  const engine = createSimulationEngine({ seed: options.seed ?? 10_171 });
  engine.enableTrace();
  const core = engine.add(new Router("core", "CORE"));
  core.getOrCreateLoopback(0);
  core.setInterfaceIp("Loopback0", CORE_LOOPBACK, 32);

  const leaves: Router[] = [];
  for (let index = 0; index < leafCount; index++) {
    const number = index + 1;
    const leaf = engine.add(new Router(`r${number}`, `R${number}`));
    leaf.addInterface("Gi0/0", macFromIndex(100 + number * 10));
    leaf.configureInterface("Gi0/0", { ip: `10.0.${number}.2`, mask: 24 });
    leaf.getOrCreateLoopback(0);
    leaf.setInterfaceIp("Loopback0", leafLoopback(index), 32);
    core.addInterface(corePort(index), macFromIndex(1 + index));
    core.configureInterface(corePort(index), { ip: `10.0.${number}.1`, mask: 24 });
    engine.connect("core", corePort(index), `r${number}`, "Gi0/0");
    leaves.push(leaf);
  }

  for (const router of [core, ...leaves]) {
    router.ospf.createProcess(1);
    router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    router.ospf.setPassiveInterface("Loopback0", true);
  }
  return { engine, core, leaves, routers: [core, ...leaves] };
}

function converge(engine: SimulationEngine, mode: "auto" | "step" = "auto"): void {
  if (mode === "auto") {
    engine.runUntilIdle();
    return;
  }
  // Step: one event at a time, exactly what the workspace's Step control does.
  let guard = 0;
  while (engine.runNextEvent()) {
    if (++guard > 1_000_000) throw new Error("step run did not terminate");
  }
}

function loopbackRoute(router: Router, loopback: string): string | undefined {
  const route = router.routingTable().find((row) => row.kind === "ospf" && row.network === loopback);
  return route === undefined ? undefined : `${route.viaIp ?? "-"} ${route.egressName} ad=${route.administrativeDistance}`;
}

/** Every router's view of every other router's Loopback, missing ones included. */
function loopbackReachability(hub: Hub): Record<string, string> {
  const view: Record<string, string> = {};
  for (const router of hub.routers) {
    const own = router.ospf.overview().routerId;
    for (const target of hub.routers) {
      if (target === router) continue;
      const loopback = target.ospf.overview().routerId!;
      view[`${own} -> ${loopback}`] = loopbackRoute(router, loopback) ?? "MISSING";
    }
  }
  return view;
}

function missingLoopbacks(hub: Hub): string[] {
  return Object.entries(loopbackReachability(hub))
    .filter(([, value]) => value === "MISSING")
    .map(([key]) => key);
}

/** The comparable link-state database: one line per LSA, canonically ordered. */
function databaseOf(router: Router): string[] {
  return router.ospf.database()
    .map((entry) => `${entry.type}/${entry.linkStateId}/${entry.advertisingRouter}/${entry.sequence}/${entry.checksum}`);
}

function ospfRoutesOf(router: Router): string[] {
  return router.routingTable()
    .filter((row) => row.kind === "ospf")
    .map((row) => `${row.network}/${row.maskInt} via ${row.viaIp ?? "-"} ${row.egressName} metric=${row.metric}`);
}

describe("OSPF multi-router convergence", () => {
  it.each(ROUTER_COUNTS)("reaches every remote loopback with %i leaves", (leafCount) => {
    const hub = buildHub(leafCount);
    converge(hub.engine);

    expect(missingLoopbacks(hub)).toEqual([]);
  });

  it.each(ROUTER_COUNTS)("synchronizes one identical link-state database with %i leaves", (leafCount) => {
    const hub = buildHub(leafCount);
    converge(hub.engine);

    // Every router in one area must hold byte-identical LSAs, so a stale or
    // never-delivered LSA is caught even where SPF happens to route around it.
    const reference = databaseOf(hub.core);
    expect(reference.length).toBe(2 * leafCount + 1); // one Router LSA each, one Network LSA per segment
    for (const router of hub.routers) expect(databaseOf(router)).toEqual(reference);
  });

  it.each(ROUTER_COUNTS)("keeps every adjacency Full with %i leaves", (leafCount) => {
    const hub = buildHub(leafCount);
    converge(hub.engine);

    expect(hub.core.ospf.neighborSummaries().map((neighbor) => neighbor.state))
      .toEqual(Array.from({ length: leafCount }, () => "full"));
    for (const leaf of hub.leaves) {
      expect(leaf.ospf.neighborSummaries().map((neighbor) => neighbor.neighborRouterId)).toEqual([CORE_LOOPBACK]);
    }
    expect(hub.core.ospf.overview().problems).toEqual([]);
  });

  it("withdraws the affected loopback when a leaf link fails and restores it afterwards", () => {
    const hub = buildHub(5);
    converge(hub.engine);
    const lastLeaf = hub.leaves[4]!;
    expect(loopbackRoute(hub.leaves[0]!, leafLoopback(4))).toBeDefined();

    hub.core.getInterface(corePort(4))!.shutdown();
    converge(hub.engine);

    expect(loopbackRoute(hub.leaves[0]!, leafLoopback(4))).toBeUndefined();
    expect(loopbackRoute(hub.leaves[1]!, leafLoopback(4))).toBeUndefined();
    // Only the failed segment is withdrawn; the rest of the fabric is intact.
    expect(loopbackRoute(hub.leaves[0]!, leafLoopback(3))).toBeDefined();
    expect(lastLeaf.ospf.neighborSummaries()).toEqual([]);

    hub.core.getInterface(corePort(4))!.noShutdown();
    converge(hub.engine);

    expect(missingLoopbacks(hub)).toEqual([]);
  });

  it("reaches the same state through Auto and through Step", () => {
    const auto = buildHub(5);
    const step = buildHub(5);
    converge(auto.engine, "auto");
    converge(step.engine, "step");

    expect(step.engine.now()).toBe(auto.engine.now());
    for (const [index, router] of step.routers.entries()) {
      expect(databaseOf(router)).toEqual(databaseOf(auto.routers[index]!));
      expect(ospfRoutesOf(router)).toEqual(ospfRoutesOf(auto.routers[index]!));
    }
    expect(loopbackReachability(step)).toEqual(loopbackReachability(auto));
  });

  it("repeats an identical run from the same topology and seed", () => {
    const first = buildHub(6);
    const second = buildHub(6);
    converge(first.engine);
    converge(second.engine);

    expect(second.engine.now()).toBe(first.engine.now());
    expect(loopbackReachability(second)).toEqual(loopbackReachability(first));
    for (const [index, router] of second.routers.entries()) {
      expect(databaseOf(router)).toEqual(databaseOf(first.routers[index]!));
      expect(router.routingTable()).toEqual(first.routers[index]!.routingTable());
    }
    expect(second.engine.traceLog.map((entry) => `${entry.time}/${entry.device}/${entry.type}`))
      .toEqual(first.engine.traceLog.map((entry) => `${entry.time}/${entry.device}/${entry.type}`));
  });

  it.each(ROUTER_COUNTS)("stays well inside the OSPF resource limits with %i leaves", (leafCount) => {
    const hub = buildHub(leafCount);
    converge(hub.engine);

    const budget = hub.engine.controlProtocolBudget;
    for (const key of ["ospfEvents", "lsaFloods", "adjacencyTransitions"] as const) {
      expect(budget.consumed(key)).toBeLessThan(budget.maximumOf(key) / 10);
    }
    // SPF is by far the tightest OSPF bound. A fabric of this size has to keep
    // real headroom under it, so that raising a limit is never mistaken for the
    // fix to a convergence gap.
    expect(budget.consumed("spfRuns")).toBeLessThan(budget.maximumOf("spfRuns") * 0.6);
  });
});

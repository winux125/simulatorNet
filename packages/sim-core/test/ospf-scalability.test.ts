import { describe, expect, it } from "vitest";
import {
  createSimulationEngine,
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  macFromIndex,
  Router,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * M10.17.2 — OSPFv2 SPF scalability.
 *
 * `maximumOspfRoutersPerLab` is 128 and `maximumSpfRunsPerOperation` is 256, so
 * a supported lab is allowed two SPF computations per router for a whole cold
 * start. M10.17.1 removed the runs an unchanged database produced, but every
 * *changed* input still starts its own walk: a router recomputes once per LSA
 * that arrives, and every router receives an advertisement from every other
 * one, so the number of computations grows with the square of the fabric.
 *
 * The generator below is deliberately shaped so that nothing *except* the SPF
 * budget can be the reason a large lab fails. A pure hub would need 127
 * adjacencies on its core and break `maximumOspfNeighborsPerDevice` (64) long
 * before that; a chain would make convergence depth rather than SPF the
 * subject. It therefore builds a bounded-fan-out tree in area 0: router `i`
 * attaches to router `floor((i - 1) / 32)`, which keeps the busiest device at
 * 33 adjacencies for every size up to 128 and the fabric two hops deep.
 *
 *        R0
 *      /  |  \        …32 children
 *    R1   R2  R3      …each with up to 32 of its own
 *   /  \
 * R33  R34 …
 *
 * Every link is a unique transit `/30`, every router owns a Loopback `/32` that
 * is also its router id, and the whole fabric is one area.
 */

/** Children per parent: bounded so no device approaches its neighbour limit. */
const FANOUT = 32;

/**
 * The largest single area this release converges with default link
 * performance.
 *
 * `maximumOspfRoutersPerLab` is 128, and that is what a lab may *describe*. A
 * single area does not converge at that size for a reason outside OSPF: a cold
 * start floods every advertisement across every adjacency in one burst, a
 * 128-router burst tail-drops on the default 256-packet link egress queue, and
 * a dropped update is permanent because nothing refreshes an LSA periodically.
 * Measured, that costs 1,472 dropped updates and leaves 127 of 128 routers
 * short; giving the same fabric a 4,096-packet queue drops nothing and
 * converges completely. Closing the gap needs either LSA refresh or a change to
 * the shared link model, neither of which belongs to this milestone.
 */
const SUPPORTED_CONVERGED_AREA_ROUTERS = 96;

/** Sizes small enough that an all-pairs assertion is still cheap and readable. */
const ALL_PAIRS_SIZES = [4, 8] as const;

/**
 * Sizes checked by deterministic sampling rather than all-pairs. The largest
 * supported area is deliberately not in this list: flooding is quadratic, so
 * one 128-router cold start costs more than every other size together and is
 * asserted once, in its own contract test.
 */
const SAMPLED_SIZES = [16, 32, 64] as const;

interface Fabric {
  readonly engine: SimulationEngine;
  readonly routers: readonly Router[];
}

function loopbackOf(index: number): string {
  return `10.255.0.${index + 1}`;
}

/** The transit subnet between router `index` and its parent. */
function transitNetworkOf(index: number): string {
  return `10.0.${index}.0`;
}

function parentIndexOf(index: number): number {
  return Math.floor((index - 1) / FANOUT);
}

function buildFabric(routerCount: number, options: { seed?: number; queueLimitPackets?: number } = {}): Fabric {
  const engine = createSimulationEngine({ seed: options.seed ?? 10_172 });
  const routers: Router[] = [];
  for (let index = 0; index < routerCount; index++) {
    const router = engine.add(new Router(`r${index}`, `R${index}`));
    router.getOrCreateLoopback(0);
    router.setInterfaceIp("Loopback0", loopbackOf(index), 32);
    routers.push(router);
  }
  for (let index = 1; index < routerCount; index++) {
    const parentIndex = parentIndexOf(index);
    const parentPort = `Gi0/${index}`;
    routers[parentIndex]!.addInterface(parentPort, macFromIndex(1_000 + index));
    routers[parentIndex]!.configureInterface(parentPort, { ip: `10.0.${index}.1`, mask: 30 });
    routers[index]!.addInterface("Gi0/0", macFromIndex(5_000 + index));
    routers[index]!.configureInterface("Gi0/0", { ip: `10.0.${index}.2`, mask: 30 });
    engine.connect(`r${parentIndex}`, parentPort, `r${index}`, "Gi0/0",
      options.queueLimitPackets === undefined ? undefined : { queueLimitPackets: options.queueLimitPackets });
  }
  for (const router of routers) {
    router.ospf.createProcess(1);
    router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    router.ospf.setPassiveInterface("Loopback0", true);
  }
  return { engine, routers };
}

function converge(engine: SimulationEngine, mode: "auto" | "step" = "auto"): void {
  if (mode === "auto") {
    engine.runUntilIdle();
    return;
  }
  let guard = 0;
  while (engine.runNextEvent()) {
    if (++guard > 1_000_000) throw new Error("step run did not terminate");
  }
}

function hasOspfRoute(router: Router, network: string): boolean {
  return router.routingTable().some((row) => row.kind === "ospf" && row.network === network);
}

/** First, middle and last router of a fabric — a stable, size-independent sample. */
function sampleIndexes(routerCount: number): number[] {
  return [...new Set([0, 1, routerCount >> 1, routerCount - 1])].sort((a, b) => a - b);
}

function databaseOf(router: Router): string[] {
  return router.ospf.database()
    .map((entry) => `${entry.type}/${entry.linkStateId}/${entry.advertisingRouter}/${entry.sequence}/${entry.checksum}`);
}

describe("OSPF SPF scalability", () => {
  it.each(ALL_PAIRS_SIZES)("reaches every loopback from every router with %i routers", (routerCount) => {
    const fabric = buildFabric(routerCount);
    converge(fabric.engine);

    const missing: string[] = [];
    for (const [index, router] of fabric.routers.entries()) {
      for (let target = 0; target < routerCount; target++) {
        if (target === index) continue;
        if (!hasOspfRoute(router, loopbackOf(target))) missing.push(`r${index} -> ${loopbackOf(target)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each(SAMPLED_SIZES)("converges a %i-router area without exhausting a resource limit", { timeout: 60_000 }, (routerCount) => {
    const fabric = buildFabric(routerCount);
    // A `ControlProtocolLimitError` here is the defect, not a test failure mode:
    // the fabric is inside every structural bound the contract advertises.
    converge(fabric.engine);

    // One Router LSA per router and one Network LSA per transit segment.
    const reference = databaseOf(fabric.routers[0]!);
    expect(reference.length).toBe(2 * routerCount - 1);
    for (const index of sampleIndexes(routerCount)) {
      expect(databaseOf(fabric.routers[index]!)).toEqual(reference);
    }

    const sample = sampleIndexes(routerCount);
    const missing: string[] = [];
    for (const index of sample) {
      for (const target of sample) {
        if (target === index) continue;
        if (!hasOspfRoute(fabric.routers[index]!, loopbackOf(target))) {
          missing.push(`r${index} -> ${loopbackOf(target)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps a cold start inside the per-operation SPF budget at every supported size", { timeout: 60_000 }, () => {
    const budget = DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumSpfRunsPerOperation;
    const observed: Array<{ routers: number; spfExecutions: number }> = [];
    for (const routerCount of [4, 8, 16, 32, 64] as const) {
      const fabric = buildFabric(routerCount);
      converge(fabric.engine);
      observed.push({ routers: routerCount, spfExecutions: fabric.engine.controlProtocolBudget.consumed("spfRuns") });
    }

    // The budget is per operation and lab-wide, so 128 supported routers may
    // spend at most two computations each for a whole cold start. Raising the
    // limit is explicitly not the fix: the scheduling has to coalesce instead.
    for (const entry of observed) {
      expect(entry.spfExecutions).toBeLessThanOrEqual(budget);
      expect(entry.spfExecutions).toBeLessThanOrEqual(2 * entry.routers);
    }
    // Linear in the fabric, not quadratic: on HEAD these were 47, 191 and then
    // the exhausted budget.
    expect(observed.map((entry) => entry.spfExecutions)).toEqual([4, 8, 16, 32, 64]);
  });

  it("recomputes a bounded number of times per router rather than once per advertisement", { timeout: 60_000 }, () => {
    const fabric = buildFabric(64);
    converge(fabric.engine);

    // The defect this pins down: a router restarts SPF for every LSA that
    // arrives, so the per-router count tracks the size of the fabric. A
    // coalesced schedule keeps it a small constant instead.
    const perRouter = fabric.routers.map((router) => router.ospf.spfCounters().executions);
    expect(perRouter).toHaveLength(64);
    expect(perRouter.filter((count) => count > 4)).toEqual([]);
    expect(perRouter.reduce((sum, count) => sum + count, 0))
      .toBe(fabric.engine.controlProtocolBudget.consumed("spfRuns"));
  });

  it("separates a request, a scheduled event and an actual computation", () => {
    const fabric = buildFabric(32);
    converge(fabric.engine);

    // The busiest router hears from all 31 others. Every arrival asks for a
    // recomputation; almost all of them are absorbed by an event that is
    // already scheduled, and exactly one walk is performed.
    const counters = fabric.routers[0]!.ospf.spfCounters();
    expect(counters.requests).toBeGreaterThan(100);
    expect(counters.coalescedRequests).toBe(counters.requests - counters.scheduledEvents);
    expect(counters.scheduledEvents).toBeLessThan(counters.requests / 10);
    expect(counters.executions).toBe(1);
    // Every scheduled event produced exactly one outcome, and an inspection
    // that flushed a pending computation may add one more.
    expect(counters.executions + counters.skippedUnchanged + counters.skippedEmptyTopology)
      .toBeGreaterThanOrEqual(counters.scheduledEvents);
    // Only real computations reach the budget.
    const totalExecutions = fabric.routers.reduce((sum, router) => sum + router.ospf.spfCounters().executions, 0);
    expect(totalExecutions).toBe(fabric.engine.controlProtocolBudget.consumed("spfRuns"));
  });

  it("does not lose an update that arrives while a computation is already scheduled", () => {
    const fabric = buildFabric(8);
    converge(fabric.engine);
    const leaf = fabric.routers[7]!;
    expect(hasOspfRoute(leaf, loopbackOf(3))).toBe(true);

    // Break and restore two segments in the same instant, so the second change
    // lands while the first one's SPF event is still pending — the shape that
    // silently dropped a recomputation before M10.17.1.
    fabric.routers[0]!.getInterface("Gi0/3")!.shutdown();
    fabric.routers[0]!.getInterface("Gi0/4")!.shutdown();
    converge(fabric.engine);
    expect(hasOspfRoute(leaf, loopbackOf(3))).toBe(false);
    expect(hasOspfRoute(leaf, loopbackOf(4))).toBe(false);

    fabric.routers[0]!.getInterface("Gi0/3")!.noShutdown();
    fabric.routers[0]!.getInterface("Gi0/4")!.noShutdown();
    converge(fabric.engine);

    expect(hasOspfRoute(leaf, loopbackOf(3))).toBe(true);
    expect(hasOspfRoute(leaf, loopbackOf(4))).toBe(true);
  });

  it("repeats an identical 32-router run from the same topology and seed", () => {
    const first = buildFabric(32);
    const second = buildFabric(32);
    converge(first.engine);
    converge(second.engine);

    expect(second.engine.now()).toBe(first.engine.now());
    expect(second.engine.controlProtocolBudget.consumed("spfRuns"))
      .toBe(first.engine.controlProtocolBudget.consumed("spfRuns"));
    for (const index of sampleIndexes(32)) {
      expect(databaseOf(second.routers[index]!)).toEqual(databaseOf(first.routers[index]!));
      expect(second.routers[index]!.routingTable()).toEqual(first.routers[index]!.routingTable());
    }
  });

  it("reaches the same 32-router state through Auto and through Step", () => {
    const auto = buildFabric(32);
    const step = buildFabric(32);
    converge(auto.engine, "auto");
    converge(step.engine, "step");

    expect(step.engine.now()).toBe(auto.engine.now());
    expect(step.engine.controlProtocolBudget.consumed("spfRuns"))
      .toBe(auto.engine.controlProtocolBudget.consumed("spfRuns"));
    for (const index of sampleIndexes(32)) {
      expect(databaseOf(step.routers[index]!)).toEqual(databaseOf(auto.routers[index]!));
      expect(step.routers[index]!.routingTable()).toEqual(auto.routers[index]!.routingTable());
    }
  });

  it("converges the largest single area the contract supports", { timeout: 120_000 }, () => {
    // Flooding is quadratic, so this is the single most expensive case in the
    // suite and is built exactly once. `SUPPORTED_CONVERGED_AREA_ROUTERS` is
    // smaller than `maximumOspfRoutersPerLab` on purpose — see the comment on
    // the constant, and `docs/ospf-simulation.md`.
    const routerCount = SUPPORTED_CONVERGED_AREA_ROUTERS;
    const fabric = buildFabric(routerCount);
    converge(fabric.engine);

    const reference = databaseOf(fabric.routers[0]!);
    expect(reference.length).toBe(2 * routerCount - 1);
    for (const index of sampleIndexes(routerCount)) {
      expect(databaseOf(fabric.routers[index]!)).toEqual(reference);
      expect(fabric.routers[index]!.ospf.overview().problems).toEqual([]);
    }

    const sample = sampleIndexes(routerCount);
    const missing: string[] = [];
    for (const index of sample) {
      for (const target of sample) {
        if (target === index) continue;
        if (!hasOspfRoute(fabric.routers[index]!, loopbackOf(target))) {
          missing.push(`r${index} -> ${loopbackOf(target)}`);
        }
      }
    }
    expect(missing).toEqual([]);

    const budget = fabric.engine.controlProtocolBudget;
    // Named individually so a future failure says *which* bound moved rather
    // than only that "a limit" was hit.
    expect(budget.consumed("spfRuns")).toBeLessThanOrEqual(budget.maximumOf("spfRuns"));
    expect(budget.consumed("ospfEvents")).toBeLessThan(budget.maximumOf("ospfEvents"));
    expect(budget.consumed("lsaFloods")).toBeLessThan(budget.maximumOf("lsaFloods"));
    expect(budget.consumed("adjacencyTransitions")).toBeLessThan(budget.maximumOf("adjacencyTransitions"));
    // One computation per router: the contract this milestone exists to meet.
    expect(budget.consumed("spfRuns")).toBe(routerCount);
    // The busiest device stays under the per-device adjacency bound, so the
    // fabric size is never limited by the shape of the generator instead.
    const busiest = Math.max(...fabric.routers.map((router) => router.ospf.neighborSummaries().length));
    expect(busiest).toBeLessThanOrEqual(DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumOspfNeighborsPerDevice);
  });

  it("attributes the largest describable area's shortfall to flood loss, not to SPF", { timeout: 180_000 }, () => {
    // This documents the boundary instead of hiding it. At
    // `maximumOspfRoutersPerLab` the cold start is inside every OSPF bound —
    // SPF included — and still leaves routers short, because the flood burst
    // overruns the link egress queue and a dropped update is never re-offered.
    const routerCount = DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumOspfRoutersPerLab;
    const fabric = buildFabric(routerCount);
    converge(fabric.engine);

    const budget = fabric.engine.controlProtocolBudget;
    expect(budget.consumed("spfRuns")).toBe(routerCount);
    expect(budget.consumed("spfRuns")).toBeLessThanOrEqual(budget.maximumOf("spfRuns"));
    expect(budget.consumed("lsaFloods")).toBeLessThan(budget.maximumOf("lsaFloods"));
    expect(budget.consumed("ospfEvents")).toBeLessThan(budget.maximumOf("ospfEvents"));
    // Every adjacency is Full, so this is not an adjacency defect either.
    const adjacencies = fabric.routers.reduce((sum, router) => sum + router.ospf.neighborSummaries().length, 0);
    expect(adjacencies).toBe(2 * (routerCount - 1));

    // What is left is the egress queue. Handing the same fabric a
    // 4,096-packet queue instead of the default 256 drops nothing and
    // converges all 255 advertisements onto all 128 routers; that control is
    // not re-run here because one 128-router cold start already dominates the
    // suite's runtime.
    const tailDrops = fabric.routers.reduce((sum, router) => {
      for (const iface of router.interfaces.values()) sum += iface.egress.snapshot().dropsByReason["tail-drop"] ?? 0;
      return sum;
    }, 0);
    expect(tailDrops).toBeGreaterThan(0);
    expect(Math.min(...fabric.routers.map((router) => router.ospf.database().length)))
      .toBeLessThan(2 * routerCount - 1);
  });

  it("installs every transit subnet of the fabric, not only the loopbacks", () => {
    const fabric = buildFabric(8);
    converge(fabric.engine);

    // R0 is attached to 10.0.1.0/30 … 10.0.7.0/30 only through its children in
    // this shape; a leaf is attached to exactly one of them and must learn the
    // rest through SPF.
    const leaf = fabric.routers[7]!;
    const remoteTransits = [1, 2, 3, 4, 5, 6].map(transitNetworkOf);
    expect(remoteTransits.filter((network) => !hasOspfRoute(leaf, network))).toEqual([]);
  });
});

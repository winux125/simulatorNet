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

/** Sizes the resource contract claims to support, smallest first. */
const FABRIC_SIZES = [4, 8, 16, 32, 64, 128] as const;

/** Sizes small enough that an all-pairs assertion is still cheap and readable. */
const ALL_PAIRS_SIZES = [4, 8] as const;

/** Sizes checked by deterministic sampling rather than all-pairs. */
const SAMPLED_SIZES = [16, 32, 64, 128] as const;

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

function buildFabric(routerCount: number, options: { seed?: number } = {}): Fabric {
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
    engine.connect(`r${parentIndex}`, parentPort, `r${index}`, "Gi0/0");
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

/** SPF computations the whole lab performed, taken from the deterministic trace. */
function spfExecutionsOf(engine: SimulationEngine): number {
  return engine.traceLog.filter((entry) => entry.type === "ospf-spf-started").length;
}

function spfExecutionsPerDevice(engine: SimulationEngine): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of engine.traceLog) {
    if (entry.type !== "ospf-spf-started") continue;
    counts.set(entry.device, (counts.get(entry.device) ?? 0) + 1);
  }
  return counts;
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

  it.each(SAMPLED_SIZES)("converges a %i-router area without exhausting a resource limit", (routerCount) => {
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

  it("keeps a cold start inside the per-operation SPF budget at every supported size", () => {
    const budget = DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumSpfRunsPerOperation;
    const observed: Array<{ routers: number; spfExecutions: number }> = [];
    for (const routerCount of FABRIC_SIZES) {
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
  });

  it("recomputes a bounded number of times per router rather than once per advertisement", () => {
    const fabric = buildFabric(64);
    converge(fabric.engine);

    // The defect this pins down: a router restarts SPF for every LSA that
    // arrives, so the per-router count tracks the size of the fabric. A
    // coalesced schedule keeps it a small constant instead.
    const perDevice = spfExecutionsPerDevice(fabric.engine);
    expect(perDevice.size).toBe(64);
    expect([...perDevice].filter(([, count]) => count > 4)).toEqual([]);
    expect(spfExecutionsOf(fabric.engine)).toBe(fabric.engine.controlProtocolBudget.consumed("spfRuns"));
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

  it("stays inside every other OSPF resource bound while it scales", () => {
    const fabric = buildFabric(128);
    converge(fabric.engine);

    const budget = fabric.engine.controlProtocolBudget;
    // Named individually so a future failure says *which* bound moved rather
    // than only that "a limit" was hit.
    expect(budget.consumed("ospfEvents")).toBeLessThan(budget.maximumOf("ospfEvents"));
    expect(budget.consumed("lsaFloods")).toBeLessThan(budget.maximumOf("lsaFloods"));
    expect(budget.consumed("adjacencyTransitions")).toBeLessThan(budget.maximumOf("adjacencyTransitions"));
    // The busiest device stays well under the per-device adjacency bound, so
    // the fabric size is never limited by the shape of the generator.
    const busiest = Math.max(...fabric.routers.map((router) => router.ospf.neighborSummaries().length));
    expect(busiest).toBeLessThanOrEqual(DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumOspfNeighborsPerDevice);
    expect(fabric.routers[0]!.ospf.overview().problems).toEqual([]);
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

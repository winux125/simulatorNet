import { describe, expect, it } from "vitest";
import {
  createSimulationEngine,
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  macFromIndex,
  Router,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * M10.17.3 — reliable OSPF flooding over finite queues.
 *
 * M10.17.2 made SPF linear: a 128-router area now costs one Dijkstra walk per
 * router and stays inside every OSPF bound. What it also measured is that the
 * same area still does not converge, and that the reason is *below* OSPF.
 *
 * A link is finite. A frame is queued on the transmitting interface and clocked
 * onto the wire at the link's capacity, and the default egress queue holds 256
 * packets. A cold start floods the whole database across every adjacency in one
 * burst, so the busiest router overruns that queue and part of the burst is
 * tail-dropped — and a tail drop is invisible to the sender. The measured chain
 * was:
 *
 *   LSA originated
 *   → the update is accepted by the OSPF sender
 *   → the egress queue tail-drops the packet
 *   → the receiver never installs the advertisement
 *   → the sender never offers it again
 *   → convergence is incomplete, for ever.
 *
 * The last step is the defect. The retransmission list was written when an
 * advertisement was flooded and never read again, so no timer ever noticed the
 * missing acknowledgement, and because nothing here refreshes an LSA and
 * duplicate suppression stops a held one from being re-flooded, the hole was
 * permanent — in an area whose adjacencies were all Full, whose budgets were all
 * intact and whose Problems panel was empty.
 *
 * The fix is reliable flooding, never a bigger default queue. Every fabric here
 * uses the default link model; the one deliberately tiny queue exists to make a
 * loss observable at a size a reader can follow, and the expected contract is
 * reliable convergence rather than zero packet loss.
 */

/** Children per parent, as in `ospf-scalability.test.ts`: bounded fan-out. */
const FANOUT = 32;

/** Sizes the supported contract has to converge on the default link model. */
const AREA_SIZES = [32, 64, 96, 128] as const;

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

/**
 * The same bounded-fan-out area-0 tree `ospf-scalability.test.ts` builds, on the
 * default link model: no custom queue, no boosted capacity, no static routes.
 */
function buildArea(routerCount: number): Fabric {
  const engine = createSimulationEngine({ seed: 10_173 });
  const routers: Router[] = [];
  for (let index = 0; index < routerCount; index++) {
    const router = engine.add(new Router(`r${index}`, `R${index}`));
    router.getOrCreateLoopback(0);
    router.setInterfaceIp("Loopback0", loopbackOf(index), 32);
    routers.push(router);
  }
  for (let index = 1; index < routerCount; index++) {
    const parentIndex = Math.floor((index - 1) / FANOUT);
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

interface Hub {
  readonly engine: SimulationEngine;
  readonly core: Router;
  readonly leaves: readonly Router[];
  /** The core interface facing the first leaf. */
  readonly constrainedPort: string;
}

/**
 * One core and `leafCount` leaves.
 *
 * With `constrained`, the *first* cable is given a one-packet egress queue and
 * a slow capacity. Nothing about that cable is a workaround: it is the ordinary
 * link model with a deliberately small bound, and it reproduces the loss the
 * 128-router area suffers at a size where a single advertisement can be named.
 */
function buildHub(leafCount: number, options: { constrained?: boolean } = {}): Hub {
  const engine = createSimulationEngine({ seed: 10_173 });
  engine.enableTrace();
  const core = engine.add(new Router("core", "CORE"));
  core.getOrCreateLoopback(0);
  core.setInterfaceIp("Loopback0", "10.255.0.9", 32);
  const leaves: Router[] = [];
  for (let index = 0; index < leafCount; index++) {
    const number = index + 1;
    const leaf = engine.add(new Router(`r${number}`, `R${number}`));
    leaf.addInterface("Gi0/0", macFromIndex(100 + number * 10));
    leaf.configureInterface("Gi0/0", { ip: `10.0.${number}.2`, mask: 24 });
    leaf.getOrCreateLoopback(0);
    leaf.setInterfaceIp("Loopback0", `10.255.0.${number}`, 32);
    core.addInterface(`Gi0/${index}`, macFromIndex(1 + index));
    core.configureInterface(`Gi0/${index}`, { ip: `10.0.${number}.1`, mask: 24 });
    engine.connect("core", `Gi0/${index}`, `r${number}`, "Gi0/0",
      index === 0 && options.constrained ? { queueLimitPackets: 1, capacityBps: 1_000_000 } : undefined);
    leaves.push(leaf);
  }
  for (const router of [core, ...leaves]) {
    router.ospf.createProcess(1);
    router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    router.ospf.setPassiveInterface("Loopback0", true);
  }
  return { engine, core, leaves, constrainedPort: "Gi0/0" };
}

function buildConstrainedHub(leafCount: number): Hub {
  return buildHub(leafCount, { constrained: true });
}

/**
 * Three routers, each cabled to both others, on the default link model.
 *
 * Every advertisement therefore reaches each router twice — once from each
 * neighbour — so duplicates arrive without any packet ever being dropped.
 */
function buildTriangle(): Fabric {
  const engine = createSimulationEngine({ seed: 10_173 });
  engine.enableTrace();
  const routers: Router[] = [];
  for (let index = 0; index < 3; index++) {
    const router = engine.add(new Router(`r${index}`, `R${index}`));
    router.getOrCreateLoopback(0);
    router.setInterfaceIp("Loopback0", loopbackOf(index), 32);
    routers.push(router);
  }
  const segments = [[0, 1], [1, 2], [0, 2]] as const;
  for (const [segment, [left, right]] of segments.entries()) {
    routers[left]!.addInterface(`Gi0/${segment}`, macFromIndex(300 + segment * 2));
    routers[left]!.configureInterface(`Gi0/${segment}`, { ip: `10.9.${segment}.1`, mask: 30 });
    routers[right]!.addInterface(`Gi0/${segment}`, macFromIndex(301 + segment * 2));
    routers[right]!.configureInterface(`Gi0/${segment}`, { ip: `10.9.${segment}.2`, mask: 30 });
    engine.connect(`r${left}`, `Gi0/${segment}`, `r${right}`, `Gi0/${segment}`);
  }
  for (const router of routers) {
    router.ospf.createProcess(1);
    router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    router.ospf.setPassiveInterface("Loopback0", true);
  }
  return { engine, routers };
}

/** First, middle and last router — a stable, size-independent sample. */
function sampleIndexes(routerCount: number): number[] {
  return [...new Set([0, 1, routerCount >> 1, routerCount - 1])].sort((a, b) => a - b);
}

/** One line per advertisement, canonically ordered: the comparable database. */
function databaseOf(router: Router): string[] {
  return router.ospf.database()
    .map((entry) => `${entry.type}/${entry.linkStateId}/${entry.advertisingRouter}/${entry.sequence}/${entry.checksum}`);
}

function hasOspfRoute(router: Router, network: string): boolean {
  return router.routingTable().some((row) => row.kind === "ospf" && row.network === network);
}

function tailDropsOn(router: Router, interfaceName: string): number {
  return router.getInterface(interfaceName)?.egress.snapshot().dropsByReason["tail-drop"] ?? 0;
}

function tailDropsOf(routers: readonly Router[]): number {
  return routers.reduce((sum, router) => {
    for (const iface of router.interfaces.values()) sum += iface.egress.snapshot().dropsByReason["tail-drop"] ?? 0;
    return sum;
  }, 0);
}

/** Advertisements `expected` holds that `actual` does not, canonically ordered. */
function missingFrom(actual: Router, expected: Router): string[] {
  const held = new Set(databaseOf(actual));
  return databaseOf(expected).filter((entry) => !held.has(entry));
}

describe("OSPF reliable flooding over finite queues", () => {
  it.each(AREA_SIZES)(
    "converges an area of %i routers on the default link egress queue",
    { timeout: 180_000 },
    (routerCount) => {
      const fabric = buildArea(routerCount);
      fabric.engine.runUntilIdle();

      // Nothing is still pending: a reliable protocol must still reach a
      // bounded, quiescent end state.
      expect(fabric.engine.pendingEventCount()).toBe(0);

      // Every adjacency is Full, so a shortfall is never an adjacency defect.
      const adjacencies = fabric.routers.flatMap((router) =>
        router.ospf.neighborSummaries().map((neighbor) => neighbor.state));
      expect(adjacencies).toHaveLength(2 * (routerCount - 1));
      expect(adjacencies.filter((state) => state !== "full")).toEqual([]);

      // One Router LSA per router and one Network LSA per transit segment, held
      // identically by every sampled router.
      const reference = databaseOf(fabric.routers[0]!);
      expect(reference).toHaveLength(2 * routerCount - 1);
      const sample = sampleIndexes(routerCount);
      for (const index of sample) {
        expect(databaseOf(fabric.routers[index]!)).toEqual(reference);
        expect(fabric.routers[index]!.ospf.overview().problems).toEqual([]);
      }

      // Sampled remote loopbacks and sampled remote transit subnets: a complete
      // database is worth nothing if SPF did not turn it into routes. A transit
      // subnet the router is attached to keeps its connected route, so only the
      // ones it has to learn are required here.
      const missingRoutes: string[] = [];
      for (const index of sample) {
        for (const target of sample) {
          if (target === index) continue;
          if (!hasOspfRoute(fabric.routers[index]!, loopbackOf(target))) {
            missingRoutes.push(`r${index} -> ${loopbackOf(target)}`);
          }
          if (target === 0) continue; // r0 has no uplink of its own
          const attached = index === target || index === Math.floor((target - 1) / FANOUT);
          if (attached) continue;
          if (!hasOspfRoute(fabric.routers[index]!, transitNetworkOf(target))) {
            missingRoutes.push(`r${index} -> ${transitNetworkOf(target)}`);
          }
        }
      }
      expect(missingRoutes).toEqual([]);

      // Named individually so a future failure says *which* bound moved.
      const budget = fabric.engine.controlProtocolBudget;
      expect(budget.consumed("spfRuns")).toBeLessThanOrEqual(budget.maximumOf("spfRuns"));
      // The linear contract M10.17.2 established: at most two walks per router
      // for a whole cold start, however the flooding underneath recovers.
      expect(budget.consumed("spfRuns")).toBeLessThanOrEqual(2 * routerCount);
      expect(budget.consumed("lsaFloods")).toBeLessThan(budget.maximumOf("lsaFloods"));
      expect(budget.consumed("ospfEvents")).toBeLessThan(budget.maximumOf("ospfEvents"));
      expect(budget.consumed("adjacencyTransitions")).toBeLessThan(budget.maximumOf("adjacencyTransitions"));
      // The generator never limits the fabric instead of the protocol.
      const busiest = Math.max(...fabric.routers.map((router) => router.ospf.neighborSummaries().length));
      expect(busiest).toBeLessThanOrEqual(DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumOspfNeighborsPerDevice);
    },
  );

  it("recovers the exact advertisement a full egress queue swallowed", () => {
    const { engine, core, leaves, constrainedPort } = buildConstrainedHub(5);
    engine.runUntilIdle();
    const starved = leaves[0]!;

    // 1. The adjacency is healthy: this is not a neighbour or election defect.
    expect(core.ospf.neighborSummaries().map((neighbor) => neighbor.state))
      .toEqual(["full", "full", "full", "full", "full"]);

    // 2. The egress queue — not OSPF — really did refuse packets on that cable.
    //    The contract is reliable convergence, not zero packet loss.
    expect(tailDropsOn(core, constrainedPort)).toBeGreaterThan(0);

    // 3. The sender noticed, because no acknowledgement arrived, and offered the
    //    lost instances again. Which advertisement lands in a full queue is not
    //    a protocol contract, so the count is read from state, never pinned.
    const counters = core.ospf.floodCounters();
    expect(counters.retransmissions).toBeGreaterThan(0);
    expect(counters.retransmittedUpdates).toBeGreaterThan(0);
    const retransmitted = engine.traceLog
      .filter((entry) => entry.device === "core" && entry.type === "ospf-lsa-retransmitted");
    expect(retransmitted.length).toBe(counters.retransmittedUpdates);
    expect(retransmitted.every((entry) => entry.detail?.interface === constrainedPort)).toBe(true);

    // 4. Every offer ended acknowledged or superseded; none was abandoned, and
    //    nothing is still waiting.
    expect(counters.abandoned).toBe(0);
    expect(counters.outstanding).toBe(0);
    expect(core.ospf.retransmissionEntries()).toEqual([]);

    // 5. The starved neighbour holds the sender's database, instance for
    //    instance — sequence and checksum included.
    expect(missingFrom(starved, core)).toEqual([]);
    expect(databaseOf(starved)).toEqual(databaseOf(core));
    expect(databaseOf(core)).toHaveLength(2 * leaves.length + 1);
    expect(core.ospf.overview().problems).toEqual([]);
  });

  it("recovers every advertisement several tail drops swallowed", () => {
    const { engine, core, leaves } = buildConstrainedHub(8);
    engine.runUntilIdle();

    // More than one packet was lost, in both directions of the constrained
    // cable: updates on the way out and acknowledgements on the way back.
    expect(tailDropsOf([core, ...leaves])).toBeGreaterThan(1);
    expect(engine.pendingEventCount()).toBe(0);

    const reference = databaseOf(core);
    expect(reference).toHaveLength(2 * leaves.length + 1);
    for (const leaf of leaves) {
      expect(databaseOf(leaf)).toEqual(reference);
      expect(leaf.ospf.floodCounters().outstanding).toBe(0);
      expect(leaf.ospf.overview().problems).toEqual([]);
    }
    expect(core.ospf.floodCounters().outstanding).toBe(0);
    expect(core.ospf.floodCounters().abandoned).toBe(0);
    expect(core.ospf.overview().problems).toEqual([]);

    // And the recovery is inside every OSPF bound: the fix is reliable
    // flooding, not a larger budget and not a larger queue.
    const budget = engine.controlProtocolBudget;
    for (const key of ["spfRuns", "lsaFloods", "ospfEvents", "adjacencyTransitions"] as const) {
      expect(budget.consumed(key)).toBeLessThan(budget.maximumOf(key));
    }
  });

  it("acknowledges a duplicate advertisement without touching the database", () => {
    // A triangle floods every advertisement to each router twice — once from
    // each neighbour — so duplicates arrive with no packet loss at all.
    const { engine, routers } = buildTriangle();
    engine.runUntilIdle();

    const offered = engine.traceLog
      .filter((entry) => entry.type === "ospf-lsa-flooded" && entry.detail?.received === undefined)
      .reduce((sum, entry) => sum + Number(entry.detail?.count ?? 0), 0);
    const installed = engine.traceLog
      .filter((entry) => entry.type === "ospf-lsa-flooded" && entry.detail?.received === true);
    // Strictly more advertisements were offered than installed: duplicates.
    expect(offered).toBeGreaterThan(installed.length);

    // No instance was ever installed twice on one router, so a duplicate never
    // mutated a database — while every offer was still acknowledged, which is
    // what makes the sender's retransmission stop.
    const installations = new Map<string, number>();
    for (const entry of installed) {
      const key = `${entry.device}|${entry.detail!.type}|${entry.detail!.linkStateId}`
        + `|${entry.detail!.advertisingRouter}|${entry.detail!.sequence}`;
      installations.set(key, (installations.get(key) ?? 0) + 1);
    }
    expect([...installations.values()].filter((count) => count > 1)).toEqual([]);

    const reference = databaseOf(routers[0]!);
    for (const router of routers) {
      expect(databaseOf(router)).toEqual(reference);
      expect(router.ospf.floodCounters().outstanding).toBe(0);
      expect(router.ospf.floodCounters().abandoned).toBe(0);
      // A duplicate carries no new information, so it never asks for a walk:
      // the fingerprint guard is never even reached.
      expect(router.ospf.spfCounters().executions).toBeLessThanOrEqual(2);
    }
  });

  it("leaves an instance outstanding that its own neighbour never acknowledged", () => {
    // One leaf stops answering entirely; the other keeps acknowledging. A list
    // is per neighbour and per instance, so one neighbour's acknowledgement can
    // never stand in for another's.
    const { engine, core, leaves } = buildHub(2);
    engine.runUntilIdle();
    const silent = leaves[0]!;
    const silentRouterId = silent.ospf.overview().routerId!;
    silent.ospf.removeProcess();

    const startedAtNs = engine.now();
    core.ospf.configureInterface("Gi0/1", { cost: 42 });
    engine.advanceTo(startedAtNs + 1_000_000_000); // one second: before any retry

    const outstanding = core.ospf.retransmissionEntries();
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.neighborRouterId).toBe(silentRouterId);
    expect(outstanding[0]!.interfaceId).toBe("Gi0/0");
    expect(outstanding[0]!.attempts).toBe(1);
    expect(outstanding[0]!.firstSentAtNs).toBe(startedAtNs);
    expect(outstanding[0]!.lastSentAtNs).toBe(startedAtNs);
    // The instance the entry names is exactly the one the sender advertises.
    const local = core.ospf.database()
      .find((entry) => entry.advertisingRouter === core.ospf.overview().routerId && entry.type === "router");
    expect(outstanding[0]!.sequence).toBe(local!.sequence);
    expect(outstanding[0]!.checksum).toBe(local!.checksum);
    // The answering leaf did acknowledge, and that cleared only its own entry.
    expect(core.ospf.floodCounters().acknowledgements).toBeGreaterThan(0);
  });

  it("starts the retransmission count over when a newer instance replaces the old one", () => {
    const { engine, core, leaves } = buildHub(2);
    engine.runUntilIdle();
    leaves[0]!.ospf.removeProcess();

    core.ospf.configureInterface("Gi0/1", { cost: 42 });
    engine.advanceTo(engine.now() + 1_000_000_000);
    const first = core.ospf.retransmissionEntries()[0]!;
    expect(first).toBeDefined();

    // A newer instance of the same advertisement: the stale entry is replaced
    // rather than kept, so the retries start again for what is actually in
    // flight and a re-originated advertisement is always delivered.
    core.ospf.configureInterface("Gi0/1", { cost: 43 });
    engine.advanceTo(engine.now() + 11_000_000_000);

    const second = core.ospf.retransmissionEntries()[0]!;
    expect(second).toBeDefined();
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second.firstSentAtNs!).toBeGreaterThan(first.firstSentAtNs!);
    // There is one entry per LSA key, never one per instance.
    expect(core.ospf.retransmissionEntries()).toHaveLength(1);
  });

  it("gives up after a deterministic number of retransmissions and says so", () => {
    const { engine, core, leaves } = buildHub(2);
    engine.runUntilIdle();
    const silentRouterId = leaves[0]!.ospf.overview().routerId!;
    const coreRouterId = core.ospf.overview().routerId!;
    leaves[0]!.ospf.removeProcess();

    core.ospf.configureInterface("Gi0/1", { cost: 42 });
    engine.runUntilIdle();

    // Three retries, then the instance is reported rather than dropped in
    // silence. The advertisement itself stays in the database and the adjacency
    // is left to the dead interval, exactly as on a real router.
    const counters = core.ospf.floodCounters();
    expect(counters.retransmissions).toBe(3);
    expect(counters.retransmittedUpdates).toBe(3);
    expect(counters.abandoned).toBe(1);
    expect(counters.outstanding).toBe(0);
    expect(core.ospf.overview().problems).toEqual([
      `Gi0/0: router LSA ${coreRouterId} from ${coreRouterId}`
      + ` was not acknowledged by ${silentRouterId} after 3 retransmissions`,
    ]);
    expect(engine.traceLog.filter((entry) => entry.type === "ospf-lsa-retransmission-exhausted"))
      .toHaveLength(1);
    // Bounded: the run still reaches quiescence rather than retrying for ever.
    expect(engine.pendingEventCount()).toBe(0);
  });

  it("keeps no retransmission timer once every instance is acknowledged", () => {
    const { engine, core, leaves } = buildConstrainedHub(5);
    engine.runUntilIdle();

    // Nothing outstanding, so nothing is scheduled: like the IPsec lifetimes,
    // reliable flooding keeps no periodic timer and `runUntilIdle()` returns.
    for (const router of [core, ...leaves]) {
      expect(router.ospf.retransmissionEntries()).toEqual([]);
      expect(router.ospf.retransmissionTimerArmed).toBe(false);
    }
    expect(engine.pendingEventCount()).toBe(0);
  });

  it("clears the retransmission list when the adjacency is lost and floods again on restore", () => {
    const { engine, core, leaves, constrainedPort } = buildConstrainedHub(5);
    engine.runUntilIdle();
    const detached = leaves[0]!;
    expect(missingFrom(detached, core)).toEqual([]);

    core.getInterface(constrainedPort)!.shutdown();
    engine.runUntilIdle();
    // The adjacency is gone, so nothing it had not acknowledged is still owed.
    expect(core.ospf.neighborSummaries().map((neighbor) => neighbor.interfaceId))
      .not.toContain(constrainedPort);
    expect(core.ospf.retransmissionEntries()
      .filter((entry) => entry.interfaceId === constrainedPort)).toEqual([]);
    expect(core.ospf.retransmissionTimerArmed).toBe(false);
    expect(engine.pendingEventCount()).toBe(0);

    core.getInterface(constrainedPort)!.noShutdown();
    engine.runUntilIdle();

    // A restored cable resumes ordinary flooding and converges again.
    expect(detached.ospf.neighborSummaries().map((neighbor) => neighbor.state)).toEqual(["full"]);
    expect(missingFrom(detached, core)).toEqual([]);
    expect(core.ospf.floodCounters().outstanding).toBe(0);
  });

  it("repeats an identical constrained-queue run from the same topology and seed", () => {
    const first = buildConstrainedHub(5);
    const second = buildConstrainedHub(5);
    first.engine.runUntilIdle();
    second.engine.runUntilIdle();

    expect(second.engine.now()).toBe(first.engine.now());
    expect(tailDropsOf([second.core, ...second.leaves]))
      .toBe(tailDropsOf([first.core, ...first.leaves]));
    expect(second.core.ospf.floodCounters()).toEqual(first.core.ospf.floodCounters());
    for (const [index, router] of [second.core, ...second.leaves].entries()) {
      const reference = [first.core, ...first.leaves][index]!;
      expect(databaseOf(router)).toEqual(databaseOf(reference));
      expect(router.routingTable()).toEqual(reference.routingTable());
    }
  });

  it("reaches the same constrained-queue state through Auto and through Step", () => {
    const auto = buildConstrainedHub(5);
    const step = buildConstrainedHub(5);
    auto.engine.runUntilIdle();
    let guard = 0;
    while (step.engine.runNextEvent()) {
      if (++guard > 1_000_000) throw new Error("step run did not terminate");
    }

    expect(step.engine.now()).toBe(auto.engine.now());
    expect(step.engine.controlProtocolBudget.consumed("spfRuns"))
      .toBe(auto.engine.controlProtocolBudget.consumed("spfRuns"));
    for (const [index, router] of [step.core, ...step.leaves].entries()) {
      const reference = [auto.core, ...auto.leaves][index]!;
      expect(databaseOf(router)).toEqual(databaseOf(reference));
      expect(router.routingTable()).toEqual(reference.routingTable());
      expect(router.ospf.floodCounters()).toEqual(reference.ospf.floodCounters());
    }
  });
});

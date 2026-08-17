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
 * tail-dropped — and a tail drop is invisible to the sender. Nothing here
 * refreshes an LSA periodically, duplicate suppression stops a lost one from
 * ever being offered again, and the retransmission list is written but never
 * read, so no timer ever offers it a second time.
 *
 * The result is a permanently divergent area whose adjacencies are all Full,
 * whose budgets are all intact, and whose Problems panel is empty.
 *
 * These tests pin that chain end to end:
 *
 *   LSA originated
 *   → the update is accepted by the OSPF sender
 *   → the egress queue tail-drops the packet
 *   → the receiver never installs the advertisement
 *   → the sender never offers it again
 *   → convergence is incomplete, for ever.
 *
 * The fix is reliable flooding, never a bigger default queue: every fabric here
 * uses the default link model, and the one deliberately tiny queue exists only
 * to make a single loss observable at a size a reader can follow.
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

/**
 * One core and `leafCount` leaves, with the *first* cable given a one-packet
 * egress queue and a slow capacity.
 *
 * Nothing about that cable is a workaround: it is the ordinary link model with
 * a deliberately small bound, and it makes the loss the 128-router area suffers
 * reproducible at a size where the exact advertisement can be named.
 */
function buildConstrainedHub(leafCount: number): {
  engine: SimulationEngine;
  core: Router;
  leaves: readonly Router[];
  /** The core interface whose queue is deliberately too small. */
  constrainedPort: string;
} {
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
      index === 0 ? { queueLimitPackets: 1, capacityBps: 1_000_000 } : undefined);
    leaves.push(leaf);
  }
  for (const router of [core, ...leaves]) {
    router.ospf.createProcess(1);
    router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    router.ospf.setPassiveInterface("Loopback0", true);
  }
  return { engine, core, leaves, constrainedPort: "Gi0/0" };
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

  it("names the exact advertisement a full egress queue swallows", () => {
    const { engine, core, leaves, constrainedPort } = buildConstrainedHub(5);
    engine.runUntilIdle();
    const starved = leaves[0]!;

    // 1. The adjacency is healthy: this is not a neighbour or election defect.
    expect(core.ospf.neighborSummaries().map((neighbor) => neighbor.state))
      .toEqual(["full", "full", "full", "full", "full"]);
    expect(core.ospf.overview().problems).toEqual([]);

    // 2. The sender holds the complete database, so it had the advertisement.
    expect(databaseOf(core)).toHaveLength(2 * leaves.length + 1);

    // 3. The egress queue — not OSPF — refused packets on that one cable.
    expect(tailDropsOn(core, constrainedPort)).toBeGreaterThan(0);

    // 4. The receiver is short, and every instance it lacks is one the sender
    //    holds, with the sender's own sequence and checksum. The set is read
    //    from state rather than pinned to a particular leaf, because which
    //    advertisement lands in a full queue is not a protocol contract.
    const missing = missingFrom(starved, core);
    expect(missing.length).toBeGreaterThan(0);
    expect(databaseOf(core)).toEqual(expect.arrayContaining(missing));
    const [type, linkStateId, advertisingRouter, sequence] = missing[0]!.split("/");
    const held = core.ospf.database()
      .find((entry) => entry.type === type && entry.linkStateId === linkStateId
        && entry.advertisingRouter === advertisingRouter);
    expect(held).toBeDefined();
    expect(String(held!.sequence)).toBe(sequence);

    // 5. The sender offered advertisements on that interface and was never told
    //    any of them was dropped: it saw fewer acknowledgements than offers.
    const offered = engine.traceLog
      .filter((entry) => entry.device === "core" && entry.type === "ospf-lsa-flooded"
        && entry.detail?.interface === constrainedPort)
      .reduce((sum, entry) => sum + Number(entry.detail?.count ?? 0), 0);
    const acknowledged = engine.traceLog
      .filter((entry) => entry.device === "core" && entry.type === "ospf-lsa-acknowledged"
        && entry.detail?.interface === constrainedPort)
      .reduce((sum, entry) => sum + Number(entry.detail?.count ?? 0), 0);
    expect(offered).toBeGreaterThan(0);
    expect(acknowledged).toBeLessThan(offered);

    // 6. And nothing was ever offered a second time: the retransmission list is
    //    written when an advertisement is flooded and never read again, so no
    //    timer exists to notice the missing acknowledgement. This is the defect.
    expect(engine.traceLog.filter((entry) => entry.type.startsWith("ospf-lsa-retransmi"))).toEqual([]);
  });

  it("never recovers a swallowed advertisement while the adjacency lives on", () => {
    const { engine, core, leaves } = buildConstrainedHub(5);
    engine.runUntilIdle();
    const starved = leaves[0]!;
    const missing = missingFrom(starved, core);
    expect(missing.length).toBeGreaterThan(0);

    // Every queue is empty and every event has run, so nothing is merely slow.
    expect(engine.pendingEventCount()).toBe(0);
    expect(core.getInterface("Gi0/0")!.egress.snapshot().depthPackets).toBe(0);

    // Thirty further seconds of virtual time — three hello intervals, and six
    // times RFC 2328's five second RxmtInterval — while the adjacency is still
    // well inside its forty second dead interval. Nothing changes.
    engine.advanceTo(engine.now() + 30_000_000_000);
    engine.runUntilIdle();

    expect(starved.ospf.neighborSummaries().map((neighbor) => neighbor.state)).toEqual(["full"]);
    expect(missingFrom(starved, core)).toEqual(missing);
    // The loss is silent: nothing is reported anywhere.
    expect(core.ospf.overview().problems).toEqual([]);
    expect(starved.ospf.overview().problems).toEqual([]);
  });

  it("keeps the loss inside the link model rather than the protocol bounds", () => {
    const { engine, core, leaves } = buildConstrainedHub(5);
    engine.runUntilIdle();

    // Every OSPF bound has headroom, so no budget explains the shortfall — only
    // the finite egress queue does.
    const budget = engine.controlProtocolBudget;
    for (const key of ["spfRuns", "lsaFloods", "ospfEvents", "adjacencyTransitions"] as const) {
      expect(budget.consumed(key)).toBeLessThan(budget.maximumOf(key));
    }
    expect(tailDropsOf([core, ...leaves])).toBeGreaterThan(0);
    expect(missingFrom(leaves[0]!, core).length).toBeGreaterThan(0);
  });
});

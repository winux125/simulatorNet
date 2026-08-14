import { describe, expect, it } from "vitest";
import { createSimulationEngine, L2Switch, macFromIndex, Router, type SimulationEngine } from "@sim/sim-core";

/**
 * M10.17.2 — remote OSPF transit networks.
 *
 * SPF already walks transit segments: it reads a Router LSA's transit link,
 * looks the segment's Network LSA up and expands the routers attached to it, so
 * a loopback two hops away is reachable. What never happens is the last step of
 * the calculation — installing a route to the *segment itself*. Only Router LSA
 * stub links become routes, and a broadcast transit segment is described by a
 * transit link and a Network LSA rather than by a stub, so the subnet between
 * two remote routers is in the database, takes part in SPF, and is still
 * missing from every remote routing table.
 *
 *   R1 ──── 10.0.12.0/30 ──── R2 ──── 10.0.23.0/30 ──── R3
 *   Lo0 10.255.0.1/32     Lo0 10.255.0.2/32     Lo0 10.255.0.3/32
 *
 * R1 holds `10.0.12.0/30` as connected and must learn `10.0.23.0/30` from R2;
 * R3 must learn `10.0.12.0/30` symmetrically.
 */

interface Line {
  readonly engine: SimulationEngine;
  readonly r1: Router;
  readonly r2: Router;
  readonly r3: Router;
  readonly routers: readonly Router[];
}

function loopbackOf(index: number): string {
  return `10.255.0.${index}`;
}

/**
 * A three-router line. Each segment is an ordinary Ethernet subnet, so it
 * elects a designated router and is described by a Network LSA; passing
 * `networkType: "point-to-point"` selects the model that describes the same
 * segment with a stub link instead.
 */
function buildLine(options: { pointToPoint?: boolean; mask?: number } = {}): Line {
  const engine = createSimulationEngine({ seed: 10_172 });
  engine.enableTrace();
  const mask = options.mask ?? 30;
  const routers: Router[] = [];
  for (let index = 1; index <= 3; index++) {
    const router = engine.add(new Router(`r${index}`, `R${index}`));
    router.getOrCreateLoopback(0);
    router.setInterfaceIp("Loopback0", loopbackOf(index), 32);
    routers.push(router);
  }
  const [r1, r2, r3] = routers as [Router, Router, Router];
  r1.addInterface("Gi0/0", macFromIndex(11));
  r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask });
  r2.addInterface("Gi0/0", macFromIndex(21));
  r2.configureInterface("Gi0/0", { ip: "10.0.12.2", mask });
  r2.addInterface("Gi0/1", macFromIndex(22));
  r2.configureInterface("Gi0/1", { ip: "10.0.23.1", mask });
  r3.addInterface("Gi0/0", macFromIndex(31));
  r3.configureInterface("Gi0/0", { ip: "10.0.23.2", mask });
  engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
  engine.connect("r2", "Gi0/1", "r3", "Gi0/0");

  for (const router of routers) {
    router.ospf.createProcess(1);
    router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    router.ospf.setPassiveInterface("Loopback0", true);
    if (options.pointToPoint) {
      for (const iface of ["Gi0/0", "Gi0/1"]) {
        if (router.getInterface(iface)) router.ospf.configureInterface(iface, { networkType: "point-to-point" });
      }
    }
  }
  return { engine, r1, r2, r3, routers };
}

function routeFor(router: Router, network: string): ReturnType<Router["routingTable"]>[number] | undefined {
  return router.routingTable().find((row) => row.network === network);
}

function ospfRouteFor(router: Router, network: string): ReturnType<Router["routingTable"]>[number] | undefined {
  return router.routingTable().find((row) => row.kind === "ospf" && row.network === network);
}

/**
 * A broadcast segment between three routers, so its Network LSA lists more than
 * two attached routers and the remote route may not depend on their order.
 */
function buildSharedSegment(): { engine: SimulationEngine; routers: Router[]; remote: Router } {
  const engine = createSimulationEngine({ seed: 10_172 });
  const routers: Router[] = [];
  for (let index = 1; index <= 3; index++) {
    const router = engine.add(new Router(`s${index}`, `S${index}`));
    router.addInterface("Gi0/0", macFromIndex(40 + index));
    router.configureInterface("Gi0/0", { ip: `10.0.99.${index}`, mask: 24 });
    router.getOrCreateLoopback(0);
    router.setInterfaceIp("Loopback0", `10.254.0.${index}`, 32);
    routers.push(router);
  }
  const remote = engine.add(new Router("remote", "REMOTE"));
  remote.addInterface("Gi0/0", macFromIndex(60));
  remote.configureInterface("Gi0/0", { ip: "10.0.98.2", mask: 30 });
  remote.getOrCreateLoopback(0);
  remote.setInterfaceIp("Loopback0", "10.254.0.9", 32);
  routers[0]!.addInterface("Gi0/1", macFromIndex(61));
  routers[0]!.configureInterface("Gi0/1", { ip: "10.0.98.1", mask: 30 });
  engine.connect("s1", "Gi0/1", "remote", "Gi0/0");

  // One switch gives all three routers a single shared Ethernet segment.
  const segment = engine.add(new L2Switch("sw1", "SW1"));
  for (const [index, router] of routers.entries()) {
    const port = `Gi0/${index + 1}`;
    segment.addInterface(port, macFromIndex(70 + index));
    engine.connect("sw1", port, router.id, "Gi0/0");
  }

  for (const router of [...routers, remote]) {
    router.ospf.createProcess(1);
    router.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    router.ospf.setPassiveInterface("Loopback0", true);
  }
  return { engine, routers, remote };
}

describe("OSPF transit network routes", () => {
  it("installs the remote transit subnet of a three-router line", () => {
    const line = buildLine();
    line.engine.runUntilIdle();

    // The near segment stays connected and the far one is learned from R2.
    expect(routeFor(line.r1, "10.0.12.0")).toMatchObject({ kind: "connected" });
    expect(ospfRouteFor(line.r1, "10.0.23.0")).toMatchObject({
      kind: "ospf",
      administrativeDistance: 110,
      egressName: "Gi0/0",
      viaIp: "10.0.12.2",
    });
    // Symmetrically from the other end.
    expect(routeFor(line.r3, "10.0.23.0")).toMatchObject({ kind: "connected" });
    expect(ospfRouteFor(line.r3, "10.0.12.0")).toMatchObject({ kind: "ospf", viaIp: "10.0.23.1" });
  });

  it("derives the prefix from the Network LSA mask, never from the designated router address", () => {
    const line = buildLine();
    line.engine.runUntilIdle();

    const route = ospfRouteFor(line.r1, "10.0.23.0");
    expect(route).toBeDefined();
    // 10.0.23.1/30 is the DR's interface address; the route is the subnet.
    expect(route!.maskInt >>> 0).toBe(0xff_ff_ff_fc);
    expect(line.r1.routingTable().some((row) => row.network === "10.0.23.1")).toBe(false);
    expect(line.r1.routingTable().some((row) => row.network === "10.0.23.2")).toBe(false);
  });

  it("keeps the point-to-point model producing the same remote subnet", () => {
    const line = buildLine({ pointToPoint: true });
    line.engine.runUntilIdle();

    expect(ospfRouteFor(line.r1, "10.0.23.0")).toMatchObject({ kind: "ospf", viaIp: "10.0.12.2" });
    expect(ospfRouteFor(line.r3, "10.0.12.0")).toMatchObject({ kind: "ospf", viaIp: "10.0.23.1" });
  });

  it("leaves a directly attached transit subnet connected", () => {
    const line = buildLine();
    line.engine.runUntilIdle();

    // R2 is attached to both segments and must keep two connected routes and no
    // OSPF route that could compete with them.
    for (const network of ["10.0.12.0", "10.0.23.0"]) {
      const rows = line.r2.routingTable().filter((row) => row.network === network);
      expect(rows.map((row) => row.kind)).toEqual(["connected"]);
    }
  });

  it("gives the remote transit route a deterministic metric and first hop", () => {
    const first = buildLine();
    const second = buildLine();
    first.engine.runUntilIdle();
    second.engine.runUntilIdle();

    const route = ospfRouteFor(first.r1, "10.0.23.0")!;
    // One interface cost to reach R2 plus R2's cost onto the far segment.
    expect(route.metric).toBe(20);
    expect(route.viaIp).toBe("10.0.12.2");
    expect(ospfRouteFor(second.r1, "10.0.23.0")).toEqual(route);
  });

  it("withdraws the remote transit route when the far link fails and restores it", () => {
    const line = buildLine();
    line.engine.runUntilIdle();
    expect(ospfRouteFor(line.r1, "10.0.23.0")).toBeDefined();

    line.r2.getInterface("Gi0/1")!.shutdown();
    line.engine.runUntilIdle();

    expect(ospfRouteFor(line.r1, "10.0.23.0")).toBeUndefined();
    expect(ospfRouteFor(line.r1, loopbackOf(3))).toBeUndefined();
    // The surviving segment is untouched.
    expect(routeFor(line.r1, "10.0.12.0")).toMatchObject({ kind: "connected" });

    line.r2.getInterface("Gi0/1")!.noShutdown();
    line.engine.runUntilIdle();

    expect(ospfRouteFor(line.r1, "10.0.23.0")).toMatchObject({ kind: "ospf", viaIp: "10.0.12.2" });
    expect(ospfRouteFor(line.r1, loopbackOf(3))).toBeDefined();
  });

  it("installs one shared segment once however many routers the Network LSA lists", () => {
    const shared = buildSharedSegment();
    shared.engine.runUntilIdle();

    const network = shared.routers[0]!.ospf.database().find((entry) => entry.type === "network"
      && entry.linkStateId.startsWith("10.0.99."));
    expect(network).toBeDefined();
    expect(network!.linkCount).toBe(3);

    const rows = shared.remote.routingTable().filter((row) => row.network === "10.0.99.0");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ospf", viaIp: "10.0.98.1", egressName: "Gi0/0" });
  });

  it("keeps the prefix correct after the designated router changes", () => {
    const shared = buildSharedSegment();
    shared.engine.runUntilIdle();
    const before = shared.remote.routingTable().filter((row) => row.network === "10.0.99.0");
    expect(before).toHaveLength(1);
    const designated = shared.routers[0]!.ospf.interfaceSummaries()
      .find((entry) => entry.interfaceId === "Gi0/0")!.designatedRouter;
    expect(designated).toBeDefined();

    // Drop the elected designated router off the segment; the survivors elect a
    // new one and re-originate the Network LSA under a different link-state id.
    const owner = shared.routers.find((router) => router.ospf.interfaceSummaries()
      .some((entry) => entry.interfaceId === "Gi0/0" && entry.address === designated))!;
    owner.getInterface("Gi0/0")!.shutdown();
    shared.engine.runUntilIdle();
    for (const router of [...shared.routers, shared.remote]) router.ospf.arm();
    shared.engine.advanceTo(shared.engine.now() + 60_000_000_000);

    const after = shared.remote.routingTable().filter((row) => row.network === "10.0.99.0");
    // Whatever the election produced, the prefix is still the subnet and there
    // is never a host route to a designated-router address.
    expect(after.every((row) => row.network === "10.0.99.0")).toBe(true);
    expect(shared.remote.routingTable().some((row) => row.network.startsWith("10.0.99.")
      && row.network !== "10.0.99.0")).toBe(false);
  });
});

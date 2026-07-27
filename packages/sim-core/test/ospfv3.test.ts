import {
  L2Switch,
  Router,
  createSimulationEngine,
  macFromIndex,
  type SimulationEngine,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function addOspfv3Router(
  engine: SimulationEngine,
  id: string,
  index: number,
  routerId: string,
  loopback: string,
): Router {
  const router = engine.add(new Router(id, id.toUpperCase()));
  router.setIpv6ForwardingEnabled(true);
  router.addInterface("Gi0/0", macFromIndex(index * 10));
  router.addInterface("Gi0/1", macFromIndex(index * 10 + 1));
  router.getOrCreateInterface("Gi0/0");
  router.getOrCreateInterface("Gi0/1");
  router.getOrCreateLoopback(0);
  router.setInterfaceIpv6("Loopback0", loopback, 128);
  router.ospfv3.createProcess(1);
  router.ospfv3.setRouterId(routerId);
  router.ospfv3.configureInterface("Gi0/0", { enabled: true, area: 0, networkType: "point-to-point" });
  router.ospfv3.configureInterface("Gi0/1", { enabled: true, area: 0, networkType: "point-to-point" });
  router.ospfv3.configureInterface("Loopback0", { enabled: true, area: 0 });
  router.ospfv3.setPassiveInterface("Loopback0", true);
  return router;
}

describe("OSPFv3 area 0", () => {
  it("forms a Full link-local adjacency and installs an IPv6 prefix route", () => {
    const engine = createSimulationEngine({ seed: 530 });
    const r1 = addOspfv3Router(engine, "r1", 1, "1.1.1.1", "2001:db8:1::1");
    const r2 = addOspfv3Router(engine, "r2", 2, "2.2.2.2", "2001:db8:2::1");
    r1.setInterfaceIpv6("Gi0/0", "2001:db8:ff::1", 64);
    r2.setInterfaceIpv6("Gi0/0", "2001:db8:ff::2", 64);
    engine.connect(r1.id, "Gi0/0", r2.id, "Gi0/0");

    engine.runUntilIdle();

    expect(r1.ospfv3.neighborSummaries()).toEqual([
      expect.objectContaining({ neighborRouterId: "2.2.2.2", state: "full", address: expect.stringMatching(/^fe80:/) }),
    ]);
    expect(r1.ipv6RoutingTable()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "ospfv3",
        network: "2001:db8:2::1",
        prefixLength: 128,
        egressName: "Gi0/0",
      }),
    ]));
    r1.ping6("2001:db8:2::1", 1);
    engine.runUntilIdle();
    expect(r1.ipv6PingResults.at(-1)).toMatchObject({ success: true });
  });

  it("reconverges deterministically over an alternate path after link failure", () => {
    const run = (): { before: string; after: string; trace: TraceEntry[] } => {
      const engine = createSimulationEngine({ seed: 531 });
      engine.enableTrace();
      const r1 = addOspfv3Router(engine, "r1", 1, "1.1.1.1", "2001:db8:1::1");
      const r2 = addOspfv3Router(engine, "r2", 2, "2.2.2.2", "2001:db8:2::1");
      const r3 = addOspfv3Router(engine, "r3", 3, "3.3.3.3", "2001:db8:3::1");
      r1.setInterfaceIpv6("Gi0/0", "2001:db8:12::1", 64);
      r2.setInterfaceIpv6("Gi0/0", "2001:db8:12::2", 64);
      r2.setInterfaceIpv6("Gi0/1", "2001:db8:23::2", 64);
      r3.setInterfaceIpv6("Gi0/0", "2001:db8:23::3", 64);
      r1.setInterfaceIpv6("Gi0/1", "2001:db8:13::1", 64);
      r3.setInterfaceIpv6("Gi0/1", "2001:db8:13::3", 64);
      r1.ospfv3.configureInterface("Gi0/1", { cost: 50 });
      r3.ospfv3.configureInterface("Gi0/1", { cost: 50 });
      engine.connect(r1.id, "Gi0/0", r2.id, "Gi0/0");
      engine.connect(r2.id, "Gi0/1", r3.id, "Gi0/0");
      engine.connect(r1.id, "Gi0/1", r3.id, "Gi0/1");
      engine.runUntilIdle();
      const before = r1.ospfv3.routeTable().find((route) => route.network === "2001:db8:3::1")!.interfaceId;

      r1.getInterface("Gi0/0")!.shutdown();
      engine.runUntilIdle();
      const after = r1.ospfv3.routeTable().find((route) => route.network === "2001:db8:3::1")!.interfaceId;
      return { before, after, trace: engine.traceLog };
    };

    const first = run();
    expect(first).toMatchObject({ before: "Gi0/0", after: "Gi0/1" });
    expect(first.trace.some((entry) =>
      entry.type === "ospfv3-neighbor-state-changed"
      && entry.detail?.reason === "interface down")).toBe(true);
    expect(run()).toEqual(first);
  });

  it("keeps OSPFv2 and OSPFv3 process state independent on the same router", () => {
    const engine = createSimulationEngine({ seed: 532 });
    const router = addOspfv3Router(engine, "r1", 1, "1.1.1.1", "2001:db8:1::1");
    router.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 30 });
    router.ospf.createProcess(10);
    router.ospf.setRouterId("10.10.10.10");
    router.ospf.configureInterface("Gi0/0", { enabled: true, area: 0 });

    expect(router.ospf.currentProcessId).toBe(10);
    expect(router.ospfv3.configuration()).toMatchObject({ processId: 1, routerId: "1.1.1.1" });
    router.ospfv3.removeProcess();
    expect(router.ospf.enabled).toBe(true);
    expect(router.ospfv3.enabled).toBe(false);
  });

  it("elects deterministic DR and BDR roles on a broadcast segment", () => {
    const engine = createSimulationEngine({ seed: 533 });
    const sw = engine.add(new L2Switch("sw1", "SW1"));
    const routers = [
      addOspfv3Router(engine, "r1", 1, "1.1.1.1", "2001:db8:1::1"),
      addOspfv3Router(engine, "r2", 2, "2.2.2.2", "2001:db8:2::1"),
      addOspfv3Router(engine, "r3", 3, "3.3.3.3", "2001:db8:3::1"),
    ];
    routers.forEach((router, index) => {
      const port = `Gi0/${index + 1}`;
      sw.addInterface(port, macFromIndex(100 + index));
      router.setInterfaceIpv6("Gi0/0", `2001:db8:ff::${index + 1}`, 64);
      router.ospfv3.configureInterface("Gi0/0", { networkType: "broadcast" });
      engine.connect(router.id, "Gi0/0", sw.id, port);
    });
    engine.runUntilIdle();

    expect(routers[0]!.ospfv3.neighborSummaries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ neighborRouterId: "3.3.3.3", state: "full", role: "dr" }),
      expect.objectContaining({ neighborRouterId: "2.2.2.2", state: "full", role: "bdr" }),
    ]));
  });
});

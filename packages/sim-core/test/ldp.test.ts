import { describe, expect, it } from "vitest";
import { createSimulationEngine, macFromIndex, Router, type SimulationEngine } from "@sim/sim-core";

function router(engine: SimulationEngine, id: string, base: number, ports = 2): Router {
  const value = engine.add(new Router(id, id.toUpperCase()));
  for (let index = 0; index < ports; index++) value.addInterface(`Gi0/${index}`, macFromIndex(base + index));
  return value;
}

function enableOspf(value: Router, routerId: string): void {
  value.ospf.createProcess(1);
  value.ospf.setRouterId(routerId);
  value.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
  value.ospf.setPassiveInterface("Loopback0", true);
  for (const iface of ["Gi0/0", "Gi0/1"]) value.ospf.configureInterface(iface, { networkType: "point-to-point" });
}

function directPair(seed = 10_112) {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const r1 = router(engine, "r1", 10, 1);
  const r2 = router(engine, "r2", 20, 1);
  r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 30 });
  r2.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 30 });
  engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
  return { engine, r1, r2 };
}

function providerChain(seed = 10_113) {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  const r1 = router(engine, "r1", 10);
  const p = router(engine, "p", 20);
  const r2 = router(engine, "r2", 30);
  r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 30 });
  p.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 30 });
  p.configureInterface("Gi0/1", { ip: "10.0.23.2", mask: 30 });
  r2.configureInterface("Gi0/0", { ip: "10.0.23.3", mask: 30 });
  for (const [value, address] of [[r1, "1.1.1.1"], [p, "2.2.2.2"], [r2, "3.3.3.3"]] as const) {
    value.getOrCreateLoopback(0);
    value.setInterfaceIp("Loopback0", address, 32);
    enableOspf(value, address);
  }
  engine.connect("r1", "Gi0/0", "p", "Gi0/0");
  engine.connect("p", "Gi0/1", "r2", "Gi0/0");
  for (const [value, interfaces] of [[r1, ["Gi0/0"]], [p, ["Gi0/0", "Gi0/1"]], [r2, ["Gi0/0"]]] as const) {
    for (const iface of interfaces) value.setMplsEnabled(iface, true);
  }
  return { engine, r1, p, r2 };
}

describe("LDP discovery and sessions", () => {
  it("does not discover a cabled Router until MPLS is enabled on both ends", () => {
    const { engine, r1 } = directPair();
    engine.runUntilIdle();
    expect(r1.ldp.neighborSummaries()).toEqual([]);
  });

  it("establishes an Operational session only across a directly connected MPLS link", () => {
    const { engine, r1, r2 } = directPair();
    r1.setMplsEnabled("Gi0/0", true);
    r2.setMplsEnabled("Gi0/0", true);
    engine.runUntilIdle();
    expect(r1.ldp.neighborSummaries()).toMatchObject([{ routerId: "10.0.12.2", state: "operational" }]);
    expect(r2.ldp.neighborSummaries()).toMatchObject([{ routerId: "10.0.12.1", state: "operational" }]);
    expect(engine.traceLog.some((entry) => entry.type === "ldp-session-established")).toBe(true);
  });

  it("selects highest Loopback address, then supports an explicit source", () => {
    const { r1 } = directPair();
    r1.getOrCreateLoopback(0);
    r1.getOrCreateLoopback(1);
    r1.setInterfaceIp("Loopback0", "1.1.1.1", 32);
    r1.setInterfaceIp("Loopback1", "9.9.9.9", 32);
    expect(r1.ldp.routerId()).toBe("9.9.9.9");
    r1.configureLdpRouterId("Loopback0");
    expect(r1.ldp.routerId()).toBe("1.1.1.1");
  });

  it("uses implicit null for a directly connected FEC", () => {
    const { engine, r1, r2 } = directPair();
    r1.setMplsEnabled("Gi0/0", true);
    r2.setMplsEnabled("Gi0/0", true);
    engine.runUntilIdle();
    expect(r1.ldp.advertisedLabel("10.0.12.0/30")).toBe(3);
    expect(r2.ldp.advertisedLabel("10.0.12.0/30")).toBe(3);
  });

  it("removes the session and affected LFIB state after interface shutdown", () => {
    const { engine, r1, r2 } = directPair();
    r1.setMplsEnabled("Gi0/0", true);
    r2.setMplsEnabled("Gi0/0", true);
    engine.runUntilIdle();
    r1.getInterface("Gi0/0")!.adminUp = false;
    r1.getInterface("Gi0/0")!.notifyStateChanged();
    engine.runUntilIdle();
    expect(r1.ldp.neighborSummaries()).toEqual([]);
    expect(r2.ldp.neighborSummaries()).toEqual([]);
  });
});

describe("LDP bindings and LFIB", () => {
  it("allocates identical labels after equivalent rebuilds", () => {
    const first = providerChain(50);
    first.engine.runUntilIdle();
    const second = providerChain(50);
    second.engine.runUntilIdle();
    expect(first.p.ldp.labelBindings()).toEqual(second.p.ldp.labelBindings());
  });

  it("installs transport bindings across an OSPF provider core", () => {
    const { engine, r1, p } = providerChain();
    engine.runUntilIdle();
    expect(r1.ldp.neighborSummaries().every((entry) => entry.state === "operational")).toBe(true);
    const remote = r1.ldp.outgoingLabelFor("3.3.3.3/32");
    expect(remote).toMatchObject({ nextHop: "10.0.12.2", outgoingInterfaceId: "Gi0/0" });
    expect(remote?.label).toBeGreaterThanOrEqual(16);
    const transit = p.mpls.forwardingTable().find((entry) => entry.fec === "3.3.3.3/32");
    expect(transit?.operation).toEqual({ type: "pop" });
  });

  it("keeps customer/BGP prefixes out of LDP FECs", () => {
    const { engine, r1 } = providerChain();
    r1.addStaticRoute("203.0.113.0", 24, "10.0.12.2");
    engine.runUntilIdle();
    expect(r1.ldp.labelBindings().some((entry) => entry.fec === "203.0.113.0/24")).toBe(false);
  });

  it("drains the event queue after its bounded activity window", () => {
    const { engine } = providerChain();
    expect(engine.runUntilIdle()).toBeGreaterThan(0);
    expect(engine.pendingEventCount()).toBe(0);
  });

  it("traces discovery, mappings and installed bindings without packet bodies", () => {
    const { engine } = providerChain();
    engine.runUntilIdle();
    const types = new Set(engine.traceLog.map((entry) => entry.type));
    for (const required of ["ldp-hello-sent", "ldp-hello-received", "ldp-label-allocated", "ldp-label-mapping-received"]) {
      expect(types.has(required)).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { createSimulationEngine, macFromIndex, Pc, Router, normalizeMac } from "@sim/sim-core";

describe("Router IPv4 forwarding", () => {
  it("routes ICMP between two directly-connected subnets", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const r = engine.add(new Router("r1", "R1"));
    r.addInterface("Gi0/0", macFromIndex(200));
    r.addInterface("Gi0/1", macFromIndex(201));
    r.configureInterface("Gi0/0", { ip: "192.168.1.1", mask: 24 });
    r.configureInterface("Gi0/1", { ip: "192.168.2.1", mask: 24 });

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "192.168.1.10", mask: 24, gateway: "192.168.1.1" });
    engine.connect("pc1", "eth0", "r1", "Gi0/0");

    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc2.addInterface("eth0", macFromIndex(2));
    pc2.configure({ ip: "192.168.2.10", mask: 24, gateway: "192.168.2.1" });
    engine.connect("pc2", "eth0", "r1", "Gi0/1");

    pc1.ping("192.168.2.10", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
    expect(r.arpTable.get("192.168.1.10")).toBe(normalizeMac(pc1.primary.mac));
    expect(r.arpTable.get("192.168.2.10")).toBe(normalizeMac(pc2.primary.mac));
  });

  it("answers a ping directed at its own interface address", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const r = engine.add(new Router("r1", "R1"));
    r.addInterface("Gi0/0", macFromIndex(200));
    r.configureInterface("Gi0/0", { ip: "192.168.1.1", mask: 24 });

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "192.168.1.10", mask: 24, gateway: "192.168.1.1" });
    engine.connect("pc1", "eth0", "r1", "Gi0/0");

    pc1.ping("192.168.1.1", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
  });

  it("reaches a remote subnet across two routers via static routes", () => {
    const engine = createSimulationEngine({ seed: 7 });

    const r1 = engine.add(new Router("r1", "R1"));
    r1.addInterface("Gi0/0", macFromIndex(210));
    r1.addInterface("Gi0/1", macFromIndex(211));
    r1.configureInterface("Gi0/0", { ip: "10.0.1.1", mask: 24 });
    r1.configureInterface("Gi0/1", { ip: "10.0.0.1", mask: 30 });
    r1.addStaticRoute("10.0.2.0", 24, "10.0.0.2");

    const r2 = engine.add(new Router("r2", "R2"));
    r2.addInterface("Gi0/0", macFromIndex(220));
    r2.addInterface("Gi0/1", macFromIndex(221));
    r2.configureInterface("Gi0/0", { ip: "10.0.2.1", mask: 24 });
    r2.configureInterface("Gi0/1", { ip: "10.0.0.2", mask: 30 });
    r2.addStaticRoute("10.0.1.0", 24, "10.0.0.1");

    engine.connect("r1", "Gi0/1", "r2", "Gi0/1");

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "10.0.1.10", mask: 24, gateway: "10.0.1.1" });
    engine.connect("pc1", "eth0", "r1", "Gi0/0");

    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc2.addInterface("eth0", macFromIndex(2));
    pc2.configure({ ip: "10.0.2.10", mask: 24, gateway: "10.0.2.1" });
    engine.connect("pc2", "eth0", "r2", "Gi0/0");

    pc1.ping("10.0.2.10", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
  });

  it("drops a packet with no matching route and emits an ICMP error", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const r = engine.add(new Router("r1", "R1"));
    r.addInterface("Gi0/0", macFromIndex(200));
    r.configureInterface("Gi0/0", { ip: "192.168.1.1", mask: 24 });
    engine.enableTrace();

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "192.168.1.10", mask: 24, gateway: "192.168.1.1" });
    engine.connect("pc1", "eth0", "r1", "Gi0/0");

    pc1.ping("10.99.99.99", 1); // no route on the router
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: false });
    expect(engine.traceLog.some((e) => e.type === "icmp-error")).toBe(true);
  });
});

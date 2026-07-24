import {
  Layer3Switch,
  L2Switch,
  Pc,
  Router,
  createSimulationEngine,
  macFromIndex,
  type Ipv4Acl,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

const denyPc1: Ipv4Acl = {
  id: "deny-pc1",
  type: "standard",
  rules: [
    { sequence: 10, action: "deny", source: { kind: "host", address: "192.168.10.10" } },
    { sequence: 20, action: "permit", source: { kind: "any" } },
  ],
};

function routedPair() {
  const engine = createSimulationEngine({ seed: 101 });
  const router = engine.add(new Router("r1", "R1"));
  router.addInterface("Gi0/0", macFromIndex(200));
  router.addInterface("Gi0/1", macFromIndex(201));
  router.configureInterface("Gi0/0", { ip: "192.168.10.1", mask: 24 });
  router.configureInterface("Gi0/1", { ip: "192.168.20.1", mask: 24 });
  const pc1 = engine.add(new Pc("pc1", "PC1"));
  pc1.addInterface("eth0", macFromIndex(1));
  pc1.configure({ ip: "192.168.10.10", mask: 24, gateway: "192.168.10.1" });
  const pc2 = engine.add(new Pc("pc2", "PC2"));
  pc2.addInterface("eth0", macFromIndex(2));
  pc2.configure({ ip: "192.168.20.10", mask: 24, gateway: "192.168.20.1" });
  engine.connect("pc1", "eth0", "r1", "Gi0/0");
  engine.connect("pc2", "eth0", "r1", "Gi0/1");
  return { engine, router, pc1, pc2 };
}

function runDenied(direction: "in" | "out"): { trace: TraceEntry[]; counters: unknown } {
  const { engine, router, pc1 } = routedPair();
  engine.enableTrace();
  router.defineAcl(denyPc1);
  router.applyAcl(direction === "in" ? "Gi0/0" : "Gi0/1", direction, "deny-pc1");
  pc1.ping("192.168.20.10", 1);
  engine.runUntilIdle();
  expect(pc1.pingResults[0]).toMatchObject({ success: false });
  return { trace: engine.traceLog, counters: router.aclCounters() };
}

describe("routed interface ACL integration", () => {
  it("applies inbound and outbound ACLs at distinct routing pipeline points", () => {
    const inbound = runDenied("in");
    expect(inbound.trace).toContainEqual(expect.objectContaining({
      type: "acl-denied",
      detail: expect.objectContaining({ interface: "Gi0/0", direction: "in", sequence: 10 }),
    }));
    const outbound = runDenied("out");
    expect(outbound.trace).toContainEqual(expect.objectContaining({
      type: "acl-denied",
      detail: expect.objectContaining({ interface: "Gi0/1", direction: "out", sequence: 10 }),
    }));
  });

  it("emits deterministic evaluated/permit/deny/implicit trace records and counters", () => {
    const first = runDenied("in");
    const second = runDenied("in");
    expect(second).toEqual(first);
    expect(first.trace.filter((entry) => entry.type === "acl-evaluated")).toHaveLength(1);
    expect(first.counters).toEqual([{
      aclId: "deny-pc1",
      sequence: 10,
      action: "deny",
      matches: 1,
    }]);

    const { engine, router, pc1 } = routedPair();
    engine.enableTrace();
    router.defineAcl({
      id: "implicit",
      type: "standard",
      rules: [{ sequence: 10, action: "permit", source: { kind: "host", address: "203.0.113.1" } }],
    });
    router.applyAcl("Gi0/0", "in", "implicit");
    pc1.ping("192.168.20.10", 2);
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) => entry.type === "acl-implicit-deny")).toBe(true);

    const permitted = routedPair();
    permitted.engine.enableTrace();
    permitted.router.defineAcl({
      id: "permit-pc1",
      type: "standard",
      rules: [{ sequence: 10, action: "permit", source: { kind: "host", address: "192.168.10.10" } }],
    });
    permitted.router.applyAcl("Gi0/0", "in", "permit-pc1");
    permitted.pc1.ping("192.168.20.10", 3);
    permitted.engine.runUntilIdle();
    expect(permitted.pc1.pingResults[0]).toMatchObject({ success: true });
    expect(permitted.engine.traceLog.some((entry) => entry.type === "acl-permitted")).toBe(true);
  });

  it("applies ACLs to router dot1Q subinterfaces", () => {
    const engine = createSimulationEngine({ seed: 102 });
    const sw = engine.add(new L2Switch("sw", "SW"));
    const router = engine.add(new Router("r1", "R1"));
    const pc1 = engine.add(new Pc("pc1", "PC1"));
    const pc2 = engine.add(new Pc("pc2", "PC2"));
    router.addInterface("Gi0/0", macFromIndex(200));
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    sw.addInterface("Gi0/24", macFromIndex(124));
    pc1.addInterface("eth0", macFromIndex(1));
    pc2.addInterface("eth0", macFromIndex(2));
    pc1.configure({ ip: "192.168.10.10", mask: 24, gateway: "192.168.10.1" });
    pc2.configure({ ip: "192.168.20.10", mask: 24, gateway: "192.168.20.1" });
    engine.connect("pc1", "eth0", "sw", "Gi0/1");
    engine.connect("pc2", "eth0", "sw", "Gi0/2");
    engine.connect("r1", "Gi0/0", "sw", "Gi0/24");
    sw.setAccess("Gi0/1", 10);
    sw.setAccess("Gi0/2", 20);
    sw.setTrunk("Gi0/24", { allowedVlans: [10, 20] });
    router.addSubinterface("Gi0/0", 10, { ip: "192.168.10.1", mask: 24 });
    router.addSubinterface("Gi0/0", 20, { ip: "192.168.20.1", mask: 24 });
    router.defineAcl(denyPc1);
    router.applyAcl("Gi0/0.10", "in", "deny-pc1");

    pc1.ping("192.168.20.10", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults[0]).toMatchObject({ success: false });
    expect(router.aclCounters()).toEqual([expect.objectContaining({ sequence: 10, matches: 1 })]);
  });

  it("applies ACLs to L3 switch SVIs but not ordinary L2 switching", () => {
    const engine = createSimulationEngine({ seed: 103 });
    const sw = engine.add(new Layer3Switch("l3", "L3SW"));
    const pc1 = engine.add(new Pc("pc1", "PC1"));
    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc2.addInterface("eth0", macFromIndex(2));
    pc1.configure({ ip: "192.168.10.10", mask: 24, gateway: "192.168.10.1" });
    pc2.configure({ ip: "192.168.10.20", mask: 24, gateway: "192.168.10.1" });
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    engine.connect("pc1", "eth0", "l3", "Gi0/1");
    engine.connect("pc2", "eth0", "l3", "Gi0/2");
    sw.setAccess("Gi0/1", 10);
    sw.setAccess("Gi0/2", 10);
    sw.setSviIp(10, "192.168.10.1", 24);
    sw.setIpRouting(true);
    sw.defineAcl(denyPc1);
    sw.applyAcl("Vlan10", "in", "deny-pc1");

    pc1.ping("192.168.10.20", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults[0]).toMatchObject({ success: true });
    expect(sw.aclCounters()).toEqual([]);
  });

  it("applies ACLs to inter-VLAN SVI routing", () => {
    const engine = createSimulationEngine({ seed: 104 });
    const sw = engine.add(new Layer3Switch("l3", "L3SW"));
    const pc1 = engine.add(new Pc("pc1", "PC1"));
    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc2.addInterface("eth0", macFromIndex(2));
    pc1.configure({ ip: "192.168.10.10", mask: 24, gateway: "192.168.10.1" });
    pc2.configure({ ip: "192.168.20.10", mask: 24, gateway: "192.168.20.1" });
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    engine.connect("pc1", "eth0", "l3", "Gi0/1");
    engine.connect("pc2", "eth0", "l3", "Gi0/2");
    sw.setAccess("Gi0/1", 10);
    sw.setAccess("Gi0/2", 20);
    sw.setSviIp(10, "192.168.10.1", 24);
    sw.setSviIp(20, "192.168.20.1", 24);
    sw.setIpRouting(true);
    sw.defineAcl(denyPc1);
    sw.applyAcl("Vlan10", "in", "deny-pc1");

    pc1.ping("192.168.20.10", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults[0]).toMatchObject({ success: false });
    expect(sw.aclCounters()).toEqual([expect.objectContaining({ sequence: 10, matches: 1 })]);
  });

  it("shares the 2,048 rule budget across routed devices in one engine", () => {
    const engine = createSimulationEngine({ seed: 105 });
    const first = engine.add(new Router("r1", "R1"));
    const second = engine.add(new Router("r2", "R2"));
    const rules = Array.from({ length: 256 }, (_, index) => ({
      sequence: index,
      action: "permit" as const,
      source: { kind: "any" as const },
    }));
    for (let index = 0; index < 8; index++) {
      first.defineAcl({ id: `first-${index}`, type: "standard", rules });
    }
    expect(engine.aclRuleBudget.usedRules).toBe(2_048);
    expect(() => second.defineAcl({
      id: "overflow",
      type: "standard",
      rules: [{ sequence: 10, action: "permit", source: { kind: "any" } }],
    })).toThrowError(expect.objectContaining({ code: "ACL_LAB_RULE_LIMIT_EXCEEDED" }));
  });
});

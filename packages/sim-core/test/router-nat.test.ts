import { IpProtocol } from "@sim/contracts";
import {
  L2Switch,
  NatError,
  Pc,
  Router,
  createSimulationEngine,
  macFromIndex,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function natTopology() {
  const engine = createSimulationEngine({ seed: 201 });
  const router = engine.add(new Router("r1", "R1"));
  router.addInterface("Gi0/0", macFromIndex(200));
  router.addInterface("Gi0/1", macFromIndex(201));
  router.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
  router.configureInterface("Gi0/1", { ip: "203.0.113.1", mask: 24 });
  router.setNatRole("Gi0/0", "inside");
  router.setNatRole("Gi0/1", "outside");

  const insideSwitch = engine.add(new L2Switch("inside-sw", "InsideSW"));
  insideSwitch.addInterface("Gi0/1", macFromIndex(101));
  insideSwitch.addInterface("Gi0/2", macFromIndex(102));
  insideSwitch.addInterface("Gi0/24", macFromIndex(124));
  engine.connect("inside-sw", "Gi0/24", "r1", "Gi0/0");

  const pc1 = engine.add(new Pc("pc1", "PC1"));
  pc1.addInterface("eth0", macFromIndex(1));
  pc1.configure({ ip: "10.0.0.10", mask: 24, gateway: "10.0.0.1" });
  engine.connect("pc1", "eth0", "inside-sw", "Gi0/1");

  const pc2 = engine.add(new Pc("pc2", "PC2"));
  pc2.addInterface("eth0", macFromIndex(2));
  pc2.configure({ ip: "10.0.0.11", mask: 24, gateway: "10.0.0.1" });
  engine.connect("pc2", "eth0", "inside-sw", "Gi0/2");

  const outside = engine.add(new Pc("outside", "Outside"));
  outside.addInterface("eth0", macFromIndex(3));
  outside.configure({ ip: "203.0.113.10", mask: 24, gateway: "203.0.113.1" });
  engine.connect("outside", "eth0", "r1", "Gi0/1");
  return { engine, router, pc1, pc2, outside };
}

function runStatic(): { success: boolean; trace: TraceEntry[]; counters: unknown } {
  const { engine, router, pc1 } = natTopology();
  engine.enableTrace();
  router.defineNatRule({
    id: "static-pc1",
    sequence: 10,
    kind: "static",
    insideLocal: "10.0.0.10",
    insideGlobal: "203.0.113.100",
  });
  router.defineAcl({
    id: "translated-out",
    type: "standard",
    rules: [
      { sequence: 10, action: "permit", source: { kind: "host", address: "203.0.113.100" } },
    ],
  });
  router.applyAcl("Gi0/1", "out", "translated-out");
  router.defineAcl({
    id: "translated-in",
    type: "extended",
    rules: [{
      sequence: 10,
      action: "permit",
      protocol: IpProtocol.ICMP,
      source: { kind: "host", address: "203.0.113.10" },
      destination: { kind: "host", address: "10.0.0.10" },
    }],
  });
  router.applyAcl("Gi0/1", "in", "translated-in");
  pc1.ping("203.0.113.10", 1);
  engine.runUntilIdle();
  return {
    success: pc1.pingResults[0]?.success ?? false,
    trace: engine.traceLog,
    counters: router.aclCounters(),
  };
}

describe("Router deterministic NAT/PAT", () => {
  it("completes static NAT outbound and return with documented ACL address views", () => {
    const result = runStatic();
    expect(result.success).toBe(true);
    expect(result.trace).toContainEqual(expect.objectContaining({
      type: "nat-translated",
      detail: expect.objectContaining({
        addressField: "source",
        originalAddress: "10.0.0.10",
        translatedAddress: "203.0.113.100",
      }),
    }));
    expect(result.trace).toContainEqual(expect.objectContaining({
      type: "nat-translated",
      detail: expect.objectContaining({
        addressField: "destination",
        originalAddress: "203.0.113.100",
        translatedAddress: "10.0.0.10",
      }),
    }));
    expect(result.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({ aclId: "translated-out", action: "permit" }),
      expect.objectContaining({ aclId: "translated-in", action: "permit" }),
    ]));
  });

  it("runs two inside clients through PAT with stable distinct ICMP tokens", () => {
    const { engine, router, pc1, pc2 } = natTopology();
    engine.enableTrace();
    router.defineNatRule({
      id: "overload",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    pc1.ping("203.0.113.10", 1);
    pc2.ping("203.0.113.10", 2);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ success: true });
    expect(pc2.pingResults[0]).toMatchObject({ success: true });
    expect(router.natTranslations().map((row) => row.insideGlobalToken)).toEqual([49_152, 49_153]);
    expect(router.natTranslations().map((row) => row.insideLocalAddress).sort()).toEqual([
      "10.0.0.10",
      "10.0.0.11",
    ]);
  });

  it("uses a server-owned ACL selector for PAT", () => {
    const { engine, router, pc1, pc2 } = natTopology();
    router.defineAcl({
      id: "nat-sources",
      type: "standard",
      rules: [
        { sequence: 10, action: "permit", source: { kind: "host", address: "10.0.0.10" } },
      ],
    });
    router.defineNatRule({
      id: "selected-overload",
      sequence: 10,
      kind: "pat",
      source: { kind: "acl", aclId: "nat-sources" },
      outsideAddress: "interface",
    });
    router.defineAcl({
      id: "translated-only",
      type: "standard",
      rules: [
        { sequence: 10, action: "permit", source: { kind: "host", address: "203.0.113.1" } },
      ],
    });
    router.applyAcl("Gi0/1", "out", "translated-only");
    pc1.ping("203.0.113.10", 1);
    pc2.ping("203.0.113.10", 2);
    engine.runUntilIdle();
    expect(pc1.pingResults[0]).toMatchObject({ success: true });
    expect(pc2.pingResults[0]).toMatchObject({ success: false });
    expect(router.natTranslations()).toHaveLength(1);
  });

  it("denies unsolicited inbound PAT traffic without throwing from the data plane", () => {
    const { engine, router, outside } = natTopology();
    engine.enableTrace();
    router.defineNatRule({
      id: "overload",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    outside.ping("203.0.113.1", 1);
    engine.runUntilIdle();
    expect(outside.pingResults[0]).toMatchObject({ success: false });
    expect(engine.traceLog.some((entry) => entry.type === "nat-no-translation")).toBe(true);
  });

  it("does not implement hairpin NAT", () => {
    const { engine, router, pc1 } = natTopology();
    router.defineNatRule({
      id: "static-pc2",
      sequence: 10,
      kind: "static",
      insideLocal: "10.0.0.11",
      insideGlobal: "203.0.113.101",
    });
    pc1.ping("203.0.113.101", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults[0]).toMatchObject({ success: false });
  });

  it("raises a typed configuration failure when routed NAT roles are incomplete", () => {
    const { engine, router, pc1 } = natTopology();
    router.setNatRole("Gi0/1", undefined);
    router.defineNatRule({
      id: "static-pc1",
      sequence: 10,
      kind: "static",
      insideLocal: "10.0.0.10",
      insideGlobal: "203.0.113.100",
    });
    pc1.ping("203.0.113.10", 1);
    expect(() => engine.runUntilIdle()).toThrowError(expect.objectContaining<Partial<NatError>>({
      code: "NAT_ROLE_MISSING",
    }));
  });

  it("is deterministic across browser/verifier-style engine rebuilds", () => {
    expect(runStatic()).toEqual(runStatic());
  });
});

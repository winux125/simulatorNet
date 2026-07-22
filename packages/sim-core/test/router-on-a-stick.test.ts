import { describe, expect, it } from "vitest";
import { createSimulationEngine, L2Switch, macFromIndex, Pc, Router, type TraceEntry } from "@sim/sim-core";

/** Build the inter-VLAN topology and drive one ping; optionally trace it. */
function buildAndPing(trace: boolean): TraceEntry[] {
  const engine = createSimulationEngine({ seed: 3 });
  if (trace) engine.enableTrace();
  const sw = engine.add(new L2Switch("sw1", "SW1"));

  const pc1 = engine.add(new Pc("pc1", "PC1"));
  pc1.addInterface("eth0", macFromIndex(1));
  pc1.configure({ ip: "192.168.10.10", mask: 24, gateway: "192.168.10.1" });
  sw.addInterface("Gi0/1", macFromIndex(101));
  engine.connect("sw1", "Gi0/1", "pc1", "eth0");
  sw.setAccess("Gi0/1", 10);

  const pc2 = engine.add(new Pc("pc2", "PC2"));
  pc2.addInterface("eth0", macFromIndex(2));
  pc2.configure({ ip: "192.168.20.10", mask: 24, gateway: "192.168.20.1" });
  sw.addInterface("Gi0/2", macFromIndex(102));
  engine.connect("sw1", "Gi0/2", "pc2", "eth0");
  sw.setAccess("Gi0/2", 20);

  sw.addInterface("Gi0/24", macFromIndex(124));
  const r = engine.add(new Router("r1", "R1"));
  r.addInterface("Gi0/0", macFromIndex(200));
  engine.connect("sw1", "Gi0/24", "r1", "Gi0/0");
  sw.setTrunk("Gi0/24", { allowedVlans: [10, 20] });
  r.addSubinterface("Gi0/0", 10, { ip: "192.168.10.1", mask: 24 });
  r.addSubinterface("Gi0/0", 20, { ip: "192.168.20.1", mask: 24 });

  pc1.ping("192.168.20.10", 1);
  engine.runUntilIdle();
  expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
  return engine.traceLog;
}

/**
 * Router-on-a-stick: a single trunk link carries two VLANs to a router whose
 * dot1Q subinterfaces are the default gateways, enabling inter-VLAN routing.
 */
describe("router-on-a-stick inter-VLAN routing", () => {
  it("routes between two VLANs over one tagged trunk", () => {
    const engine = createSimulationEngine({ seed: 3 });
    const sw = engine.add(new L2Switch("sw1", "SW1"));

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "192.168.10.10", mask: 24, gateway: "192.168.10.1" });
    sw.addInterface("Gi0/1", macFromIndex(101));
    engine.connect("sw1", "Gi0/1", "pc1", "eth0");
    sw.setAccess("Gi0/1", 10);

    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc2.addInterface("eth0", macFromIndex(2));
    pc2.configure({ ip: "192.168.20.10", mask: 24, gateway: "192.168.20.1" });
    sw.addInterface("Gi0/2", macFromIndex(102));
    engine.connect("sw1", "Gi0/2", "pc2", "eth0");
    sw.setAccess("Gi0/2", 20);

    // Trunk to the router carrying both VLANs.
    sw.addInterface("Gi0/24", macFromIndex(124));
    const r = engine.add(new Router("r1", "R1"));
    r.addInterface("Gi0/0", macFromIndex(200));
    engine.connect("sw1", "Gi0/24", "r1", "Gi0/0");
    sw.setTrunk("Gi0/24", { allowedVlans: [10, 20] });

    r.addSubinterface("Gi0/0", 10, { ip: "192.168.10.1", mask: 24 });
    r.addSubinterface("Gi0/0", 20, { ip: "192.168.20.1", mask: 24 });

    pc1.ping("192.168.20.10", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });

    // The reverse direction works too, over the same trunk.
    pc2.ping("192.168.10.10", 2);
    engine.runUntilIdle();
    expect(pc2.pingResults.at(-1)).toMatchObject({ sequence: 2, success: true });
  });

  it("is deterministic: identical seed and input yield an identical event trace", () => {
    const first = buildAndPing(true);
    const second = buildAndPing(true);
    expect(second).toEqual(first);
    // Sanity: the trace captured routing across the dot1Q trunk.
    expect(first.some((e) => e.type === "route")).toBe(true);
  });
});

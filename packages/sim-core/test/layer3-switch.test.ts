import { Layer3Switch, Pc, createSimulationEngine, macFromIndex, type TraceEntry } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function interVlan(ipRouting = true) {
  const engine = createSimulationEngine({ seed: 40 });
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
  sw.setIpRouting(ipRouting);
  return { engine, sw, pc1, pc2 };
}

describe("layer-3 switch", () => {
  it("routes deterministically between VLANs through operational SVIs", () => {
    const run = (): { trace: TraceEntry[]; success: boolean } => {
      const { engine, sw, pc1 } = interVlan();
      engine.enableTrace();
      pc1.ping("192.168.20.10", 1);
      engine.runUntilIdle();
      expect(sw.sviSummaries()).toEqual([
        expect.objectContaining({ vlanId: 10, adminUp: true, operUp: true, ip: "192.168.10.1" }),
        expect.objectContaining({ vlanId: 20, adminUp: true, operUp: true, ip: "192.168.20.1" }),
      ]);
      expect(sw.routingTable()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "connected", network: "192.168.10.0", egressName: "Vlan10" }),
        expect.objectContaining({ kind: "connected", network: "192.168.20.0", egressName: "Vlan20" }),
      ]));
      return { trace: engine.traceLog, success: pc1.pingResults[0]?.success ?? false };
    };
    const first = run();
    const second = run();
    expect(first.success).toBe(true);
    expect(second).toEqual(first);
  });

  it("keeps VLAN switching but blocks transit routing while ip routing is disabled", () => {
    const { engine, sw, pc1 } = interVlan(false);
    pc1.ping("192.168.20.10", 1);
    engine.runUntilIdle();
    expect(sw.ipRoutingEnabled).toBe(false);
    expect(pc1.pingResults).toEqual([{ sequence: 1, success: false }]);
  });

  it("derives SVI operational state from admin state, VLAN existence, and an active member port", () => {
    const { sw } = interVlan();
    expect(sw.sviSummaries().find((row) => row.vlanId === 10)?.operUp).toBe(true);
    sw.setSviAdminState(10, false);
    expect(sw.sviSummaries().find((row) => row.vlanId === 10)).toMatchObject({ adminUp: false, operUp: false });
    sw.setSviAdminState(10, true);
    sw.getInterface("Gi0/1")!.shutdown();
    expect(sw.sviSummaries().find((row) => row.vlanId === 10)?.operUp).toBe(false);
  });

  it("routes through physical no-switchport interfaces without bridging them", () => {
    const engine = createSimulationEngine({ seed: 41 });
    const sw = engine.add(new Layer3Switch("l3", "L3SW"));
    const left = engine.add(new Pc("left", "Left"));
    const right = engine.add(new Pc("right", "Right"));
    left.addInterface("eth0", macFromIndex(1));
    right.addInterface("eth0", macFromIndex(2));
    left.configure({ ip: "10.0.1.10", mask: 24, gateway: "10.0.1.1" });
    right.configure({ ip: "10.0.2.10", mask: 24, gateway: "10.0.2.1" });
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    engine.connect("left", "eth0", "l3", "Gi0/1");
    engine.connect("right", "eth0", "l3", "Gi0/2");
    sw.configureRoutedInterface("Gi0/1", "10.0.1.1", 24);
    sw.configureRoutedInterface("Gi0/2", "10.0.2.1", 24);
    sw.setIpRouting(true);
    left.ping("10.0.2.10", 1);
    engine.runUntilIdle();
    expect(left.pingResults[0]).toMatchObject({ success: true });
    expect(sw.isRoutedPort("Gi0/1")).toBe(true);
    expect(sw.portSummaries().find((row) => row.name === "Gi0/1")?.mode).toBe("access");
    expect(sw.macAddressTable()).toHaveLength(0);
  });

  it("supports static routes and locally originated ping through the shared routing plane", () => {
    const { engine, sw } = interVlan();
    sw.addStaticRoute("172.16.0.0", 16, "192.168.20.10");
    expect(sw.routingTable()).toContainEqual(expect.objectContaining({
      kind: "static",
      network: "172.16.0.0",
      viaIp: "192.168.20.10",
      egressName: "Vlan20",
    }));
    sw.ping("192.168.20.10", 7);
    engine.runUntilIdle();
    expect(sw.pingResults).toEqual([expect.objectContaining({ sequence: 7, success: true })]);
  });
});

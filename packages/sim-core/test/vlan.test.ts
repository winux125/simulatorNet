import { describe, expect, it } from "vitest";
import { createSimulationEngine, L2Switch, macFromIndex, Pc, type SimulationEngine } from "@sim/sim-core";

/** Attach a PC to `port` on `sw`, in subnet 192.168.1.0/24. */
function addPc(engine: SimulationEngine, sw: L2Switch, index: number, port: string): Pc {
  const pc = engine.add(new Pc(`pc${index}`, `PC${index}`));
  pc.addInterface("eth0", macFromIndex(index));
  pc.configure({ ip: `192.168.1.${10 + index}`, mask: 24 });
  sw.addInterface(port, macFromIndex(100 + index));
  engine.connect(sw.id, port, pc.id, "eth0");
  return pc;
}

describe("VLAN segmentation on a single switch", () => {
  it("isolates hosts in different access VLANs", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const sw = engine.add(new L2Switch("sw1", "SW1"));
    const pc1 = addPc(engine, sw, 1, "Gi0/1");
    const pc2 = addPc(engine, sw, 2, "Gi0/2");
    sw.setAccess("Gi0/1", 10);
    sw.setAccess("Gi0/2", 20);

    pc1.ping("192.168.1.12", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: false });
    expect(pc2.arpTable.has("192.168.1.11")).toBe(false); // ARP never crossed VLANs
  });

  it("connects hosts in the same access VLAN", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const sw = engine.add(new L2Switch("sw1", "SW1"));
    const pc1 = addPc(engine, sw, 1, "Gi0/1");
    addPc(engine, sw, 2, "Gi0/2");
    sw.setAccess("Gi0/1", 10);
    sw.setAccess("Gi0/2", 10);

    pc1.ping("192.168.1.12", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
  });
});

describe("802.1Q trunking between two switches", () => {
  it("carries a tagged VLAN across the trunk but isolates other VLANs", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const sw1 = engine.add(new L2Switch("sw1", "SW1"));
    const sw2 = engine.add(new L2Switch("sw2", "SW2"));

    // PC1 on sw1 access VLAN 10; PC2 on sw2 access VLAN 10; PC3 on sw2 VLAN 20.
    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "192.168.10.11", mask: 24 });
    sw1.addInterface("Gi0/1", macFromIndex(101));
    engine.connect("sw1", "Gi0/1", "pc1", "eth0");
    sw1.setAccess("Gi0/1", 10);

    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc2.addInterface("eth0", macFromIndex(2));
    pc2.configure({ ip: "192.168.10.12", mask: 24 });
    sw2.addInterface("Gi0/1", macFromIndex(102));
    engine.connect("sw2", "Gi0/1", "pc2", "eth0");
    sw2.setAccess("Gi0/1", 10);

    const pc3 = engine.add(new Pc("pc3", "PC3"));
    pc3.addInterface("eth0", macFromIndex(3));
    pc3.configure({ ip: "192.168.10.13", mask: 24 });
    sw2.addInterface("Gi0/2", macFromIndex(103));
    engine.connect("sw2", "Gi0/2", "pc3", "eth0");
    sw2.setAccess("Gi0/2", 20);

    // Trunk carrying VLANs 10 and 20 between the switches.
    sw1.addInterface("Gi0/24", macFromIndex(124));
    sw2.addInterface("Gi0/24", macFromIndex(224));
    engine.connect("sw1", "Gi0/24", "sw2", "Gi0/24");
    sw1.setTrunk("Gi0/24", { allowedVlans: [10, 20] });
    sw2.setTrunk("Gi0/24", { allowedVlans: [10, 20] });

    pc1.ping("192.168.10.12", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
    // PC3 lives in VLAN 20 and must never have seen PC1's VLAN-10 broadcast.
    expect(pc3.arpTable.has("192.168.10.11")).toBe(false);
  });

  it("carries the native VLAN untagged across the trunk", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const sw1 = engine.add(new L2Switch("sw1", "SW1"));
    const sw2 = engine.add(new L2Switch("sw2", "SW2"));

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "192.168.99.11", mask: 24 });
    sw1.addInterface("Gi0/1", macFromIndex(101));
    engine.connect("sw1", "Gi0/1", "pc1", "eth0");
    sw1.setAccess("Gi0/1", 99);

    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc2.addInterface("eth0", macFromIndex(2));
    pc2.configure({ ip: "192.168.99.12", mask: 24 });
    sw2.addInterface("Gi0/1", macFromIndex(102));
    engine.connect("sw2", "Gi0/1", "pc2", "eth0");
    sw2.setAccess("Gi0/1", 99);

    sw1.addInterface("Gi0/24", macFromIndex(124));
    sw2.addInterface("Gi0/24", macFromIndex(224));
    engine.connect("sw1", "Gi0/24", "sw2", "Gi0/24");
    sw1.setTrunk("Gi0/24", { nativeVlan: 99, allowedVlans: [99] });
    sw2.setTrunk("Gi0/24", { nativeVlan: 99, allowedVlans: [99] });

    pc1.ping("192.168.99.12", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
  });
});

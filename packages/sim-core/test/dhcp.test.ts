import { describe, expect, it } from "vitest";
import { createSimulationEngine, L2Switch, macFromIndex, maskToInt, Pc, Router } from "@sim/sim-core";

describe("DHCP address acquisition", () => {
  it("leases an address, mask and gateway to a client (DORA)", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const r = engine.add(new Router("r1", "R1"));
    r.addInterface("Gi0/0", macFromIndex(200));
    r.configureInterface("Gi0/0", { ip: "192.168.1.1", mask: 24 });
    r.addDhcpPool({
      network: "192.168.1.0",
      mask: 24,
      gateway: "192.168.1.1",
      rangeStart: "192.168.1.100",
      rangeEnd: "192.168.1.150",
    });

    const pc = engine.add(new Pc("pc1", "PC1"));
    pc.addInterface("eth0", macFromIndex(1));
    engine.connect("pc1", "eth0", "r1", "Gi0/0");

    pc.requestDhcp();
    engine.runUntilIdle();

    expect(pc.dhcpBound).toBe(true);
    expect(pc.ip).toBe("192.168.1.100");
    expect(pc.gateway).toBe("192.168.1.1");
    expect(pc.maskInt).toBe(maskToInt(24));
  });

  it("hands distinct addresses to two clients, who can then reach the gateway", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const r = engine.add(new Router("r1", "R1"));
    r.addInterface("Gi0/0", macFromIndex(200));
    r.configureInterface("Gi0/0", { ip: "192.168.1.1", mask: 24 });
    r.addDhcpPool({
      network: "192.168.1.0",
      mask: 24,
      gateway: "192.168.1.1",
      rangeStart: "192.168.1.100",
      rangeEnd: "192.168.1.150",
    });

    const sw = engine.add(new L2Switch("sw1", "SW1"));
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    sw.addInterface("Gi0/3", macFromIndex(103));
    engine.connect("sw1", "Gi0/3", "r1", "Gi0/0");

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    engine.connect("sw1", "Gi0/1", "pc1", "eth0");

    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc2.addInterface("eth0", macFromIndex(2));
    engine.connect("sw1", "Gi0/2", "pc2", "eth0");

    pc1.requestDhcp();
    pc2.requestDhcp();
    engine.runUntilIdle();

    expect(pc1.dhcpBound).toBe(true);
    expect(pc2.dhcpBound).toBe(true);
    expect(pc1.ip).not.toBe(pc2.ip);

    pc1.ping("192.168.1.1", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults.at(-1)).toMatchObject({ success: true });
  });
});

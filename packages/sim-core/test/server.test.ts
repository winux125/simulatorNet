import { L2Switch, Pc, Router, Server, createSimulationEngine, macFromIndex, type TraceEntry } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

describe("server end host", () => {
  it("reuses the host stack for static IPv4 and answers ICMP deterministically", () => {
    const run = (): { success: boolean; trace: TraceEntry[] } => {
      const engine = createSimulationEngine({ seed: 30 });
      const sw = engine.add(new L2Switch("sw", "SW"));
      const server = engine.add(new Server("server", "Server"));
      const pc = engine.add(new Pc("pc", "PC"));
      server.addInterface("eth0", macFromIndex(1));
      server.addInterface("eth1", macFromIndex(2));
      server.configure({ ip: "192.168.50.10", mask: 24, gateway: "192.168.50.1" });
      pc.addInterface("eth0", macFromIndex(3));
      pc.configure({ ip: "192.168.50.20", mask: 24, gateway: "192.168.50.1" });
      sw.addInterface("Gi0/1", macFromIndex(101));
      sw.addInterface("Gi0/2", macFromIndex(102));
      engine.connect("server", "eth0", "sw", "Gi0/1");
      engine.connect("pc", "eth0", "sw", "Gi0/2");
      engine.enableTrace();
      pc.ping("192.168.50.10", 1);
      engine.runUntilIdle();
      expect([...server.interfaces.keys()]).toEqual(["eth0", "eth1"]);
      expect(server.enabledServices).toEqual([]);
      return { success: pc.pingResults[0]?.success ?? false, trace: engine.traceLog };
    };
    const first = run();
    expect(first.success).toBe(true);
    expect(run()).toEqual(first);
  });

  it("acquires a DHCP lease through the shared end-host client", () => {
    const engine = createSimulationEngine({ seed: 31 });
    const router = engine.add(new Router("router", "R1"));
    const server = engine.add(new Server("server", "Server"));
    router.addInterface("Gi0/0", macFromIndex(100));
    router.configureInterface("Gi0/0", { ip: "10.10.0.1", mask: 24 });
    router.addDhcpPool({ network: "10.10.0.0", mask: 24, gateway: "10.10.0.1", rangeStart: "10.10.0.10", rangeEnd: "10.10.0.20" });
    server.addInterface("eth0", macFromIndex(1));
    server.addInterface("eth1", macFromIndex(2));
    engine.connect("server", "eth0", "router", "Gi0/0");
    server.requestDhcp();
    engine.runUntilIdle();
    expect(server.dhcpBound).toBe(true);
    expect(server.ip).toBe("10.10.0.10");
    expect(server.gateway).toBe("10.10.0.1");
  });

  it("does not become a router merely because both Ethernet interfaces are present", () => {
    const engine = createSimulationEngine({ seed: 30 });
    const server = engine.add(new Server("server", "Server"));
    server.addInterface("eth0", macFromIndex(1));
    server.addInterface("eth1", macFromIndex(2));
    server.configure({ ip: "192.168.50.10", mask: 24, gateway: "192.168.50.1" });
    expect(server.configurationSnapshot()).toMatchObject({ ip: "192.168.50.10", dhcpEnabled: false });
    expect([...server.interfaces.keys()]).toEqual(["eth0", "eth1"]);
    expect(server.enabledServices).toEqual([]);
    expect("routingTable" in server).toBe(false);
  });
});

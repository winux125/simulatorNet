import { createSimulationEngine, macFromIndex, Pc, Router, Server, TcpState } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

describe("EndHost runtime reconfiguration", () => {
  it("clears ARP and active TCP state without removing physical links", () => {
    const engine = createSimulationEngine({ seed: 91 });
    const pc = engine.add(new Pc("pc", "PC"));
    const server = engine.add(new Server("server", "SRV"));
    pc.addInterface("eth0", macFromIndex(1));
    server.addInterface("eth0", macFromIndex(2));
    engine.connect("pc", "eth0", "server", "eth0");
    pc.configure({ ip: "10.0.0.10", mask: 24 });
    server.configure({ ip: "10.0.0.20", mask: 24 });
    pc.arpTable.set("10.0.0.20", server.primary.mac);
    pc.connectTcp("10.0.0.20", 80);
    expect(pc.transport.tcp.inspect()).toEqual([expect.objectContaining({ state: TcpState.SynSent })]);

    pc.setStaticConfiguration({ address: "10.0.0.11", prefixLength: 24 });

    expect(pc.arpTable.size).toBe(0);
    expect(pc.transport.tcp.inspect()).toEqual([]);
    expect(pc.primary.link).toBeTruthy();
    expect(engine.links).toHaveLength(1);
  });

  it("recreates Server service listeners on the new address", () => {
    const engine = createSimulationEngine({ seed: 92 });
    const server = engine.add(new Server("server", "SRV"));
    server.addInterface("eth0", macFromIndex(3));
    server.configure({ ip: "10.0.0.20", mask: 24 });
    server.configureServices([{
      id: "dns",
      type: "dns",
      enabled: true,
      port: 53,
      records: [{ name: "host.lab", address: "10.0.0.20" }],
    }]);
    engine.runUntilIdle();
    expect(server.transport.udp.inspect()).toEqual([expect.objectContaining({ localAddress: "10.0.0.20", service: "dns" })]);

    server.setStaticConfiguration({ address: "10.0.0.21", prefixLength: 24 });
    engine.runUntilIdle();

    expect(server.transport.udp.inspect()).toEqual([expect.objectContaining({ localAddress: "10.0.0.21", service: "dns" })]);
    expect(server.listServices()).toEqual([expect.objectContaining({ id: "dns", state: "listening" })]);
  });

  it("rebinds Server listeners after a DHCP lease assigns the runtime address", () => {
    const engine = createSimulationEngine({ seed: 93 });
    const router = engine.add(new Router("router", "R1"));
    const server = engine.add(new Server("server", "SRV"));
    router.addInterface("Gi0/0", macFromIndex(100));
    router.configureInterface("Gi0/0", { ip: "10.10.0.1", mask: 24 });
    router.addDhcpPool({
      network: "10.10.0.0",
      mask: 24,
      gateway: "10.10.0.1",
      rangeStart: "10.10.0.10",
      rangeEnd: "10.10.0.20",
    });
    server.addInterface("eth0", macFromIndex(1));
    engine.connect("server", "eth0", "router", "Gi0/0");
    server.configureServices([{
      id: "http",
      type: "http",
      enabled: true,
      port: 80,
      resources: [{ path: "/", contentType: "text/plain", body: "ok" }],
    }]);

    server.requestDhcp();
    engine.runUntilIdle();

    expect(server.ip).toBe("10.10.0.10");
    expect(server.transport.tcp.inspect()).toEqual([
      expect.objectContaining({ localAddress: "10.10.0.10", localPort: 80, service: "http" }),
    ]);
  });
});

import {
  Server,
  TrafficGenerator,
  createSimulationEngine,
  macFromIndex,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function generatorTopology() {
  const engine = createSimulationEngine({ seed: 501 });
  const generator = engine.add(new TrafficGenerator("tg", "TG1"));
  generator.addInterface("eth0", macFromIndex(1));
  generator.configure({ ip: "192.168.1.10", mask: 24 });
  const server = engine.add(new Server("server", "Server"));
  server.addInterface("eth0", macFromIndex(2));
  server.configure({ ip: "192.168.1.20", mask: 24 });
  engine.connect("tg", "eth0", "server", "eth0");
  return { engine, generator, server };
}

describe("bounded Traffic Generator", () => {
  it("queues ICMP work for Step and completes it when the virtual queue drains", () => {
    const { engine, generator } = generatorTopology();
    generator.configureFlow({
      id: "ping",
      protocol: "icmp",
      destination: "192.168.1.20",
      count: 2,
      intervalNs: 1_000_000,
    });
    expect(generator.startFlow("ping")).toMatchObject({ status: "queued", sent: 0 });
    expect(engine.pendingEventCount()).toBeGreaterThan(0);
    expect(engine.runNextEvent()).toBe(true);
    expect(generator.flowResults()[0]).toMatchObject({ status: "running", sent: 1 });
    engine.runUntilIdle();
    expect(generator.flowResults()[0]).toMatchObject({
      status: "completed",
      sent: 2,
      received: 2,
      permitted: 2,
      dropped: 0,
      timedOut: 0,
    });
  });

  it("runs bounded UDP, TCP, and HTTP flows to deterministic completion", () => {
    const { engine, generator, server } = generatorTopology();
    server.bindUdp(9000, () => {});
    server.listenTcp(443, () => {}, "tcp-test");
    server.configureService({
      id: "web",
      type: "http",
      enabled: true,
      port: 80,
      resources: [{ path: "/", contentType: "text/plain", body: "ok" }],
    });
    generator.configureFlow({
      id: "udp",
      protocol: "udp",
      destination: "192.168.1.20",
      destinationPort: 9000,
      count: 2,
      intervalNs: 0,
      payloadBytes: 32,
    });
    generator.configureFlow({
      id: "tcp",
      protocol: "tcp",
      destination: "192.168.1.20",
      destinationPort: 443,
      count: 1,
      intervalNs: 0,
    });
    generator.configureFlow({
      id: "http",
      protocol: "http",
      destination: "192.168.1.20",
      url: "http://192.168.1.20/",
      count: 1,
      intervalNs: 0,
    });
    generator.startFlow("udp");
    generator.startFlow("tcp");
    generator.startFlow("http");
    engine.runUntilIdle();
    expect(generator.flowResults()).toEqual(expect.arrayContaining([
      expect.objectContaining({ flowId: "udp", status: "completed", sent: 2 }),
      expect.objectContaining({ flowId: "tcp", status: "completed", sent: 1, received: 1 }),
      expect.objectContaining({ flowId: "http", status: "completed", sent: 1, received: 1 }),
    ]));
  });

  it("enforces finite flow count, interval, payload, URL and flow-table limits", () => {
    const { generator } = generatorTopology();
    expect(() => generator.configureFlow({
      id: "too-many",
      protocol: "icmp",
      destination: "192.168.1.20",
      count: 1_025,
      intervalNs: 0,
    })).toThrow(/count/);
    expect(() => generator.configureFlow({
      id: "bad-http",
      protocol: "http",
      destination: "192.168.1.20",
      url: "https://example.invalid/",
      count: 1,
      intervalNs: 0,
    })).toThrow(/http:\/\//);
    for (let index = 0; index < 32; index++) {
      generator.configureFlow({
        id: `flow-${index}`,
        protocol: "icmp",
        destination: "192.168.1.20",
        count: 1,
        intervalNs: 0,
      });
    }
    expect(() => generator.configureFlow({
      id: "overflow",
      protocol: "icmp",
      destination: "192.168.1.20",
      count: 1,
      intervalNs: 0,
    })).toThrow(/limit/);
  });

  it("produces stable flow configuration and runtime results", () => {
    const run = () => {
      const { engine, generator } = generatorTopology();
      generator.configureFlow({
        id: "ping",
        protocol: "icmp",
        destination: "192.168.1.20",
        count: 3,
        intervalNs: 1_000,
      });
      generator.startFlow("ping");
      engine.runUntilIdle();
      return {
        configurations: generator.flowConfigurations(),
        results: generator.flowResults(),
        virtualTime: engine.now(),
      };
    };
    expect(run()).toEqual(run());
  });
});

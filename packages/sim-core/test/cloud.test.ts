import {
  IspCloud,
  Pc,
  createSimulationEngine,
  macFromIndex,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function cloudRun(lossRate: number, latencyNs: number): { success: boolean; trace: TraceEntry[]; rttNs?: number } {
  const engine = createSimulationEngine({ seed: 401 });
  engine.enableTrace();
  const cloud = engine.add(new IspCloud("isp", "ISP"));
  cloud.addInterface("Eth0/0", macFromIndex(200));
  cloud.addInterface("Eth0/1", macFromIndex(201));
  cloud.configureInterface("Eth0/0", { ip: "10.0.0.1", mask: 24 });
  cloud.configureInterface("Eth0/1", { ip: "203.0.113.1", mask: 24 });
  cloud.configureImpairment({ interfaceName: "Eth0/0", additionalLatencyNs: latencyNs, packetLossRate: lossRate });
  cloud.configureImpairment({ interfaceName: "Eth0/1", additionalLatencyNs: latencyNs, packetLossRate: lossRate });
  cloud.validateInterfaceCount();
  const left = engine.add(new Pc("left", "Left"));
  left.addInterface("eth0", macFromIndex(1));
  left.configure({ ip: "10.0.0.10", mask: 24, gateway: "10.0.0.1" });
  const right = engine.add(new Pc("right", "Right"));
  right.addInterface("eth0", macFromIndex(2));
  right.configure({ ip: "203.0.113.10", mask: 24, gateway: "203.0.113.1" });
  engine.connect("left", "eth0", "isp", "Eth0/0");
  engine.connect("right", "eth0", "isp", "Eth0/1");
  left.ping("203.0.113.10", 1);
  engine.runUntilIdle();
  return {
    success: left.pingResults[0]?.success ?? false,
    rttNs: left.pingResults[0]?.rttNs,
    trace: engine.traceLog,
  };
}

describe("simulated ISP Cloud", () => {
  it("routes configured prefixes with deterministic additional latency", () => {
    const result = cloudRun(0, 5_000_000);
    expect(result.success).toBe(true);
    expect(result.rttNs).toBeGreaterThanOrEqual(10_000_000);
    expect(result.trace.filter((entry) => entry.type === "cloud-packet-delayed")).toHaveLength(2);
  });

  it("applies seeded deterministic packet loss without real network access", () => {
    expect(cloudRun(0.35, 0)).toEqual(cloudRun(0.35, 0));
    const dropped = cloudRun(1, 0);
    expect(dropped.success).toBe(false);
    expect(dropped.trace.some((entry) => entry.type === "cloud-packet-dropped")).toBe(true);
  });

  it("enforces the supported 2-8 Ethernet interface boundary", () => {
    const engine = createSimulationEngine({ seed: 402 });
    const cloud = engine.add(new IspCloud("isp", "ISP"));
    cloud.addInterface("Eth0/0", macFromIndex(1));
    expect(() => cloud.validateInterfaceCount()).toThrow(/2-8/);
    for (let index = 1; index < 8; index++) cloud.addInterface(`Eth0/${index}`, macFromIndex(index + 1));
    expect(() => cloud.validateInterfaceCount()).not.toThrow();
    cloud.addInterface("Eth0/8", macFromIndex(20));
    expect(() => cloud.validateInterfaceCount()).toThrow(/2-8/);
  });
});

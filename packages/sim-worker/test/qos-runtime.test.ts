import type { LabDocument } from "@sim/contracts";
import { SimulationWorkerRuntime } from "@sim/sim-worker";
import { describe, expect, it } from "vitest";

const LAB: LabDocument = {
  schemaVersion: 1,
  id: "qos-runtime",
  title: "QoS runtime",
  simulation: { seed: 11 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc", kind: "pc", name: "PC", interfaces: [{ id: "eth0" }] },
      { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      { id: "srv", kind: "server", name: "SRV", interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "lan", a: { node: "pc", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
      { id: "wan", a: { node: "r1", iface: "Gi0/1" }, b: { node: "srv", iface: "eth0" }, capacityBps: 2_000_000 },
    ],
  },
  configurations: {
    pc: { kind: "pc", ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" } },
    r1: {
      kind: "router",
      interfaces: [
        { id: "Gi0/0", routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Gi0/1", routed: true, ipv4: { address: "10.0.1.1", prefixLength: 24 } },
      ],
    },
    srv: {
      kind: "server",
      interfaces: [{ id: "eth0", ipv4: { address: "10.0.1.10", prefixLength: 24 } }],
      defaultGateway: "10.0.1.1",
    },
  },
} as unknown as LabDocument;

function runtime() {
  const worker = new SimulationWorkerRuntime();
  const response = worker.handleRequest({ type: "INITIALIZE_LAB", requestId: "1", document: LAB });
  expect(response.type).toBe("REQUEST_SUCCEEDED");
  return worker;
}

function succeed<T>(response: { type: string; payload?: unknown; error?: unknown }): T {
  expect(response.type, JSON.stringify(response.error)).toBe("REQUEST_SUCCEEDED");
  return response.payload as T;
}

describe("worker QoS surface", () => {
  it("reports link performance in the UI snapshot", () => {
    const worker = runtime();
    const snapshot = succeed<{ links: Array<{ id: string; performance: { capacityBps: number } }> }>(
      worker.handleRequest({ type: "GET_SNAPSHOT", requestId: "2" }),
    );
    expect(snapshot.links.find((link) => link.id === "wan")?.performance.capacityBps).toBe(2_000_000);
  });

  it("applies a link performance change while the lab runs and persists it", () => {
    const worker = runtime();
    const view = succeed<{ performance: { capacityBps: number }; document: LabDocument }>(
      worker.handleRequest({
        type: "SET_LINK_PERFORMANCE",
        requestId: "3",
        linkId: "wan",
        performance: { capacityBps: 512_000, queueLimitPackets: 16 },
      }),
    );
    expect(view.performance.capacityBps).toBe(512_000);
    expect(view.document.topology.links.find((link) => link.id === "wan")?.queueLimitPackets).toBe(16);
  });

  it("rejects a link performance value outside the deterministic model", () => {
    const worker = runtime();
    const response = worker.handleRequest({
      type: "SET_LINK_PERFORMANCE",
      requestId: "4",
      linkId: "wan",
      performance: { capacityBps: 1 },
    });
    expect(response.type).toBe("REQUEST_FAILED");
  });

  it("writes and reads QoS configuration through the typed API", () => {
    const worker = runtime();
    const view = succeed<{ configuration: { policyMaps: Array<{ id: string }> }; runtime: { queues: unknown[] } }>(
      worker.handleRequest({
        type: "SET_QOS_CONFIGURATION",
        requestId: "5",
        deviceId: "r1",
        configuration: {
          classMaps: [{ id: "REALTIME", matchType: "match-any", matches: [{ kind: "dscp", values: [46] }] }],
          policyMaps: [{
            id: "WAN-EDGE",
            classes: [
              { className: "REALTIME", priority: { percent: 20 } },
              { className: "class-default", bandwidthPercent: 60 },
            ],
          }],
          servicePolicies: [{ interfaceName: "Gi0/1", direction: "output", policyMapId: "WAN-EDGE" }],
        },
      }),
    );
    expect(view.configuration.policyMaps.map((map) => map.id)).toEqual(["WAN-EDGE"]);
    expect(view.runtime.queues.length).toBeGreaterThan(0);

    const reread = succeed<{ configuration: { servicePolicies: unknown[] } }>(
      worker.handleRequest({ type: "GET_QOS_CONFIGURATION", requestId: "6", deviceId: "r1" }),
    );
    expect(reread.configuration.servicePolicies).toHaveLength(1);
  });

  it("clears QoS counters without touching configuration", () => {
    const worker = runtime();
    succeed(worker.handleRequest({
      type: "SET_QOS_CONFIGURATION",
      requestId: "7",
      deviceId: "r1",
      configuration: {
        classMaps: [{ id: "ANY", matchType: "match-any", matches: [{ kind: "any" }] }],
        policyMaps: [{ id: "P", classes: [{ className: "ANY", marking: { dscp: 46 } }] }],
        servicePolicies: [{ interfaceName: "Gi0/1", direction: "output", policyMapId: "P" }],
      },
    }));
    succeed(worker.handleRequest({
      type: "EXECUTE_CLI",
      requestId: "8",
      sessionId: "s1",
      deviceId: "pc",
      input: "ping 10.0.1.10",
    }));
    const before = succeed<{ runtime: { counters: unknown[] } }>(
      worker.handleRequest({ type: "GET_QOS_CONFIGURATION", requestId: "9", deviceId: "r1" }),
    );
    expect(before.runtime.counters.length).toBeGreaterThan(0);
    const after = succeed<{ runtime: { counters: unknown[] }; configuration: { policyMaps: unknown[] } }>(
      worker.handleRequest({ type: "CLEAR_QOS_RUNTIME", requestId: "10", deviceId: "r1" }),
    );
    expect(after.runtime.counters).toHaveLength(0);
    expect(after.configuration.policyMaps).toHaveLength(1);
  });

  it("refuses QoS on a device with no routed data plane", () => {
    const worker = runtime();
    const response = worker.handleRequest({ type: "GET_QOS_CONFIGURATION", requestId: "11", deviceId: "pc" });
    expect(response.type).toBe("REQUEST_FAILED");
  });
});

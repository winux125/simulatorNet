import type { LabDocument } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type DeviceInspection,
  type LabUiSnapshot,
  type SimWorkerPayload,
  type SimWorkerRequest,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";

function expandedDeviceLab(): LabDocument {
  return {
    schemaVersion: 1,
    id: "m10-expanded-devices",
    title: "Expanded devices",
    simulation: { seed: 10_001 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "server-1", kind: "server", name: "SRV1", interfaces: [{ id: "eth0" }, { id: "eth1" }] },
        { id: "hub-1", kind: "hub", name: "HUB1", interfaces: Array.from({ length: 8 }, (_, index) => ({ id: `Eth0/${index + 1}` })) },
        { id: "bridge-1", kind: "bridge", name: "BR1", interfaces: [{ id: "Eth0/1" }, { id: "Eth0/2" }] },
        { id: "l3-1", kind: "l3-switch", name: "DSW1", interfaces: Array.from({ length: 8 }, (_, index) => ({ id: `Gi0/${index + 1}` })) },
      ],
      links: [
        { id: "link-1", a: { node: "server-1", iface: "eth0" }, b: { node: "hub-1", iface: "Eth0/1" } },
        { id: "link-2", a: { node: "hub-1", iface: "Eth0/2" }, b: { node: "bridge-1", iface: "Eth0/1" } },
        { id: "link-3", a: { node: "bridge-1", iface: "Eth0/2" }, b: { node: "l3-1", iface: "Gi0/1" } },
      ],
    },
    configurations: {
      "server-1": {
        kind: "server",
        hostname: "SRV1",
        interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.0.10.2", prefixLength: 24 } }],
        defaultGateway: "10.0.10.1",
        dhcpClientEnabled: false,
        enabledServices: [],
      },
      "hub-1": { kind: "hub", hostname: "HUB1", interfaces: [] },
      "bridge-1": { kind: "bridge", hostname: "BR1", interfaces: [], agingTimeNs: 300_000_000_000 },
      "l3-1": {
        kind: "l3-switch",
        hostname: "DSW1",
        vlans: [{ id: 10, name: "SERVERS" }],
        interfaces: [
          { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
          { id: "Gi0/2", shutdown: false, mode: "routed", ipv4: { address: "192.0.2.1", prefixLength: 24 } },
        ],
        svis: [{ vlanId: 10, ipAddress: "10.0.10.1", prefixLength: 24, adminUp: true }],
        staticRoutes: [{ network: "203.0.113.0", prefixLength: 24, nextHop: "192.0.2.2" }],
        ipRoutingEnabled: true,
      },
    },
  };
}

function request<Type extends SimWorkerRequest["type"]>(
  runtime: ReturnType<typeof createSimulationWorkerRuntime>,
  input: Omit<Extract<SimWorkerRequest, { type: Type }>, "requestId">,
): SimWorkerPayload {
  const response = runtime.handleRequest({ ...input, requestId: `m10-${input.type}` });
  if (response.type === "REQUEST_FAILED") throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.payload;
}

describe("M10 worker integration", () => {
  it("initializes and serializes every expanded device as plain deterministic JSON", () => {
    const runtime = createSimulationWorkerRuntime();
    const snapshot = request(runtime, { type: "INITIALIZE_LAB", document: expandedDeviceLab() }) as LabUiSnapshot;
    expect(snapshot.nodes.map((node) => node.type)).toEqual(["bridge", "hub", "l3-switch", "server"]);
    expect(snapshot.nodes.find((node) => node.id === "server-1")?.interfaces[0]?.ipAddress).toBe("10.0.10.2");
    expect(snapshot.nodes.find((node) => node.id === "l3-1")?.interfaces[1]).toMatchObject({ mode: "routed", ipAddress: "192.0.2.1" });

    const serialized = request(runtime, { type: "SERIALIZE_LAB" }) as LabDocument;
    expect(serialized.configurations).toMatchObject({
      "server-1": { kind: "server", enabledServices: [] },
      "hub-1": { kind: "hub" },
      "bridge-1": { kind: "bridge" },
      "l3-1": { kind: "l3-switch", ipRoutingEnabled: true },
    });
    expect(JSON.parse(JSON.stringify({ snapshot, serialized }))).toEqual({ snapshot, serialized });
  });

  it("reports hub, bridge, server and layer-3 switch capability-aware inspection", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: expandedDeviceLab() });
    const ping = request(runtime, { type: "EXECUTE_CLI", sessionId: "server", deviceId: "server-1", input: "ping 10.0.10.1" });
    expect(ping).toMatchObject({ output: expect.stringContaining("Success rate is 100 percent") });

    const hub = request(runtime, { type: "GET_DEVICE_INSPECTION", deviceId: "hub-1" }) as DeviceInspection;
    const bridge = request(runtime, { type: "GET_DEVICE_INSPECTION", deviceId: "bridge-1" }) as DeviceInspection;
    const server = request(runtime, { type: "GET_DEVICE_INSPECTION", deviceId: "server-1" }) as DeviceInspection;
    const l3 = request(runtime, { type: "GET_DEVICE_INSPECTION", deviceId: "l3-1" }) as DeviceInspection;
    expect(hub).toMatchObject({ type: "hub", counters: { repeatedFrames: expect.any(Number), droppedFrames: expect.any(Number) } });
    expect(hub.counters?.repeatedFrames).toBeGreaterThan(0);
    expect(bridge).toMatchObject({ type: "bridge", macEntries: expect.arrayContaining([expect.objectContaining({ interfaceId: "Eth0/1" })]) });
    expect(server).toMatchObject({ type: "server", services: [], capabilities: expect.arrayContaining(["application-services"]) });
    expect(l3).toMatchObject({
      type: "l3-switch",
      ipRoutingEnabled: true,
      svis: [expect.objectContaining({ vlanId: 10, operationalUp: true })],
      routes: expect.arrayContaining([expect.objectContaining({ network: "203.0.113.0", prefixLength: 24 })]),
    });
  });

  it("rejects a hub CLI session with a stable typed worker error", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: expandedDeviceLab() });
    expect(runtime.handleRequest({
      type: "EXECUTE_CLI",
      requestId: "hub-cli",
      sessionId: "hub",
      deviceId: "hub-1",
      input: "show interfaces",
    })).toMatchObject({
      type: "REQUEST_FAILED",
      requestId: "hub-cli",
      error: { code: "cli-not-supported" },
    });
  });
});

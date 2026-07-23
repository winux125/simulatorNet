import type { LabDocument } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type CliExecutionResult,
  type HostNetworkStatus,
  type SimWorkerRequest,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";

function hostLab(options: { server?: boolean } = {}): LabDocument {
  const secondKind = options.server ? "server" as const : "pc" as const;
  return {
    schemaVersion: 1,
    id: "host-ip-lab",
    title: "Host IP lab",
    simulation: { seed: 77 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc-1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
        { id: "switch-1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: options.server ? "server-1" : "pc-2", kind: secondKind, name: options.server ? "SRV1" : "PC2", interfaces: [{ id: "eth0" }] },
      ],
      links: [
        { id: "a", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
        { id: "b", a: { node: "switch-1", iface: "Gi0/2" }, b: { node: options.server ? "server-1" : "pc-2", iface: "eth0" } },
      ],
    },
    configurations: {
      "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false },
      "switch-1": { kind: "l2-switch", hostname: "SW1", interfaces: [], vlans: [] },
      [options.server ? "server-1" : "pc-2"]: options.server
        ? {
          kind: "server",
          hostname: "SRV1",
          interfaces: [{ id: "eth0", shutdown: false }],
          dhcpClientEnabled: false,
          enabledServices: [{
            id: "http",
            type: "http",
            port: 80,
            enabled: true,
            resources: [{ path: "/", contentType: "text/plain", body: "ok" }],
          }],
        }
        : { kind: "pc", hostname: "PC2", interfaces: [], dhcpEnabled: false },
    },
  };
}

function succeeded<Type extends SimWorkerRequest["type"]>(
  runtime: ReturnType<typeof createSimulationWorkerRuntime>,
  input: Omit<Extract<SimWorkerRequest, { type: Type }>, "requestId">,
) {
  const response = runtime.handleRequest({ ...input, requestId: input.type });
  if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
  return response.payload;
}

describe("typed host IP worker workflow", () => {
  it("configures two PCs and pings through an L2 switch without a gateway", () => {
    const runtime = createSimulationWorkerRuntime();
    succeeded(runtime, { type: "INITIALIZE_LAB", document: hostLab() });
    succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "pc-1",
      configuration: { address: "192.168.10.10", prefixLength: 24 },
    });
    succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "pc-2",
      configuration: { address: "192.168.10.20", prefixLength: 24 },
    });
    const result = succeeded(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "pc-1",
      deviceId: "pc-1",
      input: "ping 192.168.10.20",
    }) as CliExecutionResult;
    expect(result.output).toContain("Success rate is 100 percent");
  });

  it("does not route different subnets through an L2 switch without a gateway", () => {
    const runtime = createSimulationWorkerRuntime();
    succeeded(runtime, { type: "INITIALIZE_LAB", document: hostLab() });
    succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "pc-1",
      configuration: { address: "192.168.10.10", prefixLength: 24 },
    });
    succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "pc-2",
      configuration: { address: "192.168.20.20", prefixLength: 24 },
    });
    const result = succeeded(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "pc-1",
      deviceId: "pc-1",
      input: "ping 192.168.20.20",
    }) as CliExecutionResult;
    expect(result.output).toContain("Success rate is 0 percent");
  });

  it("persists structured static PC and Server configuration", () => {
    const runtime = createSimulationWorkerRuntime();
    succeeded(runtime, { type: "INITIALIZE_LAB", document: hostLab({ server: true }) });
    succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "pc-1",
      configuration: { address: "10.0.0.20", prefixLength: 24, dnsServer: "10.0.0.11" },
    });
    const status = succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "server-1",
      configuration: { address: "10.0.0.11", prefixLength: 24 },
    }) as HostNetworkStatus;
    expect(status.runtime.address).toBe("10.0.0.11");
    const document = succeeded(runtime, { type: "SERIALIZE_LAB" }) as LabDocument;
    expect(document.configurations["pc-1"]).toMatchObject({
      kind: "pc",
      ipv4: { address: "10.0.0.20", prefixLength: 24 },
      dnsServer: "10.0.0.11",
    });
    expect(document.configurations["server-1"]).toMatchObject({
      kind: "server",
      interfaces: [expect.objectContaining({ ipv4: { address: "10.0.0.11", prefixLength: 24 } })],
    });
    const services = succeeded(runtime, { type: "GET_SERVER_SERVICES", deviceId: "server-1" });
    expect(services).toMatchObject({ services: [expect.objectContaining({ id: "http", state: "listening" })] });
  });

  it("returns bounded DHCP guidance when no DHCP server exists", () => {
    const runtime = createSimulationWorkerRuntime();
    succeeded(runtime, { type: "INITIALIZE_LAB", document: hostLab() });
    const status = succeeded(runtime, {
      type: "SET_HOST_DHCP_MODE",
      deviceId: "pc-1",
      startImmediately: true,
    }) as HostNetworkStatus;
    expect(status.runtime).toMatchObject({ dhcpState: "failed", dhcpBound: false });
    expect(status.guidance).toContain("An L2 switch forwards Ethernet frames but does not assign IP addresses.");
  });

  it("reports deterministic duplicate addresses only inside one broadcast domain", () => {
    const run = () => {
      const runtime = createSimulationWorkerRuntime();
      succeeded(runtime, { type: "INITIALIZE_LAB", document: hostLab() });
      for (const deviceId of ["pc-1", "pc-2"]) {
        succeeded(runtime, {
          type: "SET_HOST_STATIC_CONFIGURATION",
          deviceId,
          configuration: { address: "192.168.10.10", prefixLength: 24 },
        });
      }
      return (succeeded(runtime, { type: "GET_HOST_NETWORK_STATUS", deviceId: "pc-1" }) as HostNetworkStatus).warnings;
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual([expect.objectContaining({
      code: "duplicate-ip",
      message: "Duplicate IPv4 address detected: 192.168.10.10",
      deviceIds: ["pc-1", "pc-2"],
    })]);
  });

  it("static and DHCP transitions clear incompatible runtime state", () => {
    const runtime = createSimulationWorkerRuntime();
    succeeded(runtime, { type: "INITIALIZE_LAB", document: hostLab() });
    succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "pc-1",
      configuration: { address: "192.168.10.10", prefixLength: 24 },
    });
    succeeded(runtime, {
      type: "SET_HOST_DHCP_MODE",
      deviceId: "pc-1",
      startImmediately: false,
    });
    let status = succeeded(runtime, { type: "GET_HOST_NETWORK_STATUS", deviceId: "pc-1" }) as HostNetworkStatus;
    expect(status).toMatchObject({ configuration: { mode: "dhcp", address: undefined }, runtime: { address: undefined, dhcpState: "idle" } });
    succeeded(runtime, { type: "RELEASE_HOST_DHCP", deviceId: "pc-1" });
    status = succeeded(runtime, {
      type: "SET_HOST_STATIC_CONFIGURATION",
      deviceId: "pc-1",
      configuration: { address: "192.168.10.30", prefixLength: 24 },
    }) as HostNetworkStatus;
    expect(status).toMatchObject({ configuration: { mode: "static", address: "192.168.10.30" }, runtime: { dhcpBound: false, dhcpState: "idle" } });
  });
});

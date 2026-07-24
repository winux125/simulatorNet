import type { LabDocument } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type LabUiSnapshot,
  type SecurityConfigurationView,
  type SimWorkerPayload,
  type SimWorkerRequest,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";

function securityLab(): LabDocument {
  return {
    schemaVersion: 1,
    id: "worker-security",
    title: "Worker security integration",
    simulation: { seed: 10_304 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "tg", kind: "traffic-generator", name: "TG1", interfaces: [{ id: "eth0" }] },
        { id: "router", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
      ],
      links: [
        { id: "access", a: { node: "tg", iface: "eth0" }, b: { node: "router", iface: "Gi0/0" } },
      ],
    },
    configurations: {
      tg: {
        kind: "traffic-generator",
        hostname: "TG1",
        interfaces: [],
        ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" },
        dhcpEnabled: false,
        flows: [{
          id: "gateway-ping",
          protocol: "icmp",
          destination: "10.0.0.1",
          count: 1,
          intervalNs: 0,
        }],
      },
      router: {
        kind: "router",
        hostname: "R1",
        interfaces: [{
          id: "Gi0/0",
          shutdown: false,
          routed: true,
          ipv4: { address: "10.0.0.1", prefixLength: 24 },
        }],
        subinterfaces: [],
        staticRoutes: [],
        dhcpPools: [],
        acls: [],
        aclBindings: [],
        natPools: [],
        natRules: [],
        natInterfaceRoles: [],
      },
    },
  };
}

function request<Type extends SimWorkerRequest["type"]>(
  runtime: ReturnType<typeof createSimulationWorkerRuntime>,
  input: Omit<Extract<SimWorkerRequest, { type: Type }>, "requestId">,
): SimWorkerPayload {
  const response = runtime.handleRequest({ ...input, requestId: `security-${input.type}` });
  if (response.type === "REQUEST_FAILED") throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.payload;
}

describe("typed worker security/tool protocol", () => {
  it("gets, validates, applies, and serializes structured ACL configuration", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: securityLab() });
    const initial = request(runtime, {
      type: "GET_SECURITY_CONFIGURATION",
      deviceId: "router",
    }) as SecurityConfigurationView;
    expect(initial.configuration).toMatchObject({ kind: "router", acls: [] });

    const configuration = initial.configuration;
    if (configuration.kind !== "router") throw new Error("fixture mismatch");
    const updated = request(runtime, {
      type: "SET_SECURITY_CONFIGURATION",
      deviceId: "router",
      configuration: {
        ...configuration,
        acls: [{
          id: "EDGE",
          type: "standard",
          rules: [{ sequence: 10, action: "permit", source: { kind: "any" } }],
        }],
        aclBindings: [{ interfaceName: "Gi0/0", direction: "in", aclId: "EDGE" }],
      },
    }) as SecurityConfigurationView;
    expect(updated.configuration).toMatchObject({
      acls: [{ id: "EDGE", rules: [{ action: "permit" }] }],
      aclBindings: [{ interfaceName: "Gi0/0", aclId: "EDGE" }],
    });

    const serialized = request(runtime, { type: "SERIALIZE_LAB" }) as LabDocument;
    expect(serialized.configurations.router).toMatchObject({
      kind: "router",
      acls: [{ id: "EDGE" }],
    });
    expect(JSON.stringify(serialized)).not.toMatch(/aclCounters|natTranslations|trafficResults/);
  });

  it("runs a Traffic Generator flow to completion in Auto and clears only runtime results", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: securityLab() });
    const completed = request(runtime, {
      type: "RUN_TRAFFIC_FLOW",
      deviceId: "tg",
      flowId: "gateway-ping",
    }) as SecurityConfigurationView;
    expect(completed.runtime.trafficResults).toEqual([
      expect.objectContaining({ flowId: "gateway-ping", status: "completed", sent: 1, received: 1 }),
    ]);

    const cleared = request(runtime, {
      type: "CLEAR_SECURITY_RUNTIME",
      deviceId: "tg",
    }) as SecurityConfigurationView;
    expect(cleared.runtime.trafficResults).toEqual([]);
    expect(cleared.configuration).toMatchObject({
      kind: "traffic-generator",
      flows: [{ id: "gateway-ping" }],
    });
  });

  it("leaves Traffic Generator events queued in Step until Run All", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: securityLab() });
    request(runtime, { type: "SET_EXECUTION_MODE", mode: "step" });
    const queued = request(runtime, {
      type: "RUN_TRAFFIC_FLOW",
      deviceId: "tg",
      flowId: "gateway-ping",
    }) as SecurityConfigurationView;
    expect(queued.runtime.trafficResults).toEqual([
      expect.objectContaining({ flowId: "gateway-ping", status: "queued" }),
    ]);
    expect((request(runtime, { type: "GET_SNAPSHOT" }) as LabUiSnapshot).queuedEvents).toBeGreaterThan(0);

    request(runtime, { type: "STEP_NEXT_EVENT" });
    request(runtime, { type: "RUN_UNTIL_IDLE" });
    const completed = request(runtime, {
      type: "GET_SECURITY_CONFIGURATION",
      deviceId: "tg",
    }) as SecurityConfigurationView;
    expect(completed.runtime.trafficResults).toEqual([
      expect.objectContaining({ flowId: "gateway-ping", status: "completed", received: 1 }),
    ]);
  });
});

import type { LabDocument } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type LabUiSnapshot,
  type SimWorkerEvent,
  type SimWorkerPayload,
  type SimWorkerRequest,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import { demoLabDocument } from "./fixture";

function request<Type extends SimWorkerRequest["type"]>(
  runtime: ReturnType<typeof createSimulationWorkerRuntime>,
  input: Omit<Extract<SimWorkerRequest, { type: Type }>, "requestId">,
  requestId = `request-${input.type}`,
): SimWorkerPayload {
  const response = runtime.handleRequest({ ...input, requestId });
  expect(response.requestId).toBe(requestId);
  if (response.type === "REQUEST_FAILED") throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.payload;
}

function initialize(events: SimWorkerEvent[] = []) {
  const runtime = createSimulationWorkerRuntime((event) => {
    if (event.type !== "REQUEST_SUCCEEDED" && event.type !== "REQUEST_FAILED") events.push(event);
  });
  const snapshot = request(runtime, { type: "INITIALIZE_LAB", document: demoLabDocument() }) as LabUiSnapshot;
  return { runtime, snapshot, events };
}

describe("SimulationWorkerRuntime", () => {
  it("initializes a valid LabDocument and emits LAB_READY", () => {
    const { snapshot, events } = initialize();
    expect(snapshot).toMatchObject({ labId: "demo-router-on-a-stick", engineState: "idle" });
    expect(snapshot.nodes).toHaveLength(4);
    expect(events.some((event) => event.type === "LAB_READY")).toBe(true);
  });

  it("rejects an invalid document without crashing the runtime", () => {
    const runtime = createSimulationWorkerRuntime();
    const invalid = demoLabDocument();
    invalid.topology.links[0]!.a.node = "missing";
    const failed = runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "bad", document: invalid });
    expect(failed).toMatchObject({
      type: "REQUEST_FAILED",
      requestId: "bad",
      error: { code: "unknown-node", path: "topology.links[0].a.node" },
    });
    const valid = runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "good", document: demoLabDocument() });
    expect(valid.type).toBe("REQUEST_SUCCEEDED");
  });

  it("preserves request/response correlation", () => {
    const { runtime } = initialize();
    const response = runtime.handleRequest({ type: "GET_SNAPSHOT", requestId: "correlation-42" });
    expect(response.requestId).toBe("correlation-42");
  });

  it("keeps multiple CLI sessions isolated", () => {
    const { runtime } = initialize();
    const first = request(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "one",
      deviceId: "switch-1",
      input: "enable",
    });
    const second = request(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "two",
      deviceId: "switch-1",
      input: "",
    });
    expect(first).toMatchObject({ prompt: "SW1#", mode: "privileged" });
    expect(second).toMatchObject({ prompt: "SW1>", mode: "exec" });
  });

  it("prevents a CLI session from leaking to another device", () => {
    const { runtime } = initialize();
    request(runtime, { type: "EXECUTE_CLI", sessionId: "shared", deviceId: "switch-1", input: "enable" });
    const response = runtime.handleRequest({
      type: "EXECUTE_CLI",
      requestId: "mismatch",
      sessionId: "shared",
      deviceId: "router-1",
      input: "",
    });
    expect(response).toMatchObject({ type: "REQUEST_FAILED", error: { code: "cli-session-device-mismatch" } });
  });

  it("persists CLI-created structured configuration", () => {
    const { runtime } = initialize();
    for (const input of ["enable", "configure terminal", "hostname CAMPUS-SW", "end"]) {
      request(runtime, { type: "EXECUTE_CLI", sessionId: "switch", deviceId: "switch-1", input });
    }
    const serialized = request(runtime, { type: "SERIALIZE_LAB" }) as LabDocument;
    expect(serialized.configurations["switch-1"]).toMatchObject({ kind: "l2-switch", hostname: "CAMPUS-SW" });
    expect(JSON.stringify(serialized)).not.toContain("runningConfig");
  });

  it("serializes a valid canonical document", () => {
    const { runtime } = initialize();
    const first = request(runtime, { type: "SERIALIZE_LAB" }) as LabDocument;
    request(runtime, { type: "REBUILD_LAB", document: first });
    const second = request(runtime, { type: "SERIALIZE_LAB" }) as LabDocument;
    expect(second).toEqual(first);
  });

  it("resets runtime from the current configuration", () => {
    const { runtime } = initialize();
    for (const input of ["enable", "configure terminal", "hostname RESET-SW", "end"]) {
      request(runtime, { type: "EXECUTE_CLI", sessionId: "switch", deviceId: "switch-1", input });
    }
    const reset = request(runtime, { type: "RESET_RUNTIME" }) as LabUiSnapshot;
    expect(reset.nodes.find((node) => node.id === "switch-1")?.hostname).toBe("RESET-SW");
    const newSession = request(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "switch-new",
      deviceId: "switch-1",
      input: "",
    });
    expect(newSession).toMatchObject({ prompt: "RESET-SW>", mode: "exec" });
  });

  it("produces deterministic trace batches for identical requests", () => {
    const run = () => {
      const events: SimWorkerEvent[] = [];
      const { runtime } = initialize(events);
      request(runtime, { type: "EXECUTE_CLI", sessionId: "pc", deviceId: "pc-1", input: "ping 192.168.20.10" });
      return events.filter((event) => event.type === "TRACE_BATCH").flatMap((event) => event.events);
    };
    expect(run()).toEqual(run());
  });

  it("handles unknown request types as typed failures", () => {
    const runtime = createSimulationWorkerRuntime();
    const response = runtime.handleRequest({ type: "DO_SOMETHING_UNSAFE", requestId: "unknown" });
    expect(response).toMatchObject({
      type: "REQUEST_FAILED",
      requestId: "unknown",
      error: { code: "unknown-request-type" },
    });
  });

  it("runs router-on-a-stick, DHCP and ping through the worker protocol", () => {
    const { runtime, snapshot, events } = initialize();
    expect(snapshot.nodes.find((node) => node.id === "pc-1")?.interfaces[0]?.ipAddress).toBe("192.168.10.10");
    expect(snapshot.nodes.find((node) => node.id === "pc-2")?.interfaces[0]?.ipAddress).toBe("192.168.20.10");

    const gateway = request(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "pc-gateway",
      deviceId: "pc-1",
      input: "ping 192.168.10.1",
    });
    const routed = request(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "pc-routed",
      deviceId: "pc-1",
      input: "ping 192.168.20.10",
    });
    expect(gateway).toMatchObject({ output: expect.stringContaining("Success rate is 100 percent") });
    expect(routed).toMatchObject({ output: expect.stringContaining("Success rate is 100 percent") });
    const routerConfig = request(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "router-show",
      deviceId: "router-1",
      input: "show running-config",
    });
    expect(routerConfig).toMatchObject({ output: expect.stringContaining("encapsulation dot1Q 10") });
    const traces = events.filter((event) => event.type === "TRACE_BATCH").flatMap((event) => event.events);
    expect(traces.map((event) => event.type)).toEqual(expect.arrayContaining(["dhcp-discover", "dhcp-bound", "route", "ping-success"]));
  });

  it("supports pause and explicit virtual-time controls", () => {
    const { runtime } = initialize();
    request(runtime, { type: "SET_PAUSED", paused: true });
    const pausedRun = runtime.handleRequest({ type: "RUN_UNTIL_IDLE", requestId: "paused-run" });
    expect(pausedRun).toMatchObject({ type: "REQUEST_FAILED", error: { code: "runtime-paused" } });
    request(runtime, { type: "SET_PAUSED", paused: false });
    const stepped = request(runtime, { type: "ADVANCE_TIME", milliseconds: 1 });
    expect(stepped).toMatchObject({ processedEvents: 0 });
  });

  it("returns bounded plain device inspection data", () => {
    const { runtime } = initialize();
    const inspection = request(runtime, {
      type: "GET_DEVICE_INSPECTION",
      deviceId: "switch-1",
    });
    expect(inspection).toMatchObject({
      deviceId: "switch-1",
      hostname: "SW1",
      type: "l2-switch",
      vlans: expect.arrayContaining([
        expect.objectContaining({ id: 10, name: "STUDENTS" }),
        expect.objectContaining({ id: 20, name: "SERVERS" }),
      ]),
    });
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection);
  });
});

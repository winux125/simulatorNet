import type { LabDocument } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type CliExecutionResult,
  type DeviceConfigurationView,
  type LabConfigurationStatusView,
  type SimWorkerPayload,
  type SimWorkerRequest,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import { demoLabDocument } from "./fixture";

function request<Type extends SimWorkerRequest["type"]>(
  runtime: ReturnType<typeof createSimulationWorkerRuntime>,
  input: Omit<Extract<SimWorkerRequest, { type: Type }>, "requestId">,
): SimWorkerPayload {
  const response = runtime.handleRequest({ ...input, requestId: `request-${input.type}` });
  if (response.type === "REQUEST_FAILED") throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.payload;
}

function initialize() {
  const runtime = createSimulationWorkerRuntime();
  request(runtime, { type: "INITIALIZE_LAB", document: demoLabDocument() });
  return runtime;
}

function cli(runtime: ReturnType<typeof createSimulationWorkerRuntime>, deviceId: string, ...inputs: string[]) {
  let last: CliExecutionResult | undefined;
  for (const input of inputs) {
    last = request(runtime, { type: "EXECUTE_CLI", sessionId: `s:${deviceId}`, deviceId, input }) as CliExecutionResult;
  }
  return last!;
}

describe("worker configuration lifecycle", () => {
  it("renders running configuration from structured state", () => {
    const runtime = initialize();
    const view = request(runtime, { type: "GET_DEVICE_CONFIGURATION", deviceId: "switch-1" }) as DeviceConfigurationView;
    expect(view.deviceType).toBe("l2-switch");
    expect(view.supportsConfigurationText).toBe(true);
    expect(view.supportsConfigurationApply).toBe(true);
    expect(view.runningConfigurationText).toContain("hostname SW1");
    expect(view.runningConfigurationText).toBe(cli(runtime, "switch-1", "show running-config").output + "\n");
    // A document with no snapshot yet reads as saved, never as unsaved.
    expect(view.drift).toBe("saved");
  });

  it("drives save, drift and erase through the CLI", () => {
    const runtime = initialize();
    expect(cli(runtime, "switch-1", "enable", "copy run start").output).toBe(
      "Destination filename [startup-config]?\nBuilding configuration...\n[OK]",
    );
    cli(runtime, "switch-1", "configure terminal", "hostname EDGE-SW", "end");
    const modified = request(runtime, { type: "GET_DEVICE_CONFIGURATION", deviceId: "switch-1" }) as DeviceConfigurationView;
    expect(modified.drift).toBe("modified");
    expect(modified.startupConfigurationText).toContain("hostname SW1");
    expect(modified.runningConfigurationText).toContain("hostname EDGE-SW");

    cli(runtime, "switch-1", "wr");
    expect((request(runtime, { type: "GET_DEVICE_CONFIGURATION", deviceId: "switch-1" }) as DeviceConfigurationView).drift)
      .toBe("saved");

    const erased = request(runtime, { type: "ERASE_DEVICE_STARTUP_CONFIGURATION", deviceId: "switch-1" }) as DeviceConfigurationView;
    expect(erased.drift).toBe("no-startup-configuration");
    expect(erased.startupConfigurationText).toBe("% startup-config is not present\n");
  });

  it("stores the startup snapshot in the serialized document", () => {
    const runtime = initialize();
    request(runtime, { type: "SAVE_DEVICE_CONFIGURATION", deviceId: "switch-1" });
    const document = request(runtime, { type: "SERIALIZE_LAB" }) as LabDocument;
    expect(document.startupConfigurations?.["switch-1"]).toMatchObject({ state: "saved" });
    // Runtime state never joins it.
    const json = JSON.stringify(document.startupConfigurations);
    expect(json).not.toContain("arp");
    expect(json).not.toContain("lease");
  });

  it("reloads one device and leaves the others running", () => {
    const runtime = initialize();
    request(runtime, { type: "SAVE_DEVICE_CONFIGURATION", deviceId: "switch-1" });
    cli(runtime, "switch-1", "enable", "configure terminal", "hostname THROWAWAY", "end");
    // Another device's session is authenticated and must survive the reload.
    expect(cli(runtime, "router-1", "enable").prompt).toBe("R1#");

    const view = request(runtime, { type: "RELOAD_DEVICE", deviceId: "switch-1", save: false }) as DeviceConfigurationView;
    expect(view.runningConfigurationText).toContain("hostname SW1");
    expect(view.drift).toBe("saved");
    expect(cli(runtime, "router-1", "").prompt).toBe("R1#");
    // The reloaded device's own session is gone, so it starts at user EXEC.
    expect(cli(runtime, "switch-1", "").prompt).toBe("SW1>");
  });

  it("saves every supported device at once", () => {
    const runtime = initialize();
    const status = request(runtime, { type: "SAVE_ALL_DEVICE_CONFIGURATIONS" }) as LabConfigurationStatusView;
    for (const device of status.devices) {
      expect(device.drift).toBe("saved");
    }
    const hosts = status.devices.filter((device) => !device.supportsConfigurationText);
    expect(hosts.length).toBeGreaterThan(0);
    expect(status.document.startupConfigurations).toBeDefined();
  });

  it("applies structured configuration to running or to startup only", () => {
    const runtime = initialize();
    const before = request(runtime, { type: "GET_DEVICE_CONFIGURATION", deviceId: "switch-1" }) as DeviceConfigurationView;
    const renamed = { ...before.configuration, hostname: "PASTED-SW" };

    const startupOnly = request(runtime, {
      type: "APPLY_DEVICE_CONFIGURATION",
      deviceId: "switch-1",
      configuration: renamed,
      target: "startup",
    }) as DeviceConfigurationView;
    expect(startupOnly.runningConfigurationText).toContain("hostname SW1");
    expect(startupOnly.startupConfigurationText).toContain("hostname PASTED-SW");
    expect(startupOnly.drift).toBe("modified");

    const running = request(runtime, {
      type: "APPLY_DEVICE_CONFIGURATION",
      deviceId: "switch-1",
      configuration: renamed,
      target: "running",
    }) as DeviceConfigurationView;
    expect(running.runningConfigurationText).toContain("hostname PASTED-SW");
    // Applying a running configuration must not silently write NVRAM.
    expect(running.startupConfigurationText).toContain("hostname PASTED-SW");
    expect(running.drift).toBe("saved");
  });

  it("refuses a configuration written for another device kind", () => {
    const runtime = initialize();
    const router = request(runtime, { type: "GET_DEVICE_CONFIGURATION", deviceId: "router-1" }) as DeviceConfigurationView;
    const response = runtime.handleRequest({
      type: "APPLY_DEVICE_CONFIGURATION",
      requestId: "mismatch",
      deviceId: "switch-1",
      configuration: router.configuration,
      target: "running",
    });
    expect(response).toMatchObject({ type: "REQUEST_FAILED", error: { code: "configuration-type-mismatch" } });
  });

  it("never renders a host as a network appliance", () => {
    const runtime = initialize();
    const view = request(runtime, { type: "GET_DEVICE_CONFIGURATION", deviceId: "pc-1" }) as DeviceConfigurationView;
    expect(view.supportsConfigurationText).toBe(false);
    expect(view.runningConfigurationText).toContain("Desktop / IP Configuration");
  });
});

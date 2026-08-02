/**
 * A `DeviceConfigurationService` for CLI unit tests.
 *
 * The runtime injects one built on `lab-format`; these tests build devices
 * directly, so this helper derives the topology node from the device itself and
 * then uses the *same* serializer, renderer and comparison the worker and the
 * verifier use. There is deliberately no second renderer here: a golden CLI
 * transcript must be exactly the bytes the product produces.
 */
import type { DeviceConfigurationService } from "@sim/cli-engine";
import type { NodeSpec } from "@sim/contracts";
import {
  deviceConfigurationStatus,
  renderRunningConfiguration,
  renderStartupConfiguration,
  type DeviceStartupState,
} from "@sim/device-config";
import { canonicalizeDeviceConfiguration, serializeDeviceConfiguration } from "@sim/lab-format";
import type { Device } from "@sim/sim-core";

export function nodeSpecOf(device: Device): NodeSpec {
  return {
    id: device.id,
    kind: device.deviceType,
    name: device.name,
    interfaces: [...device.interfaces.values()].map((iface) => ({ id: iface.name, mac: iface.mac })),
  };
}

export interface TestConfigurationService extends DeviceConfigurationService {
  /** Devices reloaded so far, so a test can assert the lifecycle ran. */
  readonly reloaded: Array<{ deviceId: string; save: boolean }>;
}

export function createTestConfigurationService(...devices: Device[]): TestConfigurationService {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const startup = new Map<string, DeviceStartupState>();
  const reloaded: Array<{ deviceId: string; save: boolean }> = [];
  const running = (deviceId: string) => {
    const device = byId.get(deviceId);
    if (!device) throw new Error(`Unknown device '${deviceId}'`);
    const node = nodeSpecOf(device);
    return canonicalizeDeviceConfiguration(node, serializeDeviceConfiguration(device, node));
  };
  const startupOf = (deviceId: string): DeviceStartupState => startup.get(deviceId) ?? { state: "implicit" };
  return {
    reloaded,
    runningConfigurationText: (deviceId) => renderRunningConfiguration(running(deviceId)),
    startupConfigurationText: (deviceId) => {
      const state = startupOf(deviceId);
      if (state.state === "implicit") return renderRunningConfiguration(running(deviceId));
      return renderStartupConfiguration(state.state === "saved" ? state.configuration : undefined);
    },
    drift: (deviceId) => deviceConfigurationStatus(running(deviceId), startupOf(deviceId)).drift,
    saveRunningConfiguration: (deviceId) => {
      startup.set(deviceId, { state: "saved", configuration: running(deviceId) });
    },
    eraseStartupConfiguration: (deviceId) => {
      startup.set(deviceId, { state: "absent" });
    },
    reloadDevice: (deviceId, options) => {
      reloaded.push({ deviceId, save: options.save });
      if (options.save) startup.set(deviceId, { state: "saved", configuration: running(deviceId) });
    },
  };
}

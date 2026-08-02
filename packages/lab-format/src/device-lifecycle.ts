/**
 * The running / startup configuration lifecycle.
 *
 * Structured device configuration stays the single source of truth. The running
 * configuration is what the live device holds; the startup configuration is a
 * separate structured snapshot of it. Text is only ever a projection of one of
 * those two, so there is no third copy that can drift.
 *
 * `copy running-config startup-config`, `write memory`, `erase startup-config`
 * and `reload` all go through here, identically in the browser worker and in
 * the verifier.
 */
import type {
  DeviceConfig,
  DeviceStartupConfiguration,
  LabStartupConfigurations,
} from "@sim/contracts";
import {
  deviceConfigurationStatus,
  renderDeviceConfiguration,
  renderRunningConfiguration,
  renderStartupConfiguration,
  type ConfigurationStatus,
  type DeviceStartupState,
} from "@sim/device-config";
import { Layer3Switch, Router, type Device } from "@sim/sim-core";
import { createDeviceInstance, serializeDeviceConfiguration, type BuiltLab } from "./build";
import { canonicalizeDeviceConfiguration } from "./canonical";
import { LabSemanticError } from "./errors";

function requireDevice(built: BuiltLab, deviceId: string): Device {
  const device = built.getDevice(deviceId);
  if (!device) {
    throw new LabSemanticError("unknown-device", `configurations.${deviceId}`, `Unknown device '${deviceId}'`);
  }
  return device;
}

/** One device's live configuration, canonicalized so it compares stably. */
export function runningConfigurationOf(built: BuiltLab, deviceId: string): DeviceConfig {
  const device = requireDevice(built, deviceId);
  const node = built.getNode(deviceId);
  if (!node) {
    throw new LabSemanticError("unknown-device", `topology.nodes.${deviceId}`, `Unknown device '${deviceId}'`);
  }
  return canonicalizeDeviceConfiguration(node, serializeDeviceConfiguration(device, node));
}

/** Translate the stored snapshot into the comparison model `device-config` uses. */
export function startupStateOf(built: BuiltLab, deviceId: string): DeviceStartupState {
  const entry = built.startupConfigurationOf(deviceId);
  if (!entry) return { state: "implicit" };
  if (entry.state === "absent") return { state: "absent" };
  return { state: "saved", configuration: entry.configuration };
}

/** Saved / Modified / No startup configuration, from canonical snapshots. */
export function deviceConfigurationDrift(built: BuiltLab, deviceId: string): ConfigurationStatus {
  return deviceConfigurationStatus(runningConfigurationOf(built, deviceId), startupStateOf(built, deviceId));
}

export function renderDeviceRunningConfiguration(built: BuiltLab, deviceId: string): string {
  return renderRunningConfiguration(runningConfigurationOf(built, deviceId));
}

export function renderDeviceStartupConfiguration(built: BuiltLab, deviceId: string): string {
  const startup = startupStateOf(built, deviceId);
  if (startup.state === "implicit") return renderRunningConfiguration(runningConfigurationOf(built, deviceId));
  return renderStartupConfiguration(startup.state === "saved" ? startup.configuration : undefined);
}

/**
 * `copy running-config startup-config` / `write memory`.
 *
 * It copies the structured running snapshot into NVRAM. It never copies runtime
 * state, and it never touches the running configuration itself.
 */
export function saveRunningConfiguration(built: BuiltLab, deviceId: string): DeviceConfig {
  const running = runningConfigurationOf(built, deviceId);
  built.setStartupConfiguration(deviceId, { state: "saved", configuration: running });
  return running;
}

/** `erase startup-config`. Running configuration is untouched until a reload. */
export function eraseStartupConfiguration(built: BuiltLab, deviceId: string): void {
  requireDevice(built, deviceId);
  built.setStartupConfiguration(deviceId, { state: "absent" });
}

/** Every stored snapshot, for serialization. */
export function startupConfigurations(built: BuiltLab): LabStartupConfigurations | undefined {
  return built.startupConfigurations();
}

export interface ReloadDeviceOptions {
  /**
   * Save the running configuration to startup before reloading, answering
   * IOS's "System configuration has been modified. Save? [yes/no]:" with yes.
   */
  readonly save?: boolean;
}

export interface ReloadDeviceResult {
  readonly deviceId: string;
  /** The configuration the device booted with. */
  readonly configuration: DeviceConfig;
  /** True when the device booted factory defaults after `erase startup-config`. */
  readonly bootedDefaults: boolean;
  /** Cables restored after the instance was replaced. */
  readonly restoredLinks: number;
}

/**
 * Reload one device.
 *
 * The topology is *not* rebuilt and no other device is disturbed: only this
 * device's instance is replaced. Its cables are detached and reattached with
 * their exact performance, its runtime state (ARP/MAC tables, learned routes,
 * leases, sessions, translations, security associations, queues) is gone with
 * the old instance, and it boots from its startup configuration — or from
 * factory defaults when the NVRAM was erased.
 *
 * The caller closes the device's CLI/remote sessions; the management plane is
 * re-armed here so a later Telnet or SSH reaches the new instance.
 */
export function reloadDevice(
  built: BuiltLab,
  deviceId: string,
  options: ReloadDeviceOptions = {},
): ReloadDeviceResult {
  const node = built.getNode(deviceId);
  requireDevice(built, deviceId);
  if (!node) {
    throw new LabSemanticError("unknown-device", `topology.nodes.${deviceId}`, `Unknown device '${deviceId}'`);
  }
  if (options.save) saveRunningConfiguration(built, deviceId);

  const startup = startupStateOf(built, deviceId);
  const bootedDefaults = startup.state === "absent";
  const configuration = bootedDefaults
    ? canonicalizeDeviceConfiguration(node, undefined)
    : startup.state === "saved"
      ? startup.configuration
      : runningConfigurationOf(built, deviceId);

  // Remember the cabling before the instance disappears: a link is topology,
  // so it must come back exactly as it was, with the same performance.
  const cables = built.topology.links
    .filter((link) => link.a.node === deviceId || link.b.node === deviceId)
    .map((link) => ({ ...link }));

  built.management.closeForDevice(deviceId, "cleared-by-administrator");
  built.engine.remove(deviceId);
  const replacement = createDeviceInstance(node, configuration, built.engine);
  built.replaceDevice(deviceId, replacement);

  for (const link of cables) {
    built.engine.connect(link.a.node, link.a.iface, link.b.node, link.b.iface, {
      propagationDelayNs: link.propagationDelayNs,
      capacityBps: link.capacityBps,
      queueLimitPackets: link.queueLimitPackets,
    });
  }
  // Egress queue structure needs the cabled capacity, exactly as at build time.
  if (replacement instanceof Router || replacement instanceof Layer3Switch) {
    replacement.refreshEgressQueues();
  }
  built.management.rebuildDevice(deviceId);
  const remote = "remoteAccess" in configuration ? configuration.remoteAccess : undefined;
  const access = "consoleAccess" in configuration ? configuration.consoleAccess : undefined;
  built.management.configureDevice(deviceId, remote, access);
  built.management.startSnmpAgentFor(deviceId);

  return { deviceId, configuration, bootedDefaults, restoredLinks: cables.length };
}

/** Text of the configuration a device would boot with after a reload. */
export function renderStartupProjection(built: BuiltLab, deviceId: string): string {
  const startup = startupStateOf(built, deviceId);
  if (startup.state === "saved") return renderDeviceConfiguration(startup.configuration);
  if (startup.state === "implicit") return renderDeviceConfiguration(runningConfigurationOf(built, deviceId));
  return renderStartupConfiguration(undefined);
}

export type { DeviceStartupConfiguration };

/**
 * The configuration-lifecycle surface a runtime injects into a CLI session.
 *
 * `cli-engine` owns the *commands* — `show running-config`, `copy run start`,
 * `write memory`, `erase startup-config`, `reload` — and nothing else. It has no
 * idea how a device is serialized, how a snapshot is stored or how a device is
 * rebuilt: the browser worker and the verifier implement that identically
 * through `lab-format`, and hand this small structural interface to the session.
 *
 * It is the third such seam, beside the remote-session opener and the
 * management runtime, and it keeps the same rule: no engine object, no lab
 * document and no credential ever crosses it.
 */
export type ConfigurationDrift = "saved" | "modified" | "no-startup-configuration";

export interface DeviceConfigurationService {
  /** Deterministic `show running-config` text, rendered from structured state. */
  runningConfigurationText(deviceId: string): string;
  /** `show startup-config` text, including the empty-NVRAM message. */
  startupConfigurationText(deviceId: string): string;
  /** Whether the running configuration matches the stored startup snapshot. */
  drift(deviceId: string): ConfigurationDrift;
  /** Copy the structured running snapshot into NVRAM. */
  saveRunningConfiguration(deviceId: string): void;
  /** Empty the NVRAM. The running configuration is untouched until a reload. */
  eraseStartupConfiguration(deviceId: string): void;
  /**
   * Reload this device only: its runtime state is discarded and it boots from
   * its startup configuration. Other devices keep running.
   */
  reloadDevice(deviceId: string, options: { readonly save: boolean }): void;
}

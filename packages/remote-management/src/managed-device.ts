import type { ConsoleAccessConfiguration, ConsoleUserConfiguration } from "@sim/contracts";
import { createCliSession, type CliSession } from "@sim/cli-engine";
import {
  Firewall,
  IspCloud,
  L2Switch,
  Layer3Switch,
  Router,
  type Device,
  type HostTransportStack,
  type IpAddress,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * The narrow surface the management plane needs from a managed network device.
 *
 * Only Router, L2 Switch, L3 Switch and Firewall are manageable. A Hub, PC,
 * Smartphone, Access Point, Cloud, Traffic Generator or External Appliance
 * deliberately has no management plane, and a Wireless Router stays UI-managed.
 */
export interface ManagedDevice {
  readonly device: Device;
  readonly deviceId: string;
  hostname(): string;
  engine(): SimulationEngine;
  /** Management-plane sockets: the device's own listeners, never forwarding. */
  transport(): HostTransportStack;
  /** Every address the device answers management traffic on, lowest first. */
  addresses(): IpAddress[];
  /** A fresh CLI session for one remote login. */
  createSession(): CliSession;
}

export function isManageableDevice(device: Device): boolean {
  if (device instanceof IspCloud) return false;
  if (device instanceof Layer3Switch) return true;
  if (device instanceof L2Switch) return true;
  if (device instanceof Firewall) return true;
  return device instanceof Router && device.deviceType === "router";
}

/** Wrap a device for the management plane, or return undefined if unmanaged. */
export function managedDeviceOf(device: Device, engine: SimulationEngine): ManagedDevice | undefined {
  if (!isManageableDevice(device)) return undefined;
  const base = {
    device,
    deviceId: device.id,
    hostname: () => device.name,
    engine: () => engine,
    createSession: () => createCliSession(device, engine),
  };
  if (device instanceof L2Switch) {
    return {
      ...base,
      transport: () => device.managementTransport(),
      addresses: () => device.managementAddresses(),
    };
  }
  const router = device as Router;
  return {
    ...base,
    transport: () => router.management,
    addresses: () => router.managementAddresses(),
  };
}

/**
 * The device's local user database. It is the *same* store the simulated
 * console uses: there is exactly one local-user implementation, shared by
 * console, Telnet, SSH and AAA local fallback.
 */
export function localUsers(access: ConsoleAccessConfiguration | undefined): readonly ConsoleUserConfiguration[] {
  return access?.users.filter((user) => user.enabled) ?? [];
}

export function findLocalUser(
  access: ConsoleAccessConfiguration | undefined,
  username: string,
): ConsoleUserConfiguration | undefined {
  const wanted = username.trim();
  return localUsers(access).find((user) => user.username === wanted);
}

/** Educational fingerprint identifying a simulated SSH host key. */
export function deriveHostKeyFingerprint(deviceId: string, domainName: string | undefined, modulusBits: number): string {
  let hash = 2166136261;
  for (const char of `${deviceId}|${domainName ?? ""}|${modulusBits}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  const bytes: string[] = [];
  let state = hash;
  for (let index = 0; index < 16; index++) {
    state = Math.imul(state ^ (index + 0x9e3779b9), 16777619) >>> 0;
    bytes.push(((state >>> 16) & 0xff).toString(16).padStart(2, "0"));
  }
  return `SHA256:${bytes.join("")}`;
}

import {
  deviceTypeHasCapability,
  getDeviceProfile,
  type DeviceCapability,
  type DeviceProfile,
  type DeviceType,
  type WirelessInterfaceConfiguration,
} from "@sim/contracts";
import type { SimulationEngine } from "../engine/simulation-engine";
import { EthernetInterface } from "../net/interface";
import type { EthernetFrame } from "../packets/ethernet";
import type { Mac } from "../util/mac";
import { WirelessInterface } from "../net/wireless-interface";

/**
 * Base class for every simulated device. Holds its named interfaces and a
 * back-reference to the engine (assigned by `engine.add`). Subclasses implement
 * `onReceive` to define their forwarding / host behaviour.
 */
export abstract class Device {
  abstract readonly deviceType: DeviceType;
  /** Set by the engine when the device is added; used to schedule events. */
  engine!: SimulationEngine;
  readonly interfaces = new Map<string, EthernetInterface>();

  constructor(
    readonly id: string,
    public name: string,
  ) {}

  get profile(): DeviceProfile {
    return getDeviceProfile(this.deviceType);
  }

  hasCapability(capability: DeviceCapability): boolean {
    return deviceTypeHasCapability(this.deviceType, capability);
  }

  /** `hostname <name>`: rename the device (drives the CLI prompt). */
  rename(name: string): void {
    this.name = name;
  }

  addInterface(name: string, mac: Mac): EthernetInterface {
    if (this.interfaces.has(name)) {
      throw new Error(`Interface ${name} already exists on ${this.id}`);
    }
    const iface = new EthernetInterface(this, name, mac);
    this.interfaces.set(name, iface);
    return iface;
  }

  addWirelessInterface(configuration: WirelessInterfaceConfiguration): WirelessInterface {
    if (this.interfaces.has(configuration.id)) {
      throw new Error(`Interface ${configuration.id} already exists on ${this.id}`);
    }
    const iface = new WirelessInterface(this, configuration);
    iface.attachMedium(this.engine.wireless);
    this.interfaces.set(configuration.id, iface);
    return iface;
  }

  /** Lifecycle hook for deterministic lab-scoped resources such as ACL budgets. */
  onAddedToEngine(): void {}

  /**
   * Hook invoked when a port is cabled, shut down, or brought back up. Control
   * protocols use it to re-open their bounded activity window and reconverge.
   */
  onInterfaceStateChanged(_iface: EthernetInterface): void {}

  getInterface(name: string): EthernetInterface | undefined {
    return this.interfaces.get(name);
  }

  /** Handle a frame that has arrived on `ingress`. */
  abstract onReceive(frame: EthernetFrame, ingress: EthernetInterface): void;
}

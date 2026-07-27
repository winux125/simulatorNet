import type {
  WirelessInterfaceConfiguration,
  WirelessRadioSettings,
} from "@sim/contracts";
import type { Device } from "../devices/device";
import type { EthernetFrame } from "../packets/ethernet";
import { normalizeMac } from "../util/mac";
import type { WirelessMedium } from "../wireless/wireless-medium";
import { EthernetInterface } from "./interface";

/**
 * A radio L2 endpoint that deliberately has no Ethernet Link/peer. It extends
 * the shared L2 interface surface so the existing host packet stack can use
 * wlan0 without a second IPv4/IPv6/transport implementation.
 */
export class WirelessInterface extends EthernetInterface {
  private medium: WirelessMedium | undefined;
  private configuredEnabled: boolean;
  private wirelessConfiguration: WirelessInterfaceConfiguration;

  constructor(
    device: Device,
    wirelessConfiguration: WirelessInterfaceConfiguration,
  ) {
    super(device, wirelessConfiguration.id, normalizeMac(wirelessConfiguration.macAddress));
    this.wirelessConfiguration = {
      ...wirelessConfiguration,
      supportedChannels: [...wirelessConfiguration.supportedChannels],
    };
    this.configuredEnabled = wirelessConfiguration.enabled;
  }

  attachMedium(medium: WirelessMedium): void {
    this.medium = medium;
  }

  setWirelessEnabled(enabled: boolean): void {
    if (this.configuredEnabled === enabled) return;
    this.configuredEnabled = enabled;
    this.notifyStateChanged();
  }

  get wirelessEnabled(): boolean {
    return this.configuredEnabled;
  }

  updateRadioSettings(settings: WirelessRadioSettings): void {
    this.wirelessConfiguration = {
      ...this.wirelessConfiguration,
      ...settings,
      supportedChannels: [...settings.supportedChannels],
    };
    this.configuredEnabled = settings.enabled;
    this.notifyStateChanged();
  }

  override peer(): undefined {
    return undefined;
  }

  override get operationalUp(): boolean {
    return this.adminUp
      && this.configuredEnabled
      && this.medium?.isOperational(this.device.id, this.name) === true;
  }

  override notifyStateChanged(): void {
    this.device.onInterfaceStateChanged(this);
  }

  override transmit(frame: EthernetFrame): void {
    if (!this.adminUp || !this.configuredEnabled) return;
    if (!this.medium) throw new Error(`Wireless interface ${this.device.id}/${this.name} is not attached to a medium.`);
    this.medium.transmit(this.device.id, this.name, frame);
  }

  configurationSnapshot(): WirelessInterfaceConfiguration {
    return {
      ...this.wirelessConfiguration,
      macAddress: this.mac,
      enabled: this.configuredEnabled,
      supportedChannels: [...this.wirelessConfiguration.supportedChannels],
    };
  }

}

export function isWirelessInterface(
  iface: EthernetInterface,
): iface is WirelessInterface {
  return iface instanceof WirelessInterface;
}

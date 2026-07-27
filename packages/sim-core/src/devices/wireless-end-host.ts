import type {
  WirelessAssociationStatus,
  WirelessInterfaceConfiguration,
  WirelessNetworkSummary,
  WirelessSavedNetworkProfile,
  WirelessStationConfiguration,
} from "@sim/contracts";
import type { WirelessInterface } from "../net/wireless-interface";
import type { Mac } from "../util/mac";
import type { WirelessConnectRequest } from "../wireless/wireless-medium";
import { EndHost } from "./pc";

/**
 * Shared Laptop/Smartphone station behavior. IPv4, IPv6, DHCP, transport and
 * applications remain the single EndHost implementation; only the L2 bearer
 * and association control are added here.
 */
export abstract class WirelessEndHost extends EndHost {
  private wirelessInterfaceId: string | undefined;
  private stationConfiguration: WirelessStationConfiguration | undefined;

  configureWirelessInterface(
    interfaceConfiguration: WirelessInterfaceConfiguration,
    stationConfiguration: WirelessStationConfiguration,
  ): WirelessInterface {
    if (interfaceConfiguration.radioDomainId !== stationConfiguration.radio.radioDomainId) {
      throw new Error("Wireless station radio domain does not match its interface.");
    }
    if (interfaceConfiguration.band !== stationConfiguration.radio.band) {
      throw new Error("Wireless station band does not match its interface.");
    }
    const iface = this.addWirelessInterface(interfaceConfiguration);
    this.engine.wireless.registerStation({
      deviceId: this.id,
      interface: interfaceConfiguration,
      receive: (frame) => {
        if (iface.adminUp && iface.wirelessEnabled) this.onReceive(frame, iface);
      },
      preferredSsid: stationConfiguration.preferredSsid,
      preferredBssid: stationConfiguration.preferredBssid as Mac | undefined,
      autoConnect: stationConfiguration.autoConnect,
      credentials: runtimeCredentials(stationConfiguration.savedNetworks),
    });
    this.wirelessInterfaceId = iface.name;
    this.stationConfiguration = cloneStationConfiguration(stationConfiguration);
    this.selectPrimaryInterface(iface.name);
    return iface;
  }

  get wirelessInterface(): WirelessInterface {
    const id = this.wirelessInterfaceId;
    const iface = id ? this.getInterface(id) : undefined;
    if (!iface || !("wirelessEnabled" in iface)) {
      throw new Error(`Wireless station ${this.id} has no configured radio.`);
    }
    return iface as WirelessInterface;
  }

  scanWirelessNetworks(explicitSsid?: string): void {
    this.engine.wireless.scan(this.id, this.wirelessInterface.name, explicitSsid);
  }

  connectWireless(request: WirelessConnectRequest = {}): void {
    this.selectPrimaryInterface(this.wirelessInterface.name);
    this.engine.wireless.connect(this.id, this.wirelessInterface.name, request);
  }

  disconnectWireless(reason = "user-disconnect"): void {
    this.engine.wireless.disconnect(this.id, this.wirelessInterface.name, reason);
  }

  saveWirelessNetwork(profile: WirelessSavedNetworkProfile): void {
    const configuration = this.wirelessConfigurationSnapshot();
    const savedNetworks = configuration.savedNetworks
      .filter((entry) => entry.id !== profile.id && entry.ssid !== profile.ssid);
    savedNetworks.push(cloneSavedNetwork(profile));
    this.updateStationConfiguration({ ...configuration, savedNetworks });
  }

  forgetWirelessNetwork(profileId: string): void {
    const configuration = this.wirelessConfigurationSnapshot();
    this.updateStationConfiguration({
      ...configuration,
      savedNetworks: configuration.savedNetworks.filter((entry) => entry.id !== profileId),
    });
  }

  setWirelessPreferences(
    preferences: Pick<
      WirelessStationConfiguration,
      "autoConnect" | "preferredSsid" | "preferredBssid"
    >,
  ): void {
    this.updateStationConfiguration({
      ...this.wirelessConfigurationSnapshot(),
      ...preferences,
    });
  }

  setWirelessEnabled(enabled: boolean): void {
    const iface = this.wirelessInterface;
    iface.setWirelessEnabled(enabled);
    this.engine.wireless.setStationEnabled(this.id, iface.name, enabled);
  }

  wirelessStatus(): WirelessAssociationStatus {
    return this.engine.wireless.status(this.id, this.wirelessInterface.name);
  }

  wirelessScanResults(): WirelessNetworkSummary[] {
    return this.engine.wireless.scanResults(this.id, this.wirelessInterface.name);
  }

  wirelessConfigurationSnapshot(): WirelessStationConfiguration {
    const configuration = this.stationConfiguration;
    if (!configuration) throw new Error(`Wireless station ${this.id} has no configured radio.`);
    return cloneStationConfiguration({
      ...configuration,
      radio: {
        ...configuration.radio,
        enabled: this.wirelessInterface.wirelessEnabled,
      },
    });
  }

  private updateStationConfiguration(configuration: WirelessStationConfiguration): void {
    this.stationConfiguration = cloneStationConfiguration(configuration);
    this.engine.wireless.updateStationPreferences(this.id, this.wirelessInterface.name, {
      preferredSsid: configuration.preferredSsid,
      preferredBssid: configuration.preferredBssid as Mac | undefined,
      autoConnect: configuration.autoConnect,
      credentials: runtimeCredentials(configuration.savedNetworks),
    });
  }
}

function cloneStationConfiguration(
  configuration: WirelessStationConfiguration,
): WirelessStationConfiguration {
  return {
    ...configuration,
    radio: {
      ...configuration.radio,
      supportedChannels: [...configuration.radio.supportedChannels],
    },
    savedNetworks: configuration.savedNetworks.map((network) => ({
      ...cloneSavedNetwork(network),
    })),
  };
}

function cloneSavedNetwork(profile: WirelessSavedNetworkProfile): WirelessSavedNetworkProfile {
  return {
    ...profile,
    credentialVerifier: profile.credentialVerifier
      ? { ...profile.credentialVerifier }
      : undefined,
  };
}

function runtimeCredentials(profiles: readonly WirelessSavedNetworkProfile[]) {
  return profiles.map((profile) => ({
    ssid: profile.ssid,
    securityMode: profile.securityMode,
    credentialFingerprint: profile.credentialVerifier?.hashBase64,
  }));
}

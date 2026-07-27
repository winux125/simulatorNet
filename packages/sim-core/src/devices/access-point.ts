import type {
  WirelessAccessPointConfiguration,
  WirelessInterfaceConfiguration,
  WirelessRadioSettings,
} from "@sim/contracts";
import type { EthernetInterface } from "../net/interface";
import type { WirelessInterface } from "../net/wireless-interface";
import type { EthernetFrame } from "../packets/ethernet";
import { isBroadcastMac, isMulticastMac, normalizeMac } from "../util/mac";
import type { WirelessAssociatedClient } from "../wireless/wireless-medium";
import { Device } from "./device";
import { ForwardingDatabase } from "./forwarding-database";

const AP_FDB_SCOPE = "access-point";

/**
 * A transparent Ethernet/WLAN learning bridge. It deliberately contains no
 * router, DHCP server, NAT or IP firewall behavior.
 */
export class AccessPoint extends Device {
  readonly deviceType = "access-point" as const;
  private readonly forwardingDatabase = new ForwardingDatabase<typeof AP_FDB_SCOPE>();
  private wirelessInterfaceId: string | undefined;
  private accessPointConfiguration: WirelessAccessPointConfiguration | undefined;

  configureWireless(
    interfaceConfiguration: WirelessInterfaceConfiguration,
    accessPointConfiguration: WirelessAccessPointConfiguration,
  ): WirelessInterface {
    validateMatchingRadio(interfaceConfiguration, accessPointConfiguration);
    const iface = this.addWirelessInterface(interfaceConfiguration);
    this.engine.wireless.registerAccessPoint({
      deviceId: this.id,
      interfaceId: iface.name,
      macAddress: iface.mac,
      configuration: runtimeAccessPointConfiguration(accessPointConfiguration),
      receive: (frame) => {
        if (iface.adminUp && iface.wirelessEnabled) this.onReceive(frame, iface);
      },
    });
    this.wirelessInterfaceId = iface.name;
    this.accessPointConfiguration = cloneAccessPointConfiguration(accessPointConfiguration);
    return iface;
  }

  updateWireless(configuration: WirelessAccessPointConfiguration): void {
    const iface = this.wirelessInterface;
    validateMatchingRadio(iface.configurationSnapshot(), configuration);
    this.engine.wireless.updateAccessPoint(
      this.id,
      iface.name,
      runtimeAccessPointConfiguration(configuration),
    );
    iface.setWirelessEnabled(configuration.enabled);
    this.accessPointConfiguration = cloneAccessPointConfiguration(configuration);
  }

  setWirelessEnabled(enabled: boolean): void {
    const configuration = this.configurationSnapshot().accessPoint;
    this.updateWireless({ ...configuration, enabled });
  }

  associatedClients(): WirelessAssociatedClient[] {
    return this.engine.wireless.associatedClients(this.id, this.wirelessInterface.name);
  }

  disconnectClient(stationDeviceId: string, reason = "access-point-disconnect"): boolean {
    return this.engine.wireless.disconnectClient(
      this.id,
      this.wirelessInterface.name,
      stationDeviceId,
      reason,
    );
  }

  configurationSnapshot(): {
    readonly radio: WirelessRadioSettings;
    readonly accessPoint: WirelessAccessPointConfiguration;
  } {
    const configuration = this.accessPointConfiguration;
    if (!configuration) throw new Error(`Access point ${this.id} has no configured radio.`);
    const radio = this.wirelessInterface.configurationSnapshot();
    return {
      radio: {
        enabled: radio.enabled,
        band: radio.band,
        supportedChannels: [...radio.supportedChannels],
        radioDomainId: radio.radioDomainId,
      },
      accessPoint: cloneAccessPointConfiguration(configuration),
    };
  }

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    if (!ingress.operationalUp) {
      this.traceDrop(frame, ingress.name, "ingress-interface-down");
      return;
    }
    const now = this.engine.now();
    const source = normalizeMac(frame.src);
    const destination = normalizeMac(frame.dst);
    this.forwardingDatabase.learn(AP_FDB_SCOPE, source, ingress.name, now);
    this.engine.trace({
      time: now,
      type: "access-point-mac-learn",
      device: this.id,
      detail: { mac: source, interface: ingress.name },
    });

    const multicast = isBroadcastMac(destination) || isMulticastMac(destination);
    const learned = multicast
      ? undefined
      : this.forwardingDatabase.lookup(AP_FDB_SCOPE, destination, now);
    if (learned?.port === ingress.name) return;
    const egressInterfaces = learned
      ? [this.interfaces.get(learned.port)].filter(
          (iface): iface is EthernetInterface => iface !== undefined,
        )
      : [...this.interfaces.values()].filter((iface) => iface !== ingress);
    for (const egress of egressInterfaces) {
      if (!egress.operationalUp) continue;
      egress.transmit(frame);
      this.engine.trace({
        time: now,
        type: learned ? "access-point-forward" : "access-point-flood",
        device: this.id,
        detail: { ingress: ingress.name, egress: egress.name, dst: destination },
      });
    }
  }

  private get wirelessInterface(): WirelessInterface {
    const id = this.wirelessInterfaceId;
    const iface = id ? this.getInterface(id) : undefined;
    if (!iface || !("wirelessEnabled" in iface)) {
      throw new Error(`Access point ${this.id} has no configured radio.`);
    }
    return iface as WirelessInterface;
  }

  private traceDrop(frame: EthernetFrame, interfaceId: string, reason: string): void {
    this.engine.trace({
      time: this.engine.now(),
      type: "access-point-frame-dropped",
      device: this.id,
      detail: { interface: interfaceId, reason, src: frame.src, dst: frame.dst },
    });
  }
}

function validateMatchingRadio(
  interfaceConfiguration: Pick<
    WirelessInterfaceConfiguration,
    "band" | "radioDomainId" | "supportedChannels"
  >,
  accessPointConfiguration: WirelessAccessPointConfiguration,
): void {
  if (interfaceConfiguration.radioDomainId !== accessPointConfiguration.radioDomainId) {
    throw new Error("Access point radio domain does not match its wireless interface.");
  }
  if (interfaceConfiguration.band !== accessPointConfiguration.band) {
    throw new Error("Access point band does not match its wireless interface.");
  }
  if (!interfaceConfiguration.supportedChannels.includes(accessPointConfiguration.channel)) {
    throw new Error("Access point channel is not supported by its wireless interface.");
  }
}

function runtimeAccessPointConfiguration(configuration: WirelessAccessPointConfiguration) {
  return {
    ...configuration,
    security: {
      mode: configuration.security.mode,
      credentialFingerprint: configuration.security.mode === "wpa2-personal"
        ? configuration.security.credentialVerifier.hashBase64
        : undefined,
    },
  };
}

function cloneAccessPointConfiguration(
  configuration: WirelessAccessPointConfiguration,
): WirelessAccessPointConfiguration {
  return {
    ...configuration,
    security: configuration.security.mode === "wpa2-personal"
      ? {
          mode: "wpa2-personal",
          credentialVerifier: { ...configuration.security.credentialVerifier },
        }
      : { mode: "open" },
  };
}

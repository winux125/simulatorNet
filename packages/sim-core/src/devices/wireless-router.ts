import type {
  WirelessAccessPointConfiguration,
  WirelessInterfaceConfiguration,
  WirelessRouterDeviceConfig,
} from "@sim/contracts";
import type { EthernetInterface } from "../net/interface";
import type { WirelessInterface } from "../net/wireless-interface";
import type { EthernetFrame } from "../packets/ethernet";
import { macFromIndex } from "../util/mac";
import type { WirelessAssociatedClient } from "../wireless/wireless-medium";
import { Device } from "./device";
import { Firewall } from "./firewall";
import { Pc } from "./pc";
import { L2Switch } from "./switch";

const EXTERNAL_LAN_PORTS = ["LAN1", "LAN2", "LAN3", "LAN4"] as const;
const INTERNAL_LAN_INTERFACE = "LAN";
const INTERNAL_WAN_INTERFACE = "WAN";
const INTERNAL_GATEWAY_PORT = "__gateway";
const WAN_DHCP_POLL_NS = 100_000_000;
const MAXIMUM_WAN_DHCP_POLLS = 64;

/**
 * Consumer-style wireless router implemented as a composition of the existing
 * deterministic WirelessMedium, L2Switch and Firewall/Router engines.
 *
 * The facade owns the visible WAN/LAN/wlan0 endpoints. Hidden point-to-point
 * adapter interfaces connect them to the reusable components; no forwarding,
 * DHCP, NAT or stateful policy algorithm is duplicated here.
 */
export class WirelessRouter extends Device {
  readonly deviceType = "wireless-router" as const;
  private internalSwitch: L2Switch | undefined;
  private internalFirewall: Firewall | undefined;
  private internalWanClient: Pc | undefined;
  private wirelessInterfaceId: string | undefined;
  private configuration: WirelessRouterDeviceConfig | undefined;

  configureHomeNetwork(
    radioInterface: WirelessInterfaceConfiguration,
    configuration: WirelessRouterDeviceConfig,
  ): void {
    if (this.configuration) throw new Error(`Wireless router ${this.id} is already configured.`);
    validateVisibleInterfaces(this, radioInterface.id);
    validateRadioConfiguration(radioInterface, configuration.accessPoint);
    const wireless = this.addWirelessInterface(radioInterface);
    this.engine.wireless.registerAccessPoint({
      deviceId: this.id,
      interfaceId: wireless.name,
      macAddress: wireless.mac,
      configuration: {
        ...configuration.accessPoint,
        security: {
          mode: configuration.accessPoint.security.mode,
          credentialFingerprint: configuration.accessPoint.security.mode === "wpa2-personal"
            ? configuration.accessPoint.security.credentialVerifier.hashBase64
            : undefined,
        },
      },
      receive: (frame) => {
        if (wireless.adminUp && wireless.wirelessEnabled) this.onReceive(frame, wireless);
      },
    });
    this.wirelessInterfaceId = wireless.name;
    this.configuration = cloneWirelessRouterConfiguration(configuration);
    this.createInternalComposition(configuration);
  }

  get lanSwitch(): L2Switch {
    if (!this.internalSwitch) throw new Error(`Wireless router ${this.id} is not initialized.`);
    return this.internalSwitch;
  }

  get firewallRouter(): Firewall {
    if (!this.internalFirewall) throw new Error(`Wireless router ${this.id} is not initialized.`);
    return this.internalFirewall;
  }

  wanRuntimeStatus(): {
    mode: "static" | "dhcp";
    state: "static" | "idle" | "discovering" | "requesting" | "bound" | "failed";
    address?: string;
    defaultGateway?: string;
  } {
    const configuration = this.configurationSnapshot();
    if (configuration.wan.mode === "static") {
      return {
        mode: "static",
        state: "static",
        address: configuration.wan.address,
        defaultGateway: configuration.wan.defaultGateway,
      };
    }
    const client = this.internalWanClient;
    return {
      mode: "dhcp",
      state: client?.dhcpState ?? "idle",
      address: client?.lease?.ip,
      defaultGateway: client?.lease?.gateway,
    };
  }

  get wirelessInterface(): WirelessInterface {
    const iface = this.wirelessInterfaceId
      ? this.getInterface(this.wirelessInterfaceId)
      : undefined;
    if (!iface || !("wirelessEnabled" in iface)) {
      throw new Error(`Wireless router ${this.id} has no configured radio.`);
    }
    return iface as WirelessInterface;
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

  updateWireless(configuration: WirelessAccessPointConfiguration): void {
    const current = this.configurationSnapshot();
    const supportedChannels = configuration.band === "5ghz"
      ? [36, 40, 44, 48, 149, 153, 157, 161]
      : [1, 6, 11];
    if (!supportedChannels.includes(configuration.channel)) {
      throw new Error(`Wireless router channel ${configuration.channel} is not supported for ${configuration.band}.`);
    }
    this.engine.wireless.updateAccessPoint(this.id, this.wirelessInterface.name, {
      ...configuration,
      security: {
        mode: configuration.security.mode,
        credentialFingerprint: configuration.security.mode === "wpa2-personal"
          ? configuration.security.credentialVerifier.hashBase64
          : undefined,
      },
    });
    this.wirelessInterface.updateRadioSettings({
      enabled: configuration.enabled,
      band: configuration.band,
      supportedChannels,
      radioDomainId: configuration.radioDomainId,
    });
    this.configuration = cloneWirelessRouterConfiguration({
      ...current,
      radio: {
        enabled: configuration.enabled,
        band: configuration.band,
        supportedChannels,
        radioDomainId: configuration.radioDomainId,
      },
      accessPoint: configuration,
    });
  }

  configurationSnapshot(): WirelessRouterDeviceConfig {
    if (!this.configuration) throw new Error(`Wireless router ${this.id} is not initialized.`);
    return cloneWirelessRouterConfiguration(this.configuration);
  }

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    const route = relayRoute(ingress.name, this.wirelessInterfaceId);
    if (!route) {
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-router-frame-dropped",
        device: this.id,
        detail: { ingress: ingress.name, reason: "unknown-relay-interface" },
      });
      return;
    }
    const egress = this.getInterface(route);
    if (!egress?.operationalUp) {
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-router-frame-dropped",
        device: this.id,
        detail: { ingress: ingress.name, egress: route, reason: "relay-interface-down" },
      });
      return;
    }
    egress.transmit(frame);
    this.engine.trace({
      time: this.engine.now(),
      type: "wireless-router-frame-relayed",
      device: this.id,
      detail: { ingress: ingress.name, egress: route, src: frame.src, dst: frame.dst },
    });
  }

  private createInternalComposition(configuration: WirelessRouterDeviceConfig): void {
    const switchId = internalDeviceId(this.id, "lan-switch");
    const wanSwitchId = internalDeviceId(this.id, "wan-switch");
    const firewallId = internalDeviceId(this.id, "firewall");
    const wanClientId = internalDeviceId(this.id, "wan-client");
    if (
      this.engine.getDevice(switchId)
      || this.engine.getDevice(wanSwitchId)
      || this.engine.getDevice(firewallId)
      || this.engine.getDevice(wanClientId)
    ) {
      throw new Error(`Wireless router ${this.id} internal device ID collision.`);
    }
    const baseMacIndex = internalMacBase(this.id);
    const lanSwitch = this.engine.add(new L2Switch(switchId, `${this.name} LAN switch`));
    const wanSwitch = this.engine.add(new L2Switch(wanSwitchId, `${this.name} WAN segment`));
    const firewall = this.engine.add(new Firewall(firewallId, `${this.name} router/firewall`));
    const wanClient = this.engine.add(new Pc(wanClientId, `${this.name} WAN DHCP client`));
    this.internalSwitch = lanSwitch;
    this.internalFirewall = firewall;
    this.internalWanClient = wanClient;

    let macOffset = 0;
    for (const port of [...EXTERNAL_LAN_PORTS, this.wirelessInterface.name]) {
      const proxyName = internalProxyName(port);
      this.addInterface(proxyName, macFromIndex(baseMacIndex + macOffset++));
      lanSwitch.addInterface(port, macFromIndex(baseMacIndex + macOffset++));
      this.engine.connect(this.id, proxyName, lanSwitch.id, port);
    }
    this.addInterface(internalProxyName(INTERNAL_WAN_INTERFACE), macFromIndex(baseMacIndex + macOffset++));
    wanSwitch.addInterface("uplink", macFromIndex(baseMacIndex + macOffset++));
    this.engine.connect(
      this.id,
      internalProxyName(INTERNAL_WAN_INTERFACE),
      wanSwitch.id,
      "uplink",
    );
    firewall.addInterface(INTERNAL_WAN_INTERFACE, macFromIndex(baseMacIndex + macOffset++));
    wanSwitch.addInterface("firewall", macFromIndex(baseMacIndex + macOffset++));
    this.engine.connect(
      wanSwitch.id,
      "firewall",
      firewall.id,
      INTERNAL_WAN_INTERFACE,
    );
    wanClient.addInterface("eth0", macFromIndex(baseMacIndex + macOffset++));
    wanSwitch.addInterface("dhcp-client", macFromIndex(baseMacIndex + macOffset++));
    this.engine.connect(wanClient.id, "eth0", wanSwitch.id, "dhcp-client");

    lanSwitch.addInterface(INTERNAL_GATEWAY_PORT, macFromIndex(baseMacIndex + macOffset++));
    firewall.addInterface(INTERNAL_LAN_INTERFACE, macFromIndex(baseMacIndex + macOffset++));
    this.engine.connect(
      lanSwitch.id,
      INTERNAL_GATEWAY_PORT,
      firewall.id,
      INTERNAL_LAN_INTERFACE,
    );

    firewall.configureInterface(INTERNAL_LAN_INTERFACE, {
      ip: configuration.lan.address,
      mask: configuration.lan.prefixLength,
    });
    if (configuration.lan.dhcpEnabled) {
      firewall.addDhcpPool({
        id: `${this.id}-lan`,
        network: configuration.lan.address,
        mask: configuration.lan.prefixLength,
        gateway: configuration.lan.address,
        rangeStart: configuration.lan.dhcpRangeStart,
        rangeEnd: configuration.lan.dhcpRangeEnd,
      });
    }
    if (
      configuration.wan.mode === "static"
      && configuration.wan.address
      && configuration.wan.prefixLength !== undefined
    ) {
      firewall.configureInterface(INTERNAL_WAN_INTERFACE, {
        ip: configuration.wan.address,
        mask: configuration.wan.prefixLength,
      });
      if (configuration.wan.defaultGateway) {
        firewall.addStaticRoute("0.0.0.0", 0, configuration.wan.defaultGateway);
      }
    } else {
      firewall.getOrCreateInterface(INTERNAL_WAN_INTERFACE);
      wanClient.setDhcpEnabled(true);
      wanClient.requestDhcp();
      this.synchronizeWanDhcp(0);
    }

    firewall.setZone(INTERNAL_LAN_INTERFACE, "lan");
    firewall.setZone(INTERNAL_WAN_INTERFACE, "wan");
    firewall.setDefaultPolicy(configuration.firewallEnabled ? "deny" : "permit");
    if (configuration.firewallEnabled) {
      firewall.definePolicy({
        id: `${this.id}-lan-out`,
        sequence: 10,
        sourceZone: "lan",
        destinationZone: "wan",
        action: "permit",
        protocol: "ip",
      });
    }
    firewall.setNatRole(INTERNAL_LAN_INTERFACE, "inside");
    firewall.setNatRole(INTERNAL_WAN_INTERFACE, "outside");
    if (configuration.natEnabled) {
      firewall.defineNatRule({
        id: `${this.id}-pat`,
        sequence: 10,
        kind: "pat",
        source: { kind: "any" },
        outsideAddress: "interface",
      });
    }

    if (configuration.lan.ipv6Address && configuration.lan.ipv6PrefixLength !== undefined) {
      firewall.setInterfaceIpv6(
        INTERNAL_LAN_INTERFACE,
        configuration.lan.ipv6Address,
        configuration.lan.ipv6PrefixLength,
      );
      firewall.setIpv6ForwardingEnabled(true);
      if (configuration.lan.routerAdvertisementEnabled) {
        firewall.configureRouterAdvertisement(INTERNAL_LAN_INTERFACE, {
          managed: configuration.lan.dhcpv6Enabled,
          otherConfiguration: configuration.lan.dhcpv6Enabled,
          prefixes: [{
            prefix: configuration.lan.ipv6Address,
            prefixLength: configuration.lan.ipv6PrefixLength,
            autonomous: true,
            onLink: true,
            validLifetimeNs: 7_200_000_000_000,
            preferredLifetimeNs: 3_600_000_000_000,
          }],
        });
      }
    }
  }

  private synchronizeWanDhcp(poll: number): void {
    const client = this.internalWanClient;
    const firewall = this.internalFirewall;
    if (!client || !firewall) return;
    if (client.dhcpState === "bound" && client.lease) {
      firewall.configureInterface(INTERNAL_WAN_INTERFACE, {
        ip: client.lease.ip,
        mask: client.lease.mask ?? 24,
      });
      if (client.lease.gateway) {
        firewall.addStaticRoute("0.0.0.0", 0, client.lease.gateway);
      }
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-router-wan-dhcp-bound",
        device: this.id,
        detail: {
          address: client.lease.ip,
          gateway: client.lease.gateway,
        },
      });
      return;
    }
    if (client.dhcpState === "failed" || poll >= MAXIMUM_WAN_DHCP_POLLS) {
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-router-wan-dhcp-failed",
        device: this.id,
        detail: { attempts: poll },
      });
      return;
    }
    this.engine.scheduleIn(WAN_DHCP_POLL_NS, () => this.synchronizeWanDhcp(poll + 1));
  }
}

function validateVisibleInterfaces(device: Device, wirelessInterfaceId: string): void {
  for (const name of [...EXTERNAL_LAN_PORTS, INTERNAL_WAN_INTERFACE]) {
    if (!device.getInterface(name)) {
      throw new Error(`Wireless router ${device.id} has no visible interface ${name}.`);
    }
  }
  if (device.getInterface(wirelessInterfaceId)) {
    throw new Error(`Wireless router ${device.id} interface ${wirelessInterfaceId} already exists.`);
  }
}

function validateRadioConfiguration(
  radio: Pick<WirelessInterfaceConfiguration, "band" | "radioDomainId" | "supportedChannels">,
  accessPoint: WirelessAccessPointConfiguration,
): void {
  if (radio.band !== accessPoint.band || radio.radioDomainId !== accessPoint.radioDomainId) {
    throw new Error("Wireless router radio settings do not match its access point.");
  }
  if (!radio.supportedChannels.includes(accessPoint.channel)) {
    throw new Error("Wireless router channel is not supported by its radio.");
  }
}

function internalDeviceId(deviceId: string, component: string): string {
  return `__wireless-router:${deviceId}:${component}`;
}

function internalProxyName(visibleInterface: string): string {
  return `__relay:${visibleInterface}`;
}

function relayRoute(ingress: string, wirelessInterfaceId: string | undefined): string | undefined {
  if (
    ingress === INTERNAL_WAN_INTERFACE
    || ingress === wirelessInterfaceId
    || (EXTERNAL_LAN_PORTS as readonly string[]).includes(ingress)
  ) return internalProxyName(ingress);
  const prefix = "__relay:";
  return ingress.startsWith(prefix) ? ingress.slice(prefix.length) : undefined;
}

function internalMacBase(deviceId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < deviceId.length; index++) {
    hash ^= deviceId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return 0x800000 | ((hash >>> 0) & 0x7fff00);
}

function cloneWirelessRouterConfiguration(
  configuration: WirelessRouterDeviceConfig,
): WirelessRouterDeviceConfig {
  return {
    ...configuration,
    interfaces: configuration.interfaces.map((iface) => ({ ...iface })),
    radio: {
      ...configuration.radio,
      supportedChannels: [...configuration.radio.supportedChannels],
    },
    accessPoint: {
      ...configuration.accessPoint,
      security: configuration.accessPoint.security.mode === "wpa2-personal"
        ? {
            mode: "wpa2-personal",
            credentialVerifier: { ...configuration.accessPoint.security.credentialVerifier },
          }
        : { mode: "open" },
    },
    lan: { ...configuration.lan },
    wan: { ...configuration.wan },
  };
}

import { EtherType, type ServerServiceConfig } from "@sim/contracts";
import { DHCPV6_CLIENT_PORT, DHCPV6_SERVER_PORT } from "../engine/constants";
import type { EthernetInterface } from "../net/interface";
import type { CdpPacket, DiscoveryCapability, LldpPacket } from "../packets/discovery";
import { type EthernetFrame, isControlPayload } from "../packets/ethernet";
import { Ipv6NextHeader } from "../packets/ipv6";
import type { UdpDatagram } from "../packets/udp";
import { Dhcpv6Server, type Dhcpv6PoolConfig } from "../protocols/dhcpv6";
import { discoveryCapabilitiesFor, discoveryPlatformFor } from "../protocols/discovery-support";
import { NeighborDiscovery } from "../protocols/neighbor-discovery";
import type { Ipv4 } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";
import { LLDP_MAC, type Mac, normalizeMac, ZERO_MAC } from "../util/mac";
import { EndHost } from "./pc";
import { ServerServiceRegistry, type ServerServiceRuntimeSnapshot, type ServerServiceSummary } from "../services/server-services";

/**
 * Server reuses the end-host IPv4/ARP/ICMP/DHCP/transport stack and owns the
 * deterministic application-service registry. Runtime state is never part of
 * the persistent lab document.
 *
 * A server is a vendor-neutral station: it can transmit and receive LLDP when a
 * lab enables it, but it never speaks the Cisco-like CDP subset.
 */
export class Server extends EndHost {
  readonly deviceType = "server" as const;
  readonly services: ServerServiceRegistry;
  readonly dhcpv6 = new Dhcpv6Server(`duid-server-${this.id}`);
  /** LLDP only; `supportsCdp` is false so `cdp run` is rejected outright. */
  readonly discovery = new NeighborDiscovery(this, false);

  constructor(id: string, name: string) {
    super(id, name);
    this.services = new ServerServiceRegistry({
      deviceId: this.id,
      hostname: () => this.name,
      engine: () => this.engine,
      localAddress: (family, destination) => this.localTransportAddress(family, destination),
      transport: this.transport,
    });
  }

  get enabledServices(): ServerServiceConfig[] {
    return this.services.configurations().filter((service) => service.enabled);
  }

  configureServices(configurations: readonly ServerServiceConfig[]): void {
    this.services.configureAll(configurations);
  }

  configureService(configuration: ServerServiceConfig): void {
    this.services.configure(configuration);
  }

  enableService(id: string): void {
    this.services.enable(id);
  }

  disableService(id: string): void {
    this.services.disable(id);
  }

  listServices(): ServerServiceSummary[] {
    return this.services.summaries();
  }

  serviceRuntimeSnapshot(): ServerServiceRuntimeSnapshot {
    return this.services.runtimeSnapshot();
  }

  addDhcpv6Pool(configuration: Dhcpv6PoolConfig): void {
    this.dhcpv6.addPool(configuration);
  }

  dhcpv6PoolConfigurations(): Dhcpv6PoolConfig[] {
    return this.dhcpv6.configurations();
  }

  protected override onNetworkConfigurationChanged(): void {
    this.services.restartRuntime();
  }

  protected override handleIpv6ControlDatagram(source: Ipv6, datagram: UdpDatagram): boolean {
    if (datagram.dstPort !== DHCPV6_SERVER_PORT || datagram.payload.kind !== "dhcpv6") return false;
    const linkAddress = this.ipv6Addresses.summaries().find((entry) =>
      entry.source !== "link-local" && entry.state === "preferred")?.address;
    const reply = this.dhcpv6.handle(datagram.payload, linkAddress);
    const local = this.ipv6Addresses.sourceFor(source);
    if (!reply || !local) return true;
    this.sendIpv6({
      kind: "ipv6",
      src: local,
      dst: source,
      nextHeader: Ipv6NextHeader.UDP,
      hopLimit: 1,
      payload: {
        kind: "udp",
        srcPort: DHCPV6_SERVER_PORT,
        dstPort: DHCPV6_CLIENT_PORT,
        payload: reply,
      },
    });
    return true;
  }

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    // LLDP is link-local: it is consumed here and never enters the IP stack.
    if (isControlPayload(frame.payload)) {
      if (frame.payload.kind === "lldp") this.discovery.onLldp(frame.payload, ingress.name);
      return;
    }
    super.onReceive(frame, ingress);
  }

  override onInterfaceStateChanged(iface: EthernetInterface): void {
    this.discovery.onPortStateChanged(iface.name);
  }

  // --- neighbour discovery ------------------------------------------------

  discoveryInterfaceIds(): readonly string[] {
    return [...this.interfaces.keys()];
  }

  discoveryInterfaceOperationalUp(port: string): boolean {
    return this.interfaces.get(port)?.operationalUp === true;
  }

  discoveryChassisId(): Mac {
    let lowest: Mac | undefined;
    for (const iface of this.interfaces.values()) {
      const mac = normalizeMac(iface.mac);
      if (lowest === undefined || mac.localeCompare(lowest) < 0) lowest = mac;
    }
    return lowest ?? ZERO_MAC;
  }

  discoveryPlatform(): string {
    return discoveryPlatformFor(this.deviceType);
  }

  discoveryCapabilities(): readonly DiscoveryCapability[] {
    return discoveryCapabilitiesFor(this.deviceType);
  }

  discoveryManagementAddress(): Ipv4 | undefined {
    return this.ip;
  }

  discoveryPortDescription(port: string): string | undefined {
    return this.interfaces.get(port)?.description;
  }

  discoveryNativeVlan(_port: string): number | undefined {
    return undefined;
  }

  discoverySend(port: string, payload: CdpPacket | LldpPacket): void {
    if (payload.kind !== "lldp") return;
    const iface = this.interfaces.get(port);
    if (!iface?.operationalUp) return;
    iface.transmit({ src: iface.mac, dst: LLDP_MAC, etherType: EtherType.LLDP, payload });
  }
}

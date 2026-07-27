import {
  ArpOp,
  DhcpMessageType,
  EtherType,
  IcmpCode,
  IcmpType,
  IpProtocol,
  type HostStaticConfiguration,
} from "@sim/contracts";
import {
  DEFAULT_DHCP_TIMEOUT_NS,
  DEFAULT_DHCPV6_TIMEOUT_NS,
  DEFAULT_IP_TTL,
  DEFAULT_IPV6_HOP_LIMIT,
  DEFAULT_PING_TIMEOUT_NS,
  DHCP_CLIENT_PORT,
  DHCP_SERVER_PORT,
  DHCPV6_CLIENT_PORT,
  DHCPV6_SERVER_PORT,
} from "../engine/constants";
import type { EthernetInterface } from "../net/interface";
import type { ArpPacket } from "../packets/arp";
import type { DhcpMessage } from "../packets/dhcp";
import { Dhcpv6MessageType, type Dhcpv6Message } from "../packets/dhcpv6";
import type { EthernetFrame } from "../packets/ethernet";
import type { IcmpMessage } from "../packets/icmp";
import type { Ipv4Packet } from "../packets/ipv4";
import {
  Icmpv6Type,
  type Icmpv6Message,
  type RouterAdvertisement,
} from "../packets/icmpv6";
import { Ipv6NextHeader, type Ipv6Packet } from "../packets/ipv6";
import type { UdpDatagram } from "../packets/udp";
import type { TcpSegment } from "../packets/tcp";
import { HostTransportStack } from "../transport/host-transport";
import { HostApplications } from "../services/host-applications";
import type { TcpAcceptListener, TcpConnection, TcpConnectionHandlers } from "../transport/tcp";
import type { UdpListener, UdpSendOptions } from "../transport/udp";
import { BROADCAST_IP, type Ipv4, ipsShareNetwork, maskToInt, UNSPECIFIED_IP } from "../util/ipv4";
import { ipFamilyOf, type IpAddress, type IpFamily } from "../util/ip-address";
import { BROADCAST_MAC, type Mac, normalizeMac, ZERO_MAC } from "../util/mac";
import { Device } from "./device";
import { Ipv6InterfaceState, type Ipv6AddressAssignment } from "../net/ipv6-interface";
import { Ipv6NeighborDiscovery, type Ipv6NeighborEntry } from "../protocols/ipv6-neighbor-discovery";
import {
  deterministicLinkLocalAddress,
  deterministicInterfaceIdentifier,
  combineIpv6Prefix,
  IPV6_ALL_ROUTERS,
  IPV6_ALL_DHCP_SERVERS,
  ipv6SameSubnet,
  isIpv6Multicast,
  isIpv6Unspecified,
  normalizeIpv6,
  type Ipv6,
} from "../util/ipv6";

export interface DhcpLease {
  ip: Ipv4;
  mask?: Ipv4;
  gateway?: Ipv4;
  serverIp?: Ipv4;
  leaseSeconds?: number;
}

type DhcpState = "idle" | "discovering" | "requesting" | "bound" | "failed";
export type Ipv6HostMode = "static" | "slaac" | "dhcpv6";
export type Dhcpv6State = "idle" | "soliciting" | "requesting" | "bound" | "released" | "failed";

export interface Dhcpv6Lease {
  readonly address: Ipv6;
  readonly prefixLength: number;
  readonly serverId: string;
  readonly preferredLifetimeNs: number;
  readonly validLifetimeNs: number;
  readonly dnsServers: readonly Ipv6[];
}

export interface PcConfig {
  ip?: Ipv4;
  /** Dotted mask ("255.255.255.0") or prefix length (24). */
  mask?: Ipv4 | number;
  gateway?: Ipv4;
  dnsServer?: Ipv4;
}

/** Persistent PC configuration. Runtime DHCP lease data is intentionally absent. */
export interface PcConfigurationSnapshot {
  ip: Ipv4 | undefined;
  maskInt: number;
  gateway: Ipv4 | undefined;
  dhcpEnabled: boolean;
  dnsServer: Ipv4 | undefined;
}

/** Persistent IPv6 intent. Learned addresses, leases and NDP state are excluded. */
export interface HostIpv6ConfigurationSnapshot {
  readonly mode: Ipv6HostMode;
  readonly staticAddress?: Ipv6;
  readonly prefixLength?: number;
  readonly defaultRouter?: Ipv6;
  readonly dnsServer?: Ipv6;
}

export interface PingResult {
  sequence: number;
  success: boolean;
  /** Round-trip time in nanoseconds; present only on success. */
  rttNs?: number;
}

interface PendingPing {
  sentAt: number;
}

/**
 * An end host with a single interface and a minimal IPv4 stack: ARP resolution
 * with a pending queue, ICMP echo request/reply, and a per-sequence ping table
 * with timeouts. Non-local destinations are sent to the default gateway.
 */
export abstract class EndHost extends Device {
  readonly transport: HostTransportStack;
  readonly applications: HostApplications;
  private primaryInterfaceName: string | undefined;
  ip: Ipv4 | undefined;
  maskInt = maskToInt(24);
  gateway: Ipv4 | undefined;

  readonly arpTable = new Map<Ipv4, Mac>();
  readonly pingResults: PingResult[] = [];
  readonly ipv6Addresses = new Ipv6InterfaceState();
  readonly ipv6PingResults: PingResult[] = [];
  readonly ipv6Problems: string[] = [];
  ipv6Mode: Ipv6HostMode = "static";
  ipv6DefaultRouter: Ipv6 | undefined;
  private ipv6DefaultRouterUntilNs: number | undefined;
  ipv6DnsServer: Ipv6 | undefined;
  dhcpv6State: Dhcpv6State = "idle";
  dhcpv6Lease: Dhcpv6Lease | undefined;
  private ipv6NeighborRuntime: Ipv6NeighborDiscovery | undefined;
  private readonly pendingIpv6Pings = new Map<number, PendingPing>();
  private readonly icmpv6Identifier = 0x6262;
  private dhcpv6TransactionId = 0;
  private routerSolicitationSent = false;

  /** DHCP client state (see `requestDhcp`). */
  dhcpState: DhcpState = "idle";
  dhcpBound = false;
  lease: DhcpLease | undefined;
  dhcpEnabled = false;
  private dhcpXid = 0;
  private configuredIp: Ipv4 | undefined;
  private configuredMaskInt = maskToInt(24);
  private configuredGateway: Ipv4 | undefined;

  /** IPv4 packets waiting on ARP resolution, keyed by next-hop IP. */
  private readonly arpPending = new Map<Ipv4, Ipv4Packet[]>();
  /** In-flight echo requests keyed by ICMP sequence number. */
  private readonly pendingPings = new Map<number, PendingPing>();
  private readonly icmpIdentifier = 0x4242;

  constructor(id: string, name: string) {
    super(id, name);
    this.transport = new HostTransportStack({
      deviceId: this.id,
      engine: () => this.engine,
      localAddress: (family, destination) => this.localTransportAddress(family, destination),
      sendUdpPacket: (destinationAddress, datagram, sourceAddress) => {
        this.sendTransportPacket(destinationAddress, IpProtocol.UDP, datagram, sourceAddress);
      },
      sendTcpPacket: (destinationAddress, segment, sourceAddress) => {
        this.sendTransportPacket(destinationAddress, IpProtocol.TCP, segment, sourceAddress);
      },
      portUnreachable: (destinationAddress, destinationPort) => {
        this.sendPortUnreachable(destinationAddress, destinationPort);
      },
    });
    this.applications = new HostApplications({
      deviceId: this.id,
      hostname: () => this.name,
      engine: () => this.engine,
      localAddress: (family, destination) => this.localTransportAddress(family, destination),
      transport: this.transport,
    });
  }

  bindUdp(port: number, listener: UdpListener, service?: string): number {
    return this.transport.udp.bind(port, listener, service);
  }

  unbindUdp(port: number): boolean {
    return this.transport.udp.unbind(port);
  }

  sendUdp(options: UdpSendOptions): number {
    return this.transport.udp.send(options);
  }

  listenTcp(port: number, listener: TcpAcceptListener, service?: string): void {
    this.transport.tcp.listen(port, listener, service);
  }

  unlistenTcp(port: number): boolean {
    return this.transport.tcp.unlisten(port);
  }

  connectTcp(
    destinationAddress: IpAddress,
    destinationPort: number,
    handlers?: TcpConnectionHandlers,
    service?: string,
  ): TcpConnection {
    return this.transport.tcp.connect(destinationAddress, destinationPort, handlers, service);
  }

  configure(config: PcConfig): void {
    this.dhcpEnabled = false;
    if (config.ip !== undefined) this.configuredIp = config.ip;
    if (config.mask !== undefined) this.configuredMaskInt = maskToInt(config.mask);
    if (config.gateway !== undefined) this.configuredGateway = config.gateway;
    if (config.dnsServer !== undefined) this.applications.setDnsServer(config.dnsServer);
    this.ip = this.configuredIp;
    this.maskInt = this.configuredMaskInt;
    this.gateway = this.configuredGateway;
  }

  /**
   * Replace persistent static addressing while preserving physical links.
   * Every address-bound runtime object belongs to the old address and is
   * invalidated before the new configuration becomes visible.
   */
  setStaticConfiguration(config: HostStaticConfiguration): void {
    this.resetNetworkRuntime();
    this.dhcpEnabled = false;
    this.configuredIp = config.address;
    this.configuredMaskInt = maskToInt(config.prefixLength);
    this.configuredGateway = config.defaultGateway;
    this.ip = config.address;
    this.maskInt = this.configuredMaskInt;
    this.gateway = config.defaultGateway;
    this.applications.setDnsServer(config.dnsServer);
    this.onNetworkConfigurationChanged();
  }

  /** Enable/disable persistent DHCP client mode without preserving a lease. */
  setDhcpEnabled(enabled: boolean): void {
    this.resetNetworkRuntime();
    this.dhcpEnabled = enabled;
    if (enabled) {
      this.configuredIp = undefined;
      this.configuredGateway = undefined;
      this.ip = undefined;
      this.gateway = undefined;
      this.dhcpBound = false;
      this.lease = undefined;
    } else {
      this.ip = this.configuredIp;
      this.maskInt = this.configuredMaskInt;
      this.gateway = this.configuredGateway;
    }
    this.onNetworkConfigurationChanged();
  }

  configurationSnapshot(): PcConfigurationSnapshot {
    return {
      ip: this.configuredIp,
      maskInt: this.configuredMaskInt,
      gateway: this.configuredGateway,
      dhcpEnabled: this.dhcpEnabled,
      dnsServer: this.applications.dnsServer,
    };
  }

  ipv6ConfigurationSnapshot(): HostIpv6ConfigurationSnapshot {
    const configured = this.ipv6Addresses.summaries().find((entry) => entry.source === "static");
    return {
      mode: this.ipv6Mode,
      staticAddress: this.ipv6Mode === "static" ? configured?.address : undefined,
      prefixLength: this.ipv6Mode === "static" ? configured?.prefixLength : undefined,
      defaultRouter: this.ipv6Mode === "static" ? this.ipv6DefaultRouter : undefined,
      dnsServer: this.ipv6Mode === "static" ? this.ipv6DnsServer : undefined,
    };
  }

  /** The PC's single Ethernet interface. */
  get primary(): EthernetInterface {
    if (this.primaryInterfaceName) {
      const selected = this.interfaces.get(this.primaryInterfaceName);
      if (selected) return selected;
    }
    for (const iface of this.interfaces.values()) return iface;
    throw new Error(`End host ${this.id} has no interface`);
  }

  /** Select the non-transit interface used by this host's IPv4 stack. */
  selectPrimaryInterface(name: string): void {
    if (!this.interfaces.has(name)) throw new Error(`End host ${this.id} has no interface ${name}`);
    this.primaryInterfaceName = name;
  }

  /** Enable IPv6 on the primary interface and create its deterministic link-local address. */
  enableIpv6(): Ipv6 {
    const linkLocal = deterministicLinkLocalAddress(this.primary.mac);
    if (!this.ipv6Addresses.get(linkLocal)) {
      this.ipv6Addresses.add({
        address: linkLocal,
        prefixLength: 64,
        source: "link-local",
        state: "tentative",
      });
      this.ipv6Discovery().beginDad(linkLocal);
    }
    return linkLocal;
  }

  /** Replace the persistent static global address; runtime NDP state is discarded. */
  configureIpv6Static(
    addressInput: Ipv6,
    prefixLength: number,
    defaultRouter?: Ipv6,
    dnsServer?: Ipv6,
  ): void {
    const address = normalizeIpv6(addressInput);
    if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
      throw new Error(`Invalid IPv6 prefix length: ${prefixLength}`);
    }
    this.resetIpv6NetworkRuntime();
    this.ipv6Mode = "static";
    this.routerSolicitationSent = false;
    this.dhcpv6State = "idle";
    this.dhcpv6Lease = undefined;
    this.ipv6DefaultRouter = defaultRouter ? normalizeIpv6(defaultRouter) : undefined;
    this.ipv6DefaultRouterUntilNs = undefined;
    this.ipv6DnsServer = dnsServer ? normalizeIpv6(dnsServer) : undefined;
    for (const assignment of this.ipv6Addresses.summaries()) {
      if (assignment.source !== "link-local") this.ipv6Addresses.remove(assignment.address);
    }
    this.enableIpv6();
    this.ipv6Addresses.add({
      address,
      prefixLength,
      source: "static",
      state: "tentative",
    });
    this.ipv6Discovery().beginDad(address);
  }

  setIpv6Mode(mode: Ipv6HostMode): void {
    this.resetIpv6NetworkRuntime();
    this.ipv6Mode = mode;
    this.routerSolicitationSent = false;
    this.dhcpv6State = "idle";
    this.dhcpv6Lease = undefined;
    this.ipv6DefaultRouter = undefined;
    this.ipv6DefaultRouterUntilNs = undefined;
    this.ipv6DnsServer = undefined;
    for (const assignment of this.ipv6Addresses.summaries()) {
      if (
        (mode === "static" && (assignment.source === "slaac" || assignment.source === "dhcpv6"))
        || (mode !== "static" && assignment.source !== "link-local")
      ) {
        this.ipv6Addresses.remove(assignment.address);
      }
    }
    const linkLocal = this.enableIpv6();
    if (this.ipv6Addresses.get(linkLocal)?.state === "preferred") this.startIpv6Autoconfiguration();
  }

  /**
   * Resume DAD/address discovery when a presentation-independent L2 bearer
   * becomes operational. Existing preferred addresses and transport state are
   * preserved (important for same-LAN roaming).
   */
  resumeIpv6AfterLinkUp(): void {
    const linkLocal = this.enableIpv6();
    const tentative = this.ipv6Addresses.summaries()
      .filter((assignment) => assignment.state === "tentative");
    for (const assignment of tentative) this.ipv6Discovery().beginDad(assignment.address);
    if (
      tentative.length === 0
      && this.ipv6Addresses.get(linkLocal)?.state === "preferred"
      && this.ipv6Mode !== "static"
    ) {
      this.startIpv6Autoconfiguration();
    }
  }

  renewDhcpv6(): void {
    if (this.ipv6Mode !== "dhcpv6") throw new Error("DHCPv6 mode is not enabled");
    if (this.dhcpv6Lease) {
      this.beginDhcpv6(Dhcpv6MessageType.Renew, this.dhcpv6Lease.serverId, this.dhcpv6Lease.address);
    } else {
      this.beginDhcpv6(Dhcpv6MessageType.Solicit);
    }
  }

  releaseDhcpv6(): void {
    const lease = this.dhcpv6Lease;
    if (lease) {
      this.sendDhcpv6(Dhcpv6MessageType.Release, lease.serverId, lease.address);
      this.ipv6Addresses.remove(lease.address);
    }
    this.transport.reset();
    this.applications.resetRuntime();
    this.dhcpv6Lease = undefined;
    this.dhcpv6State = "released";
    this.onNetworkConfigurationChanged();
  }

  ipv6AddressSummaries(): Ipv6AddressAssignment[] {
    this.refreshIpv6Runtime();
    return this.ipv6Addresses.summaries();
  }

  ipv6NeighborEntries(): Ipv6NeighborEntry[] {
    return this.ipv6Discovery().neighborEntries();
  }

  /** Re-run bounded DAD for inspection/tests after a configured address changes. */
  beginIpv6Dad(address: Ipv6, attempts?: number): void {
    this.ipv6Discovery().beginDad(address, attempts);
  }

  /** Initiate one ICMPv6 echo request after selecting a valid source address. */
  ping6(targetInput: Ipv6, sequence = 0): void {
    this.refreshIpv6Runtime();
    const target = normalizeIpv6(targetInput);
    const source = this.ipv6Addresses.sourceFor(target);
    if (!source) throw new Error(`PC ${this.id} has no usable IPv6 address`);
    const packet: Ipv6Packet = {
      kind: "ipv6",
      src: source,
      dst: target,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: DEFAULT_IPV6_HOP_LIMIT,
      payload: {
        kind: "icmpv6",
        type: Icmpv6Type.EchoRequest,
        code: 0,
        identifier: this.icmpv6Identifier,
        sequence,
      },
    };
    this.pendingIpv6Pings.set(sequence, { sentAt: this.engine.now() });
    this.engine.scheduleIn(DEFAULT_PING_TIMEOUT_NS, () => this.timeoutIpv6Ping(sequence));
    this.engine.trace({
      time: this.engine.now(),
      type: "icmpv6-echo-request",
      device: this.id,
      detail: { src: source, dst: target, sequence },
    });
    this.sendIpv6(packet);
  }

  /** Initiate one ICMP echo request. Result is recorded in `pingResults`. */
  ping(target: Ipv4, sequence = 0): void {
    if (this.ip === undefined) throw new Error(`PC ${this.id} has no IP configured`);
    const icmp: IcmpMessage = {
      kind: "icmp",
      type: IcmpType.EchoRequest,
      code: 0,
      identifier: this.icmpIdentifier,
      sequence,
    };
    const packet: Ipv4Packet = {
      kind: "ipv4",
      src: this.ip,
      dst: target,
      protocol: IpProtocol.ICMP,
      ttl: 64,
      payload: icmp,
    };
    this.pendingPings.set(sequence, { sentAt: this.engine.now() });
    this.engine.scheduleIn(DEFAULT_PING_TIMEOUT_NS, () => this.timeoutPing(sequence));
    this.engine.trace({
      time: this.engine.now(),
      type: "icmp-echo-request",
      device: this.id,
      detail: { dst: target, sequence },
    });
    this.sendIpv4(packet);
  }

  override onReceive(frame: EthernetFrame, _ingress: EthernetInterface): void {
    const dst = normalizeMac(frame.dst);
    const mine = normalizeMac(this.primary.mac);
    if (dst !== mine && dst !== BROADCAST_MAC && !dst.startsWith("33:33:")) return; // not for us

    const payload = frame.payload;
    if (payload.kind === "arp") {
      this.handleArp(payload);
    } else if (payload.kind === "ipv4") {
      this.handleIpv4(payload, frame);
    } else if (payload.kind === "ipv6") {
      this.handleIpv6(payload, frame);
    }
  }

  // --- IPv6 / ICMPv6 / NDP ---------------------------------------------

  private ipv6Discovery(): Ipv6NeighborDiscovery {
    if (this.ipv6NeighborRuntime) return this.ipv6NeighborRuntime;
    this.ipv6NeighborRuntime = new Ipv6NeighborDiscovery({
      deviceId: this.id,
      interfaceId: this.primary.name,
      engine: () => this.engine,
      mac: () => this.primary.mac,
      addresses: this.ipv6Addresses,
      isRouter: false,
      transmit: (destinationMac, packet) => {
        this.primary.transmit({
          src: this.primary.mac,
          dst: destinationMac,
          etherType: EtherType.IPv6,
          payload: packet,
        });
      },
      onDadConflict: (_address, message) => {
        if (!this.ipv6Problems.includes(message)) this.ipv6Problems.push(message);
      },
      onDadComplete: (address) => {
        this.onNetworkConfigurationChanged();
        const assignment = this.ipv6Addresses.get(address);
        if (assignment?.source === "link-local") this.startIpv6Autoconfiguration();
      },
    });
    return this.ipv6NeighborRuntime;
  }

  protected sendIpv6(packet: Ipv6Packet): void {
    this.refreshIpv6Runtime();
    if (isIpv6Multicast(packet.dst)) {
      this.ipv6Discovery().send(packet, packet.dst);
      return;
    }
    const source = this.ipv6Addresses.get(packet.src);
    if (!source) return;
    const nextHop = ipv6SameSubnet(packet.dst, packet.src, source.prefixLength)
      ? packet.dst
      : this.ipv6DefaultRouter;
    if (!nextHop) return;
    this.ipv6Discovery().send(packet, nextHop);
  }

  private handleIpv6(packet: Ipv6Packet, frame: EthernetFrame): void {
    if (packet.hopLimit <= 0) return;
    if (this.ipv6Discovery().receive(packet, frame.src)) return;
    if (!this.ipv6Addresses.owns(packet.dst) && !isIpv6Multicast(packet.dst)) return;
    if (packet.nextHeader === Ipv6NextHeader.UDP && packet.payload.kind === "udp") {
      if (packet.payload.dstPort === DHCPV6_CLIENT_PORT && packet.payload.payload.kind === "dhcpv6") {
        this.handleDhcpv6(packet.payload.payload);
        return;
      }
      if (this.handleIpv6ControlDatagram(packet.src, packet.payload)) return;
      this.transport.receiveUdp(packet.src, packet.dst, packet.payload, isIpv6Multicast(packet.dst));
      return;
    }
    if (packet.nextHeader === Ipv6NextHeader.TCP && packet.payload.kind === "tcp") {
      this.transport.receiveTcp(packet.src, packet.dst, packet.payload);
      return;
    }
    if (packet.nextHeader !== Ipv6NextHeader.ICMPv6 || packet.payload.kind !== "icmpv6") return;
    const icmp = packet.payload;
    if (icmp.type === Icmpv6Type.RouterAdvertisement) {
      this.handleRouterAdvertisement(packet.src, icmp);
    } else if (icmp.type === Icmpv6Type.EchoRequest && this.ipv6Addresses.owns(packet.dst)) {
      this.sendIpv6EchoReply(packet.src, packet.dst, icmp);
    } else if (icmp.type === Icmpv6Type.EchoReply) {
      this.completeIpv6Ping(icmp.sequence);
    }
  }

  /** Extension point for server-side DHCPv6 and future structured control services. */
  protected handleIpv6ControlDatagram(_source: Ipv6, _datagram: UdpDatagram): boolean {
    return false;
  }

  private startIpv6Autoconfiguration(): void {
    if (this.routerSolicitationSent || this.ipv6Mode === "static") return;
    const source = this.ipv6Addresses.sourceFor("fe80::1");
    if (!source) return;
    this.routerSolicitationSent = true;
    this.sendIpv6({
      kind: "ipv6",
      src: source,
      dst: IPV6_ALL_ROUTERS,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: 255,
      payload: {
        kind: "icmpv6",
        type: Icmpv6Type.RouterSolicitation,
        code: 0,
        sourceLinkLayerAddress: this.primary.mac,
      },
    });
    this.engine.trace({
      time: this.engine.now(),
      type: "ipv6-router-solicitation",
      device: this.id,
      detail: { source },
    });
    if (this.ipv6Mode === "dhcpv6") this.beginDhcpv6(Dhcpv6MessageType.Solicit);
  }

  private handleRouterAdvertisement(source: Ipv6, advertisement: RouterAdvertisement): void {
    this.ipv6Discovery().learnNeighbor(source, advertisement.sourceLinkLayerAddress);
    if (advertisement.routerLifetimeNs > 0) {
      this.ipv6DefaultRouter = normalizeIpv6(source);
      this.ipv6DefaultRouterUntilNs = this.engine.now() + advertisement.routerLifetimeNs;
    }
    if (advertisement.dnsServers?.[0]) this.ipv6DnsServer = normalizeIpv6(advertisement.dnsServers[0]);
    if (this.ipv6Mode === "slaac") {
      for (const prefix of advertisement.prefixes) {
        if (!prefix.autonomous || prefix.prefixLength !== 64) continue;
        const address = combineIpv6Prefix(
          prefix.prefix,
          prefix.prefixLength,
          deterministicInterfaceIdentifier(this.primary.mac),
        );
        const prior = this.ipv6Addresses.get(address);
        if (!prior) {
          this.ipv6Addresses.add({
            address,
            prefixLength: prefix.prefixLength,
            source: "slaac",
            state: "tentative",
            preferredUntilNs: this.engine.now() + prefix.preferredLifetimeNs,
            validUntilNs: this.engine.now() + prefix.validLifetimeNs,
          });
          this.ipv6Discovery().beginDad(address);
        }
      }
      if (advertisement.otherConfiguration) {
        this.beginDhcpv6(Dhcpv6MessageType.InformationRequest);
      }
    } else if (this.ipv6Mode === "dhcpv6" && advertisement.managed && this.dhcpv6State === "idle") {
      this.beginDhcpv6(Dhcpv6MessageType.Solicit);
    }
    this.engine.trace({
      time: this.engine.now(),
      type: "ipv6-router-advertisement",
      device: this.id,
      detail: {
        source,
        managed: advertisement.managed,
        otherConfiguration: advertisement.otherConfiguration,
        prefixes: advertisement.prefixes.length,
      },
    });
  }

  private beginDhcpv6(
    messageType: typeof Dhcpv6MessageType.Solicit
      | typeof Dhcpv6MessageType.Renew
      | typeof Dhcpv6MessageType.InformationRequest,
    serverId?: string,
    requestedAddress?: Ipv6,
  ): void {
    this.dhcpv6TransactionId = this.engine.rng.nextU32() & 0xffffff;
    this.dhcpv6State = messageType === Dhcpv6MessageType.Solicit ? "soliciting" : "requesting";
    this.sendDhcpv6(messageType, serverId, requestedAddress);
    const transaction = this.dhcpv6TransactionId;
    this.engine.scheduleIn(DEFAULT_DHCPV6_TIMEOUT_NS, () => {
      if (transaction !== this.dhcpv6TransactionId || this.dhcpv6State === "bound") return;
      this.dhcpv6State = "failed";
      this.ipv6Problems.push("No DHCPv6 Advertise or Reply received.");
    });
  }

  private sendDhcpv6(messageType: Dhcpv6MessageType, serverId?: string, requestedAddress?: Ipv6): void {
    const source = this.ipv6Addresses.sourceFor("fe80::1");
    if (!source) return;
    const message: Dhcpv6Message = {
      kind: "dhcpv6",
      messageType,
      transactionId: this.dhcpv6TransactionId,
      clientId: `duid-ll-${normalizeMac(this.primary.mac)}`,
      serverId,
      requestedAddress,
    };
    const destination = serverId && this.ipv6DefaultRouter ? this.ipv6DefaultRouter : IPV6_ALL_DHCP_SERVERS;
    this.sendIpv6({
      kind: "ipv6",
      src: source,
      dst: destination,
      nextHeader: Ipv6NextHeader.UDP,
      hopLimit: 1,
      payload: {
        kind: "udp",
        srcPort: DHCPV6_CLIENT_PORT,
        dstPort: DHCPV6_SERVER_PORT,
        payload: message,
      },
    });
    this.engine.trace({
      time: this.engine.now(),
      type: `dhcpv6-${messageType}`,
      device: this.id,
      detail: { transactionId: message.transactionId, requestedAddress },
    });
  }

  private handleDhcpv6(message: Dhcpv6Message): void {
    if (message.transactionId !== this.dhcpv6TransactionId) return;
    if (message.messageType === Dhcpv6MessageType.Advertise && this.dhcpv6State === "soliciting") {
      this.dhcpv6State = "requesting";
      this.sendDhcpv6(Dhcpv6MessageType.Request, message.serverId, message.address);
      return;
    }
    if (message.messageType !== Dhcpv6MessageType.Reply) return;
    if (message.dnsServers?.[0]) this.ipv6DnsServer = normalizeIpv6(message.dnsServers[0]);
    if (message.address && message.serverId) {
      const address = normalizeIpv6(message.address);
      this.transport.reset();
      this.applications.resetRuntime();
      for (const assignment of this.ipv6Addresses.summaries()) {
        if (assignment.source === "dhcpv6") this.ipv6Addresses.remove(assignment.address);
      }
      const preferredLifetimeNs = message.preferredLifetimeNs ?? 3_600_000_000_000;
      const validLifetimeNs = message.validLifetimeNs ?? 7_200_000_000_000;
      this.ipv6Addresses.add({
        address,
        prefixLength: message.prefixLength ?? 128,
        source: "dhcpv6",
        state: "tentative",
        preferredUntilNs: this.engine.now() + preferredLifetimeNs,
        validUntilNs: this.engine.now() + validLifetimeNs,
      });
      this.dhcpv6Lease = {
        address,
        prefixLength: message.prefixLength ?? 128,
        serverId: message.serverId,
        preferredLifetimeNs,
        validLifetimeNs,
        dnsServers: message.dnsServers?.map(normalizeIpv6) ?? [],
      };
      this.ipv6Discovery().beginDad(address);
    }
    this.dhcpv6State = "bound";
    this.engine.trace({
      time: this.engine.now(),
      type: "dhcpv6-bound",
      device: this.id,
      detail: { address: message.address, dnsServers: message.dnsServers ?? [] },
    });
  }

  private sendIpv6EchoReply(destination: Ipv6, source: Ipv6, request: Icmpv6Message): void {
    if (request.type !== Icmpv6Type.EchoRequest) return;
    this.engine.trace({
      time: this.engine.now(),
      type: "icmpv6-echo-reply",
      device: this.id,
      detail: { dst: destination, sequence: request.sequence },
    });
    this.sendIpv6({
      kind: "ipv6",
      src: source,
      dst: destination,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: DEFAULT_IPV6_HOP_LIMIT,
      payload: {
        kind: "icmpv6",
        type: Icmpv6Type.EchoReply,
        code: 0,
        identifier: request.identifier,
        sequence: request.sequence,
      },
    });
  }

  private completeIpv6Ping(sequence: number): void {
    const pending = this.pendingIpv6Pings.get(sequence);
    if (!pending) return;
    this.pendingIpv6Pings.delete(sequence);
    const rttNs = this.engine.now() - pending.sentAt;
    this.ipv6PingResults.push({ sequence, success: true, rttNs });
    this.engine.trace({
      time: this.engine.now(),
      type: "ipv6-ping-success",
      device: this.id,
      detail: { sequence, rttNs },
    });
  }

  private timeoutIpv6Ping(sequence: number): void {
    if (!this.pendingIpv6Pings.delete(sequence)) return;
    this.ipv6PingResults.push({ sequence, success: false });
  }

  // --- ARP ---------------------------------------------------------------

  private handleArp(arp: ArpPacket): void {
    // Learn the sender in all cases (standard host behaviour), then release any
    // packets that were waiting on this address.
    this.arpTable.set(arp.senderIp, normalizeMac(arp.senderMac));
    this.flushArpPending(arp.senderIp);

    if (arp.op === ArpOp.Request && this.ip !== undefined && arp.targetIp === this.ip) {
      const reply: ArpPacket = {
        kind: "arp",
        op: ArpOp.Reply,
        senderMac: this.primary.mac,
        senderIp: this.ip,
        targetMac: arp.senderMac,
        targetIp: arp.senderIp,
      };
      this.engine.trace({
        time: this.engine.now(),
        type: "arp-reply",
        device: this.id,
        detail: { targetIp: arp.senderIp },
      });
      this.primary.transmit({
        src: this.primary.mac,
        dst: arp.senderMac,
        etherType: EtherType.ARP,
        payload: reply,
      });
    }
  }

  private sendArpRequest(targetIp: Ipv4): void {
    if (this.ip === undefined) return;
    const arp: ArpPacket = {
      kind: "arp",
      op: ArpOp.Request,
      senderMac: this.primary.mac,
      senderIp: this.ip,
      targetMac: ZERO_MAC,
      targetIp,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: "arp-request",
      device: this.id,
      detail: { targetIp },
    });
    this.primary.transmit({
      src: this.primary.mac,
      dst: BROADCAST_MAC,
      etherType: EtherType.ARP,
      payload: arp,
    });
  }

  private flushArpPending(ip: Ipv4): void {
    const mac = this.arpTable.get(ip);
    const queued = this.arpPending.get(ip);
    if (!mac || !queued) return;
    this.arpPending.delete(ip);
    for (const packet of queued) this.transmitIpv4(packet, mac);
  }

  // --- IPv4 / ICMP -------------------------------------------------------

  private nextHop(dst: Ipv4): Ipv4 | undefined {
    if (this.ip === undefined) return undefined;
    if (ipsShareNetwork(dst, this.ip, this.maskInt)) return dst;
    return this.gateway; // may be undefined -> unreachable
  }

  private sendIpv4(packet: Ipv4Packet): void {
    const hop = this.nextHop(packet.dst);
    if (hop === undefined) return; // no route: the ping simply times out
    const mac = this.arpTable.get(hop);
    if (mac !== undefined) {
      this.transmitIpv4(packet, mac);
      return;
    }
    const queued = this.arpPending.get(hop);
    if (queued) {
      queued.push(packet);
    } else {
      this.arpPending.set(hop, [packet]);
      this.sendArpRequest(hop);
    }
  }

  private transmitIpv4(packet: Ipv4Packet, dstMac: Mac): void {
    const frame: EthernetFrame = {
      src: this.primary.mac,
      dst: dstMac,
      etherType: EtherType.IPv4,
      payload: packet,
    };
    this.primary.transmit(frame);
  }

  private handleIpv4(packet: Ipv4Packet, frame: EthernetFrame): void {
    // DHCP replies are broadcast and arrive before we have an address, so they
    // are handled before the "addressed to me" check that gates unicast traffic.
    if (packet.protocol === IpProtocol.UDP && packet.payload.kind === "udp") {
      const broadcast = packet.dst === BROADCAST_IP;
      if (!broadcast && packet.dst !== this.ip) return;
      if (!broadcast) this.arpTable.set(packet.src, normalizeMac(frame.src));
      this.transport.receiveUdp(packet.src, packet.dst, packet.payload, broadcast);
      return;
    }

    if (packet.dst !== this.ip) return; // PCs do not route
    // Opportunistically cache the L2 address of the L3 source.
    this.arpTable.set(packet.src, normalizeMac(frame.src));

    if (packet.protocol === IpProtocol.TCP && packet.payload.kind === "tcp") {
      this.transport.receiveTcp(packet.src, packet.dst, packet.payload);
      return;
    }
    if (packet.protocol !== IpProtocol.ICMP || packet.payload.kind !== "icmp") return;
    const icmp = packet.payload;
    if (icmp.type === IcmpType.EchoRequest) {
      this.sendEchoReply(packet.src, icmp);
    } else if (icmp.type === IcmpType.EchoReply) {
      this.completePing(icmp.sequence);
    }
  }

  // --- DHCP client -------------------------------------------------------

  /** Begin DHCP address acquisition (the DORA exchange). */
  requestDhcp(): void {
    if (!this.dhcpEnabled) this.setDhcpEnabled(true);
    else {
      this.resetNetworkRuntime();
      this.dhcpEnabled = true;
      this.ip = undefined;
      this.gateway = undefined;
      this.onNetworkConfigurationChanged();
    }
    this.dhcpXid = this.engine.rng.nextU32();
    this.dhcpState = "discovering";
    this.dhcpBound = false;
    this.transport.udp.unbind(DHCP_CLIENT_PORT);
    this.transport.udp.bind(DHCP_CLIENT_PORT, (datagram) => this.handleDhcp(datagram.payload), "dhcp-client");
    this.engine.trace({
      time: this.engine.now(),
      type: "dhcp-discover",
      device: this.id,
      detail: { xid: this.dhcpXid },
    });
    this.sendDhcp({ messageType: DhcpMessageType.Discover });
    this.engine.scheduleIn(DEFAULT_DHCP_TIMEOUT_NS, () => this.dhcpTimeout(this.dhcpXid));
  }

  /** Release a transient lease while keeping DHCP as the persisted mode. */
  releaseDhcp(): void {
    this.resetNetworkRuntime();
    this.dhcpEnabled = true;
    this.ip = undefined;
    this.gateway = undefined;
    this.onNetworkConfigurationChanged();
  }

  /** Runtime state that must never survive an address or DHCP mode change. */
  protected resetNetworkRuntime(): void {
    this.dhcpXid = (this.dhcpXid + 1) >>> 0;
    this.dhcpState = "idle";
    this.dhcpBound = false;
    this.lease = undefined;
    this.arpTable.clear();
    this.arpPending.clear();
    this.pendingPings.clear();
    this.pingResults.length = 0;
    this.transport.reset();
    this.applications.resetRuntime();
    this.ipv6NeighborRuntime?.reset();
    this.pendingIpv6Pings.clear();
    this.ipv6PingResults.length = 0;
    this.ipv6Problems.length = 0;
  }

  /** Server overrides this to recreate address-bound service listeners. */
  protected onNetworkConfigurationChanged(): void {}

  private handleDhcp(payload: UdpDatagram["payload"]): void {
    if (payload.kind !== "dhcp") return;
    const msg = payload;
    if (msg.transactionId !== this.dhcpXid) return;
    if (normalizeMac(msg.clientMac) !== normalizeMac(this.primary.mac)) return;

    if (msg.messageType === DhcpMessageType.Offer && this.dhcpState === "discovering") {
      this.dhcpState = "requesting";
      this.sendDhcp({
        messageType: DhcpMessageType.Request,
        requestedIp: msg.yourIp,
        serverIp: msg.serverIp,
      });
    } else if (msg.messageType === DhcpMessageType.Ack && this.dhcpState === "requesting") {
      this.bindLease(msg);
    } else if (msg.messageType === DhcpMessageType.Nak) {
      this.dhcpState = "failed";
    }
  }

  private bindLease(ack: DhcpMessage): void {
    if (ack.yourIp === undefined) return;
    this.ip = ack.yourIp;
    if (ack.subnetMask !== undefined) this.maskInt = maskToInt(ack.subnetMask);
    if (ack.gateway !== undefined) this.gateway = ack.gateway;
    this.dhcpBound = true;
    this.dhcpState = "bound";
    this.lease = {
      ip: ack.yourIp,
      mask: ack.subnetMask,
      gateway: ack.gateway,
      serverIp: ack.serverIp,
      leaseSeconds: ack.leaseSeconds,
    };
    this.transport.udp.unbind(DHCP_CLIENT_PORT);
    this.onNetworkConfigurationChanged();
    this.engine.trace({
      time: this.engine.now(),
      type: "dhcp-bound",
      device: this.id,
      detail: { ip: ack.yourIp, gateway: ack.gateway },
    });
  }

  private dhcpTimeout(xid: number): void {
    if (xid !== this.dhcpXid || this.dhcpBound) return;
    this.dhcpState = "failed";
    this.transport.udp.unbind(DHCP_CLIENT_PORT);
  }

  private sendDhcp(fields: Partial<DhcpMessage> & { messageType: DhcpMessage["messageType"] }): void {
    const dhcp: DhcpMessage = {
      kind: "dhcp",
      transactionId: this.dhcpXid,
      clientMac: this.primary.mac,
      ...fields,
    };
    this.sendUdp({
      destinationAddress: BROADCAST_IP,
      destinationPort: DHCP_SERVER_PORT,
      sourcePort: DHCP_CLIENT_PORT,
      sourceAddress: this.ip ?? UNSPECIFIED_IP,
      payload: dhcp,
    });
  }

  private sendTransportPacket(
    destinationAddress: IpAddress,
    protocol: typeof IpProtocol.UDP | typeof IpProtocol.TCP,
    payload: UdpDatagram | TcpSegment,
    sourceAddress?: IpAddress,
  ): void {
    if (ipFamilyOf(destinationAddress) === "ipv6") {
      const destination = normalizeIpv6(destinationAddress);
      const source = sourceAddress === undefined
        ? this.ipv6Addresses.sourceFor(destination)
        : normalizeIpv6(sourceAddress);
      if (!source) throw new Error(`PC ${this.id} has no usable IPv6 address`);
      this.sendIpv6({
        kind: "ipv6",
        src: source,
        dst: destination,
        nextHeader: protocol === IpProtocol.UDP ? Ipv6NextHeader.UDP : Ipv6NextHeader.TCP,
        hopLimit: DEFAULT_IPV6_HOP_LIMIT,
        payload,
      });
      return;
    }
    const packet: Ipv4Packet = {
      kind: "ipv4",
      src: sourceAddress ?? this.ip ?? UNSPECIFIED_IP,
      dst: destinationAddress,
      protocol,
      ttl: DEFAULT_IP_TTL,
      payload,
    };
    if (destinationAddress === BROADCAST_IP) {
      this.primary.transmit({
        src: this.primary.mac,
        dst: BROADCAST_MAC,
        etherType: EtherType.IPv4,
        payload: packet,
      });
      return;
    }
    this.sendIpv4(packet);
  }

  private sendPortUnreachable(destinationAddress: IpAddress, destinationPort: number): void {
    if (ipFamilyOf(destinationAddress) === "ipv6") {
      const destination = normalizeIpv6(destinationAddress);
      if (isIpv6Unspecified(destination)) return;
      const source = this.ipv6Addresses.sourceFor(destination);
      if (!source) return;
      this.engine.trace({
        time: this.engine.now(),
        type: "icmpv6-port-unreachable",
        device: this.id,
        detail: { destinationAddress: destination, destinationPort },
      });
      this.sendIpv6({
        kind: "ipv6",
        src: source,
        dst: destination,
        nextHeader: Ipv6NextHeader.ICMPv6,
        hopLimit: DEFAULT_IPV6_HOP_LIMIT,
        payload: {
          kind: "icmpv6",
          type: Icmpv6Type.DestinationUnreachable,
          code: 4,
          reason: "port-unreachable",
        },
      });
      return;
    }
    if (this.ip === undefined || destinationAddress === UNSPECIFIED_IP) return;
    this.engine.trace({
      time: this.engine.now(),
      type: "icmp-port-unreachable",
      device: this.id,
      detail: { destinationAddress, destinationPort },
    });
    this.sendIpv4({
      kind: "ipv4",
      src: this.ip,
      dst: destinationAddress,
      protocol: IpProtocol.ICMP,
      ttl: DEFAULT_IP_TTL,
      payload: {
        kind: "icmp",
        type: IcmpType.DestinationUnreachable,
        code: IcmpCode.PortUnreachable,
        identifier: 0,
        sequence: 0,
      },
    });
  }

  protected localTransportAddress(family: IpFamily, destination?: IpAddress): IpAddress | undefined {
    if (family === "ipv4") return this.ip;
    this.refreshIpv6Runtime();
    return this.ipv6Addresses.sourceFor(destination ? normalizeIpv6(destination) : "2001:db8::");
  }

  private refreshIpv6Runtime(): void {
    const now = this.engine.now();
    if (this.ipv6DefaultRouterUntilNs !== undefined && now >= this.ipv6DefaultRouterUntilNs) {
      this.ipv6DefaultRouter = undefined;
      this.ipv6DefaultRouterUntilNs = undefined;
    }
    for (const assignment of this.ipv6Addresses.summaries()) {
      if (assignment.source !== "slaac" && assignment.source !== "dhcpv6") continue;
      if (assignment.validUntilNs !== undefined && now >= assignment.validUntilNs) {
        this.ipv6Addresses.remove(assignment.address);
        if (this.dhcpv6Lease?.address === assignment.address) {
          this.dhcpv6Lease = undefined;
          this.dhcpv6State = "idle";
        }
        continue;
      }
      if (
        assignment.state === "preferred" &&
        assignment.preferredUntilNs !== undefined &&
        now >= assignment.preferredUntilNs
      ) {
        this.ipv6Addresses.setState(assignment.address, "deprecated");
      }
    }
  }

  private resetIpv6NetworkRuntime(): void {
    this.ipv6NeighborRuntime?.reset();
    this.pendingIpv6Pings.clear();
    this.dhcpv6TransactionId = (this.dhcpv6TransactionId + 1) & 0xffffff;
    this.transport.reset();
    this.applications.resetRuntime();
  }

  private sendEchoReply(dst: Ipv4, request: IcmpMessage): void {
    if (this.ip === undefined) return;
    const reply: IcmpMessage = {
      kind: "icmp",
      type: IcmpType.EchoReply,
      code: 0,
      identifier: request.identifier,
      sequence: request.sequence,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: "icmp-echo-reply",
      device: this.id,
      detail: { dst, sequence: request.sequence },
    });
    this.sendIpv4({
      kind: "ipv4",
      src: this.ip,
      dst,
      protocol: IpProtocol.ICMP,
      ttl: 64,
      payload: reply,
    });
  }

  private completePing(sequence: number): void {
    const pending = this.pendingPings.get(sequence);
    if (!pending) return; // unknown or already timed out
    this.pendingPings.delete(sequence);
    const rttNs = this.engine.now() - pending.sentAt;
    this.pingResults.push({ sequence, success: true, rttNs });
    this.engine.trace({
      time: this.engine.now(),
      type: "ping-success",
      device: this.id,
      detail: { sequence, rttNs },
    });
  }

  private timeoutPing(sequence: number): void {
    const pending = this.pendingPings.get(sequence);
    if (!pending) return; // already answered
    this.pendingPings.delete(sequence);
    this.pingResults.push({ sequence, success: false });
  }
}

/** Interactive client end host. */
export class Pc extends EndHost {
  readonly deviceType = "pc" as const;
}

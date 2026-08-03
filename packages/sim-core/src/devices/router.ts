import {
  ArpOp,
  DhcpMessageType,
  EtherType,
  IcmpCode,
  IcmpType,
  IpProtocol,
  type DeviceType,
} from "@sim/contracts";
import {
  DEFAULT_DHCP_LEASE_SECONDS,
  DEFAULT_IP_TTL,
  DEFAULT_IPV6_HOP_LIMIT,
  DEFAULT_PING_TIMEOUT_NS,
  DHCP_CLIENT_PORT,
  DHCPV6_CLIENT_PORT,
  DHCPV6_SERVER_PORT,
  DHCP_SERVER_PORT,
} from "../engine/constants";
import { EthernetInterface } from "../net/interface";
import { estimateIpPacketSizeBytes, estimatePacketWireSizeBytes } from "../net/packet-size";
import { Ipv6InterfaceState, type Ipv6AddressAssignment } from "../net/ipv6-interface";
import type { ArpPacket } from "../packets/arp";
import type { DhcpMessage } from "../packets/dhcp";
import type { Dhcpv6Message } from "../packets/dhcpv6";
import type { CdpPacket, DiscoveryCapability, LldpPacket } from "../packets/discovery";
import { type EthernetFrame, isControlPayload } from "../packets/ethernet";
import type { IcmpMessage } from "../packets/icmp";
import {
  Icmpv6Type,
  type Icmpv6Message,
  type RouterAdvertisementPrefix,
} from "../packets/icmpv6";
import { Ipv6NextHeader, type Ipv6Packet } from "../packets/ipv6";
import type { Ospfv3Packet } from "../packets/ospfv3";
import {
  OSPF_ALL_DESIGNATED_ROUTERS_MAC,
  OSPF_ALL_ROUTERS_MAC,
  OSPF_PROTOCOL,
  type OspfPacket,
} from "../packets/ospf";
import { discoveryCapabilitiesFor, discoveryPlatformFor, supportsCdp } from "../protocols/discovery-support";
import { NeighborDiscovery } from "../protocols/neighbor-discovery";
import { Dhcpv6Server, type Dhcpv6PoolConfig } from "../protocols/dhcpv6";
import {
  Ipv6NeighborDiscovery,
  type Ipv6NeighborEntry,
} from "../protocols/ipv6-neighbor-discovery";
import {
  OSPF_ADMINISTRATIVE_DISTANCE,
  OspfProcess,
  type OspfInterfaceDescriptor,
} from "../protocols/ospf";
import {
  Ospfv3Process,
  type Ospfv3InterfaceDescriptor,
} from "../protocols/ospfv3";
import { BgpProcess, type Vpnv4Route } from "../protocols/bgp";
import {
  LdpProcess,
  type LdpFecRoute,
  type LdpInterfaceDescriptor,
  type LdpPeerDescriptor,
} from "../protocols/ldp";
import type { Ipv4Packet } from "../packets/ipv4";
import type { MplsPacket } from "../packets/mpls";
import {
  MplsForwardingPlane,
  type MplsForwardingEntry,
} from "../mpls/label-forwarding";
import { ESP_OVERHEAD_BYTES } from "../packets/esp";
import type { GrePacket } from "../packets/gre";
import { IKE_PORT, type IkeMessage } from "../packets/ike";
import type { UdpDatagram } from "../packets/udp";
import type { TcpSegment } from "../packets/tcp";
import { HostTransportStack } from "../transport/host-transport";
import {
  IpsecEngine,
  type IkePeerConfiguration,
  type IkeSessionSummary,
  type IpsecProfileConfiguration,
  type IpsecProposalConfiguration,
  type IpsecSecurityAssociation,
} from "../vpn/ipsec";
import {
  GreTunnelEngine,
  TunnelInterface,
  compareTunnelNames,
  defaultTunnel,
  isTunnelInterface,
  parseTunnelName,
  tunnelName,
  type GreTunnelConfiguration,
  type TunnelOperationalState,
} from "../vpn/gre-tunnel";
import { VpnConfigurationError } from "../vpn/limits";
import { RemoteAccessState } from "../management/remote-access-state";
import { AaaState } from "../management/aaa-state";
import { ConsoleAccessState } from "../management/console-access-state";
import { emitLinkTrap, SnmpAgent } from "../management/snmp-agent";
import { deviceMibSource } from "../management/device-mib";
import type { SnmpInterfaceRow } from "../management/snmp-mib";
import { ipFamilyOf, type IpAddress, type IpFamily } from "../util/ip-address";
import {
  type AclBinding,
  type AclCounter,
  type AclDirection,
  type AclRuleBudget,
  type Ipv4Acl,
  type Ipv6Acl,
  PacketPolicyEngine,
  PacketPolicyError,
} from "../policy/packet-policy-engine";
import {
  QOS_CLASS_DEFAULT,
  QosPolicyEngine,
  dscpOf,
  type EgressClassProfile,
  type EgressQueueProfile,
  type QosClassCounter,
  type QosClassMap,
  type QosClassificationResult,
  type QosDirection,
  type QosEvaluationContext,
  type QosPolicyMap,
  type QosProblem,
  type QosServicePolicyBinding,
} from "../qos";
import {
  NatEngine,
  NatError,
  type NatInterfaceRole,
  type NatPool,
  type NatRule,
  type NatTranslation,
  type NatTranslationResult,
} from "../policy/nat-engine";
import {
  VrfRoutingTable,
  type ImportedVpnRoute,
  type VrfConfiguration,
  type VrfRoute,
} from "../routing/vrf";
import {
  BROADCAST_IP,
  intToIp,
  type Ipv4,
  ipToInt,
  maskToInt,
} from "../util/ipv4";
import {
  deterministicLinkLocalAddress,
  IPV6_ALL_NODES,
  ipv6InPrefix,
  ipv6Network,
  ipv6ToBigInt,
  isIpv6Multicast,
  normalizeIpv6,
  type Ipv6,
} from "../util/ipv6";
import {
  BROADCAST_MAC,
  CISCO_SHARED_MAC,
  isBroadcastMac,
  LLDP_MAC,
  type Mac,
  normalizeMac,
  ZERO_MAC,
} from "../util/mac";
import { Device } from "./device";

export interface L3Config {
  ip: Ipv4;
  /** Dotted mask ("255.255.255.0") or prefix length (24). */
  mask: Ipv4 | number;
}

/** A layer-3 interface: a physical port, or a dot1Q subinterface of one. */
export interface L3Interface {
  /** Logical name: "Gi0/0" for a routed port, "Gi0/0.10" for a subinterface. */
  readonly name: string;
  readonly physical: EthernetInterface;
  /** 802.1Q VLAN encapsulation for a subinterface; undefined = untagged port. */
  readonly vlan: number | undefined;
  /** `encapsulation dot1Q <vlan> native`: this subinterface carries the native
   * (untagged) VLAN, so its frames ingress/egress without a tag. */
  native: boolean;
  ip: Ipv4 | undefined;
  maskInt: number;
  readonly ipv6: Ipv6InterfaceState;
  /** Explicit routing context. Undefined always means global. */
  vrfId?: string;
}

export interface RouterAdvertisementConfig {
  readonly prefixes: readonly RouterAdvertisementPrefix[];
  readonly managed?: boolean;
  readonly otherConfiguration?: boolean;
  readonly routerLifetimeNs?: number;
  readonly dnsServers?: readonly Ipv6[];
}

export interface Ipv6RouterInterfaceRow {
  readonly name: string;
  readonly addresses: readonly Ipv6AddressAssignment[];
  readonly adminUp: boolean;
  readonly operUp: boolean;
}

/** A row of `show ip interface brief` / `show ip route`, for the CLI. */
export interface RouterInterfaceRow {
  name: string;
  ip: Ipv4 | undefined;
  maskInt: number;
  vlan: number | undefined;
  native: boolean;
  adminUp: boolean;
  operUp: boolean;
  description: string | undefined;
}

/** One row of `show interfaces tunnel`: configuration plus the derived verdict. */
export interface TunnelSummary {
  readonly name: string;
  readonly source: GreTunnelConfiguration["source"];
  /** Resolved outer source address; undefined when the source is unusable. */
  readonly sourceAddress: Ipv4 | undefined;
  readonly destinationAddress: Ipv4;
  readonly mode: "gre-ipv4";
  readonly mtu: number;
  readonly ttl: number;
  readonly adminUp: boolean;
  readonly operUp: boolean;
  /** Why the tunnel is down; undefined while it is operational. */
  readonly reason: TunnelOperationalState["reason"];
  readonly ipv4: { address: Ipv4; prefixLength: number } | undefined;
  readonly ipv6: ReadonlyArray<{ address: Ipv6; prefixLength: number }>;
  readonly ipsecProfileId: string | undefined;
  readonly protected: boolean;
}

/** Outer IPv4 header plus the GRE header a tunnel adds to every packet. */
const WIRE_SIZE_GRE_OVERHEAD_BYTES = 24;

export type RouteSource = "connected" | "static" | "ospf" | "bgp";

/** Cisco-like administrative distances for the sources this release models. */
export const ROUTE_ADMINISTRATIVE_DISTANCE: Readonly<Record<RouteSource, number>> = Object.freeze({
  connected: 0,
  static: 1,
  ospf: OSPF_ADMINISTRATIVE_DISTANCE,
  bgp: 20,
});

export interface RouteRow {
  kind: RouteSource;
  network: Ipv4;
  maskInt: number;
  /** Next-hop IP for a learned route; undefined for a connected route. */
  viaIp: Ipv4 | undefined;
  egressName: string;
  administrativeDistance: number;
  metric: number;
}

interface StaticRoute {
  network: number;
  maskInt: number;
  prefixLen: number;
  nextHop: Ipv4;
}

interface ResolvedRoute {
  egress: L3Interface;
  nextHopIp: Ipv4;
  metric: number;
  administrativeDistance: number;
}

export type Ipv6RouteSource = "connected" | "static" | "ospfv3";

export interface Ipv6RouteRow {
  readonly kind: Ipv6RouteSource;
  readonly network: Ipv6;
  readonly prefixLength: number;
  readonly viaIp: Ipv6 | undefined;
  readonly egressName: string;
  readonly administrativeDistance: number;
  readonly metric: number;
}

interface Ipv6StaticRoute {
  readonly network: Ipv6;
  readonly prefixLength: number;
  readonly nextHop: Ipv6;
}

interface ResolvedIpv6Route {
  readonly egress: L3Interface;
  readonly nextHopIp: Ipv6;
}

/** A logical interface with no cable; it is up whenever it is not shut down. */
class LoopbackInterface extends EthernetInterface {
  override get operationalUp(): boolean {
    return this.adminUp;
  }

  /** A loopback never puts a frame on a wire. */
  override transmit(): void {}
}

interface DhcpPool {
  id: string;
  network: number;
  maskInt: number;
  mask: Ipv4;
  gateway: Ipv4 | undefined;
  rangeStart: number;
  rangeEnd: number;
  leaseSeconds: number;
  /** clientMac -> assigned address. */
  readonly leases: Map<Mac, Ipv4>;
  /** Assigned address strings, for quick collision checks. */
  readonly assigned: Set<Ipv4>;
}

export interface DhcpPoolConfig {
  /** Stable document identifier; derived from the subnet when omitted. */
  id?: string;
  /** Any address inside the target subnet (masked to the network). */
  network: Ipv4;
  mask: Ipv4 | number;
  gateway?: Ipv4;
  rangeStart: Ipv4;
  rangeEnd: Ipv4;
  leaseSeconds?: number;
}

/**
 * A router: multiple layer-3 interfaces (routed ports and dot1Q subinterfaces
 * for router-on-a-stick), a routing table of connected + static routes resolved
 * by longest-prefix match, per-router ARP, and IPv4/ICMP forwarding with TTL
 * decrement and unreachable/time-exceeded replies. It can also host a DHCP
 * server that leases addresses from per-subnet pools.
 */
export class Router extends Device {
  readonly deviceType: DeviceType = "router";
  readonly packetPolicy = new PacketPolicyEngine();
  readonly nat = new NatEngine();
  /**
   * The one reusable QoS engine. Router, Firewall, L3 Switch and Wireless Router
   * all classify and mark through it; there is no second classifier.
   */
  readonly qos = new QosPolicyEngine();
  /** CDP/LLDP neighbour discovery; both start disabled until configured. */
  readonly discovery = new NeighborDiscovery(this, supportsCdp(this.deviceType));
  /** Deterministic OSPFv2 area-0 process; inert until `router ospf` runs. */
  readonly ospf = new OspfProcess(this);
  /** OSPFv3 is independent from the OSPFv2 process and advertises IPv6 prefixes only. */
  readonly ospfv3 = new Ospfv3Process(this);
  /** BGPv4 uses the shared routed management TCP stack on port 179. */
  readonly bgp = new BgpProcess(this);
  /** Structured MPLS LFIB. Only Router exposes this plane in M10.11. */
  readonly mpls = new MplsForwardingPlane();
  /** LDP discovers only directly attached, MPLS-enabled Router peers. */
  readonly ldp = new LdpProcess(this);
  /** Isolated customer IPv4 RIBs; MPLS remains Router-only. */
  readonly vrfs = new VrfRoutingTable();
  /**
   * Logical GRE tunnel configuration. It holds no packets and no peer state:
   * operational status is derived from the underlay routing table on demand.
   */
  readonly tunnels = new GreTunnelEngine();
  /**
   * IKEv2-like negotiation and the resulting security associations. This is a
   * deterministic educational model: it provides no real cryptographic
   * protection. See `docs/vpn-tunnels.md`.
   */
  readonly ipsec = new IpsecEngine();
  private readonly l3 = new Map<string, L3Interface>();
  private readonly loopbacks = new Map<number, LoopbackInterface>();
  private readonly tunnelInterfaces = new Map<string, TunnelInterface>();
  private readonly natRoles = new Map<string, NatInterfaceRole>();
  private readonly staticRoutes: StaticRoute[] = [];
  private readonly ipv6StaticRoutes: Ipv6StaticRoute[] = [];
  private readonly dhcpPools: DhcpPool[] = [];
  readonly dhcpv6 = new Dhcpv6Server(`duid-router-${this.id}`);
  private readonly ipv6DiscoveryByInterface = new Map<string, Ipv6NeighborDiscovery>();
  private readonly routerAdvertisements = new Map<string, RouterAdvertisementConfig>();
  private forwardingEnabled = true;
  private ipv6ForwardingEnabled = false;
  readonly pingResults: Array<{ sequence: number; success: boolean; rttNs?: number }> = [];
  private readonly pendingPings = new Map<number, number>();
  readonly ipv6PingResults: Array<{ sequence: number; success: boolean; rttNs?: number }> = [];
  readonly ipv6Problems: string[] = [];
  private readonly pendingIpv6Pings = new Map<number, number>();

  readonly arpTable = new Map<Ipv4, Mac>();
  /** IPv4 packets awaiting ARP resolution, keyed by next-hop IP. */
  private readonly arpPending = new Map<Ipv4, Array<{
    payload: Ipv4Packet | MplsPacket;
    etherType: EtherType;
    egress: L3Interface;
  }>>();

  /**
   * Management-plane sockets. A network device is not a general-purpose server:
   * this stack exists so management services (remote CLI, AAA clients, an SNMP
   * agent) terminate on the device's own addresses through the same simulated
   * UDP/TCP path as any other traffic. It never forwards and never turns the
   * device into a DNS/HTTP/TFTP host.
   */
  /** Persistent Telnet/SSH/VTY configuration; behaviour lives in the service. */
  readonly remoteAccess = new RemoteAccessState(this.id);
  /** Persistent AAA method lists and servers; the decision layer is separate. */
  readonly aaa = new AaaState();
  /** The one shared local-user database: console, VTY, Telnet, SSH and AAA. */
  readonly consoleAccess = new ConsoleAccessState();
  /** SNMPv2c agent over the management transport; disabled until configured. */
  readonly snmp: SnmpAgent = new SnmpAgent({
    deviceId: this.id,
    engine: () => this.engine,
    transport: () => this.management,
    mib: () => deviceMibSource(this, this.snmp),
  });

  readonly management: HostTransportStack = new HostTransportStack({
    deviceId: this.id,
    engine: () => this.engine,
    localAddress: (family, destination) => this.managementSourceAddress(family, destination),
    portUnreachable: () => undefined,
    sendUdpPacket: (destination, datagram, source) => this.sendManagement(destination, datagram, source),
    sendTcpPacket: (destination, segment, source) => this.sendManagement(destination, segment, source),
  });

  // --- configuration -----------------------------------------------------

  override onAddedToEngine(): void {
    this.packetPolicy.useRuleBudget(this.engine.aclRuleBudget);
    this.qos.useOperationBudget(this.engine.qosBudget);
    this.tunnels.useTunnelBudget(this.engine.vpnTunnelBudget);
    // The tunnel engine never reaches into the router: it asks these four
    // questions and decides operational state from the answers alone.
    this.tunnels.useHooks({
      interfaceAddress: (name) => {
        const iface = this.l3.get(name);
        return iface?.ip !== undefined && iface.physical.operationalUp ? iface.ip : undefined;
      },
      ownsAddress: (address) => [...this.l3.values()].some((iface) =>
        iface.ip === address && iface.physical.operationalUp),
      // Deliberately state-blind: a route that egresses a tunnel must stay
      // *visible* here so recursion is reported rather than silently ignored.
      underlayEgress: (destination) => this.resolve(destination, true)?.egress.name,
      isTunnelInterface: (name) => isTunnelInterface(this.l3.get(name)?.physical),
      protectionReady: (tunnel) => this.tunnelProtectionReady(tunnel),
    });
    this.ipsec.useHooks({
      nowNs: () => this.engine.now(),
      scheduleIn: (delayNs, run) => this.engine.scheduleIn(delayNs, run),
      trace: (type, detail) => this.traceTunnel(type, detail),
      localAddressFor: (peerId) => this.tunnelSourceForPeer(peerId),
      // IKE travels the ordinary underlay path, so an ACL or a firewall policy
      // can block it exactly like real UDP 500 traffic.
      sendIke: (localAddress, remoteAddress, message) =>
        this.sendIke(localAddress, remoteAddress, message),
      peerReachable: (remoteAddress) => this.resolve(remoteAddress, true) !== undefined,
      tunnelForPeer: (peerId) => this.tunnelIdForPeer(peerId),
    });
    this.bgp.start();
    this.ldp.arm();
  }

  // --- site-to-site IPsec -------------------------------------------------

  /**
   * The tunnel whose IPsec profile binds this IKE peer. Exactly one profile per
   * tunnel, so this is unambiguous.
   */
  private tunnelIdForPeer(peerId: string): string | undefined {
    for (const tunnel of this.tunnelConfigurations()) {
      if (tunnel.ipsecProfileId === undefined) continue;
      if (this.ipsec.profile(tunnel.ipsecProfileId)?.ikePeerId === peerId) return tunnel.id;
    }
    return undefined;
  }

  /** The outer source address the protected tunnel negotiates and sends from. */
  private tunnelSourceForPeer(peerId: string): Ipv4 | undefined {
    const tunnelId = this.tunnelIdForPeer(peerId);
    return tunnelId === undefined ? undefined : this.tunnels.sourceAddress(tunnelId);
  }

  /** Originate one IKE message over UDP 500 through the ordinary routed path. */
  private sendIke(localAddress: Ipv4, remoteAddress: Ipv4, message: IkeMessage): void {
    this.originate({
      kind: "ipv4",
      src: localAddress,
      dst: remoteAddress,
      protocol: IpProtocol.UDP,
      ttl: DEFAULT_IP_TTL,
      payload: { kind: "udp", srcPort: IKE_PORT, dstPort: IKE_PORT, payload: message },
    });
  }

  /** `show crypto ikev2 sa` / `show crypto session`: runtime only, never persisted. */
  ikeSessionSummaries(): IkeSessionSummary[] {
    return this.ipsec.sessionSummaries();
  }

  /** `show crypto ipsec sa`: runtime only, never persisted. */
  ipsecSecurityAssociations(): IpsecSecurityAssociation[] {
    return this.ipsec.securityAssociations();
  }

  defineIkePeer(peer: IkePeerConfiguration): void {
    this.ipsec.definePeer(peer);
  }

  defineIpsecProposal(proposal: IpsecProposalConfiguration): void {
    this.ipsec.defineProposal(proposal);
  }

  defineIpsecProfile(profile: IpsecProfileConfiguration): void {
    this.ipsec.defineProfile(profile);
  }

  ikePeerConfigurations(): IkePeerConfiguration[] {
    return this.ipsec.peerConfigurations();
  }

  ipsecProposalConfigurations(): IpsecProposalConfiguration[] {
    return this.ipsec.proposalConfigurations();
  }

  ipsecProfileConfigurations(): IpsecProfileConfiguration[] {
    return this.ipsec.profileConfigurations();
  }

  /**
   * Apply everything virtual time has made due — a rekey that has come round,
   * an SA that has outlived its lifetime. IPsec keeps no periodic timer, so the
   * runtime calls this after advancing the clock; every protected packet and
   * every VPN inspection calls it implicitly.
   */
  checkVpnLifetimes(): void {
    this.ipsec.checkLifetimes();
  }

  /** Discard every negotiated session and SA; configuration is untouched. */
  resetVpnRuntime(): void {
    this.ipsec.resetRuntime();
    this.ipsec.arm();
  }

  // --- GRE tunnel interfaces ---------------------------------------------

  /**
   * `interface Tunnel<n>`: a logical interface with no cable. It has an
   * administrative state and overlay addresses, produces connected overlay
   * routes and can run OSPF — but it never appears in the connection modal and
   * never anchors a canvas edge.
   */
  getOrCreateTunnel(index: number): L3Interface {
    if (!this.supportsTunnels()) {
      throw new VpnConfigurationError(
        "VPN_UNSUPPORTED_DEVICE",
        `Device type '${this.deviceType}' does not support GRE tunnel interfaces.`,
      );
    }
    if (!Number.isInteger(index) || index < 0 || index > 2_147_483_647) {
      throw new VpnConfigurationError("VPN_INVALID_CONFIGURATION", `Invalid tunnel number ${index}.`);
    }
    const name = tunnelName(index);
    const existing = this.l3.get(name);
    if (existing) return existing;
    if (!this.tunnels.has(name)) this.tunnels.define(defaultTunnel(name));
    const physical = new TunnelInterface(
      this,
      name,
      this.logicalMac(name),
      () => this.tunnels.evaluate(name),
    );
    this.tunnelInterfaces.set(name, physical);
    const iface: L3Interface = {
      name,
      physical,
      vlan: undefined,
      native: false,
      ip: undefined,
      maskInt: maskToInt(30),
      ipv6: new Ipv6InterfaceState(),
    };
    this.l3.set(name, iface);
    this.ospf.arm();
    return iface;
  }

  /** True for the device kinds whose routing plane can terminate a GRE tunnel. */
  supportsTunnels(): boolean {
    return this.hasCapability("vpn-tunnel");
  }

  isTunnel(name: string): boolean {
    return isTunnelInterface(this.l3.get(name)?.physical);
  }

  tunnelNumbers(): number[] {
    return [...this.tunnelInterfaces.keys()]
      .map((name) => parseTunnelName(name) ?? 0)
      .sort((a, b) => a - b);
  }

  removeTunnel(index: number): void {
    const name = tunnelName(index);
    this.l3.delete(name);
    this.tunnelInterfaces.delete(name);
    this.ipv6DiscoveryByInterface.delete(name);
    this.tunnels.remove(name);
    this.packetPolicy.unbind(name, "in");
    this.packetPolicy.unbind(name, "out");
    this.ospf.arm();
  }

  /**
   * Apply one tunnel configuration change. Overlay addressing is mirrored onto
   * the L3 interface so connected routes, OSPF and ACLs treat a tunnel exactly
   * like any other routed interface.
   */
  configureTunnel(
    index: number,
    patch: Partial<Omit<GreTunnelConfiguration, "id">>,
  ): GreTunnelConfiguration {
    const iface = this.getOrCreateTunnel(index);
    const updated = this.tunnels.update(iface.name, patch);
    const primary = updated.ipv4Addresses[0];
    if (primary) {
      iface.ip = primary.address;
      iface.maskInt = maskToInt(primary.prefixLength);
    } else if (patch.ipv4Addresses !== undefined) {
      iface.ip = undefined;
    }
    for (const address of updated.ipv6Addresses) {
      this.setInterfaceIpv6(iface.name, address.address, address.prefixLength);
    }
    if (updated.adminUp) iface.physical.noShutdown();
    else iface.physical.shutdown();
    this.ospf.arm();
    return updated;
  }

  /**
   * Tunnel configuration in canonical order, without any runtime state.
   *
   * Overlay addressing is read back from the L3 interface rather than from a
   * second copy inside the tunnel engine, so `ip address` / `ipv6 address`
   * typed on a Tunnel interface and `configureTunnel` can never disagree.
   */
  tunnelConfigurations(): GreTunnelConfiguration[] {
    return this.tunnels.configurations()
      .filter((tunnel) => this.l3.has(tunnel.id))
      .map((tunnel) => {
        const iface = this.l3.get(tunnel.id)!;
        return {
          ...tunnel,
          adminUp: iface.physical.adminUp,
          ipv4Addresses: iface.ip === undefined
            ? []
            : [{ address: iface.ip, prefixLength: popcount(iface.maskInt) }],
          ipv6Addresses: iface.ipv6.summaries()
            .filter((entry) => entry.source === "static")
            .map((entry) => ({ address: entry.address, prefixLength: entry.prefixLength })),
        };
      });
  }

  /** `show interfaces tunnel`: configuration plus the derived operational verdict. */
  tunnelSummaries(): TunnelSummary[] {
    return this.tunnelConfigurations()
      .sort((left, right) => compareTunnelNames(left.id, right.id))
      .map((tunnel) => {
        const iface = this.l3.get(tunnel.id)!;
        const state = this.tunnels.evaluate(tunnel.id);
        return {
          name: tunnel.id,
          source: tunnel.source,
          sourceAddress: state.sourceAddress,
          destinationAddress: tunnel.destinationAddress,
          mode: tunnel.mode,
          mtu: tunnel.mtu,
          ttl: tunnel.ttl,
          adminUp: iface.physical.adminUp,
          operUp: iface.physical.operationalUp,
          reason: iface.physical.adminUp ? state.reason : "administratively-down",
          ipv4: iface.ip === undefined ? undefined : { address: iface.ip, prefixLength: popcount(iface.maskInt) },
          ipv6: iface.ipv6.summaries()
            .filter((entry) => entry.source === "static")
            .map((entry) => ({ address: entry.address, prefixLength: entry.prefixLength })),
          ipsecProfileId: tunnel.ipsecProfileId,
          protected: tunnel.ipsecProfileId !== undefined,
        };
      });
  }

  /**
   * A protected tunnel only carries traffic while its peer has an active
   * outbound SA. Negotiation is re-armed here, so the first packet after a
   * failure deterministically triggers a fresh attempt.
   */
  protected tunnelProtectionReady(tunnel: GreTunnelConfiguration): boolean {
    const profileId = tunnel.ipsecProfileId;
    if (profileId === undefined) return true;
    const profile = this.ipsec.profile(profileId);
    if (!profile) return false;
    if (this.ipsec.hasActiveProtection(profile.ikePeerId)) return true;
    this.ipsec.arm();
    return false;
  }

  /**
   * Hand a routed packet to a tunnel: encapsulate it in GRE, then send the outer
   * packet through the ordinary underlay path so it is filtered, translated,
   * classified and queued exactly like any other IPv4 packet.
   */
  private sendThroughTunnel(egress: L3Interface, packet: Ipv4Packet | Ipv6Packet): void {
    const tunnel = this.tunnels.get(egress.name);
    if (!tunnel) return;
    const state: TunnelOperationalState = (egress.physical as TunnelInterface).state;
    if (!state.up || state.sourceAddress === undefined) {
      this.traceTunnel("gre-tunnel-down", {
        tunnel: egress.name,
        reason: state.reason ?? "administratively-down",
        destination: packet.dst,
      });
      return;
    }
    this.traceTunnel("gre-encapsulation-started", {
      tunnel: egress.name,
      source: state.sourceAddress,
      destination: tunnel.destinationAddress,
      innerProtocol: packet.kind,
      innerSource: packet.src,
      innerDestination: packet.dst,
    });
    const inner = estimateIpPacketSizeBytes(packet);
    const encapsulated = inner + WIRE_SIZE_GRE_OVERHEAD_BYTES + this.tunnelOverheadBytes(tunnel);
    if (encapsulated > tunnel.mtu) {
      this.traceTunnel("gre-mtu-exceeded", {
        tunnel: egress.name,
        mtu: tunnel.mtu,
        bytes: encapsulated,
        innerBytes: inner,
      });
      this.reportTunnelTooBig(packet, tunnel.mtu - WIRE_SIZE_GRE_OVERHEAD_BYTES - this.tunnelOverheadBytes(tunnel));
      return;
    }
    const gre: GrePacket = {
      kind: "gre",
      protocol: packet.kind === "ipv4" ? "ipv4" : "ipv6",
      innerPacket: packet,
      tunnelId: tunnel.id,
    };
    const outer = this.buildTunnelOuterPacket(tunnel, state.sourceAddress, gre);
    if (!outer) return;
    const route = this.resolve(outer.dst);
    if (!route) {
      this.traceTunnel("gre-tunnel-down", {
        tunnel: egress.name,
        reason: "destination-unreachable",
        destination: outer.dst,
      });
      return;
    }
    if (this.isTunnel(route.egress.name)) {
      this.traceTunnel("gre-recursive-route-rejected", {
        tunnel: egress.name,
        via: route.egress.name,
        destination: outer.dst,
      });
      return;
    }
    this.traceTunnel("gre-packet-sent", {
      tunnel: egress.name,
      source: outer.src,
      destination: outer.dst,
      protocol: outer.protocol,
      bytes: encapsulated,
      egress: route.egress.name,
    });
    this.egressSend(outer, route.egress, route.nextHopIp);
  }

  /**
   * The outer underlay packet a tunnel emits. Plain GRE is sent as protocol 47;
   * a protected tunnel wraps the same GRE payload in a simulated ESP envelope
   * first, which is why the outbound pipeline order is fixed as
   * GRE encapsulation → IPsec protection → outer underlay routing.
   */
  protected buildTunnelOuterPacket(
    tunnel: GreTunnelConfiguration,
    sourceAddress: Ipv4,
    gre: GrePacket,
  ): Ipv4Packet | undefined {
    const profileId = tunnel.ipsecProfileId;
    if (profileId === undefined) {
      return {
        kind: "ipv4",
        src: sourceAddress,
        dst: tunnel.destinationAddress,
        protocol: IpProtocol.GRE,
        ttl: tunnel.ttl,
        payload: gre,
      };
    }
    const profile = this.ipsec.profile(profileId);
    const esp = profile
      ? this.ipsec.protect(profile.ikePeerId, gre, estimateIpPacketSizeBytes(gre.innerPacket))
      : undefined;
    if (!esp) {
      // A tunnel that requires protection never falls back to sending in the
      // clear; it drops and re-arms the negotiation instead.
      this.traceTunnel("gre-tunnel-down", { tunnel: tunnel.id, reason: "protection-unavailable" });
      this.ipsec.arm();
      return undefined;
    }
    return {
      kind: "ipv4",
      src: sourceAddress,
      dst: tunnel.destinationAddress,
      protocol: IpProtocol.ESP,
      ttl: tunnel.ttl,
      payload: esp,
    };
  }

  /** Every protected packet also carries the simulated ESP envelope overhead. */
  protected tunnelOverheadBytes(tunnel: GreTunnelConfiguration): number {
    return tunnel.ipsecProfileId === undefined ? 0 : ESP_OVERHEAD_BYTES;
  }

  /**
   * A GRE packet arrived for one of our tunnel source addresses. Validate the
   * peer, then hand the inner packet to the overlay routing path with the
   * tunnel as its ingress interface, so overlay ACLs see it.
   */
  protected receiveGre(outer: Ipv4Packet, gre: GrePacket): void {
    const tunnel = this.tunnels.matchArrival(outer.src, outer.dst);
    if (!tunnel) {
      this.traceTunnel("gre-tunnel-down", {
        reason: "no-matching-tunnel",
        source: outer.src,
        destination: outer.dst,
      });
      return;
    }
    const iface = this.l3.get(tunnel.id);
    if (!iface || !iface.physical.operationalUp) {
      this.traceTunnel("gre-tunnel-down", {
        tunnel: tunnel.id,
        reason: iface ? (iface.physical as TunnelInterface).state.reason ?? "administratively-down" : "administratively-down",
        source: outer.src,
      });
      return;
    }
    this.traceTunnel("gre-packet-received", {
      tunnel: tunnel.id,
      source: outer.src,
      destination: outer.dst,
      innerProtocol: gre.protocol,
    });
    const inner = gre.innerPacket;
    if (gre.protocol === "ipv4" && inner.kind === "ipv4") {
      this.traceTunnel("gre-decapsulated", {
        tunnel: tunnel.id,
        innerProtocol: "ipv4",
        innerSource: inner.src,
        innerDestination: inner.dst,
      });
      this.receiveOverlayIpv4(inner, iface);
      return;
    }
    if (gre.protocol === "ipv6" && inner.kind === "ipv6") {
      this.traceTunnel("gre-decapsulated", {
        tunnel: tunnel.id,
        innerProtocol: "ipv6",
        innerSource: inner.src,
        innerDestination: inner.dst,
      });
      this.receiveOverlayIpv6(inner, iface);
      return;
    }
    this.traceTunnel("gre-tunnel-down", { tunnel: tunnel.id, reason: "unsupported-payload" });
  }

  /** A decapsulated IPv4 packet re-enters the ordinary routed path. */
  private receiveOverlayIpv4(packet: Ipv4Packet, ingress: L3Interface): void {
    // Overlay OSPF is this router's own control traffic, exactly as on a cabled
    // interface: it reaches the local process before the ACL pipeline.
    if (packet.protocol === OSPF_PROTOCOL && packet.payload.kind === "ospf") {
      this.ospf.onPacket(packet.payload, ingress.name, packet.src);
      return;
    }
    if (!this.permitByAcl(packet, ingress, "in")) return;
    if (this.isOwnIp(packet.dst)) {
      this.deliverLocal(packet);
      return;
    }
    this.forward(packet, ingress);
  }

  /** A decapsulated IPv6 packet re-enters the ordinary routed path. */
  private receiveOverlayIpv6(packet: Ipv6Packet, ingress: L3Interface): void {
    if (packet.nextHeader === Ipv6NextHeader.OSPF && packet.payload.kind === "ospfv3") {
      this.ospfv3.onPacket(packet.payload, ingress.name, packet.src);
      return;
    }
    if (!this.permitByIpv6Acl(packet, ingress, "in")) return;
    if (this.isOwnIpv6(packet.dst)) {
      this.deliverLocalIpv6(packet);
      return;
    }
    if (isIpv6Multicast(packet.dst)) return;
    this.forwardIpv6(packet, ingress);
  }

  /**
   * Tell the sender the packet was too big. Fragmentation is deliberately not
   * modelled, so the tunnel drops and reports rather than splitting the packet.
   */
  private reportTunnelTooBig(packet: Ipv4Packet | Ipv6Packet, mtu: number): void {
    if (packet.kind === "ipv6") {
      this.originateIpv6({
        kind: "ipv6",
        src: this.managementSourceAddress("ipv6", packet.src) ?? packet.dst,
        dst: packet.src,
        nextHeader: Ipv6NextHeader.ICMPv6,
        hopLimit: DEFAULT_IPV6_HOP_LIMIT,
        payload: { kind: "icmpv6", type: Icmpv6Type.PacketTooBig, code: 0, mtu, reason: "packet-too-big" },
      });
      return;
    }
    const source = this.managementSourceAddress("ipv4", packet.src);
    if (source === undefined) return;
    this.originate({
      kind: "ipv4",
      src: source,
      dst: packet.src,
      protocol: IpProtocol.ICMP,
      ttl: DEFAULT_IP_TTL,
      payload: {
        kind: "icmp",
        type: IcmpType.DestinationUnreachable,
        code: IcmpCode.FragmentationNeeded,
        identifier: 0,
        sequence: 0,
        nextHopMtu: mtu,
      },
    });
  }

  protected traceTunnel(type: string, detail: Record<string, unknown>): void {
    this.engine.trace({ time: this.engine.now(), type, device: this.id, detail });
  }

  // --- quality of service ------------------------------------------------

  defineQosClassMap(map: QosClassMap): void {
    this.qos.defineClassMap(map);
  }

  removeQosClassMap(id: string): void {
    this.qos.removeClassMap(id);
  }

  qosClassMapConfigurations(): QosClassMap[] {
    return this.qos.classMapConfigurations();
  }

  defineQosPolicyMap(map: QosPolicyMap): void {
    this.qos.definePolicyMap(map);
  }

  removeQosPolicyMap(id: string): void {
    this.qos.removePolicyMap(id);
    this.refreshEgressQueueProfiles();
  }

  qosPolicyMapConfigurations(): QosPolicyMap[] {
    return this.qos.policyMapConfigurations();
  }

  /** `service-policy input|output <policy-map>` on a routed interface or SVI. */
  applyServicePolicy(interfaceName: string, direction: QosDirection, policyMapId: string): void {
    if (!this.l3.has(interfaceName)) {
      throw new PacketPolicyError(
        "ACL_INVALID_CONFIGURATION",
        `Router ${this.id} has no L3 interface ${interfaceName}.`,
      );
    }
    this.qos.attach({ interfaceName, direction, policyMapId });
    this.refreshEgressQueueProfiles();
  }

  removeServicePolicy(interfaceName: string, direction: QosDirection): void {
    this.qos.detach(interfaceName, direction);
    this.refreshEgressQueueProfiles();
  }

  qosServicePolicies(): QosServicePolicyBinding[] {
    return this.qos.bindingConfigurations();
  }

  qosCounters(): QosClassCounter[] {
    return this.qos.counterSummaries();
  }

  resetQosRuntime(): void {
    this.qos.resetCounters();
  }

  qosProblems(): QosProblem[] {
    return this.qos.problems();
  }

  /** Re-install queue structure once the topology's cables (and capacity) exist. */
  refreshEgressQueues(): void {
    this.refreshEgressQueueProfiles();
  }

  /**
   * Re-derive per-interface queue structure after a policy change.
   *
   * Queueing is a property of the physical port, so a policy map attached to a
   * routed port installs its queues there. A policy on a dot1Q subinterface
   * still classifies, marks and polices, but the port keeps one shared queue
   * set — an educational simplification documented in `docs/qos-simulation.md`.
   */
  protected refreshEgressQueueProfiles(): void {
    const byPhysical = new Map<string, EgressQueueProfile>();
    for (const iface of [...this.l3.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const policy = this.qos.policyFor(iface.name, "output");
      if (!policy) continue;
      if (byPhysical.has(iface.physical.name)) continue;
      byPhysical.set(iface.physical.name, egressProfileOf(policy, iface.name, iface.physical.link?.capacityBps ?? 0));
    }
    for (const physical of this.interfaces.values()) {
      physical.configureEgressProfile(byPhysical.get(physical.name));
    }
  }

  /** Used by composed routing planes, such as an L3 switch SVI data plane. */
  useAclRuleBudget(budget: AclRuleBudget): void {
    this.packetPolicy.useRuleBudget(budget);
  }

  defineAcl(acl: Ipv4Acl): void {
    this.packetPolicy.defineAcl(acl);
  }

  removeAcl(aclId: string): void {
    this.packetPolicy.removeAcl(aclId);
  }

  applyAcl(interfaceName: string, direction: AclDirection, aclId: string): void {
    if (!this.l3.has(interfaceName)) {
      throw new PacketPolicyError(
        "ACL_INVALID_CONFIGURATION",
        `Router ${this.id} has no L3 interface ${interfaceName}.`,
      );
    }
    this.packetPolicy.bind({ interfaceName, direction, aclId });
  }

  removeAclBinding(interfaceName: string, direction: AclDirection): void {
    this.packetPolicy.unbind(interfaceName, direction);
  }

  aclConfigurations(): Ipv4Acl[] {
    return this.packetPolicy.aclConfigurations();
  }

  aclBindings(): AclBinding[] {
    return this.packetPolicy.bindingConfigurations();
  }

  aclCounters(): AclCounter[] {
    return this.packetPolicy.counterSummaries();
  }

  resetAclCounters(): void {
    this.packetPolicy.resetCounters();
  }

  defineIpv6Acl(acl: Ipv6Acl): void {
    this.packetPolicy.defineIpv6Acl(acl);
  }

  removeIpv6Acl(aclId: string): void {
    this.packetPolicy.removeIpv6Acl(aclId);
  }

  applyIpv6Acl(interfaceName: string, direction: AclDirection, aclId: string): void {
    if (!this.l3.has(interfaceName)) {
      throw new PacketPolicyError(
        "ACL_INVALID_CONFIGURATION",
        `Router ${this.id} has no L3 interface ${interfaceName}.`,
      );
    }
    this.packetPolicy.bindIpv6({ interfaceName, direction, aclId });
  }

  removeIpv6AclBinding(interfaceName: string, direction: AclDirection): void {
    this.packetPolicy.unbindIpv6(interfaceName, direction);
  }

  ipv6AclConfigurations(): Ipv6Acl[] {
    return this.packetPolicy.ipv6AclConfigurations();
  }

  ipv6AclBindings(): AclBinding[] {
    return this.packetPolicy.ipv6BindingConfigurations();
  }

  setNatRole(interfaceName: string, role: NatInterfaceRole | undefined): void {
    if (!this.l3.has(interfaceName)) {
      throw new NatError("NAT_ROLE_MISSING", `Router ${this.id} has no L3 interface ${interfaceName}.`);
    }
    if (role === undefined) this.natRoles.delete(interfaceName);
    else this.natRoles.set(interfaceName, role);
  }

  natRole(interfaceName: string): NatInterfaceRole | undefined {
    return this.natRoles.get(interfaceName);
  }

  defineNatPool(pool: NatPool): void {
    this.nat.definePool(pool);
  }

  removeNatPool(poolId: string): void {
    this.nat.removePool(poolId);
  }

  defineNatRule(rule: NatRule): void {
    this.nat.defineRule(rule);
  }

  removeNatRule(ruleId: string): void {
    this.nat.removeRule(ruleId);
  }

  natPoolConfigurations(): NatPool[] {
    return this.nat.poolConfigurations();
  }

  natRuleConfigurations(): NatRule[] {
    return this.nat.ruleConfigurations();
  }

  natTranslations(): NatTranslation[] {
    return this.nat.translationTable(this.engine.now());
  }

  resetNatRuntime(): void {
    this.nat.resetRuntime();
  }

  validateNatRoles(): void {
    if (!this.nat.hasRules()) return;
    const roles = new Set(this.natRoles.values());
    if (!roles.has("inside") || !roles.has("outside")) {
      throw new NatError("NAT_ROLE_MISSING", "NAT requires at least one inside and one outside L3 interface.");
    }
  }

  /** Assign an IP/mask directly to a physical port (a routed interface). */
  configureInterface(physicalName: string, config: L3Config): L3Interface {
    const iface = this.getOrCreateInterface(physicalName);
    iface.ip = config.ip;
    iface.maskInt = maskToInt(config.mask);
    return iface;
  }

  /** Add a dot1Q subinterface on `physicalName` for `vlan` (router-on-a-stick). */
  addSubinterface(physicalName: string, vlan: number, config: L3Config): L3Interface {
    const iface = this.getOrCreateSubinterface(physicalName, vlan);
    iface.ip = config.ip;
    iface.maskInt = maskToInt(config.mask);
    return iface;
  }

  /** `interface <name>`: ensure a routed L3 interface exists on the physical port. */
  getOrCreateInterface(physicalName: string): L3Interface {
    const existing = this.l3.get(physicalName);
    if (existing) return existing;
    const iface: L3Interface = {
      name: physicalName,
      physical: this.requirePhysical(physicalName),
      vlan: undefined,
      native: false,
      ip: undefined,
      maskInt: maskToInt(24),
      ipv6: new Ipv6InterfaceState(),
    };
    this.l3.set(iface.name, iface);
    return iface;
  }

  removeInterface(name: string): void {
    this.l3.delete(name);
    this.natRoles.delete(name);
    this.ipv6DiscoveryByInterface.delete(name);
    this.routerAdvertisements.delete(name);
  }

  setForwardingEnabled(enabled: boolean): void {
    this.forwardingEnabled = enabled;
  }

  get ipRoutingEnabled(): boolean {
    return this.forwardingEnabled;
  }

  /** `mpls ip` is valid only on a cabled physical Router interface. */
  setMplsEnabled(interfaceName: string, enabled: boolean): void {
    const iface = this.l3.get(interfaceName);
    if (!iface) throw new Error(`Router ${this.id} has no L3 interface ${interfaceName}`);
    if (iface.name !== iface.physical.name || isTunnelInterface(iface.physical) || this.isLoopback(interfaceName)) {
      throw new Error(`MPLS is supported only on physical Router interfaces (${interfaceName}).`);
    }
    if (enabled && iface.vrfId !== undefined) {
      throw new Error(`Customer-facing VRF interface ${interfaceName} cannot be an MPLS core interface.`);
    }
    this.mpls.setInterfaceEnabled(interfaceName, enabled);
    this.ldp.arm();
  }

  mplsInterfaceSummaries(): ReadonlyArray<{ interfaceId: string; enabled: boolean; operational: boolean }> {
    return this.mpls.enabledInterfaceIds().map((interfaceId) => ({
      interfaceId,
      enabled: true,
      operational: this.l3.get(interfaceId)?.physical.operationalUp ?? false,
    }));
  }

  installMplsForwardingEntry(entry: MplsForwardingEntry): void {
    if (entry.outgoingInterfaceId !== undefined && !this.mpls.interfaceEnabled(entry.outgoingInterfaceId)) {
      throw new Error(`MPLS is not enabled on interface ${entry.outgoingInterfaceId}.`);
    }
    this.mpls.install(entry);
  }

  configureLdpRouterId(interfaceName: string | undefined): void {
    this.ldp.configureRouterId(interfaceName);
  }

  defineVrf(configuration: VrfConfiguration): void {
    this.vrfs.define(configuration);
    this.rebuildVpnLabelBindings();
    this.bgp.refreshRoutes();
  }

  vrfConfigurations(): readonly VrfConfiguration[] {
    return this.vrfs.configurationsSnapshot();
  }

  vrfStaticRouteConfigurations(vrfId: string): readonly VrfRoute[] {
    return this.vrfs.staticRouteConfigurations(vrfId);
  }

  assignInterfaceVrf(interfaceName: string, vrfId: string | undefined): void {
    const iface = this.l3.get(interfaceName) ?? this.getOrCreateInterface(interfaceName);
    if (this.isLoopback(interfaceName) || isTunnelInterface(iface.physical)) {
      throw new Error(`Interface ${interfaceName} cannot be assigned to a customer VRF.`);
    }
    if (vrfId !== undefined && !this.vrfs.configuration(vrfId)) throw new Error(`Unknown VRF '${vrfId}'.`);
    if (vrfId !== undefined && this.mpls.interfaceEnabled(interfaceName)) {
      throw new Error(`MPLS core interface ${interfaceName} cannot be assigned to VRF ${vrfId}.`);
    }
    if (iface.ip !== undefined) {
      const duplicate = [...this.l3.values()].find((candidate) =>
        candidate !== iface && candidate.vrfId === vrfId && candidate.ip === iface.ip);
      if (duplicate) throw new Error(`Duplicate IPv4 address ${iface.ip} in ${vrfId ? `VRF ${vrfId}` : "global routing"}.`);
    }
    iface.vrfId = vrfId;
    this.ospf.arm();
    this.ldp.arm();
    this.bgp.refreshRoutes();
    this.bgp.onInterfaceStateChanged();
  }

  interfaceVrf(interfaceName: string): string | undefined {
    return this.l3.get(interfaceName)?.vrfId;
  }

  addVrfStaticRoute(vrfId: string, network: Ipv4, prefixLength: number, nextHop: Ipv4): void {
    // This is configuration validation, so the next hop only needs to belong
    // to a configured interface subnet. Link/admin operational state is a
    // runtime forwarding concern and links are attached after configuration
    // during LabDocument rebuild.
    if (!this.connectedVrfInterfaceFor(vrfId, nextHop, false)) {
      throw new Error(`VRF ${vrfId} next hop ${nextHop} is not reachable in the same VRF.`);
    }
    this.vrfs.addStaticRoute(vrfId, network, prefixLength, nextHop);
    this.bgp.refreshRoutes();
  }

  vrfRoutingTable(vrfId: string): readonly VrfRoute[] {
    return this.vrfs.routes(vrfId, this.connectedVrfRoutes(vrfId));
  }

  /** `encapsulation dot1Q <vlan> [native]`: ensure the subinterface exists. */
  getOrCreateSubinterface(physicalName: string, vlan: number, native = false): L3Interface {
    const name = `${physicalName}.${vlan}`;
    const existing = this.l3.get(name);
    if (existing) {
      existing.native = native;
      return existing;
    }
    const iface: L3Interface = {
      name,
      physical: this.requirePhysical(physicalName),
      vlan,
      native,
      ip: undefined,
      maskInt: maskToInt(24),
      ipv6: new Ipv6InterfaceState(),
    };
    this.l3.set(name, iface);
    return iface;
  }

  /** `ip address <ip> <mask>`: set the address on an existing L3 interface. */
  setInterfaceIp(name: string, ip: Ipv4, mask: Ipv4 | number): void {
    const iface = this.l3.get(name);
    if (!iface) throw new Error(`Router ${this.id} has no L3 interface ${name}`);
    const duplicate = [...this.l3.values()].find((candidate) =>
      candidate !== iface && candidate.vrfId === iface.vrfId && candidate.ip === ip);
    if (duplicate) throw new Error(`Duplicate IPv4 address ${ip} in ${iface.vrfId ? `VRF ${iface.vrfId}` : "global routing"}.`);
    iface.ip = ip;
    iface.maskInt = maskToInt(mask);
    this.ospf.arm();
    this.bgp.refreshRoutes();
    this.ldp.arm();
  }

  setIpv6ForwardingEnabled(enabled: boolean): void {
    this.ipv6ForwardingEnabled = enabled;
  }

  get ipv6UnicastRoutingEnabled(): boolean {
    return this.ipv6ForwardingEnabled;
  }

  /** `ipv6 enable`: create the deterministic link-local address and run DAD. */
  enableInterfaceIpv6(name: string): Ipv6 {
    const iface = this.l3.get(name);
    if (!iface) throw new Error(`Router ${this.id} has no L3 interface ${name}`);
    const address = deterministicLinkLocalAddress(iface.physical.mac);
    if (!iface.ipv6.get(address)) {
      iface.ipv6.add({ address, prefixLength: 64, source: "link-local", state: "tentative" });
      this.ipv6Discovery(iface).beginDad(address);
    }
    return address;
  }

  /** `ipv6 address <address>/<prefix>` on a physical, SVI, subinterface or loopback. */
  setInterfaceIpv6(name: string, addressInput: Ipv6, prefixLength: number): void {
    const iface = this.l3.get(name);
    if (!iface) throw new Error(`Router ${this.id} has no L3 interface ${name}`);
    this.enableInterfaceIpv6(name);
    const address = normalizeIpv6(addressInput);
    iface.ipv6.add({ address, prefixLength, source: "static", state: "tentative" });
    this.ipv6Discovery(iface).beginDad(address);
  }

  addIpv6StaticRoute(network: Ipv6, prefixLength: number, nextHop: Ipv6): void {
    this.ipv6StaticRoutes.push({
      network: ipv6Network(normalizeIpv6(network), prefixLength),
      prefixLength,
      nextHop: normalizeIpv6(nextHop),
    });
  }

  configureRouterAdvertisement(interfaceName: string, config: RouterAdvertisementConfig): void {
    const iface = this.l3.get(interfaceName);
    if (!iface) throw new Error(`Router ${this.id} has no L3 interface ${interfaceName}`);
    this.enableInterfaceIpv6(interfaceName);
    this.routerAdvertisements.set(interfaceName, {
      ...config,
      prefixes: config.prefixes.map((prefix) => ({
        ...prefix,
        prefix: ipv6Network(normalizeIpv6(prefix.prefix), prefix.prefixLength),
      })),
      dnsServers: config.dnsServers?.map(normalizeIpv6),
    });
  }

  addDhcpv6Pool(config: Dhcpv6PoolConfig): void {
    this.dhcpv6.addPool(config);
  }

  // --- loopback interfaces -----------------------------------------------

  /**
   * `interface Loopback<n>`: a logical interface with no cable. It has an
   * administrative state and an address, produces a connected route, takes part
   * in router-id selection, and can be advertised by OSPF — but it is never a
   * diagram connection point, so the canvas cable handle ignores it.
   */
  getOrCreateLoopback(index: number): L3Interface {
    if (!Number.isInteger(index) || index < 0 || index > 2_147_483_647) {
      throw new Error(`Invalid loopback number ${index}`);
    }
    const name = loopbackName(index);
    const existing = this.l3.get(name);
    if (existing) return existing;
    const loopback = new LoopbackInterface(this, name, this.logicalMac(name));
    this.loopbacks.set(index, loopback);
    const iface: L3Interface = {
      name,
      physical: loopback,
      vlan: undefined,
      native: false,
      ip: undefined,
      maskInt: maskToInt(32),
      ipv6: new Ipv6InterfaceState(),
    };
    this.l3.set(name, iface);
    this.ospf.arm();
    this.ldp.arm();
    return iface;
  }

  removeLoopback(index: number): void {
    const name = loopbackName(index);
    this.l3.delete(name);
    this.loopbacks.delete(index);
    this.ipv6DiscoveryByInterface.delete(name);
    this.routerAdvertisements.delete(name);
    this.ospf.arm();
    this.ldp.arm();
  }

  isLoopback(name: string): boolean {
    return this.l3.get(name)?.physical instanceof LoopbackInterface;
  }

  /** Loopback numbers currently configured, in numeric order. */
  loopbackNumbers(): number[] {
    return [...this.loopbacks.keys()].sort((a, b) => a - b);
  }

  /** Loopback rows only, for `show ip interface brief` and serialization. */
  loopbackSummaries(): RouterInterfaceRow[] {
    return this.interfaceSummaries().filter((row) => this.isLoopback(row.name));
  }

  loopbackInterface(index: number): EthernetInterface | undefined {
    return this.loopbacks.get(index);
  }

  /** Deterministic locally-administered MAC for a logical interface. */
  private logicalMac(name: string): Mac {
    let hash = 2_166_136_261;
    for (const char of `${this.id}:${name}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
    const octets = [0x02, 0x4c, (hash >>> 24) & 0xff, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff];
    return octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
  }

  /** Add a static route: `ip route <network> <mask> <nextHop>`. */
  addStaticRoute(network: Ipv4, mask: Ipv4 | number, nextHop: Ipv4): void {
    const maskInt = maskToInt(mask);
    this.staticRoutes.push({
      network: (ipToInt(network) & maskInt) >>> 0,
      maskInt,
      prefixLen: popcount(maskInt),
      nextHop,
    });
    this.bgp.refreshRoutes();
  }

  /** Drop every configured static route (used when a composed plane is re-armed). */
  clearStaticRoutes(): void {
    this.staticRoutes.length = 0;
    this.bgp.refreshRoutes();
  }

  addDhcpPool(config: DhcpPoolConfig): void {
    const maskInt = maskToInt(config.mask);
    const network = (ipToInt(config.network) & maskInt) >>> 0;
    this.dhcpPools.push({
      id: config.id ?? `${intToIp(network)}/${popcount(maskInt)}`,
      network,
      maskInt,
      mask: intToIp(maskInt),
      gateway: config.gateway,
      rangeStart: ipToInt(config.rangeStart),
      rangeEnd: ipToInt(config.rangeEnd),
      leaseSeconds: config.leaseSeconds ?? DEFAULT_DHCP_LEASE_SECONDS,
      leases: new Map(),
      assigned: new Set(),
    });
  }

  /** All configured L3 interfaces, for inspection/tests. */
  get l3Interfaces(): readonly L3Interface[] {
    return [...this.l3.values()];
  }

  /** Static routes as persistent configuration, without resolved runtime data. */
  staticRouteConfigurations(): Array<{ network: Ipv4; maskInt: number; nextHop: Ipv4 }> {
    return this.staticRoutes.map((route) => ({
      network: intToIp(route.network),
      maskInt: route.maskInt,
      nextHop: route.nextHop,
    }));
  }

  ipv6StaticRouteConfigurations(): Ipv6StaticRoute[] {
    return this.ipv6StaticRoutes.map((route) => ({ ...route }));
  }

  routerAdvertisementConfigurations(): Array<{
    interfaceName: string;
    configuration: RouterAdvertisementConfig;
  }> {
    return [...this.routerAdvertisements.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([interfaceName, configuration]) => ({
        interfaceName,
        configuration: {
          ...configuration,
          prefixes: configuration.prefixes.map((prefix) => ({ ...prefix })),
          dnsServers: configuration.dnsServers ? [...configuration.dnsServers] : undefined,
        },
      }));
  }

  /** DHCP pool definitions without leases or assigned-address runtime state. */
  dhcpPoolConfigurations(): Array<{
    id: string;
    network: Ipv4;
    maskInt: number;
    gateway: Ipv4 | undefined;
    rangeStart: Ipv4;
    rangeEnd: Ipv4;
    leaseSeconds: number;
  }> {
    return this.dhcpPools.map((pool) => ({
      id: pool.id,
      network: intToIp(pool.network),
      maskInt: pool.maskInt,
      gateway: pool.gateway,
      rangeStart: intToIp(pool.rangeStart),
      rangeEnd: intToIp(pool.rangeEnd),
      leaseSeconds: pool.leaseSeconds,
    }));
  }

  // --- inspection (public API for the CLI `show` formatters) -------------

  /** `show ip interface brief`: routed ports and subinterfaces with status. */
  interfaceSummaries(): RouterInterfaceRow[] {
    return [...this.l3.values()].map((iface) => ({
      name: iface.name,
      ip: iface.ip,
      maskInt: iface.maskInt,
      vlan: iface.vlan,
      native: iface.native,
      adminUp: iface.physical.adminUp,
      operUp: iface.physical.operationalUp,
      description: iface.physical.description,
    }));
  }

  ipv6InterfaceSummaries(): Ipv6RouterInterfaceRow[] {
    return [...this.l3.values()]
      .map((iface) => ({
        name: iface.name,
        addresses: iface.ipv6.summaries(),
        adminUp: iface.physical.adminUp,
        operUp: iface.physical.operationalUp,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  ipv6NeighborEntries(): Array<Ipv6NeighborEntry & { interfaceName: string }> {
    return [...this.ipv6DiscoveryByInterface.entries()]
      .flatMap(([interfaceName, discovery]) =>
        discovery.neighborEntries().map((entry) => ({ ...entry, interfaceName })))
      .sort((left, right) =>
        left.interfaceName.localeCompare(right.interfaceName) || left.address.localeCompare(right.address));
  }

  ipv6RoutingTable(): Ipv6RouteRow[] {
    const rows: Ipv6RouteRow[] = [];
    for (const iface of this.l3.values()) {
      if (isTunnelInterface(iface.physical) && !iface.physical.operationalUp) continue;
      for (const assignment of iface.ipv6.summaries()) {
        if (assignment.state === "duplicate" || assignment.state === "tentative") continue;
        if (assignment.source === "link-local") continue;
        rows.push({
          kind: "connected",
          network: ipv6Network(assignment.address, assignment.prefixLength),
          prefixLength: assignment.prefixLength,
          viaIp: undefined,
          egressName: iface.name,
          administrativeDistance: 0,
          metric: 0,
        });
      }
    }
    for (const route of this.ipv6StaticRoutes) {
      const egress = this.connectedIpv6InterfaceFor(route.nextHop);
      rows.push({
        kind: "static",
        network: route.network,
        prefixLength: route.prefixLength,
        viaIp: route.nextHop,
        egressName: egress?.name ?? "",
        administrativeDistance: 1,
        metric: 0,
      });
    }
    if (this.ospfv3.enabled) {
      for (const route of this.ospfv3.routeTable()) {
        rows.push({
          kind: "ospfv3",
          network: route.network,
          prefixLength: route.prefixLength,
          viaIp: route.nextHop,
          egressName: route.interfaceId,
          administrativeDistance: route.administrativeDistance,
          metric: route.cost,
        });
      }
    }
    return rows.sort((left, right) =>
      right.prefixLength - left.prefixLength
      || left.network.localeCompare(right.network)
      || left.egressName.localeCompare(right.egressName));
  }

  /** `show ip route`: connected, then static, then OSPF-learned routes. */
  routingTable(): RouteRow[] {
    const rows: RouteRow[] = [];
    for (const iface of this.l3.values()) {
      if (iface.ip === undefined || iface.vrfId !== undefined) continue;
      // Preserve the educational configured-route view for ordinary physical
      // interfaces. A down tunnel is different: its overlay route cannot exist
      // without a usable underlay and would otherwise recurse into itself.
      if (isTunnelInterface(iface.physical) && !iface.physical.operationalUp) continue;
      rows.push({
        kind: "connected",
        network: intToIp((ipToInt(iface.ip) & iface.maskInt) >>> 0),
        maskInt: iface.maskInt,
        viaIp: undefined,
        egressName: iface.name,
        administrativeDistance: ROUTE_ADMINISTRATIVE_DISTANCE.connected,
        metric: 0,
      });
    }
    for (const route of this.staticRoutes) {
      const egress = this.connectedInterfaceFor(route.nextHop);
      rows.push({
        kind: "static",
        network: intToIp(route.network),
        maskInt: route.maskInt,
        viaIp: route.nextHop,
        egressName: egress?.name ?? "",
        administrativeDistance: ROUTE_ADMINISTRATIVE_DISTANCE.static,
        metric: 0,
      });
    }
    for (const route of this.ospfRoutes()) {
      rows.push({
        kind: "ospf",
        network: route.network,
        maskInt: route.maskInt,
        viaIp: route.nextHop,
        egressName: route.interfaceId,
        administrativeDistance: ROUTE_ADMINISTRATIVE_DISTANCE.ospf,
        metric: route.cost,
      });
    }
    for (const route of this.bgp.selectedRoutes()) {
      if (route.source === "local") continue;
      const underlay = this.resolve(route.nextHop, false, false);
      rows.push({
        kind: "bgp",
        network: route.network,
        maskInt: maskToInt(route.prefixLength),
        viaIp: route.nextHop,
        egressName: underlay?.egress.name ?? "",
        administrativeDistance: route.source === "ebgp" ? 20 : 200,
        metric: route.igpMetric,
      });
    }
    return rows;
  }

  /**
   * OSPF-learned routes that survive the local table: a prefix already known
   * from a connected interface or a static route keeps its better distance.
   */
  private ospfRoutes(): ReturnType<OspfProcess["routeTable"]> {
    if (!this.ospf.enabled) return [];
    return this.ospf.routeTable().filter((route) => {
      const network = (ipToInt(route.network) & route.maskInt) >>> 0;
      for (const iface of this.l3.values()) {
        if (iface.ip === undefined || iface.vrfId !== undefined || iface.maskInt !== route.maskInt) continue;
        if (((ipToInt(iface.ip) & iface.maskInt) >>> 0) === network) return false;
      }
      return !this.staticRoutes.some((entry) => entry.maskInt === route.maskInt && entry.network === network);
    });
  }

  /** Originate an ICMP echo from the address selected by longest-prefix match. */
  ping(target: Ipv4, sequence = 0): void {
    const route = this.resolve(target);
    if (!route?.egress.ip) throw new Error(`Router ${this.id} has no route to ${target}`);
    const request: IcmpMessage = {
      kind: "icmp",
      type: IcmpType.EchoRequest,
      code: 0,
      identifier: 0x5254,
      sequence,
    };
    this.pendingPings.set(sequence, this.engine.now());
    this.engine.scheduleIn(DEFAULT_PING_TIMEOUT_NS, () => {
      if (!this.pendingPings.delete(sequence)) return;
      this.pingResults.push({ sequence, success: false });
    });
    this.engine.trace({
      time: this.engine.now(),
      type: "icmp-echo-request",
      device: this.id,
      detail: { dst: target, sequence },
    });
    this.originate({
      kind: "ipv4",
      src: route.egress.ip,
      dst: target,
      protocol: IpProtocol.ICMP,
      ttl: DEFAULT_IP_TTL,
      payload: request,
    });
  }

  ping6(targetInput: Ipv6, sequence = 0): void {
    const target = normalizeIpv6(targetInput);
    const route = this.resolveIpv6(target);
    const source = route ? this.sourceIpv6Address(route.egress, target) : undefined;
    if (!route || !source) throw new Error(`Router ${this.id} has no IPv6 route to ${target}`);
    this.pendingIpv6Pings.set(sequence, this.engine.now());
    this.engine.scheduleIn(DEFAULT_PING_TIMEOUT_NS, () => {
      if (!this.pendingIpv6Pings.delete(sequence)) return;
      this.ipv6PingResults.push({ sequence, success: false });
    });
    this.originateIpv6({
      kind: "ipv6",
      src: source,
      dst: target,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: DEFAULT_IPV6_HOP_LIMIT,
      payload: {
        kind: "icmpv6",
        type: Icmpv6Type.EchoRequest,
        code: 0,
        identifier: 0x5256,
        sequence,
      },
    });
  }

  // --- receive path ------------------------------------------------------

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    // Link-local control frames never reach the routing, NAT or ACL pipeline.
    if (isControlPayload(frame.payload)) {
      this.receiveControlFrame(frame, ingress);
      return;
    }
    const iface = this.l3ForIngress(ingress, frame.vlan);
    if (!iface) return; // no L3 config for this (port, vlan)

    const dstMac = normalizeMac(frame.dst);
    const myMac = normalizeMac(iface.physical.mac);
    const ospfGroup = dstMac === OSPF_ALL_ROUTERS_MAC || dstMac === OSPF_ALL_DESIGNATED_ROUTERS_MAC;
    const payload = frame.payload;
    const ipv6Group = payload.kind === "ipv6" && isIpv6Multicast(payload.dst);
    if (dstMac !== myMac && !isBroadcastMac(dstMac) && !ospfGroup && !ipv6Group) return;
    if (payload.kind === "arp") {
      this.handleArp(payload, iface);
    } else if (payload.kind === "ipv4") {
      this.handleIpv4(payload, frame, iface);
    } else if (payload.kind === "ipv6") {
      this.handleIpv6(payload, frame, iface);
    } else if (payload.kind === "mpls") {
      this.handleMpls(payload, iface);
    }
  }

  /** MPLS transit bypasses customer IPv4 lookup until the label stack is gone. */
  private handleMpls(packet: MplsPacket, ingress: L3Interface): void {
    if (!this.mpls.interfaceEnabled(ingress.name)) {
      this.traceMpls("mpls-packet-dropped", { reason: "mpls-not-enabled", interface: ingress.name });
      return;
    }
    const before = packet.labels.map((entry) => entry.label);
    const decision = this.mpls.forward(packet);
    if (decision.kind === "drop") {
      const traceType = decision.reason === "unknown-label"
        ? "mpls-label-unknown"
        : decision.reason === "ttl-exceeded" ? "mpls-ttl-exceeded" : "mpls-packet-dropped";
      this.traceMpls(traceType, { reason: decision.detail, incomingLabel: decision.incomingLabel, before });
      return;
    }
    if (decision.kind === "deliver") {
      this.traceMpls("mpls-packet-delivered", {
        incomingLabel: decision.entry.incomingLabel,
        vrfId: decision.vrfId,
        before,
      });
      this.receiveMplsIpv4(decision.packet, ingress, decision.vrfId);
      return;
    }
    const egressId = decision.entry.outgoingInterfaceId;
    const nextHop = decision.entry.nextHop;
    const egress = egressId === undefined ? undefined : this.l3.get(egressId);
    if (!egress || !nextHop || !this.mpls.interfaceEnabled(egress.name) || !egress.physical.operationalUp) {
      this.traceMpls("mpls-packet-dropped", {
        reason: "mpls-egress-unavailable",
        incomingLabel: decision.entry.incomingLabel,
        egress: egressId,
      });
      return;
    }
    if (decision.kind === "ipv4") {
      this.traceMpls("mpls-label-popped", { before, after: [], egress: egress.name });
      this.traceMpls("mpls-php-applied", { incomingLabel: decision.entry.incomingLabel, fec: decision.entry.fec });
      this.sendResolvedPayload(decision.packet, EtherType.IPv4, egress, nextHop);
      return;
    }
    const after = decision.packet.labels.map((entry) => entry.label);
    const operation = decision.entry.operation.type;
    this.traceMpls(
      operation === "swap" ? "mpls-label-swapped" : operation === "pop" ? "mpls-label-popped" : "mpls-label-imposed",
      { before, after, egress: egress.name, fec: decision.entry.fec },
    );
    if (operation === "pop" && decision.entry.source === "ldp") {
      this.traceMpls("mpls-php-applied", {
        incomingLabel: decision.entry.incomingLabel,
        remainingLabels: after,
        fec: decision.entry.fec,
      });
    }
    this.traceMpls("mpls-packet-forwarded", { labels: after, egress: egress.name, nextHop });
    this.sendResolvedPayload(decision.packet, EtherType.MPLS, egress, nextHop);
  }

  protected receiveMplsIpv4(packet: Ipv4Packet, ingress: L3Interface, vrfId?: string): void {
    if (vrfId !== undefined) {
      if (!this.vrfs.configuration(vrfId)) {
        this.traceMpls("mpls-packet-dropped", { reason: "vrf-reference-missing", vrfId });
        return;
      }
      if (this.isOwnIpInContext(packet.dst, vrfId)) this.deliverLocal(packet);
      else this.forwardVrf(packet, ingress, vrfId, false);
      return;
    }
    if (this.isOwnIp(packet.dst)) this.deliverLocal(packet);
    else this.forwardAfterMpls(packet, ingress);
  }

  private forwardAfterMpls(packet: Ipv4Packet, ingress: L3Interface): void {
    if (!this.forwardingEnabled) return;
    const route = this.resolve(packet.dst);
    if (!route) {
      this.sendIcmpError(IcmpType.DestinationUnreachable, IcmpCode.NetUnreachable, packet, ingress);
      return;
    }
    if (!this.permitForward(packet, ingress, route.egress)) return;
    this.egressSend(packet, route.egress, route.nextHopIp);
  }

  private forwardVrf(packet: Ipv4Packet, ingress: L3Interface, vrfId: string, decrementTtl: boolean): void {
    if (!this.forwardingEnabled) return;
    const ttl = decrementTtl ? packet.ttl - 1 : packet.ttl;
    if (ttl <= 0) {
      this.sendIcmpError(IcmpType.TimeExceeded, IcmpCode.TtlExceeded, packet, ingress);
      return;
    }
    const route = this.vrfs.lookup(vrfId, packet.dst, this.connectedVrfRoutes(vrfId));
    if (!route) {
      this.traceMpls("l3vpn-packet-dropped", { reason: "no-vrf-route", vrfId, destination: packet.dst });
      this.sendIcmpError(IcmpType.DestinationUnreachable, IcmpCode.NetUnreachable, packet, ingress);
      return;
    }
    const outbound = { ...packet, ttl };
    if (route.source === "bgp-vpn") {
      if (!route.remotePe || route.vpnLabel === undefined) {
        this.traceMpls("l3vpn-packet-dropped", { reason: "vpn-label-unavailable", vrfId, destination: packet.dst });
        return;
      }
      const transport = this.ldp.outgoingLabelFor(`${route.remotePe}/32`);
      if (!transport) {
        this.traceMpls("l3vpn-packet-dropped", { reason: "transport-label-unavailable", vrfId, remotePe: route.remotePe });
        return;
      }
      const egress = this.l3.get(transport.outgoingInterfaceId);
      if (!egress?.physical.operationalUp || !this.mpls.interfaceEnabled(egress.name)) {
        this.traceMpls("l3vpn-packet-dropped", { reason: "mpls-egress-unavailable", vrfId, egress: transport.outgoingInterfaceId });
        return;
      }
      const labels = transport.label === 3 ? [route.vpnLabel] : [transport.label, route.vpnLabel];
      const labelled = this.mpls.impose(outbound, labels);
      this.traceMpls("mpls-label-imposed", { vrfId, labels, remotePe: route.remotePe, destination: packet.dst });
      this.traceMpls("l3vpn-packet-forwarded", { vrfId, labels, remotePe: route.remotePe });
      this.sendResolvedPayload(labelled, EtherType.MPLS, egress, transport.nextHop);
      return;
    }
    const nextHop = route.nextHop ?? packet.dst;
    const egress = route.outgoingInterfaceId
      ? this.l3.get(route.outgoingInterfaceId)
      : this.connectedVrfInterfaceFor(vrfId, nextHop);
    if (!egress?.physical.operationalUp || !this.permitForward(outbound, ingress, egress)) return;
    this.egressSend(outbound, egress, nextHop);
  }

  private traceMpls(type: string, detail: Readonly<Record<string, unknown>>): void {
    this.engine.trace({ time: this.engine.now(), type, device: this.id, detail: { ...detail } });
  }

  /** Dispatch a link-local control payload; a router terminates every one. */
  protected receiveControlFrame(frame: EthernetFrame, ingress: EthernetInterface): void {
    const payload = frame.payload;
    if (payload.kind === "cdp") this.discovery.onCdp(payload, ingress.name);
    else if (payload.kind === "lldp") this.discovery.onLldp(payload, ingress.name);
  }

  override onInterfaceStateChanged(iface: EthernetInterface): void {
    this.discovery.onPortStateChanged(iface.name);
    this.ospf.onInterfaceStateChanged(iface.name);
    this.ospfv3.onInterfaceStateChanged(iface.name);
    this.bgp.onInterfaceStateChanged();
    this.ldp.arm();
    for (const [name, l3] of this.l3) {
      if (l3.physical === iface && !iface.operationalUp) {
        this.ipv6DiscoveryByInterface.get(name)?.reset();
      }
      if (l3.physical === iface && name !== iface.name) {
        this.ospfv3.onInterfaceStateChanged(name);
      }
    }
    emitLinkTrap(this.snmp, iface.name, iface.operationalUp);
  }

  // --- OSPFv3 host --------------------------------------------------------

  ospfv3Interfaces(): readonly Ospfv3InterfaceDescriptor[] {
    return [...this.l3.values()]
      .map((iface) => ({
        id: iface.name,
        linkLocal: iface.ipv6.summaries().find((address) =>
          address.source === "link-local" && address.state === "preferred")?.address,
        prefixes: iface.ipv6.summaries()
          .filter((address) =>
            address.source !== "link-local"
            && address.state !== "tentative"
            && address.state !== "duplicate")
          .map((address) => ({
            network: ipv6Network(address.address, address.prefixLength),
            prefixLength: address.prefixLength,
          })),
        operationalUp: iface.physical.operationalUp,
        loopback: iface.physical instanceof LoopbackInterface,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  ospfv3Send(interfaceId: string, destination: Ipv6, packet: Ospfv3Packet): void {
    const iface = this.l3.get(interfaceId);
    const source = iface?.ipv6.summaries().find((address) =>
      address.source === "link-local" && address.state === "preferred")?.address;
    if (!iface || !source || !iface.physical.operationalUp) return;
    const ipv6: Ipv6Packet = {
      kind: "ipv6",
      src: source,
      dst: destination,
      nextHeader: Ipv6NextHeader.OSPF,
      hopLimit: 1,
      payload: packet,
    };
    // A GRE tunnel is point-to-point and has no link layer, so OSPFv3 control
    // traffic is encapsulated instead of being resolved through NDP.
    if (isTunnelInterface(iface.physical)) {
      this.sendThroughTunnel(iface, ipv6);
      return;
    }
    this.ipv6Discovery(iface).send(ipv6, destination);
  }

  ospfv3RoutesChanged(): void {
    this.engine?.trace({
      time: this.engine.now(),
      type: "ospfv3-routing-table-changed",
      device: this.id,
      detail: { routes: this.ospfv3.routeTable().length },
    });
  }

  // --- OSPF host ----------------------------------------------------------

  ospfInterfaces(): readonly OspfInterfaceDescriptor[] {
    return [...this.l3.values()]
      .filter((iface) => iface.vrfId === undefined)
      .map((iface): OspfInterfaceDescriptor => ({
        id: iface.name,
        address: iface.ip,
        maskInt: iface.maskInt,
        operationalUp: iface.physical.operationalUp,
        loopback: iface.physical instanceof LoopbackInterface,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  ospfSend(interfaceId: string, destination: Ipv4, packet: OspfPacket): void {
    const iface = this.l3.get(interfaceId);
    if (!iface?.ip || !iface.physical.operationalUp) return;
    const ipv4: Ipv4Packet = {
      kind: "ipv4",
      src: iface.ip,
      dst: destination,
      protocol: OSPF_PROTOCOL,
      // OSPF is single-hop; a TTL of one keeps it from leaving the segment.
      ttl: 1,
      payload: packet,
    };
    // A GRE tunnel is point-to-point and has no link layer: both the multicast
    // hello and a unicast reply are encapsulated and routed over the underlay.
    if (isTunnelInterface(iface.physical)) {
      this.sendThroughTunnel(iface, ipv4);
      return;
    }
    // Multicast OSPF resolves its own MAC; a unicast reply uses the ARP cache.
    const mac = destination === "224.0.0.5"
      ? OSPF_ALL_ROUTERS_MAC
      : destination === "224.0.0.6"
        ? OSPF_ALL_DESIGNATED_ROUTERS_MAC
        : this.arpTable.get(destination);
    if (mac === undefined) {
      this.egressSendPublic(ipv4, iface, destination);
      return;
    }
    this.transmit(iface, mac, EtherType.IPv4, ipv4);
  }

  ospfRoutesChanged(): void {
    this.engine?.trace({
      time: this.engine.now(),
      type: "ospf-routing-table-changed",
      device: this.id,
      detail: { routes: this.ospf.routeTable().length },
    });
    this.ldp.arm();
    this.bgp.refreshRoutes();
    this.bgp.onInterfaceStateChanged();
  }

  /** Send through the normal ARP-resolving egress path (used by OSPF unicast). */
  private egressSendPublic(packet: Ipv4Packet, egress: L3Interface, nextHopIp: Ipv4): void {
    this.egressSend(packet, egress, nextHopIp);
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

  /** The lowest configured IPv4 address, so the value is stable across runs. */
  discoveryManagementAddress(): Ipv4 | undefined {
    let lowest: Ipv4 | undefined;
    for (const iface of this.l3.values()) {
      if (iface.ip === undefined || iface.vrfId !== undefined) continue;
      if (lowest === undefined || ipToInt(iface.ip) < ipToInt(lowest)) lowest = iface.ip;
    }
    return lowest;
  }

  discoveryPortDescription(port: string): string | undefined {
    return this.interfaces.get(port)?.description;
  }

  discoveryNativeVlan(_port: string): number | undefined {
    return undefined;
  }

  discoverySend(port: string, payload: CdpPacket | LldpPacket): void {
    const iface = this.interfaces.get(port);
    if (!iface?.operationalUp) return;
    iface.transmit({
      src: iface.mac,
      dst: payload.kind === "cdp" ? CISCO_SHARED_MAC : LLDP_MAC,
      etherType: payload.kind === "cdp" ? EtherType.LLC : EtherType.LLDP,
      payload,
    });
  }

  private l3ForIngress(ingress: EthernetInterface, vlan: number | undefined): L3Interface | undefined {
    for (const iface of this.l3.values()) {
      if (iface.physical !== ingress) continue;
      if (vlan === undefined) {
        // Untagged: a routed port, or a subinterface flagged as the native VLAN.
        if (iface.native || (iface.vlan === undefined && !iface.native)) return iface;
      } else if (iface.vlan === vlan && !iface.native) {
        return iface;
      }
    }
    return undefined;
  }

  // --- ARP ---------------------------------------------------------------

  private handleArp(arp: ArpPacket, iface: L3Interface): void {
    this.arpTable.set(arp.senderIp, normalizeMac(arp.senderMac));
    this.flushArpPending(arp.senderIp);

    const ownsTarget = iface.ip !== undefined && (
      arp.targetIp === iface.ip
      || (
        this.natRoles.get(iface.name) === "outside"
        && this.nat.ownsOutsideAddress(arp.targetIp, iface.ip)
      )
    );
    if (arp.op === ArpOp.Request && ownsTarget) {
      const reply: ArpPacket = {
        kind: "arp",
        op: ArpOp.Reply,
        senderMac: iface.physical.mac,
        senderIp: arp.targetIp,
        targetMac: arp.senderMac,
        targetIp: arp.senderIp,
      };
      this.engine.trace({
        time: this.engine.now(),
        type: "arp-reply",
        device: this.id,
        detail: { iface: iface.name, targetIp: arp.senderIp },
      });
      this.transmit(iface, arp.senderMac, EtherType.ARP, reply);
    }
  }

  private sendArpRequest(iface: L3Interface, targetIp: Ipv4): void {
    if (iface.ip === undefined) return;
    const arp: ArpPacket = {
      kind: "arp",
      op: ArpOp.Request,
      senderMac: iface.physical.mac,
      senderIp: iface.ip,
      targetMac: ZERO_MAC,
      targetIp,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: "arp-request",
      device: this.id,
      detail: { iface: iface.name, targetIp },
    });
    this.transmit(iface, BROADCAST_MAC, EtherType.ARP, arp);
  }

  private flushArpPending(ip: Ipv4): void {
    const mac = this.arpTable.get(ip);
    const queued = this.arpPending.get(ip);
    if (!mac || !queued) return;
    this.arpPending.delete(ip);
    for (const { payload, etherType, egress } of queued) this.transmit(egress, mac, etherType, payload);
  }

  // --- IPv6 / ICMPv6 / NDP / DHCPv6 ------------------------------------

  private ipv6Discovery(iface: L3Interface): Ipv6NeighborDiscovery {
    const existing = this.ipv6DiscoveryByInterface.get(iface.name);
    if (existing) return existing;
    const discovery = new Ipv6NeighborDiscovery({
      deviceId: this.id,
      interfaceId: iface.name,
      engine: () => this.engine,
      mac: () => iface.physical.mac,
      addresses: iface.ipv6,
      isRouter: true,
      transmit: (destinationMac, packet) => {
        if (!this.permitByIpv6Acl(packet, iface, "out")) return;
        this.transmit(iface, destinationMac, EtherType.IPv6, packet);
      },
      onDadConflict: (_address, message) => {
        const scoped = `${iface.name}: ${message}`;
        if (!this.ipv6Problems.includes(scoped)) this.ipv6Problems.push(scoped);
      },
    });
    this.ipv6DiscoveryByInterface.set(iface.name, discovery);
    return discovery;
  }

  private handleIpv6(received: Ipv6Packet, frame: EthernetFrame, ingress: L3Interface): void {
    const packet = this.applyInputQos(ingress, frame, received);
    if (!packet) return;
    if (!this.permitByIpv6Acl(packet, ingress, "in")) return;
    if (packet.nextHeader === Ipv6NextHeader.OSPF && packet.payload.kind === "ospfv3") {
      this.ospfv3.onPacket(packet.payload, ingress.name, packet.src);
      return;
    }
    const discovery = this.ipv6Discovery(ingress);
    if (discovery.receive(packet, frame.src)) return;
    if (packet.src !== "::") discovery.learnNeighbor(packet.src, frame.src);

    if (
      packet.nextHeader === Ipv6NextHeader.ICMPv6
      && packet.payload.kind === "icmpv6"
      && packet.payload.type === Icmpv6Type.RouterSolicitation
    ) {
      this.sendRouterAdvertisement(ingress, packet.src);
      return;
    }
    if (
      packet.nextHeader === Ipv6NextHeader.UDP
      && packet.payload.kind === "udp"
      && packet.payload.dstPort === DHCPV6_SERVER_PORT
      && packet.payload.payload.kind === "dhcpv6"
    ) {
      this.handleDhcpv6(packet.payload.payload, ingress, packet.src);
      return;
    }
    if (this.isOwnIpv6(packet.dst)) {
      this.deliverLocalIpv6(packet);
      return;
    }
    if (isIpv6Multicast(packet.dst)) return;
    this.forwardIpv6(packet, ingress);
  }

  private deliverLocalIpv6(packet: Ipv6Packet): void {
    if (packet.nextHeader === Ipv6NextHeader.UDP && packet.payload.kind === "udp") {
      this.management.receiveUdp(packet.src, packet.dst, packet.payload, false);
      return;
    }
    if (packet.nextHeader === Ipv6NextHeader.TCP && packet.payload.kind === "tcp") {
      this.management.receiveTcp(packet.src, packet.dst, packet.payload);
      return;
    }
    if (packet.nextHeader !== Ipv6NextHeader.ICMPv6 || packet.payload.kind !== "icmpv6") return;
    const message = packet.payload;
    if (message.type === Icmpv6Type.EchoReply) {
      const sentAt = this.pendingIpv6Pings.get(message.sequence);
      if (sentAt === undefined) return;
      this.pendingIpv6Pings.delete(message.sequence);
      const rttNs = this.engine.now() - sentAt;
      this.ipv6PingResults.push({ sequence: message.sequence, success: true, rttNs });
      this.engine.trace({
        time: this.engine.now(),
        type: "ipv6-ping-success",
        device: this.id,
        detail: { sequence: message.sequence, rttNs },
      });
      return;
    }
    if (message.type !== Icmpv6Type.EchoRequest) return;
    this.originateIpv6({
      kind: "ipv6",
      src: packet.dst,
      dst: packet.src,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: DEFAULT_IPV6_HOP_LIMIT,
      payload: {
        kind: "icmpv6",
        type: Icmpv6Type.EchoReply,
        code: 0,
        identifier: message.identifier,
        sequence: message.sequence,
      },
    });
  }

  private forwardIpv6(packet: Ipv6Packet, ingress: L3Interface): void {
    if (!this.ipv6ForwardingEnabled) return;
    if (packet.hopLimit <= 1) {
      this.sendIcmpv6Error(Icmpv6Type.TimeExceeded, packet, ingress);
      return;
    }
    const route = this.resolveIpv6(packet.dst);
    if (!route) {
      this.sendIcmpv6Error(Icmpv6Type.DestinationUnreachable, packet, ingress);
      return;
    }
    this.engine.trace({
      time: this.engine.now(),
      type: "ipv6-route",
      device: this.id,
      detail: { destination: packet.dst, egress: route.egress.name, nextHop: route.nextHopIp },
    });
    this.sendIpv6ThroughEgress({ ...packet, hopLimit: packet.hopLimit - 1 }, route.egress, route.nextHopIp);
  }

  private originateIpv6(packet: Ipv6Packet): void {
    if (isIpv6Multicast(packet.dst)) {
      const iface = [...this.l3.values()].find((entry) => entry.ipv6.owns(packet.src));
      if (iface) this.ipv6Discovery(iface).send(packet, packet.dst);
      return;
    }
    const route = this.resolveIpv6(packet.dst);
    if (!route) return;
    this.sendIpv6ThroughEgress(packet, route.egress, route.nextHopIp);
  }

  /**
   * The single IPv6 egress point. A cabled interface resolves the next hop with
   * NDP; a tunnel has no link layer at all, so its packet is encapsulated in
   * GRE and re-routed over the IPv4 underlay instead.
   */
  private sendIpv6ThroughEgress(packet: Ipv6Packet, egress: L3Interface, nextHopIp: Ipv6): void {
    if (isTunnelInterface(egress.physical)) {
      if (!this.permitByIpv6Acl(packet, egress, "out")) return;
      this.sendThroughTunnel(egress, packet);
      return;
    }
    this.ipv6Discovery(egress).send(packet, nextHopIp);
  }

  private sendIcmpv6Error(
    type: typeof Icmpv6Type.DestinationUnreachable | typeof Icmpv6Type.TimeExceeded,
    offending: Ipv6Packet,
    ingress: L3Interface,
  ): void {
    const source = this.sourceIpv6Address(ingress, offending.src);
    if (!source) return;
    const payload: Icmpv6Message = type === Icmpv6Type.TimeExceeded
      ? { kind: "icmpv6", type, code: 0, reason: "hop-limit-exceeded" }
      : { kind: "icmpv6", type, code: 0, reason: "no-route" };
    this.originateIpv6({
      kind: "ipv6",
      src: source,
      dst: offending.src,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: DEFAULT_IPV6_HOP_LIMIT,
      payload,
    });
  }

  private sendRouterAdvertisement(iface: L3Interface, requester: Ipv6): void {
    const config = this.routerAdvertisements.get(iface.name);
    if (!config) return;
    const source = iface.ipv6.summaries().find((entry) =>
      entry.source === "link-local" && entry.state === "preferred")?.address;
    if (!source) return;
    const destination = requester === "::" ? IPV6_ALL_NODES : requester;
    this.ipv6Discovery(iface).send({
      kind: "ipv6",
      src: source,
      dst: destination,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: 255,
      payload: {
        kind: "icmpv6",
        type: Icmpv6Type.RouterAdvertisement,
        code: 0,
        currentHopLimit: DEFAULT_IPV6_HOP_LIMIT,
        managed: config.managed ?? false,
        otherConfiguration: config.otherConfiguration ?? false,
        routerLifetimeNs: config.routerLifetimeNs ?? 1_800_000_000_000,
        sourceLinkLayerAddress: iface.physical.mac,
        prefixes: config.prefixes,
        dnsServers: config.dnsServers,
      },
    }, destination);
  }

  private handleDhcpv6(message: Dhcpv6Message, iface: L3Interface, source: Ipv6): void {
    const linkAddress = iface.ipv6.summaries().find((entry) =>
      entry.source !== "link-local" && entry.state === "preferred")?.address;
    const reply = this.dhcpv6.handle(message, linkAddress);
    if (!reply) return;
    const local = iface.ipv6.summaries().find((entry) =>
      entry.source === "link-local" && entry.state === "preferred")?.address;
    if (!local) return;
    this.ipv6Discovery(iface).send({
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
    }, source);
    this.engine.trace({
      time: this.engine.now(),
      type: `dhcpv6-${reply.messageType}`,
      device: this.id,
      detail: { interface: iface.name, clientId: reply.clientId, address: reply.address },
    });
  }

  // --- IPv4 / ICMP -------------------------------------------------------

  private handleIpv4(packet: Ipv4Packet, frame: EthernetFrame, ingress: L3Interface): void {
    // OSPF is this router's own control traffic. It is delivered to the local
    // process before the NAT and ACL pipeline, so a lab can never accidentally
    // filter away its own adjacencies while learning about ACLs.
    if (ingress.vrfId === undefined && packet.protocol === OSPF_PROTOCOL && packet.payload.kind === "ospf") {
      this.ospf.onPacket(packet.payload, ingress.name, packet.src);
      return;
    }
    // Input QoS classifies, marks and polices before ACL, NAT and routing, so
    // the rest of the pipeline sees the packet the policy produced.
    const admitted = this.applyInputQos(ingress, frame, packet);
    if (!admitted) return;
    let acceptedPacket = admitted;
    if (this.nat.hasRules() && this.natRoles.get(ingress.name) === "outside") {
      this.validateNatRoles();
      try {
        const result = this.nat.translateInbound(packet, this.natContext(ingress));
        acceptedPacket = result.packet;
        this.traceNatTranslation("destination", packet, result);
      } catch (error) {
        if (error instanceof NatError && error.code === "NAT_NO_TRANSLATION") {
          this.traceNatError(error, ingress, packet);
          return;
        }
        throw error;
      }
    }
    if (!this.permitByAcl(acceptedPacket, ingress, "in")) return;

    // Opportunistically cache the L2 address of the L3 source.
    this.arpTable.set(acceptedPacket.src, normalizeMac(frame.src));

    // DHCP server: broadcast requests are delivered locally regardless of dst IP.
    if (acceptedPacket.payload.kind === "udp" && acceptedPacket.payload.dstPort === DHCP_SERVER_PORT) {
      this.handleDhcp(acceptedPacket.payload, ingress);
      return;
    }

    if (this.isOwnIpInContext(acceptedPacket.dst, ingress.vrfId)) {
      this.deliverLocal(acceptedPacket);
      return;
    }
    if (ingress.vrfId !== undefined) this.forwardVrf(acceptedPacket, ingress, ingress.vrfId, true);
    else this.forward(acceptedPacket, ingress);
  }

  private deliverLocal(packet: Ipv4Packet): void {
    // Tunnel encapsulations terminate here: the outer packet was addressed to
    // one of our own tunnel source addresses, so it is unwrapped rather than
    // handed to a management socket.
    if (packet.payload.kind === "gre") {
      this.receiveGre(packet, packet.payload);
      return;
    }
    if (this.deliverProtectedLocal(packet)) return;
    if (packet.payload.kind === "udp") {
      this.management.receiveUdp(packet.src, packet.dst, packet.payload, false);
      return;
    }
    if (packet.payload.kind === "tcp") {
      this.management.receiveTcp(packet.src, packet.dst, packet.payload);
      return;
    }
    if (packet.protocol !== IpProtocol.ICMP || packet.payload.kind !== "icmp") return;
    const icmp = packet.payload;
    if (icmp.type === IcmpType.EchoReply) {
      const sentAt = this.pendingPings.get(icmp.sequence);
      if (sentAt === undefined) return;
      this.pendingPings.delete(icmp.sequence);
      const rttNs = this.engine.now() - sentAt;
      this.pingResults.push({ sequence: icmp.sequence, success: true, rttNs });
      this.engine.trace({
        time: this.engine.now(),
        type: "ping-success",
        device: this.id,
        detail: { sequence: icmp.sequence, rttNs },
      });
      return;
    }
    if (icmp.type !== IcmpType.EchoRequest) return;
    const reply: IcmpMessage = {
      kind: "icmp",
      type: IcmpType.EchoReply,
      code: 0,
      identifier: icmp.identifier,
      sequence: icmp.sequence,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: "icmp-echo-reply",
      device: this.id,
      detail: { dst: packet.src, sequence: icmp.sequence },
    });
    this.originate({
      kind: "ipv4",
      src: packet.dst,
      dst: packet.src,
      protocol: IpProtocol.ICMP,
      ttl: DEFAULT_IP_TTL,
      payload: reply,
    });
  }

  private forward(packet: Ipv4Packet, ingress: L3Interface): void {
    if (!this.forwardingEnabled) return;
    const ttl = packet.ttl - 1;
    if (ttl <= 0) {
      this.sendIcmpError(IcmpType.TimeExceeded, IcmpCode.TtlExceeded, packet, ingress);
      return;
    }
    const route = this.resolve(packet.dst);
    if (!route) {
      this.sendIcmpError(IcmpType.DestinationUnreachable, IcmpCode.NetUnreachable, packet, ingress);
      return;
    }
    if (!this.permitForward(packet, ingress, route.egress)) return;
    this.engine.trace({
      time: this.engine.now(),
      type: "route",
      device: this.id,
      detail: { dst: packet.dst, egress: route.egress.name, nextHop: route.nextHopIp },
    });
    let outbound = { ...packet, ttl };
    if (this.nat.hasRules()) {
      this.validateNatRoles();
      const ingressRole = this.natRoles.get(ingress.name);
      const egressRole = this.natRoles.get(route.egress.name);
      if (!ingressRole || !egressRole) {
        throw new NatError(
          "NAT_ROLE_MISSING",
          `NAT role missing on ${!ingressRole ? ingress.name : route.egress.name}.`,
        );
      }
      if (ingressRole === "inside" && egressRole === "outside") {
        const result = this.nat.translateOutbound(outbound, this.natContext(route.egress));
        this.traceNatTranslation("source", outbound, result);
        outbound = result.packet;
      }
    }
    const additionalDelayNs = this.forwardingDelayNs(outbound, ingress, route.egress);
    if (additionalDelayNs > 0) {
      this.engine.scheduleIn(additionalDelayNs, () => {
        this.egressSend(outbound, route.egress, route.nextHopIp);
      });
    } else {
      this.egressSend(outbound, route.egress, route.nextHopIp);
    }
  }

  /**
   * The inbound protected path. Outer ACL, firewall policy and NAT have already
   * run, so what remains is: ESP SA lookup → replay validation → unprotect →
   * GRE decapsulation. IKE negotiation messages terminate here too, which is
   * why an ACL that denies UDP 500 stops a tunnel from ever establishing.
   */
  protected deliverProtectedLocal(packet: Ipv4Packet): boolean {
    const payload = packet.payload;
    if (payload.kind === "udp" && payload.dstPort === IKE_PORT && payload.payload.kind === "ike") {
      this.ipsec.onIkeMessage(payload.payload, packet.src, packet.dst);
      return true;
    }
    if (payload.kind !== "esp") return false;
    const result = this.ipsec.unprotect(payload, packet.src, estimateIpPacketSizeBytes(packet));
    // A rejection is already traced with its typed reason; the packet is gone.
    if (!("payload" in result)) return true;
    this.receiveGre(packet, result.payload);
    return true;
  }

  /** Extension point for stateful firewalls and deterministic ISP impairment. */
  protected permitForward(
    _packet: Ipv4Packet,
    _ingress: L3Interface,
    _egress: L3Interface,
  ): boolean {
    return true;
  }

  /** Additional virtual transit delay; physical link delay remains separate. */
  protected forwardingDelayNs(
    _packet: Ipv4Packet,
    _ingress: L3Interface,
    _egress: L3Interface,
  ): number {
    return 0;
  }

  // --- management plane --------------------------------------------------

  /**
   * The address a management socket sources from. It follows the routing table
   * so a reply always leaves through the interface that owns the conversation,
   * and falls back to the numerically lowest configured address (loopbacks
   * included) when there is no specific destination.
   */
  managementSourceAddress(family: IpFamily, destination?: IpAddress): IpAddress | undefined {
    if (family === "ipv6") {
      if (destination !== undefined && ipFamilyOf(destination) === "ipv6") {
        const route = this.resolveIpv6(destination);
        const preferred = route
          ? this.sourceIpv6Address(route.egress, destination)
          : undefined;
        if (preferred) return preferred;
      }
      return this.ipv6InterfaceSummaries()
        .flatMap((row) => row.addresses)
        .filter((address) => address.source !== "link-local" && address.state !== "duplicate")
        .map((address) => address.address)
        .sort((a, b) => (ipv6ToBigInt(a) < ipv6ToBigInt(b) ? -1 : 1))[0];
    }
    if (destination !== undefined && ipFamilyOf(destination) === "ipv4") {
      const route = this.resolve(destination);
      if (route?.egress.ip !== undefined) return route.egress.ip;
    }
    return [...this.l3.values()]
      .flatMap((iface) => (iface.ip === undefined || iface.vrfId !== undefined ? [] : [iface.ip]))
      .sort((a, b) => ipToInt(a) - ipToInt(b))[0];
  }

  // --- SNMP MIB source ------------------------------------------------------
  // Only state the engine genuinely models is reported; nothing is invented.

  snmpInterfaceRows(): SnmpInterfaceRow[] {
    return this.interfaceSummaries()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row, index) => ({
        index: index + 1,
        name: row.name,
        ifType: row.vlan === undefined ? 6 : 53,
        adminUp: row.adminUp,
        operationalUp: row.operUp,
        inUnicastPackets: 0,
        outUnicastPackets: 0,
        inDiscards: 0,
        outDiscards: 0,
      }));
  }

  snmpIpv4Addresses(): string[] {
    return [...this.l3.values()]
      .flatMap((iface) => (iface.ip === undefined ? [] : [iface.ip]))
      .sort((a, b) => ipToInt(a) - ipToInt(b));
  }

  snmpIpv6Addresses(): string[] {
    return this.ipv6InterfaceSummaries()
      .flatMap((row) => row.addresses.map((address) => address.address))
      .sort((a, b) => a.localeCompare(b));
  }

  snmpRouteCount(): number {
    return this.routingTable().length + this.ipv6RoutingTable().length;
  }

  snmpNeighborCount(): number {
    return this.discovery.neighborTable().length;
  }

  snmpOspfNeighborCount(): number {
    return this.ospf.neighborSummaries().length;
  }

  snmpOspfv3NeighborCount(): number {
    return this.ospfv3.neighborSummaries().length;
  }

  /** Every address this device answers management traffic on, lowest first. */
  managementAddresses(): IpAddress[] {
    const ipv4 = [...this.l3.values()]
      .flatMap((iface) => (iface.ip === undefined || iface.vrfId !== undefined ? [] : [iface.ip]))
      .sort((a, b) => ipToInt(a) - ipToInt(b));
    const ipv6 = this.ipv6InterfaceSummaries()
      .flatMap((row) => row.addresses)
      .filter((address) => address.source !== "link-local" && address.state !== "duplicate")
      .map((address) => address.address)
      .sort((a, b) => (ipv6ToBigInt(a) < ipv6ToBigInt(b) ? -1 : 1));
    return [...ipv4, ...ipv6];
  }

  /** Adapter used by BGP to select the ordinary routed source or update-source. */
  bgpSourceAddress(remoteAddress: Ipv4, updateSource?: string): Ipv4 | undefined {
    if (updateSource !== undefined) {
      const iface = this.l3.get(updateSource);
      return iface?.physical.operationalUp && iface.ip !== undefined ? iface.ip : undefined;
    }
    return this.managementSourceAddress("ipv4", remoteAddress) as Ipv4 | undefined;
  }

  bgpOwnsAddress(address: Ipv4): boolean {
    return this.managementAddresses().includes(address);
  }

  bgpRouteReachable(address: Ipv4): boolean {
    return this.resolve(address, false, false) !== undefined;
  }

  bgpExactRouteExists(network: Ipv4, prefixLength: number): boolean {
    const maskInt = maskToInt(prefixLength);
    return this.routingTable().some((route) =>
      route.kind !== "bgp"
      && route.maskInt === maskInt
      && ((ipToInt(route.network) & maskInt) >>> 0) === ipToInt(network)
      && (route.kind === "connected" || route.egressName !== ""));
  }

  bgpIgpMetric(address: Ipv4): number | undefined {
    return this.resolve(address, false, false)?.metric;
  }

  bgpRoutesChanged(): void {
    this.engine.trace({
      time: this.engine.now(),
      type: "bgp-routing-table-changed",
      device: this.id,
      detail: { routes: this.bgp.selectedRoutes().length },
    });
  }

  bgpVpnv4Exports(): readonly Vpnv4Route[] {
    const bgp = this.bgp.configurationSnapshot();
    const nextHop = bgp?.routerId ?? this.ldp.routerId();
    if (!bgp || !nextHop) return [];
    const routes: Vpnv4Route[] = [];
    for (const family of [...(bgp.vrfAddressFamilies ?? [])].sort((a, b) => a.vrfId.localeCompare(b.vrfId))) {
      const vrf = this.vrfs.configuration(family.vrfId);
      if (!vrf) continue;
      const candidates = this.vrfRoutingTable(vrf.id).filter((route) =>
        (route.source === "connected" && family.redistributeConnected)
        || (route.source === "static" && family.redistributeStatic));
      for (const route of candidates) {
        const routeId = `local-vpnv4:${vrf.routeDistinguisher}:${route.network}/${route.prefixLength}`;
        routes.push({
          routeDistinguisher: vrf.routeDistinguisher,
          network: route.network,
          prefixLength: route.prefixLength,
          routeTargets: [...vrf.exportRouteTargets],
          vpnLabel: this.vrfs.vpnLabel(vrf.id),
          nextHop,
          sourceVrfId: vrf.id,
          path: { origin: "igp", asPath: [], nextHop, localPreference: 100, med: 0 },
          routeId,
          source: "local",
          neighborRouterId: bgp.routerId,
          learnedAtNs: 0,
          localPreference: 100,
          med: 0,
          weight: 32_768,
          igpMetric: 0,
          communities: [],
          clusterList: [],
        });
      }
    }
    return routes.sort((a, b) => a.routeDistinguisher.localeCompare(b.routeDistinguisher)
      || ipToInt(a.network) - ipToInt(b.network)
      || b.prefixLength - a.prefixLength);
  }

  bgpVpnv4RoutesChanged(routes: readonly Vpnv4Route[]): void {
    const imported: ImportedVpnRoute[] = routes.map((route) => ({
      routeDistinguisher: route.routeDistinguisher,
      network: route.network,
      prefixLength: route.prefixLength,
      routeTargets: [...route.routeTargets],
      vpnLabel: route.vpnLabel,
      nextHop: route.nextHop,
      metric: route.igpMetric,
    }));
    this.vrfs.replaceImported(imported);
    this.rebuildVpnLabelBindings();
    this.engine.trace({
      time: this.engine.now(),
      type: "bgp-vpnv4-routing-table-changed",
      device: this.id,
      detail: { routes: imported.length },
    });
  }

  vpnLabelBindings(): ReadonlyArray<{ label: number; vrfId: string }> {
    return this.vrfs.configurationsSnapshot().map((vrf) => ({ label: this.vrfs.vpnLabel(vrf.id), vrfId: vrf.id }));
  }

  /** Clear derived MPLS/LDP state while preserving every structured setting. */
  resetMplsRuntime(): void {
    this.ldp.resetRuntime();
    this.mpls.clearRuntime();
    this.rebuildVpnLabelBindings();
    this.ldp.arm();
  }

  private rebuildVpnLabelBindings(): void {
    this.mpls.removeBySource("vpn");
    for (const vrf of this.vrfs.configurationsSnapshot()) {
      this.mpls.install({
        incomingLabel: this.vrfs.vpnLabel(vrf.id),
        fec: `${vrf.routeDistinguisher}:vrf`,
        operation: { type: "deliver", vrfId: vrf.id },
        source: "vpn",
      });
    }
  }

  // --- LDP host ---------------------------------------------------------

  ldpInterfaces(): readonly LdpInterfaceDescriptor[] {
    return [...this.l3.values()]
      .filter((iface) => iface.name === iface.physical.name && !this.isLoopback(iface.name) && !isTunnelInterface(iface.physical))
      .map((iface) => ({
        id: iface.name,
        address: iface.ip,
        enabled: this.mpls.interfaceEnabled(iface.name),
        operational: iface.physical.operationalUp,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  ldpPeer(interfaceId: string): LdpPeerDescriptor | undefined {
    const local = this.l3.get(interfaceId);
    const peerInterface = local?.physical.peer();
    if (!local || !peerInterface || !(peerInterface.device instanceof Router)) return undefined;
    const peerRouter = peerInterface.device;
    const remote = peerRouter.l3.get(peerInterface.name);
    return {
      deviceId: peerRouter.id,
      localInterfaceId: interfaceId,
      remoteInterfaceId: peerInterface.name,
      remoteAddress: remote?.ip,
      process: peerRouter.ldp,
    };
  }

  ldpRouterIdCandidates(): readonly { interfaceId: string; address: Ipv4; loopback: boolean; active: boolean }[] {
    return [...this.l3.values()]
      .filter((iface): iface is L3Interface & { ip: Ipv4 } => iface.ip !== undefined)
      .map((iface) => ({
        interfaceId: iface.name,
        address: iface.ip,
        loopback: this.isLoopback(iface.name),
        active: iface.physical.operationalUp,
      }))
      .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId));
  }

  ldpRouteReachable(address: Ipv4): boolean {
    return this.resolve(address, false, false) !== undefined;
  }

  ldpFecs(): readonly LdpFecRoute[] {
    const byFec = new Map<string, LdpFecRoute>();
    for (const route of this.routingTable()) {
      if (route.kind !== "connected" && route.kind !== "ospf") continue;
      const prefixLength = popcount(route.maskInt);
      const fec = `${route.network}/${prefixLength}`;
      const candidate: LdpFecRoute = {
        fec,
        source: route.kind,
        nextHop: route.viaIp,
        outgoingInterfaceId: route.egressName,
      };
      const existing = byFec.get(fec);
      if (!existing || candidate.source === "connected") byFec.set(fec, candidate);
    }
    return [...byFec.values()].sort((a, b) => a.fec.localeCompare(b.fec));
  }

  ldpInstallForwardingEntry(entry: MplsForwardingEntry): void {
    this.mpls.install(entry);
  }

  ldpClearForwardingEntries(): void {
    this.mpls.removeBySource("ldp");
  }

  private sendManagement(
    destination: IpAddress,
    payload: UdpDatagram | TcpSegment,
    source?: IpAddress,
  ): void {
    if (ipFamilyOf(destination) === "ipv6") {
      const src = source ?? this.managementSourceAddress("ipv6", destination);
      if (src === undefined) return;
      this.originateIpv6({
        kind: "ipv6",
        src,
        dst: destination,
        nextHeader: payload.kind === "udp" ? Ipv6NextHeader.UDP : Ipv6NextHeader.TCP,
        hopLimit: DEFAULT_IPV6_HOP_LIMIT,
        payload,
      });
      return;
    }
    const src = source ?? this.managementSourceAddress("ipv4", destination);
    if (src === undefined) return;
    this.originate({
      kind: "ipv4",
      src,
      dst: destination,
      protocol: payload.kind === "udp" ? IpProtocol.UDP : IpProtocol.TCP,
      ttl: payload.kind === "tcp"
        ? (this.bgp.outboundTtl(destination as Ipv4) ?? DEFAULT_IP_TTL)
        : DEFAULT_IP_TTL,
      payload,
    });
  }

  /** Originate a locally-generated packet (echo reply, ICMP error). */
  private originate(packet: Ipv4Packet): void {
    const route = this.resolve(packet.dst);
    if (!route) return; // cannot reach the destination: drop silently
    this.egressSend(packet, route.egress, route.nextHopIp);
  }

  private sendIcmpError(type: IcmpType, code: IcmpCode, offending: Ipv4Packet, ingress: L3Interface): void {
    if (ingress.ip === undefined) return;
    const icmp: IcmpMessage = { kind: "icmp", type, code, identifier: 0, sequence: 0 };
    this.engine.trace({
      time: this.engine.now(),
      type: "icmp-error",
      device: this.id,
      detail: { dst: offending.src, icmpType: type, code },
    });
    this.originate({
      kind: "ipv4",
      src: ingress.ip,
      dst: offending.src,
      protocol: IpProtocol.ICMP,
      ttl: DEFAULT_IP_TTL,
      payload: icmp,
    });
  }

  private egressSend(packet: Ipv4Packet, egress: L3Interface, nextHopIp: Ipv4): void {
    if (egress.ip === undefined) return;
    if (!this.permitByAcl(packet, egress, "out")) return;
    // A tunnel has no cable and no next hop of its own: the packet is
    // encapsulated and handed back to the underlay instead of being ARPed for.
    if (isTunnelInterface(egress.physical)) {
      this.sendThroughTunnel(egress, packet);
      return;
    }
    this.sendResolvedPayload(packet, EtherType.IPv4, egress, nextHopIp);
  }

  private sendResolvedPayload(
    payload: Ipv4Packet | MplsPacket,
    etherType: EtherType,
    egress: L3Interface,
    nextHopIp: Ipv4,
  ): void {
    const mac = this.arpTable.get(nextHopIp);
    if (mac !== undefined) {
      this.transmit(egress, mac, etherType, payload);
      return;
    }
    const queued = this.arpPending.get(nextHopIp);
    if (queued) {
      queued.push({ payload, etherType, egress });
    } else {
      this.arpPending.set(nextHopIp, [{ payload, etherType, egress }]);
      this.sendArpRequest(egress, nextHopIp);
    }
  }

  // --- routing table -----------------------------------------------------

  /**
   * Route selection: longest prefix wins first, then the lowest administrative
   * distance, then the lowest metric, then a stable tie-break on the next hop
   * and egress name so two engines always choose the same path.
   */
  private resolve(dst: Ipv4, ignoreTunnelState = false, includeBgp = true): ResolvedRoute | undefined {
    const dstInt = ipToInt(dst);
    interface Candidate {
      prefixLen: number;
      distance: number;
      metric: number;
      egress: L3Interface;
      nextHopIp: Ipv4;
    }
    let best: Candidate | undefined;
    const consider = (candidate: Candidate): void => {
      if (!best
        || candidate.prefixLen > best.prefixLen
        || (candidate.prefixLen === best.prefixLen && (
          candidate.distance < best.distance
          || (candidate.distance === best.distance && (
            candidate.metric < best.metric
            || (candidate.metric === best.metric && (
              ipToInt(candidate.nextHopIp) < ipToInt(best.nextHopIp)
              || (candidate.nextHopIp === best.nextHopIp
                && candidate.egress.name.localeCompare(best.egress.name) < 0)))))))) {
        best = candidate;
      }
    };

    // Connected routes: directly reachable, next hop is the destination itself.
    for (const iface of this.l3.values()) {
      if (iface.ip === undefined) continue;
      // A physical connected route disappears with link/admin down. The
      // underlay-only tunnel resolver may intentionally inspect a down tunnel,
      // but that exception never makes a down physical port reachable.
      if (!iface.physical.operationalUp
        && (!ignoreTunnelState || !isTunnelInterface(iface.physical))) continue;
      const network = (ipToInt(iface.ip) & iface.maskInt) >>> 0;
      if (((dstInt & iface.maskInt) >>> 0) !== network) continue;
      consider({
        prefixLen: popcount(iface.maskInt),
        distance: ROUTE_ADMINISTRATIVE_DISTANCE.connected,
        metric: 0,
        egress: iface,
        nextHopIp: dst,
      });
    }

    // Static routes: resolve the configured next hop against a connected subnet.
    for (const route of this.staticRoutes) {
      if (((dstInt & route.maskInt) >>> 0) !== route.network) continue;
      const egress = this.connectedInterfaceFor(route.nextHop, ignoreTunnelState);
      if (!egress) continue; // next hop not directly connected: unusable
      consider({
        prefixLen: route.prefixLen,
        distance: ROUTE_ADMINISTRATIVE_DISTANCE.static,
        metric: 0,
        egress,
        nextHopIp: route.nextHop,
      });
    }

    // OSPF-learned routes.
    if (this.ospf.enabled) {
      for (const route of this.ospf.routeTable()) {
        if (((dstInt & route.maskInt) >>> 0) !== ((ipToInt(route.network) & route.maskInt) >>> 0)) continue;
        const egress = this.l3.get(route.interfaceId);
        if (!egress?.physical.operationalUp || route.nextHop === undefined) continue;
        consider({
          prefixLen: popcount(route.maskInt),
          distance: ROUTE_ADMINISTRATIVE_DISTANCE.ospf,
          metric: route.cost,
          egress,
          nextHopIp: route.nextHop,
        });
      }
    }

    if (includeBgp) {
      for (const route of this.bgp.selectedRoutes()) {
        if (route.source === "local") continue;
        const maskInt = maskToInt(route.prefixLength);
        if (((dstInt & maskInt) >>> 0) !== ipToInt(route.network)) continue;
        const underlay = this.resolve(route.nextHop, ignoreTunnelState, false);
        if (!underlay) continue;
        consider({
          prefixLen: route.prefixLength,
          distance: route.source === "ebgp" ? 20 : 200,
          metric: route.igpMetric,
          egress: underlay.egress,
          nextHopIp: route.nextHop,
        });
      }
    }

    return best ? {
      egress: best.egress,
      nextHopIp: best.nextHopIp,
      metric: best.metric,
      administrativeDistance: best.distance,
    } : undefined;
  }

  private resolveIpv6(destinationInput: Ipv6): ResolvedIpv6Route | undefined {
    const destination = normalizeIpv6(destinationInput);
    interface Candidate extends ResolvedIpv6Route {
      readonly prefixLength: number;
      readonly distance: number;
      readonly metric: number;
    }
    let best: Candidate | undefined;
    const consider = (candidate: Candidate): void => {
      if (!best
        || candidate.prefixLength > best.prefixLength
        || (candidate.prefixLength === best.prefixLength && (
          candidate.distance < best.distance
          || (candidate.distance === best.distance && (
            candidate.metric < best.metric
            || (candidate.metric === best.metric && (
              ipv6ToBigInt(candidate.nextHopIp) < ipv6ToBigInt(best.nextHopIp)
              || (candidate.nextHopIp === best.nextHopIp
                && candidate.egress.name.localeCompare(best.egress.name) < 0)))))))) {
        best = candidate;
      }
    };

    for (const iface of this.l3.values()) {
      if (!iface.physical.operationalUp) continue;
      for (const assignment of iface.ipv6.summaries()) {
        if (assignment.state === "tentative" || assignment.state === "duplicate") continue;
        if (!ipv6InPrefix(destination, assignment.address, assignment.prefixLength)) continue;
        consider({
          prefixLength: assignment.prefixLength,
          distance: 0,
          metric: 0,
          egress: iface,
          nextHopIp: destination,
        });
      }
    }
    for (const route of this.ipv6StaticRoutes) {
      if (!ipv6InPrefix(destination, route.network, route.prefixLength)) continue;
      const egress = this.connectedIpv6InterfaceFor(route.nextHop);
      if (!egress) continue;
      consider({
        prefixLength: route.prefixLength,
        distance: 1,
        metric: 0,
        egress,
        nextHopIp: route.nextHop,
      });
    }
    if (this.ospfv3.enabled) {
      for (const route of this.ospfv3.routeTable()) {
        if (!ipv6InPrefix(destination, route.network, route.prefixLength)) continue;
        const egress = this.l3.get(route.interfaceId);
        if (!egress?.physical.operationalUp) continue;
        consider({
          prefixLength: route.prefixLength,
          distance: route.administrativeDistance,
          metric: route.cost,
          egress,
          nextHopIp: route.nextHop,
        });
      }
    }
    return best ? { egress: best.egress, nextHopIp: best.nextHopIp } : undefined;
  }

  private connectedIpv6InterfaceFor(address: Ipv6): L3Interface | undefined {
    for (const iface of this.l3.values()) {
      if (!iface.physical.operationalUp) continue;
      for (const assignment of iface.ipv6.summaries()) {
        if (assignment.state === "tentative" || assignment.state === "duplicate") continue;
        if (ipv6InPrefix(address, assignment.address, assignment.prefixLength)) return iface;
      }
    }
    return undefined;
  }

  private sourceIpv6Address(iface: L3Interface, destination: Ipv6): Ipv6 | undefined {
    return iface.ipv6.sourceFor(destination);
  }

  private isOwnIpv6(address: Ipv6): boolean {
    for (const iface of this.l3.values()) {
      if (iface.ipv6.owns(address)) return true;
    }
    return false;
  }

  private connectedInterfaceFor(ip: Ipv4, ignoreTunnelState = false): L3Interface | undefined {
    const ipInt = ipToInt(ip);
    for (const iface of this.l3.values()) {
      if (iface.ip === undefined || iface.vrfId !== undefined) continue;
      if (!iface.physical.operationalUp
        && (!ignoreTunnelState || !isTunnelInterface(iface.physical))) continue;
      const network = (ipToInt(iface.ip) & iface.maskInt) >>> 0;
      if (((ipInt & iface.maskInt) >>> 0) === network) return iface;
    }
    return undefined;
  }

  private connectedVrfRoutes(vrfId: string): VrfRoute[] {
    return [...this.l3.values()]
      .filter((iface): iface is L3Interface & { ip: Ipv4 } =>
        iface.vrfId === vrfId && iface.ip !== undefined && iface.physical.operationalUp)
      .map((iface) => ({
        network: intToIp((ipToInt(iface.ip) & iface.maskInt) >>> 0),
        prefixLength: popcount(iface.maskInt),
        source: "connected" as const,
        outgoingInterfaceId: iface.name,
        administrativeDistance: 0,
        metric: 0,
      }));
  }

  private connectedVrfInterfaceFor(vrfId: string, address: Ipv4, requireOperational = true): L3Interface | undefined {
    const value = ipToInt(address);
    return [...this.l3.values()]
      .filter((iface): iface is L3Interface & { ip: Ipv4 } =>
        iface.vrfId === vrfId && iface.ip !== undefined && (!requireOperational || iface.physical.operationalUp))
      .sort((a, b) => b.name.localeCompare(a.name))
      .find((iface) => ((value & iface.maskInt) >>> 0) === ((ipToInt(iface.ip) & iface.maskInt) >>> 0));
  }

  private isOwnIp(ip: Ipv4): boolean {
    for (const iface of this.l3.values()) {
      if (iface.vrfId === undefined && iface.ip === ip) return true;
    }
    return false;
  }

  private isOwnIpInContext(ip: Ipv4, vrfId: string | undefined): boolean {
    return [...this.l3.values()].some((iface) => iface.vrfId === vrfId && iface.ip === ip);
  }

  private permitByAcl(packet: Ipv4Packet, iface: L3Interface, direction: AclDirection): boolean {
    const decision = this.packetPolicy.evaluate(iface.name, direction, packet);
    if (!decision) return true;
    const detail = {
      aclId: decision.aclId,
      interface: decision.interfaceName,
      direction: decision.direction,
      sequence: decision.sequence ?? null,
      action: decision.action,
      implicit: decision.implicit,
      source: packet.src,
      destination: packet.dst,
      protocol: packet.protocol,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: "acl-evaluated",
      device: this.id,
      detail,
    });
    this.engine.trace({
      time: this.engine.now(),
      type: decision.implicit
        ? "acl-implicit-deny"
        : decision.action === "permit"
          ? "acl-permitted"
          : "acl-denied",
      device: this.id,
      detail,
    });
    return decision.action === "permit";
  }

  private permitByIpv6Acl(packet: Ipv6Packet, iface: L3Interface, direction: AclDirection): boolean {
    const decision = this.packetPolicy.evaluateIpv6(iface.name, direction, packet);
    if (!decision) return true;
    const detail = {
      aclId: decision.aclId,
      interface: decision.interfaceName,
      direction: decision.direction,
      sequence: decision.sequence ?? null,
      action: decision.action,
      implicit: decision.implicit,
      source: packet.src,
      destination: packet.dst,
      nextHeader: packet.nextHeader,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: decision.action === "permit" ? "ipv6-acl-permitted" : "ipv6-acl-denied",
      device: this.id,
      detail,
    });
    if (
      decision.action === "deny"
      && packet.nextHeader === Ipv6NextHeader.ICMPv6
      && packet.payload.kind === "icmpv6"
      && packet.payload.type >= Icmpv6Type.RouterSolicitation
      && packet.payload.type <= Icmpv6Type.NeighborAdvertisement
    ) {
      const problem = `IPv6 ACL ${decision.aclId} blocked required ICMPv6 control traffic on ${iface.name}; NDP or SLAAC may fail.`;
      if (!this.ipv6Problems.includes(problem)) this.ipv6Problems.push(problem);
    }
    return decision.action === "permit";
  }

  private natContext(outside: L3Interface) {
    return {
      nowNs: this.engine.now(),
      outsideInterfaceAddress: outside.ip,
      aclPermits: (aclId: string, packet: Ipv4Packet) => this.packetPolicy.aclPermits(aclId, packet),
    };
  }

  private traceNatTranslation(
    addressField: "source" | "destination",
    before: Ipv4Packet,
    result: NatTranslationResult,
  ): void {
    if (!result.translation) return;
    this.engine.trace({
      time: this.engine.now(),
      type: "nat-translated",
      device: this.id,
      detail: {
        ruleId: result.translation.ruleId,
        kind: result.translation.kind,
        protocol: result.translation.protocol,
        addressField,
        originalAddress: addressField === "source" ? before.src : before.dst,
        translatedAddress: addressField === "source" ? result.packet.src : result.packet.dst,
        originalToken: addressField === "source"
          ? packetTransportToken(before, "source")
          : packetTransportToken(before, "destination"),
        translatedToken: addressField === "source"
          ? packetTransportToken(result.packet, "source")
          : packetTransportToken(result.packet, "destination"),
      },
    });
  }

  private traceNatError(error: NatError, ingress: L3Interface, packet: Ipv4Packet): void {
    this.engine.trace({
      time: this.engine.now(),
      type: "nat-no-translation",
      device: this.id,
      detail: {
        code: error.code,
        interface: ingress.name,
        source: packet.src,
        destination: packet.dst,
        protocol: packet.protocol,
      },
    });
  }

  // --- DHCP server -------------------------------------------------------

  private handleDhcp(udp: UdpDatagram, ingress: L3Interface): void {
    const msg = udp.payload;
    if (msg.kind !== "dhcp") return;
    const pool = this.poolForInterface(ingress);
    if (!pool) return;

    if (msg.messageType === DhcpMessageType.Discover) {
      const offer = this.allocate(pool, msg.clientMac);
      if (offer === undefined) return; // pool exhausted
      this.sendDhcpReply(ingress, pool, DhcpMessageType.Offer, msg, offer);
    } else if (msg.messageType === DhcpMessageType.Request) {
      const requested = msg.requestedIp ?? pool.leases.get(msg.clientMac);
      const assigned = this.allocate(pool, msg.clientMac, requested);
      if (assigned === undefined || (requested !== undefined && assigned !== requested)) {
        this.sendDhcpReply(ingress, pool, DhcpMessageType.Nak, msg, undefined);
        return;
      }
      this.sendDhcpReply(ingress, pool, DhcpMessageType.Ack, msg, assigned);
    }
  }

  private poolForInterface(iface: L3Interface): DhcpPool | undefined {
    if (iface.ip === undefined) return undefined;
    const ipInt = ipToInt(iface.ip);
    for (const pool of this.dhcpPools) {
      if (((ipInt & pool.maskInt) >>> 0) === pool.network) return pool;
    }
    return undefined;
  }

  /** Reuse or allocate a lease for `clientMac`, honouring a requested address. */
  private allocate(pool: DhcpPool, clientMac: Mac, requested?: Ipv4): Ipv4 | undefined {
    const key = normalizeMac(clientMac);
    const existing = pool.leases.get(key);
    if (existing !== undefined) {
      if (requested === undefined || requested === existing) return existing;
      // Client asked for a different address than its lease: only honour it if free.
    }
    if (requested !== undefined && this.isAssignable(pool, requested) && !pool.assigned.has(requested)) {
      return this.commitLease(pool, key, requested);
    }
    for (let n = pool.rangeStart; n <= pool.rangeEnd; n++) {
      const candidate = intToIp(n);
      if (pool.assigned.has(candidate)) continue;
      if (!this.isAssignable(pool, candidate)) continue;
      return this.commitLease(pool, key, candidate);
    }
    return undefined;
  }

  private commitLease(pool: DhcpPool, clientMac: Mac, ip: Ipv4): Ipv4 {
    const prior = pool.leases.get(clientMac);
    if (prior !== undefined && prior !== ip) pool.assigned.delete(prior);
    pool.leases.set(clientMac, ip);
    pool.assigned.add(ip);
    return ip;
  }

  /** Never hand out the gateway or one of the router's own addresses. */
  private isAssignable(pool: DhcpPool, ip: Ipv4): boolean {
    if (ip === pool.gateway) return false;
    if (this.isOwnIp(ip)) return false;
    const ipInt = ipToInt(ip);
    return ipInt >= pool.rangeStart && ipInt <= pool.rangeEnd;
  }

  private sendDhcpReply(
    iface: L3Interface,
    pool: DhcpPool,
    messageType: number,
    request: DhcpMessage,
    yourIp: Ipv4 | undefined,
  ): void {
    if (iface.ip === undefined) return;
    const dhcp: DhcpMessage = {
      kind: "dhcp",
      messageType: messageType as DhcpMessage["messageType"],
      transactionId: request.transactionId,
      clientMac: request.clientMac,
      yourIp,
      serverIp: iface.ip,
      subnetMask: pool.mask,
      gateway: pool.gateway,
      leaseSeconds: pool.leaseSeconds,
    };
    const udp: UdpDatagram = {
      kind: "udp",
      srcPort: DHCP_SERVER_PORT,
      dstPort: DHCP_CLIENT_PORT,
      payload: dhcp,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: "dhcp-server",
      device: this.id,
      detail: { messageType, yourIp, clientMac: normalizeMac(request.clientMac) },
    });
    // Client has no address yet, so the reply is broadcast within the segment.
    const packet: Ipv4Packet = {
      kind: "ipv4",
      src: iface.ip,
      dst: BROADCAST_IP,
      protocol: IpProtocol.UDP,
      ttl: DEFAULT_IP_TTL,
      payload: udp,
    };
    if (this.permitByAcl(packet, iface, "out")) {
      this.transmit(iface, BROADCAST_MAC, EtherType.IPv4, packet);
    }
  }

  // --- transmit helper ---------------------------------------------------

  private transmit(
    iface: L3Interface,
    dstMac: Mac,
    etherType: EtherType,
    payload: ArpPacket | Ipv4Packet | Ipv6Packet | MplsPacket,
  ): void {
    const frame: EthernetFrame = {
      src: iface.physical.mac,
      dst: dstMac,
      etherType,
      // A native subinterface egresses untagged; a tagged subinterface keeps its tag.
      vlan: iface.native ? undefined : iface.vlan,
      payload,
    };
    this.emit(iface, frame);
  }

  // --- QoS pipeline ------------------------------------------------------
  //
  // Output order is fixed and covered by tests:
  //   route/policy decision -> QoS classification -> marking -> transmit
  // Input order is:
  //   receive -> input QoS classification/marking -> ACL/NAT/routing pipeline

  /** Everything a QoS match rule may need beyond the packet itself. */
  protected qosContext(flowId?: string): QosEvaluationContext {
    return {
      nowNs: this.engine.now(),
      flowId,
      aclPermits: (aclId, packet) =>
        this.packetPolicy.hasAcl(aclId) && this.packetPolicy.aclPermits(aclId, packet),
      ipv6AclPermits: (aclId, packet) =>
        this.packetPolicy.hasIpv6Acl(aclId) && this.packetPolicy.ipv6AclPermits(aclId, packet),
    };
  }

  /**
   * The single egress point of the routed data plane. Classification and marking
   * happen here, after the routing and ACL/NAT decision and before the frame
   * reaches the interface's deterministic egress queue.
   */
  protected emit(iface: L3Interface, frame: EthernetFrame): void {
    const outcome = this.applyOutputQos(iface, frame);
    if (!outcome.frame) return; // policed away before it reached the queue
    iface.physical.transmit(outcome.frame, outcome.className);
  }

  protected applyOutputQos(
    iface: L3Interface,
    frame: EthernetFrame,
  ): {
    frame: EthernetFrame | undefined;
    className: string;
    classification: QosClassificationResult | undefined;
  } {
    const payload = frame.payload;
    const untouched = { frame, className: QOS_CLASS_DEFAULT, classification: undefined };
    if (payload.kind !== "ipv4" && payload.kind !== "ipv6") return untouched;
    if (!this.qos.policyFor(iface.name, "output")) return untouched;
    const subject = {
      packet: payload,
      wireSizeBytes: estimatePacketWireSizeBytes(frame),
      cos: frame.pcp,
    };
    const classification = this.qos.classify(iface.name, "output", subject, this.qosContext());
    if (!classification) return untouched;
    this.traceQos(classification, subject.packet, iface.name, subject.wireSizeBytes);

    const policed = this.applyPolicer(classification, subject.wireSizeBytes, iface.name, "output");
    if (policed.dropped) return { frame: undefined, className: classification.className, classification };

    const marking = this.qos.applyMarking(
      subject,
      policed.dscp === undefined
        ? classification.policyClass.marking
        : { ...classification.policyClass.marking, dscp: policed.dscp },
      frame.pcp,
    );
    if (!marking.changed) return { frame, className: classification.className, classification };
    this.qos.recordMarked(classification);
    this.engine.trace({
      time: this.engine.now(),
      type: "qos-marked",
      device: this.id,
      detail: {
        interface: iface.name,
        direction: "output",
        class: classification.className,
        policy: classification.policyMapId,
        dscpBefore: marking.dscpBefore,
        dscpAfter: marking.dscpAfter,
        cosBefore: marking.cosBefore ?? null,
        cosAfter: marking.cosAfter ?? null,
      },
    });
    return {
      // A CoS only exists inside an 802.1Q tag: an untagged egress frame never
      // gains a priority code point, however the policy was written.
      frame: {
        ...frame,
        payload: marking.packet,
        pcp: frame.vlan === undefined ? undefined : marking.cosAfter,
      },
      className: classification.className,
      classification,
    };
  }

  /**
   * Token-bucket policing. Conforming traffic is transmitted, exceeding traffic
   * is dropped or marked down — and either way the packet is never delayed.
   */
  private applyPolicer(
    classification: QosClassificationResult,
    wireSizeBytes: number,
    interfaceName: string,
    direction: QosDirection,
  ): { dropped: boolean; dscp: number | undefined } {
    if (!classification.policyClass.police) return { dropped: false, dscp: undefined };
    const verdict = this.qos.police(classification, wireSizeBytes, this.engine.now());
    const detail = {
      interface: interfaceName,
      direction,
      policy: classification.policyMapId,
      class: classification.className,
      bytes: wireSizeBytes,
      rateBps: classification.policyClass.police.rateBps,
    };
    if (verdict.action === "conform") {
      this.engine.trace({ time: this.engine.now(), type: "qos-police-conform", device: this.id, detail });
      return { dropped: false, dscp: undefined };
    }
    this.engine.trace({ time: this.engine.now(), type: "qos-police-exceed", device: this.id, detail });
    if (verdict.action === "exceed-mark") return { dropped: false, dscp: verdict.dscp };
    this.qos.recordDropped(classification);
    this.engine.trace({ time: this.engine.now(), type: "qos-police-dropped", device: this.id, detail });
    return { dropped: true, dscp: undefined };
  }

  /**
   * Input QoS runs before ACL, NAT and routing so a re-marked packet is what the
   * rest of the pipeline sees. Returns `undefined` when the policy dropped it.
   */
  protected applyInputQos<T extends Ipv4Packet | Ipv6Packet>(
    ingress: L3Interface,
    frame: EthernetFrame,
    packet: T,
  ): T | undefined {
    if (!this.qos.policyFor(ingress.name, "input")) return packet;
    const subject = {
      packet,
      wireSizeBytes: estimatePacketWireSizeBytes(frame),
      cos: frame.pcp,
    };
    const classification = this.qos.classify(ingress.name, "input", subject, this.qosContext());
    if (!classification) return packet;
    this.traceQos(classification, packet, ingress.name, subject.wireSizeBytes, "input");
    const policed = this.applyPolicer(classification, subject.wireSizeBytes, ingress.name, "input");
    if (policed.dropped) return undefined;
    const marking = this.qos.applyMarking(
      subject,
      policed.dscp === undefined
        ? classification.policyClass.marking
        : { ...classification.policyClass.marking, dscp: policed.dscp },
      frame.pcp,
    );
    if (!marking.changed) return packet;
    this.qos.recordMarked(classification);
    this.engine.trace({
      time: this.engine.now(),
      type: "qos-marked",
      device: this.id,
      detail: {
        interface: ingress.name,
        direction: "input",
        class: classification.className,
        policy: classification.policyMapId,
        dscpBefore: marking.dscpBefore,
        dscpAfter: marking.dscpAfter,
      },
    });
    return marking.packet as T;
  }

  private traceQos(
    classification: QosClassificationResult,
    packet: Ipv4Packet | Ipv6Packet,
    interfaceName: string,
    bytes: number,
    direction: QosDirection = "output",
  ): void {
    const detail = {
      interface: interfaceName,
      direction,
      policy: classification.policyMapId,
      class: classification.className,
      dscp: dscpOf(packet),
      bytes,
    };
    this.engine.trace({
      time: this.engine.now(),
      type: classification.className === QOS_CLASS_DEFAULT && !classification.matched
        ? "qos-class-default"
        : "qos-classified",
      device: this.id,
      detail,
    });
    this.engine.trace({
      time: this.engine.now(),
      type: "qos-policy-applied",
      device: this.id,
      detail,
    });
  }

  private requirePhysical(name: string): EthernetInterface {
    const physical = this.interfaces.get(name);
    if (!physical) throw new Error(`Router ${this.id} has no interface ${name}`);
    return physical;
  }
}

export function loopbackName(index: number): string {
  return `Loopback${index}`;
}

/** Parse "Loopback0"; returns undefined for anything else. */
export function parseLoopbackName(name: string): number | undefined {
  if (!/^loopback\d+$/i.test(name)) return undefined;
  const index = Number(name.slice("Loopback".length));
  return Number.isInteger(index) ? index : undefined;
}

/** Count set bits in a 32-bit mask -> prefix length. */
function popcount(maskInt: number): number {
  let n = maskInt >>> 0;
  let count = 0;
  while (n) {
    n &= n - 1;
    count++;
  }
  return count;
}

/**
 * Translate a policy map into the queue structure an interface can schedule.
 * `priority percent` becomes an explicit bits-per-second allowance against the
 * link capacity, so the built-in LLQ policer is a real bound and not a guess.
 */
function egressProfileOf(
  policy: QosPolicyMap,
  interfaceName: string,
  capacityBps: number,
): EgressQueueProfile {
  const classes: EgressClassProfile[] = policy.classes.map((entry) => {
    const priorityRateBps = entry.priority?.rateBps
      ?? (entry.priority?.percent !== undefined && capacityBps > 0
        ? Math.max(1, Math.round((capacityBps * entry.priority.percent) / 100))
        : undefined);
    return {
      className: entry.className,
      kind: entry.priority
        ? "priority"
        : entry.className === QOS_CLASS_DEFAULT
          ? "default"
          : "bandwidth",
      priorityRateBps,
      bandwidthPercent: entry.bandwidthPercent,
      shapeRateBps: entry.shape?.averageRateBps,
      shapeBurstBytes: entry.shape?.burstBytes,
      queueLimitPackets: entry.queueLimitPackets,
    };
  });
  if (!classes.some((entry) => entry.className === QOS_CLASS_DEFAULT)) {
    classes.push({ className: QOS_CLASS_DEFAULT, kind: "default" });
  }
  return { policyMapId: policy.id, interfaceName, classes };
}

function packetTransportToken(
  packet: Ipv4Packet,
  side: "source" | "destination",
): number | undefined {
  if (packet.payload.kind === "tcp" || packet.payload.kind === "udp") {
    return side === "source" ? packet.payload.srcPort : packet.payload.dstPort;
  }
  if (packet.payload.kind === "icmp") return packet.payload.identifier;
  return undefined;
}

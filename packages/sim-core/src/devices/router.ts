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
  DEFAULT_PING_TIMEOUT_NS,
  DHCP_CLIENT_PORT,
  DHCP_SERVER_PORT,
} from "../engine/constants";
import { EthernetInterface } from "../net/interface";
import type { ArpPacket } from "../packets/arp";
import type { DhcpMessage } from "../packets/dhcp";
import type { CdpPacket, DiscoveryCapability, LldpPacket } from "../packets/discovery";
import { type EthernetFrame, isControlPayload } from "../packets/ethernet";
import type { IcmpMessage } from "../packets/icmp";
import {
  OSPF_ALL_DESIGNATED_ROUTERS_MAC,
  OSPF_ALL_ROUTERS_MAC,
  OSPF_PROTOCOL,
  type OspfPacket,
} from "../packets/ospf";
import { discoveryCapabilitiesFor, discoveryPlatformFor, supportsCdp } from "../protocols/discovery-support";
import { NeighborDiscovery } from "../protocols/neighbor-discovery";
import {
  OSPF_ADMINISTRATIVE_DISTANCE,
  OspfProcess,
  type OspfInterfaceDescriptor,
} from "../protocols/ospf";
import type { Ipv4Packet } from "../packets/ipv4";
import type { UdpDatagram } from "../packets/udp";
import {
  type AclBinding,
  type AclCounter,
  type AclDirection,
  type AclRuleBudget,
  type Ipv4Acl,
  PacketPolicyEngine,
  PacketPolicyError,
} from "../policy/packet-policy-engine";
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
  BROADCAST_IP,
  intToIp,
  type Ipv4,
  ipToInt,
  maskToInt,
} from "../util/ipv4";
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

export type RouteSource = "connected" | "static" | "ospf";

/** Cisco-like administrative distances for the sources this release models. */
export const ROUTE_ADMINISTRATIVE_DISTANCE: Readonly<Record<RouteSource, number>> = Object.freeze({
  connected: 0,
  static: 1,
  ospf: OSPF_ADMINISTRATIVE_DISTANCE,
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
  /** CDP/LLDP neighbour discovery; both start disabled until configured. */
  readonly discovery = new NeighborDiscovery(this, supportsCdp(this.deviceType));
  /** Deterministic OSPFv2 area-0 process; inert until `router ospf` runs. */
  readonly ospf = new OspfProcess(this);
  private readonly l3 = new Map<string, L3Interface>();
  private readonly loopbacks = new Map<number, LoopbackInterface>();
  private readonly natRoles = new Map<string, NatInterfaceRole>();
  private readonly staticRoutes: StaticRoute[] = [];
  private readonly dhcpPools: DhcpPool[] = [];
  private forwardingEnabled = true;
  readonly pingResults: Array<{ sequence: number; success: boolean; rttNs?: number }> = [];
  private readonly pendingPings = new Map<number, number>();

  readonly arpTable = new Map<Ipv4, Mac>();
  /** IPv4 packets awaiting ARP resolution, keyed by next-hop IP. */
  private readonly arpPending = new Map<Ipv4, { packet: Ipv4Packet; egress: L3Interface }[]>();

  // --- configuration -----------------------------------------------------

  override onAddedToEngine(): void {
    this.packetPolicy.useRuleBudget(this.engine.aclRuleBudget);
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
    };
    this.l3.set(iface.name, iface);
    return iface;
  }

  removeInterface(name: string): void {
    this.l3.delete(name);
    this.natRoles.delete(name);
  }

  setForwardingEnabled(enabled: boolean): void {
    this.forwardingEnabled = enabled;
  }

  get ipRoutingEnabled(): boolean {
    return this.forwardingEnabled;
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
    };
    this.l3.set(name, iface);
    return iface;
  }

  /** `ip address <ip> <mask>`: set the address on an existing L3 interface. */
  setInterfaceIp(name: string, ip: Ipv4, mask: Ipv4 | number): void {
    const iface = this.l3.get(name);
    if (!iface) throw new Error(`Router ${this.id} has no L3 interface ${name}`);
    iface.ip = ip;
    iface.maskInt = maskToInt(mask);
    this.ospf.arm();
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
    };
    this.l3.set(name, iface);
    this.ospf.arm();
    return iface;
  }

  removeLoopback(index: number): void {
    const name = loopbackName(index);
    this.l3.delete(name);
    this.loopbacks.delete(index);
    this.ospf.arm();
  }

  isLoopback(name: string): boolean {
    return this.l3.get(name)?.physical instanceof LoopbackInterface;
  }

  /** Loopback numbers currently configured, in numeric order. */
  loopbackNumbers(): number[] {
    return [...this.loopbacks.keys()].sort((a, b) => a - b);
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

  /** `show ip route`: connected, then static, then OSPF-learned routes. */
  routingTable(): RouteRow[] {
    const rows: RouteRow[] = [];
    for (const iface of this.l3.values()) {
      if (iface.ip === undefined) continue;
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
        if (iface.ip === undefined || iface.maskInt !== route.maskInt) continue;
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
    if (dstMac !== myMac && !isBroadcastMac(dstMac) && !ospfGroup) return; // not addressed to us

    const payload = frame.payload;
    if (payload.kind === "arp") {
      this.handleArp(payload, iface);
    } else if (payload.kind === "ipv4") {
      this.handleIpv4(payload, frame, iface);
    }
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
  }

  // --- OSPF host ----------------------------------------------------------

  ospfInterfaces(): readonly OspfInterfaceDescriptor[] {
    return [...this.l3.values()]
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
      if (iface.ip === undefined) continue;
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
    for (const { packet, egress } of queued) this.transmit(egress, mac, EtherType.IPv4, packet);
  }

  // --- IPv4 / ICMP -------------------------------------------------------

  private handleIpv4(packet: Ipv4Packet, frame: EthernetFrame, ingress: L3Interface): void {
    // OSPF is this router's own control traffic. It is delivered to the local
    // process before the NAT and ACL pipeline, so a lab can never accidentally
    // filter away its own adjacencies while learning about ACLs.
    if (packet.protocol === OSPF_PROTOCOL && packet.payload.kind === "ospf") {
      this.ospf.onPacket(packet.payload, ingress.name, packet.src);
      return;
    }
    let acceptedPacket = packet;
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

    if (this.isOwnIp(acceptedPacket.dst)) {
      this.deliverLocal(acceptedPacket);
      return;
    }
    this.forward(acceptedPacket, ingress);
  }

  private deliverLocal(packet: Ipv4Packet): void {
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
    const mac = this.arpTable.get(nextHopIp);
    if (mac !== undefined) {
      this.transmit(egress, mac, EtherType.IPv4, packet);
      return;
    }
    const queued = this.arpPending.get(nextHopIp);
    if (queued) {
      queued.push({ packet, egress });
    } else {
      this.arpPending.set(nextHopIp, [{ packet, egress }]);
      this.sendArpRequest(egress, nextHopIp);
    }
  }

  // --- routing table -----------------------------------------------------

  /**
   * Route selection: longest prefix wins first, then the lowest administrative
   * distance, then the lowest metric, then a stable tie-break on the next hop
   * and egress name so two engines always choose the same path.
   */
  private resolve(dst: Ipv4): ResolvedRoute | undefined {
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
      const egress = this.connectedInterfaceFor(route.nextHop);
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
        if (!egress || route.nextHop === undefined) continue;
        consider({
          prefixLen: popcount(route.maskInt),
          distance: ROUTE_ADMINISTRATIVE_DISTANCE.ospf,
          metric: route.cost,
          egress,
          nextHopIp: route.nextHop,
        });
      }
    }

    return best ? { egress: best.egress, nextHopIp: best.nextHopIp } : undefined;
  }

  private connectedInterfaceFor(ip: Ipv4): L3Interface | undefined {
    const ipInt = ipToInt(ip);
    for (const iface of this.l3.values()) {
      if (iface.ip === undefined) continue;
      const network = (ipToInt(iface.ip) & iface.maskInt) >>> 0;
      if (((ipInt & iface.maskInt) >>> 0) === network) return iface;
    }
    return undefined;
  }

  private isOwnIp(ip: Ipv4): boolean {
    for (const iface of this.l3.values()) {
      if (iface.ip === ip) return true;
    }
    return false;
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

  private transmit(iface: L3Interface, dstMac: Mac, etherType: EtherType, payload: ArpPacket | Ipv4Packet): void {
    const frame: EthernetFrame = {
      src: iface.physical.mac,
      dst: dstMac,
      etherType,
      // A native subinterface egresses untagged; a tagged subinterface keeps its tag.
      vlan: iface.native ? undefined : iface.vlan,
      payload,
    };
    iface.physical.transmit(frame);
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

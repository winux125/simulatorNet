import { ArpOp, DhcpMessageType, EtherType, IcmpCode, IcmpType, IpProtocol } from "@sim/contracts";
import { DEFAULT_DHCP_LEASE_SECONDS, DEFAULT_IP_TTL, DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from "../engine/constants";
import type { EthernetInterface } from "../net/interface";
import type { ArpPacket } from "../packets/arp";
import type { DhcpMessage } from "../packets/dhcp";
import type { EthernetFrame } from "../packets/ethernet";
import type { IcmpMessage } from "../packets/icmp";
import type { Ipv4Packet } from "../packets/ipv4";
import type { UdpDatagram } from "../packets/udp";
import {
  BROADCAST_IP,
  intToIp,
  type Ipv4,
  ipToInt,
  maskToInt,
} from "../util/ipv4";
import { BROADCAST_MAC, isBroadcastMac, type Mac, normalizeMac, ZERO_MAC } from "../util/mac";
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
  ip: Ipv4 | undefined;
  maskInt: number;
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

interface DhcpPool {
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
  private readonly l3 = new Map<string, L3Interface>();
  private readonly staticRoutes: StaticRoute[] = [];
  private readonly dhcpPools: DhcpPool[] = [];

  readonly arpTable = new Map<Ipv4, Mac>();
  /** IPv4 packets awaiting ARP resolution, keyed by next-hop IP. */
  private readonly arpPending = new Map<Ipv4, { packet: Ipv4Packet; egress: L3Interface }[]>();

  // --- configuration -----------------------------------------------------

  /** Assign an IP/mask directly to a physical port (a routed interface). */
  configureInterface(physicalName: string, config: L3Config): L3Interface {
    const physical = this.requirePhysical(physicalName);
    const iface: L3Interface = {
      name: physicalName,
      physical,
      vlan: undefined,
      ip: config.ip,
      maskInt: maskToInt(config.mask),
    };
    this.l3.set(iface.name, iface);
    return iface;
  }

  /** Add a dot1Q subinterface on `physicalName` for `vlan` (router-on-a-stick). */
  addSubinterface(physicalName: string, vlan: number, config: L3Config): L3Interface {
    const physical = this.requirePhysical(physicalName);
    const iface: L3Interface = {
      name: `${physicalName}.${vlan}`,
      physical,
      vlan,
      ip: config.ip,
      maskInt: maskToInt(config.mask),
    };
    this.l3.set(iface.name, iface);
    return iface;
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
    this.dhcpPools.push({
      network: (ipToInt(config.network) & maskInt) >>> 0,
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

  // --- receive path ------------------------------------------------------

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    const iface = this.l3ForIngress(ingress, frame.vlan);
    if (!iface) return; // no L3 config for this (port, vlan)

    const dstMac = normalizeMac(frame.dst);
    const myMac = normalizeMac(iface.physical.mac);
    if (dstMac !== myMac && !isBroadcastMac(dstMac)) return; // not addressed to us

    const payload = frame.payload;
    if (payload.kind === "arp") {
      this.handleArp(payload, iface);
    } else if (payload.kind === "ipv4") {
      this.handleIpv4(payload, frame, iface);
    }
  }

  private l3ForIngress(ingress: EthernetInterface, vlan: number | undefined): L3Interface | undefined {
    for (const iface of this.l3.values()) {
      if (iface.physical === ingress && iface.vlan === vlan) return iface;
    }
    return undefined;
  }

  // --- ARP ---------------------------------------------------------------

  private handleArp(arp: ArpPacket, iface: L3Interface): void {
    this.arpTable.set(arp.senderIp, normalizeMac(arp.senderMac));
    this.flushArpPending(arp.senderIp);

    if (arp.op === ArpOp.Request && iface.ip !== undefined && arp.targetIp === iface.ip) {
      const reply: ArpPacket = {
        kind: "arp",
        op: ArpOp.Reply,
        senderMac: iface.physical.mac,
        senderIp: iface.ip,
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
    // Opportunistically cache the L2 address of the L3 source.
    this.arpTable.set(packet.src, normalizeMac(frame.src));

    // DHCP server: broadcast requests are delivered locally regardless of dst IP.
    if (packet.payload.kind === "udp" && packet.payload.dstPort === DHCP_SERVER_PORT) {
      this.handleDhcp(packet.payload, ingress);
      return;
    }

    if (this.isOwnIp(packet.dst)) {
      this.deliverLocal(packet);
      return;
    }
    this.forward(packet, ingress);
  }

  private deliverLocal(packet: Ipv4Packet): void {
    if (packet.protocol !== IpProtocol.ICMP || packet.payload.kind !== "icmp") return;
    const icmp = packet.payload;
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
    this.engine.trace({
      time: this.engine.now(),
      type: "route",
      device: this.id,
      detail: { dst: packet.dst, egress: route.egress.name, nextHop: route.nextHopIp },
    });
    this.egressSend({ ...packet, ttl }, route.egress, route.nextHopIp);
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

  /** Longest-prefix match over connected + static routes. */
  private resolve(dst: Ipv4): ResolvedRoute | undefined {
    const dstInt = ipToInt(dst);
    let best: { prefixLen: number; egress: L3Interface; nextHopIp: Ipv4 } | undefined;

    // Connected routes: directly reachable, next hop is the destination itself.
    for (const iface of this.l3.values()) {
      if (iface.ip === undefined) continue;
      const network = (ipToInt(iface.ip) & iface.maskInt) >>> 0;
      if (((dstInt & iface.maskInt) >>> 0) !== network) continue;
      const prefixLen = popcount(iface.maskInt);
      if (!best || prefixLen > best.prefixLen) {
        best = { prefixLen, egress: iface, nextHopIp: dst };
      }
    }

    // Static routes: resolve the configured next hop against a connected subnet.
    for (const route of this.staticRoutes) {
      if (((dstInt & route.maskInt) >>> 0) !== route.network) continue;
      if (best && route.prefixLen <= best.prefixLen) continue;
      const egress = this.connectedInterfaceFor(route.nextHop);
      if (!egress) continue; // next hop not directly connected: unusable
      best = { prefixLen: route.prefixLen, egress, nextHopIp: route.nextHop };
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
    this.transmit(iface, BROADCAST_MAC, EtherType.IPv4, {
      kind: "ipv4",
      src: iface.ip,
      dst: BROADCAST_IP,
      protocol: IpProtocol.UDP,
      ttl: DEFAULT_IP_TTL,
      payload: udp,
    });
  }

  // --- transmit helper ---------------------------------------------------

  private transmit(iface: L3Interface, dstMac: Mac, etherType: EtherType, payload: ArpPacket | Ipv4Packet): void {
    const frame: EthernetFrame = {
      src: iface.physical.mac,
      dst: dstMac,
      etherType,
      vlan: iface.vlan,
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

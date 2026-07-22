import { ArpOp, DhcpMessageType, EtherType, IcmpType, IpProtocol } from "@sim/contracts";
import {
  DEFAULT_DHCP_TIMEOUT_NS,
  DEFAULT_IP_TTL,
  DEFAULT_PING_TIMEOUT_NS,
  DHCP_CLIENT_PORT,
  DHCP_SERVER_PORT,
} from "../engine/constants";
import type { EthernetInterface } from "../net/interface";
import type { ArpPacket } from "../packets/arp";
import type { DhcpMessage } from "../packets/dhcp";
import type { EthernetFrame } from "../packets/ethernet";
import type { IcmpMessage } from "../packets/icmp";
import type { Ipv4Packet } from "../packets/ipv4";
import type { UdpDatagram } from "../packets/udp";
import { BROADCAST_IP, type Ipv4, ipsShareNetwork, maskToInt, UNSPECIFIED_IP } from "../util/ipv4";
import { BROADCAST_MAC, type Mac, normalizeMac, ZERO_MAC } from "../util/mac";
import { Device } from "./device";

export interface DhcpLease {
  ip: Ipv4;
  mask?: Ipv4;
  gateway?: Ipv4;
  serverIp?: Ipv4;
  leaseSeconds?: number;
}

type DhcpState = "idle" | "discovering" | "requesting" | "bound" | "failed";

export interface PcConfig {
  ip?: Ipv4;
  /** Dotted mask ("255.255.255.0") or prefix length (24). */
  mask?: Ipv4 | number;
  gateway?: Ipv4;
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
export class Pc extends Device {
  ip: Ipv4 | undefined;
  maskInt = maskToInt(24);
  gateway: Ipv4 | undefined;

  readonly arpTable = new Map<Ipv4, Mac>();
  readonly pingResults: PingResult[] = [];

  /** DHCP client state (see `requestDhcp`). */
  dhcpState: DhcpState = "idle";
  dhcpBound = false;
  lease: DhcpLease | undefined;
  private dhcpXid = 0;

  /** IPv4 packets waiting on ARP resolution, keyed by next-hop IP. */
  private readonly arpPending = new Map<Ipv4, Ipv4Packet[]>();
  /** In-flight echo requests keyed by ICMP sequence number. */
  private readonly pendingPings = new Map<number, PendingPing>();
  private readonly icmpIdentifier = 0x4242;

  configure(config: PcConfig): void {
    if (config.ip !== undefined) this.ip = config.ip;
    if (config.mask !== undefined) this.maskInt = maskToInt(config.mask);
    if (config.gateway !== undefined) this.gateway = config.gateway;
  }

  /** The PC's single Ethernet interface. */
  get primary(): EthernetInterface {
    for (const iface of this.interfaces.values()) return iface;
    throw new Error(`PC ${this.id} has no interface`);
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
    if (dst !== mine && dst !== BROADCAST_MAC) return; // not for us

    const payload = frame.payload;
    if (payload.kind === "arp") {
      this.handleArp(payload);
    } else if (payload.kind === "ipv4") {
      this.handleIpv4(payload, frame);
    }
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
    if (packet.payload.kind === "udp") {
      this.handleUdp(packet.payload);
      return;
    }

    if (packet.dst !== this.ip) return; // PCs do not route
    // Opportunistically cache the L2 address of the L3 source.
    this.arpTable.set(packet.src, normalizeMac(frame.src));

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
    this.dhcpXid = this.engine.rng.nextU32();
    this.dhcpState = "discovering";
    this.dhcpBound = false;
    this.engine.trace({
      time: this.engine.now(),
      type: "dhcp-discover",
      device: this.id,
      detail: { xid: this.dhcpXid },
    });
    this.sendDhcp({ messageType: DhcpMessageType.Discover });
    this.engine.scheduleIn(DEFAULT_DHCP_TIMEOUT_NS, () => this.dhcpTimeout(this.dhcpXid));
  }

  private handleUdp(udp: UdpDatagram): void {
    if (udp.dstPort !== DHCP_CLIENT_PORT || udp.payload.kind !== "dhcp") return;
    const msg = udp.payload;
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
  }

  private sendDhcp(fields: Partial<DhcpMessage> & { messageType: DhcpMessage["messageType"] }): void {
    const dhcp: DhcpMessage = {
      kind: "dhcp",
      transactionId: this.dhcpXid,
      clientMac: this.primary.mac,
      ...fields,
    };
    const udp: UdpDatagram = {
      kind: "udp",
      srcPort: DHCP_CLIENT_PORT,
      dstPort: DHCP_SERVER_PORT,
      payload: dhcp,
    };
    const packet: Ipv4Packet = {
      kind: "ipv4",
      src: this.ip ?? UNSPECIFIED_IP,
      dst: BROADCAST_IP,
      protocol: IpProtocol.UDP,
      ttl: DEFAULT_IP_TTL,
      payload: udp,
    };
    this.primary.transmit({
      src: this.primary.mac,
      dst: BROADCAST_MAC,
      etherType: EtherType.IPv4,
      payload: packet,
    });
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

import type { EthernetFrame, L2Payload } from "../packets/ethernet";
import type { Ipv4Packet } from "../packets/ipv4";
import type { Ipv6Packet } from "../packets/ipv6";
import type { TcpSegment } from "../packets/tcp";
import type { UdpDatagram } from "../packets/udp";

/**
 * Deterministic educational wire-size model.
 *
 * SimulatorNet never serializes a frame to bytes, so a queue scheduler needs a
 * single agreed estimate of "how big is this packet on the wire". These numbers
 * follow the real header layouts closely enough to teach serialization delay;
 * they deliberately do not model preamble, inter-frame gap, or any NIC-specific
 * padding, and they are not a claim of hardware accuracy.
 */
export const WIRE_SIZE_MODEL = Object.freeze({
  /** Destination + source MAC + EtherType. */
  ethernetHeaderBytes: 14,
  /** Frame check sequence. */
  frameCheckSequenceBytes: 4,
  /** One 802.1Q tag. */
  vlanTagBytes: 4,
  /** Smallest legal Ethernet frame including the FCS. */
  minimumFrameBytes: 64,
  /** Largest frame this model will ever report, so a queue stays bounded. */
  maximumFrameBytes: 9_216,
  ipv4HeaderBytes: 20,
  ipv6HeaderBytes: 40,
  icmpHeaderBytes: 8,
  icmpv6HeaderBytes: 8,
  udpHeaderBytes: 8,
  tcpHeaderBytes: 20,
  /** Classic `ping` data length, used when a flow does not request a size. */
  defaultIcmpDataBytes: 56,
  /** Bounded stand-in for a structured application message with no explicit size. */
  defaultApplicationBytes: 64,
});

/** Fixed educational sizes for the structured payloads the engine models. */
const FIXED_PAYLOAD_BYTES: Readonly<Record<string, number>> = Object.freeze({
  arp: 28,
  bpdu: 35,
  lacp: 110,
  pagp: 76,
  cdp: 96,
  lldp: 96,
  ospf: 44,
  ospfv3: 40,
  dhcp: 300,
  dhcpv6: 100,
  dns: 64,
  http: 128,
  tftp: 128,
  ntp: 48,
  syslog: 96,
  radius: 96,
  tacacs: 96,
  snmp: 96,
  "wireless-management": 64,
});

function clampBytes(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), maximum);
}

/**
 * Explicit application size when the payload declares one, the string length
 * when the data is a string, otherwise a bounded default. Never unbounded and
 * never dependent on object iteration order.
 */
function applicationBytes(payload: { payloadBytes?: number; data?: unknown }): number {
  if (payload.payloadBytes !== undefined) {
    return clampBytes(payload.payloadBytes, WIRE_SIZE_MODEL.maximumFrameBytes);
  }
  if (typeof payload.data === "string") {
    return clampBytes(payload.data.length, WIRE_SIZE_MODEL.maximumFrameBytes);
  }
  return WIRE_SIZE_MODEL.defaultApplicationBytes;
}

function udpBytes(datagram: UdpDatagram): number {
  const payload = datagram.payload;
  const inner = payload.kind === "udp-application"
    ? applicationBytes(payload)
    : FIXED_PAYLOAD_BYTES[payload.kind] ?? WIRE_SIZE_MODEL.defaultApplicationBytes;
  return WIRE_SIZE_MODEL.udpHeaderBytes + inner;
}

function tcpBytes(segment: TcpSegment): number {
  const payload = segment.payload;
  if (!payload) return WIRE_SIZE_MODEL.tcpHeaderBytes;
  const inner = payload.kind === "tcp-application"
    ? applicationBytes(payload)
    : FIXED_PAYLOAD_BYTES[payload.kind] ?? WIRE_SIZE_MODEL.defaultApplicationBytes;
  return WIRE_SIZE_MODEL.tcpHeaderBytes + inner;
}

function ipv4Bytes(packet: Ipv4Packet): number {
  const payload = packet.payload;
  if (payload.kind === "udp") return WIRE_SIZE_MODEL.ipv4HeaderBytes + udpBytes(payload);
  if (payload.kind === "tcp") return WIRE_SIZE_MODEL.ipv4HeaderBytes + tcpBytes(payload);
  if (payload.kind === "icmp") {
    const data = payload.payloadBytes ?? WIRE_SIZE_MODEL.defaultIcmpDataBytes;
    return WIRE_SIZE_MODEL.ipv4HeaderBytes
      + WIRE_SIZE_MODEL.icmpHeaderBytes
      + clampBytes(data, WIRE_SIZE_MODEL.maximumFrameBytes);
  }
  return WIRE_SIZE_MODEL.ipv4HeaderBytes + (FIXED_PAYLOAD_BYTES[payload.kind] ?? WIRE_SIZE_MODEL.defaultApplicationBytes);
}

function ipv6Bytes(packet: Ipv6Packet): number {
  const payload = packet.payload;
  if (payload.kind === "udp") return WIRE_SIZE_MODEL.ipv6HeaderBytes + udpBytes(payload);
  if (payload.kind === "tcp") return WIRE_SIZE_MODEL.ipv6HeaderBytes + tcpBytes(payload);
  if (payload.kind === "icmpv6") {
    const data = payload.payloadBytes ?? WIRE_SIZE_MODEL.defaultIcmpDataBytes;
    return WIRE_SIZE_MODEL.ipv6HeaderBytes
      + WIRE_SIZE_MODEL.icmpv6HeaderBytes
      + clampBytes(data, WIRE_SIZE_MODEL.maximumFrameBytes);
  }
  return WIRE_SIZE_MODEL.ipv6HeaderBytes + (FIXED_PAYLOAD_BYTES[payload.kind] ?? WIRE_SIZE_MODEL.defaultApplicationBytes);
}

function l2PayloadBytes(payload: L2Payload): number {
  if (payload.kind === "ipv4") return ipv4Bytes(payload);
  if (payload.kind === "ipv6") return ipv6Bytes(payload);
  return FIXED_PAYLOAD_BYTES[payload.kind] ?? WIRE_SIZE_MODEL.defaultApplicationBytes;
}

/**
 * The single wire-size API. Every queue, policer, shaper and counter uses it, so
 * a byte count can never disagree between two protocol paths.
 */
export function estimatePacketWireSizeBytes(frame: EthernetFrame): number {
  const overhead = WIRE_SIZE_MODEL.ethernetHeaderBytes
    + WIRE_SIZE_MODEL.frameCheckSequenceBytes
    + (frame.vlan === undefined ? 0 : WIRE_SIZE_MODEL.vlanTagBytes);
  const total = overhead + l2PayloadBytes(frame.payload);
  return Math.min(
    Math.max(total, WIRE_SIZE_MODEL.minimumFrameBytes),
    WIRE_SIZE_MODEL.maximumFrameBytes,
  );
}

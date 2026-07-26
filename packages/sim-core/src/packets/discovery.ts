import type { Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";

/**
 * Structured CDP and LLDP advertisements.
 *
 * Both are educational subsets. CDP carries the handful of fields a CCNA-level
 * lab actually uses; LLDP carries the mandatory TLVs plus a management address.
 * LLDP-MED, PoE negotiation, voice VLAN, location TLVs and SNMP integration are
 * deliberately out of scope, and neither protocol advertises a duplex or speed
 * that the engine does not model.
 */

export type DiscoveryProtocol = "cdp" | "lldp";

/** Capability flags shared by both protocols, in a vendor-neutral spelling. */
export type DiscoveryCapability = "router" | "switch" | "bridge" | "host" | "station";

export const SIMULATORNET_SOFTWARE = "SimulatorNet educational implementation";

export interface CdpPacket {
  readonly kind: "cdp";
  readonly version: 2;
  readonly deviceId: string;
  readonly portId: string;
  readonly platform: string;
  readonly capabilities: readonly DiscoveryCapability[];
  readonly softwareVersion: string;
  readonly managementAddress?: Ipv4;
  readonly nativeVlan?: number;
  /** Advertised hold time; zero is an explicit withdrawal. */
  readonly holdTimeNs: number;
}

export interface LldpPacket {
  readonly kind: "lldp";
  readonly chassisId: Mac;
  readonly portId: string;
  readonly portDescription?: string;
  readonly systemName: string;
  readonly systemDescription: string;
  readonly capabilities: readonly DiscoveryCapability[];
  readonly managementAddress?: Ipv4;
  /** LLDP TTL; a shutdown frame carries TTL 0. */
  readonly ttlNs: number;
}

export function isDiscoveryWithdrawal(packet: CdpPacket | LldpPacket): boolean {
  return packet.kind === "cdp" ? packet.holdTimeNs <= 0 : packet.ttlNs <= 0;
}

/** Cisco-style single-letter capability codes for `show cdp neighbors`. */
export function capabilityCode(capability: DiscoveryCapability): string {
  if (capability === "router") return "R";
  if (capability === "switch") return "S";
  if (capability === "bridge") return "B";
  return "H";
}

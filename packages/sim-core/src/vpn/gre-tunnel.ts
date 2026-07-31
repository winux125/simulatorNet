import type { Device } from "../devices/device";
import { EthernetInterface } from "../net/interface";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";
import type { Mac } from "../util/mac";
import {
  DEFAULT_VPN_LIMITS,
  VpnConfigurationError,
  type VpnTunnelBudget,
} from "./limits";

/** Where the outer (underlay) source address of a tunnel comes from. */
export type GreTunnelSource =
  | { readonly type: "interface"; readonly interfaceId: string }
  | { readonly type: "address"; readonly address: Ipv4 };

export interface TunnelOverlayIpv4Address {
  readonly address: Ipv4;
  readonly prefixLength: number;
}

export interface TunnelOverlayIpv6Address {
  readonly address: Ipv6;
  readonly prefixLength: number;
}

/**
 * Persistent configuration of one logical GRE tunnel. It contains no runtime
 * state: no encapsulated packet queue, no peer reachability, no counters and no
 * negotiated security association ever appears here.
 */
export interface GreTunnelConfiguration {
  /** Logical interface name, e.g. "Tunnel0". */
  readonly id: string;
  readonly source: GreTunnelSource;
  readonly destinationAddress: Ipv4;
  /** Only GRE over an IPv4 underlay is modelled in this release. */
  readonly mode: "gre-ipv4";
  readonly ipv4Addresses: readonly TunnelOverlayIpv4Address[];
  readonly ipv6Addresses: readonly TunnelOverlayIpv6Address[];
  readonly mtu: number;
  readonly ttl: number;
  readonly adminUp: boolean;
  /** `tunnel protection ipsec profile <id>`; unset means plain GRE. */
  readonly ipsecProfileId?: string;
}

export const DEFAULT_TUNNEL_MTU = 1_476;
export const DEFAULT_TUNNEL_TTL = 255;

/** Why a tunnel is not usable. `undefined` on an operational tunnel. */
export type TunnelDownReason =
  | "administratively-down"
  | "source-unavailable"
  | "destination-unreachable"
  | "recursive-route"
  | "protection-unavailable";

export interface TunnelOperationalState {
  readonly up: boolean;
  readonly reason?: TunnelDownReason;
  /** The resolved outer source address, when the source is usable. */
  readonly sourceAddress?: Ipv4;
}

const DOWN_ADMIN: TunnelOperationalState = Object.freeze({ up: false, reason: "administratively-down" });

/**
 * The small structural surface the tunnel engine needs from its routing plane.
 * Keeping it explicit means the engine never reaches into the router, so the
 * same code can serve a Router and a Firewall without either importing the
 * other.
 */
export interface GreTunnelRuntimeHooks {
  /** Usable IPv4 address of a named L3 interface; undefined when unusable. */
  interfaceAddress(interfaceName: string): Ipv4 | undefined;
  /** True when this device owns `address` on an operational interface. */
  ownsAddress(address: Ipv4): boolean;
  /**
   * The egress interface name the *underlay* routing table selects for the
   * tunnel destination, or undefined when there is no route at all.
   */
  underlayEgress(destination: Ipv4): string | undefined;
  /** True when `interfaceName` is itself a tunnel — i.e. a recursive route. */
  isTunnelInterface(interfaceName: string): boolean;
  /** False when a protected tunnel currently has no usable security association. */
  protectionReady(tunnel: GreTunnelConfiguration): boolean;
}

/**
 * A logical interface with no cable and no canvas presence.
 *
 * It has an administrative state and overlay addresses, produces connected
 * overlay routes and can run OSPFv2/OSPFv3 — but it never appears in the
 * connection modal, never anchors an X6 edge, and never puts a frame on a wire:
 * the router hands its packets to the tunnel data path instead.
 */
export class TunnelInterface extends EthernetInterface {
  constructor(
    device: Device,
    name: string,
    mac: Mac,
    private readonly evaluate: () => TunnelOperationalState,
  ) {
    super(device, name, mac);
  }

  override get operationalUp(): boolean {
    return this.adminUp && this.evaluate().up;
  }

  /** The current operational verdict, including why the tunnel is down. */
  get state(): TunnelOperationalState {
    return this.adminUp ? this.evaluate() : DOWN_ADMIN;
  }

  /** A tunnel is never cabled, so nothing is ever clocked onto a wire here. */
  override transmit(): void {}
}

export function isTunnelInterface(iface: EthernetInterface | undefined): iface is TunnelInterface {
  return iface instanceof TunnelInterface;
}

export function tunnelName(index: number): string {
  return `Tunnel${index}`;
}

/** Parse "Tunnel0"; returns undefined for anything else. */
export function parseTunnelName(name: string): number | undefined {
  if (!/^tunnel\d+$/iu.test(name)) return undefined;
  const index = Number(name.slice("Tunnel".length));
  return Number.isInteger(index) ? index : undefined;
}

/**
 * Owns the persistent tunnel configuration of one device and decides, purely
 * from that configuration plus the injected routing hooks, whether each tunnel
 * is operational. It holds no packets, no counters and no timers.
 */
export class GreTunnelEngine {
  private readonly tunnels = new Map<string, GreTunnelConfiguration>();
  private hooks: GreTunnelRuntimeHooks | undefined;
  private budget: VpnTunnelBudget | undefined;
  /** Re-entrancy guard: evaluating a tunnel must never consult itself. */
  private readonly evaluating = new Set<string>();

  useHooks(hooks: GreTunnelRuntimeHooks): void {
    this.hooks = hooks;
  }

  useTunnelBudget(budget: VpnTunnelBudget): void {
    this.budget = budget;
  }

  has(id: string): boolean {
    return this.tunnels.has(id);
  }

  get(id: string): GreTunnelConfiguration | undefined {
    return this.tunnels.get(id);
  }

  get size(): number {
    return this.tunnels.size;
  }

  /** Configuration in canonical name order, so serialization is stable. */
  configurations(): GreTunnelConfiguration[] {
    return [...this.tunnels.values()]
      .sort((left, right) => compareTunnelNames(left.id, right.id))
      .map(cloneTunnel);
  }

  define(configuration: GreTunnelConfiguration): GreTunnelConfiguration {
    const normalized = validateTunnel(configuration);
    if (!this.tunnels.has(normalized.id)) {
      if (this.tunnels.size >= DEFAULT_VPN_LIMITS.maximumTunnelsPerDevice) {
        throw new VpnConfigurationError(
          "VPN_TUNNEL_LIMIT",
          `Tunnel interface limit exceeded (${DEFAULT_VPN_LIMITS.maximumTunnelsPerDevice}).`,
        );
      }
      this.budget?.reserve();
    }
    this.tunnels.set(normalized.id, normalized);
    return normalized;
  }

  /** Merge one field group into an existing tunnel, or create it from defaults. */
  update(id: string, patch: Partial<Omit<GreTunnelConfiguration, "id">>): GreTunnelConfiguration {
    const existing = this.tunnels.get(id) ?? defaultTunnel(id);
    return this.define({ ...existing, ...patch, id });
  }

  remove(id: string): void {
    if (this.tunnels.delete(id)) this.budget?.release();
  }

  /**
   * A tunnel is up when it is administratively up, its source resolves to a
   * usable local address, its destination has an underlay route, and that route
   * does not egress through a tunnel — GRE never needs a peer handshake, so a
   * missing remote endpoint is only discovered when traffic fails.
   */
  evaluate(id: string): TunnelOperationalState {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return { up: false, reason: "administratively-down" };
    if (!tunnel.adminUp) return DOWN_ADMIN;
    // Evaluating a tunnel consults the routing table, which consults interface
    // state — including this tunnel. Report "down" for the nested lookup so the
    // recursion terminates and a self-referential route can never look usable.
    if (this.evaluating.has(id)) return { up: false, reason: "recursive-route" };
    const hooks = this.hooks;
    if (!hooks) return { up: false, reason: "source-unavailable" };
    this.evaluating.add(id);
    try {
      const sourceAddress = tunnel.source.type === "interface"
        ? hooks.interfaceAddress(tunnel.source.interfaceId)
        : hooks.ownsAddress(tunnel.source.address) ? tunnel.source.address : undefined;
      if (sourceAddress === undefined) return { up: false, reason: "source-unavailable" };
      const egress = hooks.underlayEgress(tunnel.destinationAddress);
      if (egress === undefined) return { up: false, reason: "destination-unreachable", sourceAddress };
      if (hooks.isTunnelInterface(egress)) {
        return { up: false, reason: "recursive-route", sourceAddress };
      }
      if (tunnel.ipsecProfileId !== undefined && !hooks.protectionReady(tunnel)) {
        return { up: false, reason: "protection-unavailable", sourceAddress };
      }
      return { up: true, sourceAddress };
    } finally {
      this.evaluating.delete(id);
    }
  }

  /** The resolved outer source address, ignoring destination reachability. */
  sourceAddress(id: string): Ipv4 | undefined {
    const tunnel = this.tunnels.get(id);
    const hooks = this.hooks;
    if (!tunnel || !hooks) return undefined;
    return tunnel.source.type === "interface"
      ? hooks.interfaceAddress(tunnel.source.interfaceId)
      : hooks.ownsAddress(tunnel.source.address) ? tunnel.source.address : undefined;
  }

  /**
   * The tunnel that should accept a received GRE/ESP packet: its resolved
   * source must be the outer destination and its configured destination must be
   * the outer source. Anything else is not ours and is dropped.
   */
  matchArrival(outerSource: Ipv4, outerDestination: Ipv4): GreTunnelConfiguration | undefined {
    for (const tunnel of this.configurations()) {
      if (tunnel.destinationAddress !== outerSource) continue;
      if (this.sourceAddress(tunnel.id) !== outerDestination) continue;
      return tunnel;
    }
    return undefined;
  }
}

export function defaultTunnel(id: string): GreTunnelConfiguration {
  return {
    id,
    source: { type: "address", address: "0.0.0.0" },
    destinationAddress: "0.0.0.0",
    mode: "gre-ipv4",
    ipv4Addresses: [],
    ipv6Addresses: [],
    mtu: DEFAULT_TUNNEL_MTU,
    ttl: DEFAULT_TUNNEL_TTL,
    adminUp: true,
  };
}

function cloneTunnel(tunnel: GreTunnelConfiguration): GreTunnelConfiguration {
  return {
    ...tunnel,
    source: { ...tunnel.source },
    ipv4Addresses: tunnel.ipv4Addresses.map((entry) => ({ ...entry })),
    ipv6Addresses: tunnel.ipv6Addresses.map((entry) => ({ ...entry })),
  };
}

/** Numeric order ("Tunnel2" before "Tunnel10"), falling back to text order. */
export function compareTunnelNames(left: string, right: string): number {
  const a = parseTunnelName(left);
  const b = parseTunnelName(right);
  if (a !== undefined && b !== undefined) return a - b;
  return left.localeCompare(right);
}

export function validateTunnel(configuration: GreTunnelConfiguration): GreTunnelConfiguration {
  const index = parseTunnelName(configuration.id);
  if (index === undefined) {
    throw new VpnConfigurationError(
      "VPN_INVALID_CONFIGURATION",
      `Tunnel interface name '${configuration.id}' must be Tunnel<n>.`,
    );
  }
  if (configuration.mode !== "gre-ipv4") {
    throw new VpnConfigurationError(
      "VPN_INVALID_CONFIGURATION",
      "Only 'gre-ipv4' tunnel mode is supported; multipoint GRE and NHRP are not modelled.",
    );
  }
  if (configuration.source.type === "interface" && !configuration.source.interfaceId.trim()) {
    throw new VpnConfigurationError("VPN_INVALID_CONFIGURATION", "Tunnel source interface is required.");
  }
  if (configuration.source.type === "address") requireIpv4(configuration.source.address, "Tunnel source address");
  requireIpv4(configuration.destinationAddress, "Tunnel destination");
  if (
    !Number.isInteger(configuration.mtu)
    || configuration.mtu < DEFAULT_VPN_LIMITS.minimumTunnelMtu
    || configuration.mtu > DEFAULT_VPN_LIMITS.maximumTunnelMtu
  ) {
    throw new VpnConfigurationError(
      "VPN_INVALID_CONFIGURATION",
      `Tunnel MTU must be between ${DEFAULT_VPN_LIMITS.minimumTunnelMtu} and ${DEFAULT_VPN_LIMITS.maximumTunnelMtu}.`,
    );
  }
  if (
    !Number.isInteger(configuration.ttl)
    || configuration.ttl < DEFAULT_VPN_LIMITS.minimumTunnelTtl
    || configuration.ttl > DEFAULT_VPN_LIMITS.maximumTunnelTtl
  ) {
    throw new VpnConfigurationError(
      "VPN_INVALID_CONFIGURATION",
      `Tunnel TTL must be between ${DEFAULT_VPN_LIMITS.minimumTunnelTtl} and ${DEFAULT_VPN_LIMITS.maximumTunnelTtl}.`,
    );
  }
  // A destination inside the tunnel's own overlay subnet always recurses, and
  // that is decidable from configuration alone.
  for (const overlay of configuration.ipv4Addresses) {
    if (overlayContains(overlay, configuration.destinationAddress)) {
      throw new VpnConfigurationError(
        "VPN_INVALID_CONFIGURATION",
        `Tunnel ${configuration.id} destination ${configuration.destinationAddress} is inside its own overlay subnet.`,
      );
    }
  }
  return cloneTunnel({ ...configuration, id: tunnelName(index) });
}

function overlayContains(overlay: TunnelOverlayIpv4Address, address: Ipv4): boolean {
  if (overlay.prefixLength < 0 || overlay.prefixLength > 32) return false;
  const mask = overlay.prefixLength === 0 ? 0 : (0xffffffff << (32 - overlay.prefixLength)) >>> 0;
  return ((ipToInt(overlay.address) & mask) >>> 0) === ((ipToInt(address) & mask) >>> 0);
}

function requireIpv4(value: Ipv4, label: string): void {
  try {
    ipToInt(value);
  } catch {
    throw new VpnConfigurationError("VPN_INVALID_CONFIGURATION", `${label} must be a valid IPv4 address.`);
  }
}

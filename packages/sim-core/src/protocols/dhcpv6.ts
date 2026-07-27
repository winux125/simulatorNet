import { NS_PER_S } from "../engine/constants";
import {
  Dhcpv6MessageType,
  type Dhcpv6Message,
} from "../packets/dhcpv6";
import {
  bigIntToIpv6,
  ipv6InPrefix,
  ipv6ToBigInt,
  normalizeIpv6,
  type Ipv6,
} from "../util/ipv6";
import {
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  enforceStructuralLimit,
} from "./limits";

export interface Dhcpv6PoolConfig {
  readonly id: string;
  readonly prefix: Ipv6;
  readonly prefixLength: number;
  readonly rangeStart: Ipv6;
  readonly rangeEnd: Ipv6;
  readonly dnsServers?: readonly Ipv6[];
  readonly preferredLifetimeNs?: number;
  readonly validLifetimeNs?: number;
}

interface Dhcpv6Pool {
  readonly config: Required<Omit<Dhcpv6PoolConfig, "dnsServers">> & {
    readonly dnsServers: readonly Ipv6[];
  };
  readonly leases: Map<string, Ipv6>;
  readonly assigned: Set<Ipv6>;
}

/**
 * Deterministic, bounded educational DHCPv6 server. It owns runtime leases,
 * while callers own packet delivery and persistent pool configuration.
 */
export class Dhcpv6Server {
  private readonly pools: Dhcpv6Pool[] = [];

  constructor(readonly serverId: string) {}

  addPool(input: Dhcpv6PoolConfig): void {
    enforceStructuralLimit("maximumDhcpv6PoolsPerDevice", this.pools.length + 1);
    const prefix = normalizeIpv6(input.prefix);
    const rangeStart = normalizeIpv6(input.rangeStart);
    const rangeEnd = normalizeIpv6(input.rangeEnd);
    if (!ipv6InPrefix(rangeStart, prefix, input.prefixLength)
      || !ipv6InPrefix(rangeEnd, prefix, input.prefixLength)) {
      throw new Error(`DHCPv6 range must be inside ${prefix}/${input.prefixLength}`);
    }
    if (ipv6ToBigInt(rangeStart) > ipv6ToBigInt(rangeEnd)) {
      throw new Error("DHCPv6 range start must not be greater than range end");
    }
    this.pools.push({
      config: {
        id: input.id,
        prefix,
        prefixLength: input.prefixLength,
        rangeStart,
        rangeEnd,
        dnsServers: (input.dnsServers ?? []).map(normalizeIpv6),
        preferredLifetimeNs: input.preferredLifetimeNs ?? 3_600 * NS_PER_S,
        validLifetimeNs: input.validLifetimeNs ?? 7_200 * NS_PER_S,
      },
      leases: new Map(),
      assigned: new Set(),
    });
  }

  configurations(): Dhcpv6PoolConfig[] {
    return this.pools.map(({ config }) => ({ ...config, dnsServers: [...config.dnsServers] }));
  }

  resetRuntime(): void {
    for (const pool of this.pools) {
      pool.leases.clear();
      pool.assigned.clear();
    }
  }

  handle(message: Dhcpv6Message, linkAddress?: Ipv6): Dhcpv6Message | undefined {
    const pool = this.poolFor(message.requestedAddress ?? linkAddress);
    if (!pool) return undefined;
    if (message.messageType === Dhcpv6MessageType.Release) {
      const released = pool.leases.get(message.clientId);
      if (released) pool.assigned.delete(released);
      pool.leases.delete(message.clientId);
      return this.reply(message, pool);
    }
    if (message.messageType === Dhcpv6MessageType.InformationRequest) {
      return this.reply(message, pool);
    }
    if (message.messageType === Dhcpv6MessageType.Solicit) {
      const address = this.allocate(pool, message.clientId, message.requestedAddress);
      return address ? this.reply(message, pool, Dhcpv6MessageType.Advertise, address) : undefined;
    }
    if (message.messageType === Dhcpv6MessageType.Request || message.messageType === Dhcpv6MessageType.Renew) {
      if (message.serverId !== undefined && message.serverId !== this.serverId) return undefined;
      const address = this.allocate(pool, message.clientId, message.requestedAddress);
      return address ? this.reply(message, pool, Dhcpv6MessageType.Reply, address) : undefined;
    }
    return undefined;
  }

  private poolFor(address?: Ipv6): Dhcpv6Pool | undefined {
    if (address === undefined) return this.pools[0];
    return this.pools.find((pool) =>
      ipv6InPrefix(address, pool.config.prefix, pool.config.prefixLength));
  }

  private allocate(pool: Dhcpv6Pool, clientId: string, requested?: Ipv6): Ipv6 | undefined {
    const existing = pool.leases.get(clientId);
    if (existing && (requested === undefined || normalizeIpv6(requested) === existing)) return existing;
    if (requested !== undefined) {
      const candidate = normalizeIpv6(requested);
      if (this.assignable(pool, candidate)) return this.commit(pool, clientId, candidate);
    }
    let candidate = ipv6ToBigInt(pool.config.rangeStart);
    const end = ipv6ToBigInt(pool.config.rangeEnd);
    let inspected = 0;
    while (candidate <= end && inspected <= DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumDhcpv6LeasesPerDevice) {
      const address = bigIntToIpv6(candidate);
      if (this.assignable(pool, address)) return this.commit(pool, clientId, address);
      candidate++;
      inspected++;
    }
    return undefined;
  }

  private assignable(pool: Dhcpv6Pool, address: Ipv6): boolean {
    return ipv6InPrefix(address, pool.config.prefix, pool.config.prefixLength)
      && !pool.assigned.has(address)
      && this.totalLeases() < DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumDhcpv6LeasesPerDevice;
  }

  private commit(pool: Dhcpv6Pool, clientId: string, address: Ipv6): Ipv6 {
    const prior = pool.leases.get(clientId);
    if (prior) pool.assigned.delete(prior);
    pool.leases.set(clientId, address);
    pool.assigned.add(address);
    return address;
  }

  private totalLeases(): number {
    return this.pools.reduce((total, pool) => total + pool.leases.size, 0);
  }

  private reply(
    request: Dhcpv6Message,
    pool: Dhcpv6Pool,
    messageType: typeof Dhcpv6MessageType.Advertise | typeof Dhcpv6MessageType.Reply =
      Dhcpv6MessageType.Reply,
    address?: Ipv6,
  ): Dhcpv6Message {
    return {
      kind: "dhcpv6",
      messageType,
      transactionId: request.transactionId,
      clientId: request.clientId,
      serverId: this.serverId,
      address,
      prefixLength: address ? pool.config.prefixLength : undefined,
      preferredLifetimeNs: address ? pool.config.preferredLifetimeNs : undefined,
      validLifetimeNs: address ? pool.config.validLifetimeNs : undefined,
      dnsServers: [...pool.config.dnsServers],
    };
  }
}

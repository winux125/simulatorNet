import { EtherType } from "@sim/contracts";
import { NS_PER_S } from "../engine/constants";
import type { SimulationEngine } from "../engine/simulation-engine";
import type { Ipv6InterfaceState } from "../net/ipv6-interface";
import {
  Icmpv6Type,
  type NeighborAdvertisement,
  type NeighborSolicitation,
} from "../packets/icmpv6";
import { Ipv6NextHeader, type Ipv6Packet } from "../packets/ipv6";
import { DEFAULT_CONTROL_PROTOCOL_LIMITS } from "./limits";
import {
  IPV6_ALL_NODES,
  IPV6_UNSPECIFIED,
  ipv6MulticastMac,
  isIpv6Multicast,
  isIpv6Unspecified,
  normalizeIpv6,
  solicitedNodeMulticast,
  type Ipv6,
} from "../util/ipv6";
import type { Mac } from "../util/mac";
import { normalizeMac } from "../util/mac";

export const DEFAULT_DAD_ATTEMPTS = 1;
export const DAD_PROBE_INTERVAL_NS = NS_PER_S;

export interface Ipv6NeighborEntry {
  readonly address: Ipv6;
  readonly mac: Mac;
  readonly state: "reachable";
  readonly learnedAtNs: number;
}

export interface Ipv6NeighborDiscoveryAdapter {
  readonly deviceId: string;
  readonly interfaceId: string;
  readonly engine: () => SimulationEngine;
  readonly mac: () => Mac;
  readonly addresses: Ipv6InterfaceState;
  readonly isRouter: boolean;
  readonly transmit: (destinationMac: Mac, packet: Ipv6Packet) => void;
  readonly onDadConflict: (address: Ipv6, message: string) => void;
  readonly onDadComplete?: (address: Ipv6) => void;
}

/**
 * Bounded NDP/DAD runtime for one logical IPv6 interface. It owns only
 * transient neighbor and pending-resolution state; the adapter owns address
 * configuration and Ethernet presentation.
 */
export class Ipv6NeighborDiscovery {
  private readonly neighbors = new Map<Ipv6, Ipv6NeighborEntry>();
  private readonly pending = new Map<Ipv6, Ipv6Packet[]>();
  private readonly dadGeneration = new Map<Ipv6, number>();

  constructor(private readonly host: Ipv6NeighborDiscoveryAdapter) {}

  neighborEntries(): Ipv6NeighborEntry[] {
    return [...this.neighbors.values()]
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((entry) => ({ ...entry }));
  }

  beginDad(addressInput: Ipv6, attempts = DEFAULT_DAD_ATTEMPTS): void {
    const address = normalizeIpv6(addressInput);
    if (!Number.isInteger(attempts) || attempts < 1
      || attempts > DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumDadAttemptsPerAddress) {
      throw new Error(`DAD attempts must be between 1 and ${DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumDadAttemptsPerAddress}`);
    }
    const assignment = this.host.addresses.get(address);
    if (!assignment) throw new Error(`Cannot run DAD for unconfigured address ${address}`);
    assignment.state = "tentative";
    const generation = (this.dadGeneration.get(address) ?? 0) + 1;
    this.dadGeneration.set(address, generation);
    this.sendDadProbe(address, generation, attempts, 0);
  }

  send(packet: Ipv6Packet, nextHopInput: Ipv6): void {
    const nextHop = normalizeIpv6(nextHopInput);
    if (isIpv6Multicast(nextHop)) {
      this.host.transmit(ipv6MulticastMac(nextHop), packet);
      return;
    }
    const known = this.neighbors.get(nextHop);
    if (known) {
      this.host.transmit(known.mac, packet);
      return;
    }
    const queued = this.pending.get(nextHop);
    if (queued) {
      if (queued.length >= DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumPendingIpv6PacketsPerResolution) {
        throw new Error(`Pending IPv6 packet limit exceeded for ${nextHop}`);
      }
      queued.push(packet);
      return;
    }
    if (this.pending.size >= DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumPendingIpv6ResolutionsPerDevice) {
      throw new Error(`Pending IPv6 resolution limit exceeded on ${this.host.deviceId}`);
    }
    this.pending.set(nextHop, [packet]);
    this.sendNeighborSolicitation(nextHop, packet.src);
  }

  receive(packet: Ipv6Packet, sourceMac: Mac): boolean {
    if (packet.nextHeader !== Ipv6NextHeader.ICMPv6 || packet.payload.kind !== "icmpv6") return false;
    if (packet.payload.type === Icmpv6Type.NeighborSolicitation) {
      this.receiveNeighborSolicitation(packet, packet.payload, sourceMac);
      return true;
    }
    if (packet.payload.type === Icmpv6Type.NeighborAdvertisement) {
      this.receiveNeighborAdvertisement(packet.payload, sourceMac);
      return true;
    }
    return false;
  }

  reset(): void {
    this.neighbors.clear();
    this.pending.clear();
    for (const address of this.dadGeneration.keys()) {
      this.dadGeneration.set(address, (this.dadGeneration.get(address) ?? 0) + 1);
    }
  }

  private sendNeighborSolicitation(target: Ipv6, source: Ipv6): void {
    this.charge();
    const destination = solicitedNodeMulticast(target);
    const message: NeighborSolicitation = {
      kind: "icmpv6",
      type: Icmpv6Type.NeighborSolicitation,
      code: 0,
      target,
      sourceLinkLayerAddress: isIpv6Unspecified(source) ? undefined : this.host.mac(),
    };
    this.trace("ndp-neighbor-solicitation", { target, source });
    this.host.transmit(ipv6MulticastMac(destination), {
      kind: "ipv6",
      src: source,
      dst: destination,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: 255,
      payload: message,
    });
  }

  private receiveNeighborSolicitation(packet: Ipv6Packet, message: NeighborSolicitation, sourceMac: Mac): void {
    this.charge();
    const target = normalizeIpv6(message.target);
    const assignment = this.host.addresses.get(target);
    if (!isIpv6Unspecified(packet.src) && message.sourceLinkLayerAddress) {
      this.learn(packet.src, message.sourceLinkLayerAddress);
    }
    if (assignment?.state === "tentative" && normalizeMac(sourceMac) !== normalizeMac(this.host.mac())) {
      this.markDuplicate(target);
      return;
    }
    if (!assignment || assignment.state === "duplicate" || assignment.state === "tentative") return;

    const destination = isIpv6Unspecified(packet.src) ? IPV6_ALL_NODES : packet.src;
    const advertisement: NeighborAdvertisement = {
      kind: "icmpv6",
      type: Icmpv6Type.NeighborAdvertisement,
      code: 0,
      target,
      targetLinkLayerAddress: this.host.mac(),
      solicited: !isIpv6Unspecified(packet.src),
      override: true,
      router: this.host.isRouter,
    };
    this.trace("ndp-neighbor-advertisement", { target, destination });
    this.host.transmit(isIpv6Multicast(destination) ? ipv6MulticastMac(destination) : sourceMac, {
      kind: "ipv6",
      src: target,
      dst: destination,
      nextHeader: Ipv6NextHeader.ICMPv6,
      hopLimit: 255,
      payload: advertisement,
    });
  }

  private receiveNeighborAdvertisement(message: NeighborAdvertisement, sourceMac: Mac): void {
    this.charge();
    const target = normalizeIpv6(message.target);
    const assignment = this.host.addresses.get(target);
    if (assignment?.state === "tentative" && normalizeMac(sourceMac) !== normalizeMac(this.host.mac())) {
      this.markDuplicate(target);
      return;
    }
    this.learn(target, message.targetLinkLayerAddress);
  }

  private learn(addressInput: Ipv6, macInput: Mac): void {
    const address = normalizeIpv6(addressInput);
    const mac = normalizeMac(macInput);
    if (!this.neighbors.has(address)
      && this.neighbors.size >= DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumIpv6NeighborsPerDevice) {
      throw new Error(`IPv6 neighbor limit exceeded on ${this.host.deviceId}`);
    }
    this.neighbors.set(address, { address, mac, state: "reachable", learnedAtNs: this.host.engine().now() });
    const queued = this.pending.get(address);
    if (!queued) return;
    this.pending.delete(address);
    for (const packet of queued) this.host.transmit(mac, packet);
  }

  private sendDadProbe(address: Ipv6, generation: number, attempts: number, sent: number): void {
    if (this.dadGeneration.get(address) !== generation) return;
    const assignment = this.host.addresses.get(address);
    if (!assignment || assignment.state !== "tentative") return;
    this.sendNeighborSolicitation(address, IPV6_UNSPECIFIED);
    const nextSent = sent + 1;
    this.host.engine().scheduleIn(DAD_PROBE_INTERVAL_NS, () => {
      if (this.dadGeneration.get(address) !== generation) return;
      const current = this.host.addresses.get(address);
      if (!current || current.state !== "tentative") return;
      if (nextSent < attempts) {
        this.sendDadProbe(address, generation, attempts, nextSent);
        return;
      }
      current.state = "preferred";
      this.trace("ipv6-dad-complete", { address, attempts });
      this.host.onDadComplete?.(address);
    });
  }

  private markDuplicate(address: Ipv6): void {
    const assignment = this.host.addresses.get(address);
    if (!assignment || assignment.state === "duplicate") return;
    assignment.state = "duplicate";
    this.dadGeneration.set(address, (this.dadGeneration.get(address) ?? 0) + 1);
    const message = `Duplicate IPv6 address detected: ${address}`;
    this.trace("ipv6-dad-conflict", { address, message });
    this.host.onDadConflict(address, message);
  }

  private charge(): void {
    this.host.engine().controlProtocolBudget.consume("ipv6ControlEvents");
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.host.engine();
    engine.trace({ time: engine.now(), type, device: this.host.deviceId, detail: {
      interface: this.host.interfaceId,
      etherType: EtherType.IPv6,
      ...detail,
    } });
  }
}

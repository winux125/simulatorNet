import type { SimulationEngine } from "../engine/simulation-engine";
import { DeterministicLabelAllocator, type MplsForwardingEntry } from "../mpls/label-forwarding";
import { MPLS_IMPLICIT_NULL_LABEL } from "../packets/mpls";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import { enforceStructuralLimit } from "./limits";
import { ProtocolActivity } from "./protocol-activity";

export const LDP_ACTIVITY_INTERVAL_NS = 1_000_000;
export const LDP_ACTIVITY_ROUNDS = 4;
export const LDP_MAXIMUM_ACTIVITY_TICKS = 32;

export type LdpSessionState =
  | "nonexistent"
  | "initialized"
  | "open-sent"
  | "open-received"
  | "operational"
  | "closing";

export interface LdpFecRoute {
  readonly fec: string;
  readonly source: "connected" | "ospf";
  readonly nextHop?: Ipv4;
  readonly outgoingInterfaceId: string;
}

export interface LdpInterfaceDescriptor {
  readonly id: string;
  readonly address?: Ipv4;
  readonly enabled: boolean;
  readonly operational: boolean;
}

export interface LdpPeerDescriptor {
  readonly deviceId: string;
  readonly localInterfaceId: string;
  readonly remoteInterfaceId: string;
  readonly remoteAddress?: Ipv4;
  readonly process: LdpProcess;
}

export interface LdpHost {
  readonly id: string;
  readonly engine: SimulationEngine;
  ldpInterfaces(): readonly LdpInterfaceDescriptor[];
  ldpPeer(interfaceId: string): LdpPeerDescriptor | undefined;
  ldpRouterIdCandidates(): readonly { interfaceId: string; address: Ipv4; loopback: boolean; active: boolean }[];
  ldpRouteReachable(address: Ipv4): boolean;
  ldpFecs(): readonly LdpFecRoute[];
  ldpInstallForwardingEntry(entry: MplsForwardingEntry): void;
  ldpClearForwardingEntries(): void;
}

export interface LdpNeighborSummary {
  readonly deviceId: string;
  readonly routerId: Ipv4;
  readonly state: LdpSessionState;
  readonly localInterfaceId: string;
  readonly remoteInterfaceId: string;
  readonly localTransportAddress: Ipv4;
  readonly remoteTransportAddress: Ipv4;
}

export interface LdpLabelBinding {
  readonly fec: string;
  readonly localLabel: number;
  readonly remoteLabels: Readonly<Record<string, number>>;
  readonly implicitNullNeighborIds: readonly string[];
}

interface NeighborRuntime {
  deviceId: string;
  routerId: Ipv4;
  state: LdpSessionState;
  localInterfaceId: string;
  remoteInterfaceId: string;
  localTransportAddress: Ipv4;
  remoteTransportAddress: Ipv4;
}

/** Deterministic downstream-unsolicited LDP subset for Router core links. */
export class LdpProcess {
  private configuredRouterIdInterface: string | undefined;
  private readonly neighbors = new Map<string, NeighborRuntime>();
  private readonly bindings = new Map<string, LdpLabelBinding>();
  private readonly allocator = new DeterministicLabelAllocator();
  private readonly activity: ProtocolActivity;

  constructor(private readonly host: LdpHost) {
    this.activity = new ProtocolActivity(
      () => this.host.engine,
      {
        name: "ldp",
        intervalNs: LDP_ACTIVITY_INTERVAL_NS,
        quiescenceRounds: LDP_ACTIVITY_ROUNDS,
        maximumTicks: LDP_MAXIMUM_ACTIVITY_TICKS,
      },
      () => this.reconcile(),
    );
  }

  configureRouterId(interfaceId: string | undefined): void {
    if (interfaceId !== undefined && !this.host.ldpRouterIdCandidates().some((entry) => entry.interfaceId === interfaceId)) {
      throw new Error(`LDP router-id source ${interfaceId} does not exist.`);
    }
    this.configuredRouterIdInterface = interfaceId;
    this.resetRuntime();
    this.arm();
  }

  configuredRouterIdSource(): string | undefined {
    return this.configuredRouterIdInterface;
  }

  routerId(): Ipv4 | undefined {
    const candidates = this.host.ldpRouterIdCandidates().filter((entry) => entry.active);
    if (this.configuredRouterIdInterface !== undefined) {
      return candidates.find((entry) => entry.interfaceId === this.configuredRouterIdInterface)?.address;
    }
    const loopbacks = candidates.filter((entry) => entry.loopback);
    const source = loopbacks.length ? loopbacks : candidates;
    return [...source].sort((a, b) => ipToInt(b.address) - ipToInt(a.address))[0]?.address;
  }

  arm(): void {
    this.activity.arm();
  }

  resetRuntime(): void {
    for (const neighbor of this.neighbors.values()) {
      this.trace("ldp-session-state-changed", { neighbor: neighbor.routerId, from: neighbor.state, to: "closing" });
      this.trace("ldp-binding-removed", { neighbor: neighbor.routerId, reason: "runtime-reset" });
    }
    this.neighbors.clear();
    this.bindings.clear();
    this.allocator.clear();
    this.host.ldpClearForwardingEntries();
    this.activity.quiesce();
    this.activity.resetBudget();
  }

  neighborSummaries(): readonly LdpNeighborSummary[] {
    return [...this.neighbors.values()]
      .sort((a, b) => ipToInt(a.routerId) - ipToInt(b.routerId))
      .map((entry) => ({ ...entry }));
  }

  labelBindings(): readonly LdpLabelBinding[] {
    return [...this.bindings.values()]
      .sort((a, b) => a.fec.localeCompare(b.fec))
      .map((entry) => ({
        ...entry,
        remoteLabels: { ...entry.remoteLabels },
        implicitNullNeighborIds: [...entry.implicitNullNeighborIds],
      }));
  }

  outgoingLabelFor(fec: string): { label: number; nextHop: Ipv4; outgoingInterfaceId: string } | undefined {
    const route = this.host.ldpFecs().find((entry) => entry.fec === fec && entry.source !== "connected");
    if (!route?.nextHop) return undefined;
    const neighbor = this.neighborSummaries().find((entry) =>
      entry.state === "operational" && this.peerForNeighbor(entry)?.remoteAddress === route.nextHop);
    if (!neighbor) return undefined;
    const label = this.peerForNeighbor(neighbor)?.process.advertisedLabel(fec);
    if (label === undefined) return undefined;
    return { label, nextHop: route.nextHop, outgoingInterfaceId: route.outgoingInterfaceId };
  }

  advertisedLabel(fec: string): number | undefined {
    const route = this.host.ldpFecs().find((entry) => entry.fec === fec);
    if (!route) return undefined;
    if (route.source === "connected") return MPLS_IMPLICIT_NULL_LABEL;
    return this.bindings.get(fec)?.localLabel;
  }

  private reconcile(): void {
    this.host.engine.controlProtocolBudget.consume("ldpEvents", this.host.id);
    const localRouterId = this.routerId();
    const discovered = new Set<string>();
    if (localRouterId !== undefined) {
      const interfaces = this.host.ldpInterfaces()
        .filter((entry) => entry.enabled && entry.operational && entry.address !== undefined)
        .sort((a, b) => a.id.localeCompare(b.id));
      enforceStructuralLimit("maximumLdpNeighborsPerDevice", interfaces.length);
      for (const iface of interfaces) {
        this.trace("ldp-hello-sent", { interface: iface.id, routerId: localRouterId, port: 646 });
        const peer = this.host.ldpPeer(iface.id);
        const remoteRouterId = peer?.process.routerId();
        if (!peer || !peer.remoteAddress || !remoteRouterId || remoteRouterId === localRouterId) continue;
        if (!peer.process.interfaceEnabled(peer.remoteInterfaceId)) continue;
        this.trace("ldp-hello-received", { interface: iface.id, neighbor: remoteRouterId });
        if (!this.host.ldpRouteReachable(remoteRouterId)) continue;
        discovered.add(remoteRouterId);
        this.establish(peer, localRouterId, remoteRouterId, iface.address!);
      }
    }
    for (const [routerId, neighbor] of [...this.neighbors]) {
      if (discovered.has(routerId)) continue;
      this.transition(neighbor, "closing");
      this.neighbors.delete(routerId);
      this.trace("ldp-label-withdrawn", { neighbor: routerId, reason: "adjacency-lost" });
    }
    this.rebuildBindings();
  }

  private establish(peer: LdpPeerDescriptor, localRouterId: Ipv4, remoteRouterId: Ipv4, localAddress: Ipv4): void {
    const existing = this.neighbors.get(remoteRouterId);
    if (existing?.state === "operational") return;
    const runtime: NeighborRuntime = existing ?? {
      deviceId: peer.deviceId,
      routerId: remoteRouterId,
      state: "nonexistent",
      localInterfaceId: peer.localInterfaceId,
      remoteInterfaceId: peer.remoteInterfaceId,
      localTransportAddress: localRouterId,
      remoteTransportAddress: remoteRouterId,
    };
    this.neighbors.set(remoteRouterId, runtime);
    for (const state of ["initialized", "open-sent", "open-received", "operational"] as const) this.transition(runtime, state);
    runtime.localTransportAddress = localRouterId;
    runtime.remoteTransportAddress = remoteRouterId;
    this.trace("ldp-session-established", {
      neighbor: remoteRouterId,
      localAddress,
      remoteAddress: peer.remoteAddress,
      tcpPort: 646,
    });
  }

  private rebuildBindings(): void {
    this.host.ldpClearForwardingEntries();
    const routes = [...this.host.ldpFecs()].sort((a, b) => a.fec.localeCompare(b.fec));
    enforceStructuralLimit("maximumLdpBindingsPerRouter", routes.length);
    const allocated = this.allocator.allocateAll(routes.map((entry) => entry.fec));
    this.bindings.clear();
    for (const route of routes) {
      const localLabel = allocated.get(route.fec)!;
      const remoteLabels: Record<string, number> = {};
      const implicitNullNeighborIds: string[] = [];
      for (const neighbor of this.neighborSummaries().filter((entry) => entry.state === "operational")) {
        const label = this.peerForNeighbor(neighbor)?.process.advertisedLabel(route.fec);
        if (label === undefined) continue;
        remoteLabels[neighbor.routerId] = label;
        if (label === MPLS_IMPLICIT_NULL_LABEL) implicitNullNeighborIds.push(neighbor.routerId);
        this.trace("ldp-label-mapping-received", { neighbor: neighbor.routerId, fec: route.fec, label });
      }
      const binding: LdpLabelBinding = { fec: route.fec, localLabel, remoteLabels, implicitNullNeighborIds };
      this.bindings.set(route.fec, binding);
      this.trace("ldp-label-allocated", { fec: route.fec, label: localLabel });
      this.trace("ldp-label-mapping-sent", { fec: route.fec, label: route.source === "connected" ? 3 : localLabel });
      if (route.source === "connected" || !route.nextHop) continue;
      const next = this.neighborSummaries().find((entry) =>
        entry.state === "operational" && this.peerForNeighbor(entry)?.remoteAddress === route.nextHop);
      const outgoingLabel = next ? remoteLabels[next.routerId] : undefined;
      if (outgoingLabel === undefined) continue;
      this.host.ldpInstallForwardingEntry({
        incomingLabel: localLabel,
        fec: route.fec,
        operation: outgoingLabel === MPLS_IMPLICIT_NULL_LABEL ? { type: "pop" } : { type: "swap", outgoingLabel },
        nextHop: route.nextHop,
        outgoingInterfaceId: route.outgoingInterfaceId,
        source: "ldp",
      });
      this.trace("ldp-binding-installed", { fec: route.fec, localLabel, outgoingLabel, nextHop: route.nextHop });
    }
  }

  private interfaceEnabled(interfaceId: string): boolean {
    return this.host.ldpInterfaces().some((entry) => entry.id === interfaceId && entry.enabled && entry.operational);
  }

  private peerForNeighbor(neighbor: LdpNeighborSummary): LdpPeerDescriptor | undefined {
    return this.host.ldpPeer(neighbor.localInterfaceId);
  }

  private transition(runtime: NeighborRuntime, state: LdpSessionState): void {
    if (runtime.state === state) return;
    this.host.engine.controlProtocolBudget.consume("ldpStateTransitions", `${this.host.id}:${runtime.routerId}`);
    const from = runtime.state;
    runtime.state = state;
    this.trace("ldp-session-state-changed", { neighbor: runtime.routerId, from, to: state });
  }

  private trace(type: string, detail: Readonly<Record<string, unknown>>): void {
    this.host.engine.trace({ time: this.host.engine.now(), type, device: this.host.id, detail: { ...detail } });
  }
}

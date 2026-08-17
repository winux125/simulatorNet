/**
 * Centralized, finite resource limits for the layer-2/layer-3 control protocols.
 *
 * Every control protocol in SimulatorNet is bounded twice: by a *structural*
 * limit (how much protocol state a lab may describe) and by a *per-operation*
 * event budget (how much work one Auto run or one grading check may perform).
 * Both are deterministic and identical in the browser worker and the verifier.
 */
export const DEFAULT_CONTROL_PROTOCOL_LIMITS = Object.freeze({
  // --- spanning tree ---------------------------------------------------
  maximumSpanningTreeInstancesPerDevice: 128,
  maximumSpanningTreeInstancesPerLab: 256,
  maximumSpanningTreePortsPerInstance: 64,
  maximumBpduEventsPerOperation: 10_000,
  maximumPortTransitionsPerOperation: 128,
  maximumTopologyChangesPerOperation: 256,

  // --- EtherChannel ----------------------------------------------------
  maximumPortChannelsPerDevice: 64,
  maximumMembersPerPortChannel: 8,
  maximumAggregatorsPerLab: 256,
  maximumNegotiationEventsPerOperation: 10_000,

  // --- neighbour discovery ---------------------------------------------
  maximumDiscoveryNeighborsPerDevice: 64,
  maximumDiscoveryNeighborsPerLab: 512,
  maximumDiscoveryAdvertisementsPerOperation: 10_000,

  // --- IPv6 neighbour discovery ---------------------------------------
  maximumIpv6NeighborsPerDevice: 128,
  maximumPendingIpv6ResolutionsPerDevice: 64,
  maximumPendingIpv6PacketsPerResolution: 32,
  maximumDadAttemptsPerAddress: 3,
  maximumIpv6ControlEventsPerOperation: 20_000,
  maximumDhcpv6PoolsPerDevice: 32,
  maximumDhcpv6LeasesPerDevice: 256,

  // --- wireless LAN ---------------------------------------------------
  maximumWirelessManagementEventsPerOperation: 20_000,
  maximumWirelessFramesPerOperation: 50_000,
  maximumWirelessAssociationAttemptsPerOperation: 16,

  // --- OSPFv2 ----------------------------------------------------------
  maximumOspfRoutersPerLab: 128,
  maximumOspfNeighborsPerDevice: 64,
  maximumOspfInterfacesPerDevice: 64,
  maximumLsasPerLab: 4_096,
  /**
   * Offering an advertisement to a neighbour is inherently quadratic: an area of
   * N routers holds up to 2N-1 advertisements and offers each of them once
   * across each of the 2(N-1) directed adjacencies of a minimal connected area.
   * A 128-router cold start measures **48,895** offers — identically on a
   * fan-out tree of 2, 8 or 32 and on a 128-hop chain — so this carries the
   * largest supported area with roughly a third of headroom.
   *
   * This is deliberately not the same judgement as the SPF budget below. SPF
   * repetition was redundant work — the same tree rebuilt from the same inputs —
   * and was removed rather than budgeted. Offering an advertisement to a
   * neighbour that has not seen it is work the protocol actually has to do, so
   * it is budgeted instead. A *re-offer* is not: an instance already on a
   * neighbour's retransmission list is never sent again by a later flood, which
   * is what took the figure down from the 59,593 M10.17.2 measured.
   */
  maximumLsaFloodsPerOperation: 64_000,
  maximumSpfRunsPerOperation: 256,
  maximumAdjacencyTransitionsPerOperation: 4_096,
  /**
   * A protocol event is one OSPF packet sent or received, so this tracks packets
   * rather than advertisements: batching a flood wave into one Link State Update
   * per neighbour took a 128-router cold start from 226,420 events to 11,672 on
   * a bounded fan-out tree. The bound is sized from the most expensive supported
   * shape instead — a 128-hop chain, where every advertisement is relayed at
   * every hop — which measures **72,644**, again with about a third of headroom.
   */
  maximumOspfEventsPerOperation: 96_000,

  // --- BGP -------------------------------------------------------------
  maximumBgpPeersPerDevice: 64,
  maximumBgpSessionsPerLab: 256,
  maximumBgpMessagesPerOperation: 20_000,
  maximumBgpStateTransitionsPerOperation: 4_096,
  maximumBgpPrefixesPerPeer: 4_096,
  maximumBgpAsPathLength: 256,
  maximumBgpRouteReflectorClientsPerDevice: 64,
  maximumBgpClusterListLength: 16,
  maximumBgpCommunitiesPerRoute: 32,
  maximumBgpReflectedUpdatesPerOperation: 20_000,
  maximumBgpCommunityListsPerDevice: 128,
  maximumBgpCommunityListEntriesPerList: 128,
  maximumBgpAsPathListsPerDevice: 128,
  maximumBgpAsPathListEntriesPerList: 128,
  maximumBgpAggregatesPerDevice: 64,
  maximumBgpAsPathPrependLength: 10,

  // --- MPLS / LDP ------------------------------------------------------
  maximumLdpNeighborsPerDevice: 64,
  maximumLdpSessionsPerLab: 256,
  maximumLdpBindingsPerRouter: 4_096,
  maximumLdpEventsPerOperation: 20_000,
  maximumLdpStateTransitionsPerOperation: 4_096,

  // --- VXLAN overlays --------------------------------------------------
  maximumVnisPerVtep: 128,
  maximumRemoteVtepsPerVni: 32,
  maximumRemoteMacsPerVtep: 4_096,
  maximumBumReplicasPerOperation: 20_000,
  maximumVxlanEventsPerOperation: 50_000,

  // --- routed VXLAN overlays (symmetric IRB) ---------------------------
  /** L3VNIs one VTEP may associate with a VRF. One VRF carries at most one. */
  maximumL3VnisPerVtep: 64,
  maximumRoutedVxlanPacketsPerOperation: 20_000,

  // --- BGP EVPN --------------------------------------------------------
  maximumEvpnRoutesPerDevice: 8_192,
  maximumEvpnMacRoutesPerVni: 1_024,
  maximumEvpnImetRoutesPerVni: 64,
  maximumEvpnUpdatesPerOperation: 20_000,
  /** Type 5 IP Prefix routes, bounded per originating VRF and per device. */
  maximumEvpnIpPrefixRoutesPerVrf: 1_024,
  maximumEvpnIpPrefixRoutesPerDevice: 4_096,
  maximumImportedEvpnRoutesPerVrf: 1_024,

  // --- EVPN multihoming (Single-Active) --------------------------------
  maximumEthernetSegmentsPerDevice: 64,
  maximumInterfacesPerEthernetSegment: 8,
  /** VTEPs that may share one Ethernet Segment, this device included. */
  maximumEsPeersPerSegment: 8,
  maximumEvpnEsRoutesPerDevice: 1_024,
  maximumEvpnAdRoutesPerDevice: 4_096,
  /** DF elections one Auto run or graded action may perform. */
  maximumDfElectionsPerOperation: 4_096,
});

export type ControlProtocolLimits = typeof DEFAULT_CONTROL_PROTOCOL_LIMITS;

export type ControlProtocolBudgetKey =
  | "bpduEvents"
  | "portTransitions"
  | "topologyChanges"
  | "negotiationEvents"
  | "discoveryAdvertisements"
  | "ipv6ControlEvents"
  | "wirelessManagementEvents"
  | "wirelessFrames"
  | "wirelessAssociationAttempts"
  | "lsaFloods"
  | "spfRuns"
  | "adjacencyTransitions"
  | "ospfEvents"
  | "bgpMessages"
  | "bgpStateTransitions"
  | "bgpReflectedUpdates"
  | "ldpEvents"
  | "ldpStateTransitions"
  | "vxlanEvents"
  | "bumReplicas"
  | "routedVxlanPackets"
  | "evpnUpdates"
  | "dfElections";

const BUDGET_LIMIT_KEYS: Readonly<Record<ControlProtocolBudgetKey, keyof ControlProtocolLimits>> = Object.freeze({
  bpduEvents: "maximumBpduEventsPerOperation",
  portTransitions: "maximumPortTransitionsPerOperation",
  topologyChanges: "maximumTopologyChangesPerOperation",
  negotiationEvents: "maximumNegotiationEventsPerOperation",
  discoveryAdvertisements: "maximumDiscoveryAdvertisementsPerOperation",
  ipv6ControlEvents: "maximumIpv6ControlEventsPerOperation",
  wirelessManagementEvents: "maximumWirelessManagementEventsPerOperation",
  wirelessFrames: "maximumWirelessFramesPerOperation",
  wirelessAssociationAttempts: "maximumWirelessAssociationAttemptsPerOperation",
  lsaFloods: "maximumLsaFloodsPerOperation",
  spfRuns: "maximumSpfRunsPerOperation",
  adjacencyTransitions: "maximumAdjacencyTransitionsPerOperation",
  ospfEvents: "maximumOspfEventsPerOperation",
  bgpMessages: "maximumBgpMessagesPerOperation",
  bgpStateTransitions: "maximumBgpStateTransitionsPerOperation",
  bgpReflectedUpdates: "maximumBgpReflectedUpdatesPerOperation",
  ldpEvents: "maximumLdpEventsPerOperation",
  ldpStateTransitions: "maximumLdpStateTransitionsPerOperation",
  vxlanEvents: "maximumVxlanEventsPerOperation",
  bumReplicas: "maximumBumReplicasPerOperation",
  routedVxlanPackets: "maximumRoutedVxlanPacketsPerOperation",
  evpnUpdates: "maximumEvpnUpdatesPerOperation",
  dfElections: "maximumDfElectionsPerOperation",
});

/** Raised when a lab exceeds a structural or per-operation protocol bound. */
export class ControlProtocolLimitError extends Error {
  readonly code = "control-protocol-limit";

  constructor(
    readonly limit: string,
    readonly actual: number,
    readonly maximum: number,
    readonly scope?: string,
  ) {
    super(`Control protocol limit '${limit}' exceeded${scope ? ` on '${scope}'` : ""}: ${actual} > ${maximum}`);
    this.name = "ControlProtocolLimitError";
  }
}

/** Raised when a control-protocol configuration value is outside its range. */
export class ControlProtocolConfigurationError extends Error {
  readonly code = "control-protocol-configuration";

  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "ControlProtocolConfigurationError";
  }
}

/**
 * Lab-scoped, per-operation event budget shared by every control protocol on
 * one engine. The worker resets it before each Auto/Step run and the verifier
 * resets it per graded action, so a bounded operation always stays bounded.
 *
 * A budget entry may be scoped — port transitions, for instance, are limited
 * per port rather than per lab — so one busy port cannot starve the others.
 */
export class ControlProtocolBudget {
  private readonly used = new Map<string, number>();

  constructor(readonly limits: ControlProtocolLimits = DEFAULT_CONTROL_PROTOCOL_LIMITS) {}

  reset(): void {
    this.used.clear();
  }

  consumed(key: ControlProtocolBudgetKey, scope?: string): number {
    return this.used.get(budgetEntryKey(key, scope)) ?? 0;
  }

  /** Charge `amount` against `key`, throwing once the operation budget is spent. */
  consume(key: ControlProtocolBudgetKey, scope?: string, amount = 1): void {
    const maximum = this.limits[BUDGET_LIMIT_KEYS[key]];
    const next = this.consumed(key, scope) + amount;
    if (next > maximum) throw new ControlProtocolLimitError(key, next, maximum, scope);
    this.used.set(budgetEntryKey(key, scope), next);
  }

  /** Charge `amount` and report whether the budget still allowed the work. */
  tryConsume(key: ControlProtocolBudgetKey, scope?: string, amount = 1): boolean {
    const maximum = this.limits[BUDGET_LIMIT_KEYS[key]];
    const next = this.consumed(key, scope) + amount;
    if (next > maximum) return false;
    this.used.set(budgetEntryKey(key, scope), next);
    return true;
  }

  maximumOf(key: ControlProtocolBudgetKey): number {
    return this.limits[BUDGET_LIMIT_KEYS[key]];
  }
}

function budgetEntryKey(key: ControlProtocolBudgetKey, scope: string | undefined): string {
  return scope === undefined ? key : `${key}\u0000${scope}`;
}

/** Structural guard used when protocol state is created, not when it runs. */
export function enforceStructuralLimit(
  limit: keyof ControlProtocolLimits,
  actual: number,
  limits: ControlProtocolLimits = DEFAULT_CONTROL_PROTOCOL_LIMITS,
): void {
  const maximum = limits[limit];
  if (actual > maximum) throw new ControlProtocolLimitError(limit, actual, maximum);
}

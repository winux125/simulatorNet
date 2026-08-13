import {
  ControlProtocolConfigurationError,
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  enforceStructuralLimit,
} from "../protocols/limits";
import { selectByFlowKey } from "../util/hash";
import { ipToInt, type Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";
import {
  agreedDfAlgorithm,
  electDesignatedForwarderModulus,
  electEvpnDesignatedForwarder,
  isEvpnDfAlgorithm,
  type EvpnDfAlgorithm,
  type EvpnDfCandidateWeight,
  type EvpnDfFallbackReason,
} from "./df-election";

/**
 * An Ethernet Segment Identifier, in the canonical five-group form the rest of
 * SimulatorNet uses for structured protocol fields: `0000:0000:0000:0000:0001`.
 *
 * The ten bytes an ESI occupies on the wire are deliberately *not* modelled as a
 * byte array. Every other protocol field in this engine is structured rather
 * than encoded, and an ESI is only ever compared, sorted and displayed — so one
 * canonical lowercase string is both the storage form and the comparison key,
 * and two engines can never disagree about ordering.
 */
export type Esi = string;

/** `ESI 0`: the reserved value that means "this attachment is single-homed". */
export const ESI_ZERO: Esi = "0000:0000:0000:0000:0000";

/** `MAX-ESI`: reserved by RFC 7432 and never a usable segment identifier. */
export const ESI_MAX: Esi = "ffff:ffff:ffff:ffff:ffff";

const ESI_PATTERN = /^[0-9a-f]{4}(:[0-9a-f]{4}){4}$/u;

/**
 * How the leaves of one Ethernet Segment share it.
 *
 * **Single-Active** (M10.16): exactly one leaf carries tenant traffic for a
 * VLAN and the others stand by. **All-Active** (M10.17): every operational
 * attachment carries known unicast, and the Designated Forwarder role narrows to
 * one thing only — who delivers overlay BUM toward the shared segment.
 *
 * Preference-based and AC-DF variants are not modelled, so an unsupported mode
 * is a type error here and a reported, never silently downgraded, value at every
 * parser boundary.
 */
export type EvpnRedundancyMode = "single-active" | "all-active";

export function isEvpnRedundancyMode(value: string): value is EvpnRedundancyMode {
  return value === "single-active" || value === "all-active";
}

/**
 * `evpn ethernet-segment <name>`: one CE attached to this VTEP through
 * interfaces that some other VTEP also attaches to, named by a shared ESI.
 *
 * Only configuration lives here. The discovered peers, the elected Designated
 * Forwarder, every A-D route and the primary/backup paths are runtime and are
 * rebuilt identically by the browser worker and the verifier.
 */
export interface EvpnEthernetSegmentConfiguration {
  readonly id: string;
  readonly esi: Esi;
  readonly redundancyMode: EvpnRedundancyMode;
  /** Access switchports or Port-channels; never a Loopback, SVI, NVE or routed port. */
  readonly interfaces: readonly string[];
  /**
   * `df-election hrw`. Absent means the modulus election of RFC 7432 §8.5, so a
   * segment written before M10.17 keeps exactly the winner it always had —
   * nothing is silently reinterpreted as highest-random-weight.
   */
  readonly dfAlgorithm?: EvpnDfAlgorithm;
}

/** Why one Ethernet Segment is not operational. */
export type EthernetSegmentDownReason =
  | "no-attachment-configured"
  | "attachment-missing"
  | "attachment-down"
  | "nve-down";

export interface EvpnEthernetSegmentState {
  readonly id: string;
  readonly esi: Esi;
  readonly redundancyMode: EvpnRedundancyMode;
  readonly dfAlgorithm: EvpnDfAlgorithm;
  readonly interfaces: readonly string[];
  /** The subset that currently carries traffic; empty means the ES is down. */
  readonly operationalInterfaces: readonly string[];
  readonly up: boolean;
  readonly reason: EthernetSegmentDownReason | undefined;
  /** VLANs this attachment carries that are mapped to an L2VNI, sorted. */
  readonly vlanIds: readonly number[];
}

/** One VTEP that advertised a Type 4 route for a shared Ethernet Segment. */
export interface EvpnEsPeer {
  readonly esi: Esi;
  readonly vtep: Ipv4;
  readonly routerId: Ipv4 | undefined;
  /** `true` when this VTEP is the local device rather than a discovered peer. */
  readonly local: boolean;
  /** `true` once a per-ES Ethernet A-D route backs the segment route. */
  readonly reachable: boolean;
  /**
   * The redundancy mode the peer advertised on its Type 4 route.
   *
   * A route written before M10.17 carries none, which reads as the
   * Single-Active this engine has always assumed. A peer whose mode differs
   * from the local segment's is reported and never aliased to: two leaves that
   * disagree about who may forward would duplicate or black-hole traffic.
   */
  readonly redundancyMode: EvpnRedundancyMode;
  /** `true` when the peer's mode matches the local segment's. */
  readonly modeAgrees: boolean;
  /** The DF election the peer advertised; absent on a route means `default`. */
  readonly dfAlgorithm: EvpnDfAlgorithm;
}

/** Why one `<ESI, VNI, MAC>` resolves to the VTEP it does. */
export type EvpnAliasingReason =
  /** All-Active: one of several equally usable PEs, chosen per flow. */
  | "all-active-aliasing"
  /** Single-Active: the segment's current Designated Forwarder. */
  | "single-active-designated-forwarder"
  /** No usable Ethernet A-D reachability remains for the segment. */
  | "no-usable-path";

/**
 * The runtime path state of one MAC behind a multihomed Ethernet Segment.
 *
 * This is deliberately *not* Single-Active's primary/backup shape. In All-Active
 * every eligible VTEP is a live path, so the state that matters is the eligible
 * set and which member of it one flow selected — never "the one that forwards
 * and the ones that do not".
 *
 * Every field is runtime: none of it is ever serialized into a `LabDocument`,
 * and the browser worker and the verifier rebuild all of it from the same
 * structured configuration and the same imported routes.
 */
export interface EvpnAliasingPathSet {
  readonly esi: Esi;
  readonly vni: number;
  readonly macAddress: Mac;
  /** The VTEP whose Type 2 route announced the address. */
  readonly advertisingVtep: Ipv4;
  /** Every VTEP that may carry the address, in canonical address order. */
  readonly eligibleVteps: readonly Ipv4[];
  /** The one this VTEP programs by default; a flow may select another. */
  readonly selectedVtep: Ipv4;
  readonly redundancyMode: EvpnRedundancyMode;
  readonly reason: EvpnAliasingReason;
}

/**
 * The result of one `<ESI, VLAN>` Designated Forwarder election.
 *
 * Every participating leaf runs the same election over the same canonically
 * ordered candidate list, so all of them independently reach an identical
 * answer without any leaf telling another what it decided.
 */
export interface EvpnDfState {
  readonly esi: Esi;
  readonly vlanId: number;
  readonly candidates: readonly Ipv4[];
  readonly designatedForwarder: Ipv4 | undefined;
  /** The candidate that takes over if the winner withdraws. */
  readonly backupDesignatedForwarder: Ipv4 | undefined;
  readonly localRole: "df" | "non-df";
  /** What the local segment asked for. */
  readonly requestedAlgorithm: EvpnDfAlgorithm;
  /** What every participant actually ran; `default` when one of them dissents. */
  readonly effectiveAlgorithm: EvpnDfAlgorithm;
  /** Present only when HRW was requested and not agreed. */
  readonly fallbackReason: EvpnDfFallbackReason | undefined;
  /** Per-candidate HRW weights, in candidate order. Empty for the modulus one. */
  readonly candidateWeights: readonly EvpnDfCandidateWeight[];
}

/** The questions the segment engine asks its device; it never reaches inside. */
export interface EthernetSegmentHooks {
  /** Whether an attachment name is a real interface on this device. */
  interfaceExists(name: string): boolean;
  /**
   * Whether an attachment may carry an Ethernet Segment at all: an access
   * switchport or a Port-channel, never a Loopback, SVI, NVE or routed port.
   */
  interfaceEligible(name: string): boolean;
  interfaceOperationalUp(name: string): boolean;
  /** The VLANs an attachment carries that are mapped to an L2VNI. */
  overlayVlansOf(name: string): readonly number[];
  /** This VTEP's own source address, or `undefined` while the NVE is down. */
  localVtep(): Ipv4 | undefined;
  /**
   * Whether the underlay can actually reach a remote VTEP right now.
   *
   * An alias is only usable if the packet can get there, so this is part of
   * eligibility rather than something the forwarding path discovers by failing.
   */
  underlayReachable(vtep: Ipv4): boolean;
}

function compareAddresses(left: Ipv4, right: Ipv4): number {
  return ipToInt(left) - ipToInt(right);
}

/**
 * Canonicalize an ESI, accepting the two spellings a learner is likely to type.
 *
 * `0000:0000:0000:0000:0001` is the canonical form; a plain 20-digit hex run is
 * accepted because that is how the value is often written down. Anything else is
 * rejected rather than padded into a value the author did not mean.
 */
export function normalizeEsi(value: string, field = "esi"): Esi {
  const trimmed = value.trim().toLowerCase();
  const compact = trimmed.replace(/[.:-]/gu, "");
  if (!/^[0-9a-f]{20}$/u.test(compact)) {
    throw new ControlProtocolConfigurationError(`Invalid Ethernet Segment Identifier '${value}'`, field);
  }
  const normalized = (compact.match(/.{4}/gu) ?? []).join(":");
  if (!ESI_PATTERN.test(normalized)) {
    throw new ControlProtocolConfigurationError(`Invalid Ethernet Segment Identifier '${value}'`, field);
  }
  return normalized;
}

/** `true` for the two values RFC 7432 reserves: ESI 0 and MAX-ESI. */
export function isReservedEsi(value: Esi): boolean {
  return value === ESI_ZERO || value === ESI_MAX;
}

/**
 * The ESI a multihomed Ethernet Segment must carry.
 *
 * ESI 0 means single-homed and MAX-ESI is reserved, so neither can name a
 * segment two VTEPs are supposed to discover each other through.
 */
export function requireMultihomedEsi(value: string, field = "esi"): Esi {
  const esi = normalizeEsi(value, field);
  if (esi === ESI_ZERO) {
    throw new ControlProtocolConfigurationError("ESI 0 is reserved for single-homed attachments", field);
  }
  if (esi === ESI_MAX) {
    throw new ControlProtocolConfigurationError("MAX-ESI is reserved and cannot identify a segment", field);
  }
  return esi;
}

/**
 * The default `<ESI, VLAN>` Designated Forwarder election.
 *
 * This is the documented modulus election of RFC 7432 §8.5 and stays the
 * behaviour of every segment that does not ask for something else. The algorithm
 * itself lives in `./df-election` beside highest-random-weight, so the two can
 * never drift apart; this name is kept because the rest of the engine and its
 * tests have always called it.
 */
export const electDesignatedForwarder = electDesignatedForwarderModulus;

interface EsRouteEntry {
  readonly vtep: Ipv4;
  readonly routerId: Ipv4 | undefined;
  /** Absent on a pre-M10.17 route, which means the Single-Active it assumed. */
  readonly redundancyMode: EvpnRedundancyMode;
  /** Absent on a pre-M10.17 route, which means the modulus election. */
  readonly dfAlgorithm: EvpnDfAlgorithm;
}

/**
 * Persistent Ethernet Segment configuration plus the runtime tables an EVPN
 * multihoming leaf rebuilds from scratch.
 *
 * The discovered peer list, the elected DF and the per-ES/per-EVI Ethernet A-D
 * reachability are all runtime: none of them is ever serialized into a
 * `LabDocument`, and both the browser worker and the verifier derive them from
 * the same structured configuration and the same imported routes.
 */
export class EthernetSegmentEngine {
  private readonly segments = new Map<string, EvpnEthernetSegmentConfiguration>();
  /** ESI → VTEPs that advertised a Type 4 route. Runtime only. */
  private readonly esRoutes = new Map<Esi, Map<Ipv4, EsRouteEntry>>();
  /** ESI → VTEPs that advertised a per-ES Ethernet A-D route. Runtime only. */
  private readonly adPerEs = new Map<Esi, Set<Ipv4>>();
  /** `<esi>|<vni>` → VTEPs that advertised a per-EVI Ethernet A-D route. */
  private readonly adPerEvi = new Map<string, Set<Ipv4>>();
  private hooks: EthernetSegmentHooks = {
    interfaceExists: () => false,
    interfaceEligible: () => false,
    interfaceOperationalUp: () => false,
    overlayVlansOf: () => [],
    localVtep: () => undefined,
    underlayReachable: () => false,
  };

  useHooks(hooks: EthernetSegmentHooks): void {
    this.hooks = hooks;
  }

  get configured(): boolean {
    return this.segments.size > 0;
  }

  // --- configuration -------------------------------------------------------

  /**
   * Define or replace one Ethernet Segment atomically, so a rejected edit never
   * leaves a half-applied segment behind.
   */
  configure(configuration: EvpnEthernetSegmentConfiguration): void {
    const id = configuration.id.trim();
    if (!id || id.length > 64) {
      throw new ControlProtocolConfigurationError("An Ethernet Segment needs a name of 1-64 characters", "id");
    }
    if (!isEvpnRedundancyMode(configuration.redundancyMode)) {
      throw new ControlProtocolConfigurationError(
        `Redundancy mode '${configuration.redundancyMode}' is not supported;`
        + " only 'single-active' and 'all-active' are modelled",
        "redundancyMode",
      );
    }
    const esi = requireMultihomedEsi(configuration.esi);
    enforceStructuralLimit(
      "maximumEthernetSegmentsPerDevice",
      this.segments.size + (this.segments.has(id) ? 0 : 1),
    );
    // One ESI names one segment on one VTEP. The same ESI on *another* VTEP is
    // exactly the point of multihoming, but two local segments claiming it would
    // make the DF election argue with itself.
    for (const existing of this.segments.values()) {
      if (existing.id !== id && existing.esi === esi) {
        throw new ControlProtocolConfigurationError(
          `Ethernet Segment '${existing.id}' already uses ESI ${esi}`,
          "esi",
        );
      }
    }
    enforceStructuralLimit("maximumInterfacesPerEthernetSegment", configuration.interfaces.length);
    const interfaces: string[] = [];
    for (const name of configuration.interfaces) {
      if (!this.hooks.interfaceExists(name)) {
        throw new ControlProtocolConfigurationError(`Interface '${name}' does not exist`, "interfaces");
      }
      if (!this.hooks.interfaceEligible(name)) {
        throw new ControlProtocolConfigurationError(
          `Interface '${name}' cannot carry an Ethernet Segment: use an access switchport or a Port-channel`,
          "interfaces",
        );
      }
      const owner = this.segmentForInterface(name);
      if (owner && owner.id !== id) {
        throw new ControlProtocolConfigurationError(
          `Interface '${name}' already belongs to Ethernet Segment '${owner.id}'`,
          "interfaces",
        );
      }
      if (!interfaces.includes(name)) interfaces.push(name);
    }
    const dfAlgorithm = configuration.dfAlgorithm ?? "default";
    if (!isEvpnDfAlgorithm(dfAlgorithm)) {
      throw new ControlProtocolConfigurationError(
        `DF election '${dfAlgorithm}' is not supported; only 'default' and 'hrw' are modelled`,
        "dfAlgorithm",
      );
    }
    this.segments.set(id, {
      id,
      esi,
      redundancyMode: configuration.redundancyMode,
      interfaces: interfaces.sort((a, b) => a.localeCompare(b)),
      // An absent algorithm stays absent, so a pre-M10.17 segment round-trips
      // without gaining a key it never had.
      ...(configuration.dfAlgorithm === undefined ? {} : { dfAlgorithm }),
    });
  }

  remove(id: string): boolean {
    return this.segments.delete(id);
  }

  /** Detach one interface, leaving the segment itself defined. */
  detachInterface(name: string): boolean {
    const owner = this.segmentForInterface(name);
    if (!owner) return false;
    this.segments.set(owner.id, {
      ...owner,
      interfaces: owner.interfaces.filter((entry) => entry !== name),
    });
    return true;
  }

  configurations(): EvpnEthernetSegmentConfiguration[] {
    return [...this.segments.values()]
      .map((entry) => ({ ...entry, interfaces: [...entry.interfaces] }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  configuration(id: string): EvpnEthernetSegmentConfiguration | undefined {
    return this.segments.get(id);
  }

  segmentForInterface(name: string): EvpnEthernetSegmentConfiguration | undefined {
    return [...this.segments.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .find((segment) => segment.interfaces.includes(name));
  }

  /** The ESI an attachment belongs to, or `undefined` for a single-homed port. */
  esiForInterface(name: string): Esi | undefined {
    return this.segmentForInterface(name)?.esi;
  }

  segmentForEsi(esi: Esi): EvpnEthernetSegmentConfiguration | undefined {
    return [...this.segments.values()].find((segment) => segment.esi === esi);
  }

  // --- operational state ---------------------------------------------------

  /**
   * Per-segment state. A segment is operational when the NVE has a usable
   * source address and at least one of its attachments is up — a segment whose
   * last attachment failed is exactly what triggers mass withdrawal.
   */
  states(): EvpnEthernetSegmentState[] {
    const localVtep = this.hooks.localVtep();
    return this.configurations().map((segment) => {
      const missing = segment.interfaces.filter((name) => !this.hooks.interfaceExists(name));
      const operationalInterfaces = segment.interfaces
        .filter((name) => this.hooks.interfaceExists(name) && this.hooks.interfaceOperationalUp(name));
      const vlanIds = [...new Set(operationalInterfaces.flatMap((name) => this.hooks.overlayVlansOf(name)))]
        .sort((a, b) => a - b);
      const reason = segment.interfaces.length === 0
        ? "no-attachment-configured" as const
        : missing.length === segment.interfaces.length
          ? "attachment-missing" as const
          : operationalInterfaces.length === 0
            ? "attachment-down" as const
            : localVtep === undefined
              ? "nve-down" as const
              : undefined;
      return {
        id: segment.id,
        esi: segment.esi,
        redundancyMode: segment.redundancyMode,
        dfAlgorithm: segment.dfAlgorithm ?? "default",
        interfaces: [...segment.interfaces],
        operationalInterfaces,
        up: reason === undefined,
        reason,
        vlanIds,
      };
    });
  }

  state(id: string): EvpnEthernetSegmentState | undefined {
    return this.states().find((entry) => entry.id === id);
  }

  stateForEsi(esi: Esi): EvpnEthernetSegmentState | undefined {
    return this.states().find((entry) => entry.esi === esi);
  }

  /** Every locally operational segment, in canonical ESI order. */
  operationalSegments(): EvpnEthernetSegmentState[] {
    return this.states().filter((entry) => entry.up);
  }

  // --- discovered peers ----------------------------------------------------

  /**
   * Replace the Type 4 derived peer table. Returns `true` when something moved,
   * so the caller only re-runs the DF election when the candidate set changed.
   */
  replaceEsRoutes(
    entries: readonly {
      esi: Esi;
      vtep: Ipv4;
      routerId?: Ipv4;
      redundancyMode?: EvpnRedundancyMode;
      dfAlgorithm?: EvpnDfAlgorithm;
    }[],
  ): boolean {
    const next = new Map<Esi, Map<Ipv4, EsRouteEntry>>();
    for (const entry of entries) {
      const perEsi = next.get(entry.esi) ?? new Map<Ipv4, EsRouteEntry>();
      if (perEsi.size >= DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumEsPeersPerSegment) continue;
      perEsi.set(entry.vtep, {
        vtep: entry.vtep,
        routerId: entry.routerId,
        // A Type 4 written before M10.17 carries neither field, and
        // Single-Active with the modulus election is exactly what this engine
        // assumed of it.
        redundancyMode: entry.redundancyMode ?? "single-active",
        dfAlgorithm: entry.dfAlgorithm ?? "default",
      });
      next.set(entry.esi, perEsi);
    }
    if (signatureOfEsRoutes(next) === signatureOfEsRoutes(this.esRoutes)) return false;
    this.esRoutes.clear();
    for (const [esi, peers] of next) this.esRoutes.set(esi, peers);
    return true;
  }

  /**
   * Replace the Ethernet A-D reachability tables. Per-ES reachability is what a
   * mass withdrawal removes in one message; per-EVI reachability is what makes a
   * VTEP eligible as a deterministic backup for one EVI.
   */
  replaceAdRoutes(
    perEs: readonly { esi: Esi; vtep: Ipv4 }[],
    perEvi: readonly { esi: Esi; vni: number; vtep: Ipv4 }[],
  ): boolean {
    const nextEs = new Map<Esi, Set<Ipv4>>();
    for (const entry of perEs) {
      const set = nextEs.get(entry.esi) ?? new Set<Ipv4>();
      set.add(entry.vtep);
      nextEs.set(entry.esi, set);
    }
    const nextEvi = new Map<string, Set<Ipv4>>();
    for (const entry of perEvi) {
      const key = eviKey(entry.esi, entry.vni);
      const set = nextEvi.get(key) ?? new Set<Ipv4>();
      set.add(entry.vtep);
      nextEvi.set(key, set);
    }
    const changed = signatureOfAd(nextEs) !== signatureOfAd(this.adPerEs)
      || signatureOfAd(nextEvi) !== signatureOfAd(this.adPerEvi);
    if (!changed) return false;
    this.adPerEs.clear();
    for (const [esi, set] of nextEs) this.adPerEs.set(esi, set);
    this.adPerEvi.clear();
    for (const [key, set] of nextEvi) this.adPerEvi.set(key, set);
    return true;
  }

  /**
   * The VTEPs that share one Ethernet Segment, the local device included.
   *
   * The order is canonical — ESI, then VTEP address, then router ID — so no
   * table, election or `show` row can ever depend on `Map` insertion order.
   */
  peers(): EvpnEsPeer[] {
    const localVtep = this.hooks.localVtep();
    const rows: EvpnEsPeer[] = [];
    const esis = new Set<Esi>([...this.esRoutes.keys()]);
    for (const segment of this.operationalSegments()) esis.add(segment.esi);
    for (const esi of [...esis].sort()) {
      const remote = this.esRoutes.get(esi);
      const local = this.segmentForEsi(esi);
      const localMode = local?.redundancyMode;
      if (localVtep !== undefined && this.stateForEsi(esi)?.up === true) {
        rows.push({
          esi,
          vtep: localVtep,
          routerId: undefined,
          local: true,
          reachable: this.adPerEs.get(esi)?.has(localVtep) ?? true,
          redundancyMode: localMode ?? "single-active",
          modeAgrees: true,
          dfAlgorithm: local?.dfAlgorithm ?? "default",
        });
      }
      for (const entry of [...(remote?.values() ?? [])]) {
        if (entry.vtep === localVtep) continue;
        rows.push({
          esi,
          vtep: entry.vtep,
          routerId: entry.routerId,
          local: false,
          reachable: this.adPerEs.get(esi)?.has(entry.vtep) === true,
          redundancyMode: entry.redundancyMode,
          // A leaf with no local attachment holds no opinion of its own, so it
          // never reports a peer as disagreeing with a mode it does not have.
          modeAgrees: localMode === undefined || entry.redundancyMode === localMode,
          dfAlgorithm: entry.dfAlgorithm,
        });
      }
    }
    return rows.sort((a, b) => a.esi.localeCompare(b.esi)
      || compareAddresses(a.vtep, b.vtep)
      || (a.routerId ?? "").localeCompare(b.routerId ?? ""));
  }

  peersForEsi(esi: Esi): EvpnEsPeer[] {
    return this.peers().filter((peer) => peer.esi === esi);
  }

  /** The redundancy mode one VTEP advertised for a segment. */
  redundancyModeOf(esi: Esi, vtep: Ipv4): EvpnRedundancyMode | undefined {
    if (vtep === this.hooks.localVtep() && this.segmentForEsi(esi)) {
      return this.segmentForEsi(esi)!.redundancyMode;
    }
    return this.esRoutes.get(esi)?.get(vtep)?.redundancyMode;
  }

  /** Peers of a locally All-Active segment that call themselves something else. */
  disagreeingPeers(esi: Esi): EvpnEsPeer[] {
    return this.peersForEsi(esi).filter((peer) => !peer.local && !peer.modeAgrees);
  }

  /** Whether one VTEP still backs a segment with a per-ES Ethernet A-D route. */
  hasEsReachability(esi: Esi, vtep: Ipv4): boolean {
    return this.adPerEs.get(esi)?.has(vtep) === true;
  }

  /** Whether one VTEP advertised per-EVI reachability for `<ESI, VNI>`. */
  hasEviReachability(esi: Esi, vni: number, vtep: Ipv4): boolean {
    return this.adPerEvi.get(eviKey(esi, vni))?.has(vtep) === true;
  }

  // --- Designated Forwarder ------------------------------------------------

  /**
   * The DF candidates for one segment: every VTEP that advertised a Type 4
   * route for it, plus this device when its own attachment is operational.
   */
  dfCandidates(esi: Esi): Ipv4[] {
    const localVtep = this.hooks.localVtep();
    const candidates = new Set<Ipv4>();
    if (localVtep !== undefined && this.stateForEsi(esi)?.up === true) candidates.add(localVtep);
    for (const entry of this.esRoutes.get(esi)?.values() ?? []) candidates.add(entry.vtep);
    return [...candidates].sort(compareAddresses);
  }

  /**
   * One DF result per `<ESI, VLAN>`.
   *
   * The VLAN set comes from the local attachment, because that is the only VLAN
   * set this device forwards for. A leaf with no local attachment for a segment
   * still computes the same answer for the VLANs it does carry.
   */
  dfStates(): EvpnDfState[] {
    const localVtep = this.hooks.localVtep();
    const rows: EvpnDfState[] = [];
    for (const segment of this.states()) {
      if (!segment.up) continue;
      const candidates = this.dfCandidates(segment.esi);
      const { effective, fallbackReason } = this.agreedAlgorithmFor(segment.esi, segment.dfAlgorithm, candidates);
      for (const vlanId of segment.vlanIds) {
        const result = electEvpnDesignatedForwarder(candidates, {
          esi: segment.esi,
          ethernetTag: vlanId,
          algorithm: effective,
        });
        rows.push({
          esi: segment.esi,
          vlanId,
          candidates: result.candidates,
          designatedForwarder: result.designatedForwarder,
          backupDesignatedForwarder: result.backupDesignatedForwarder,
          localRole: result.designatedForwarder !== undefined && result.designatedForwarder === localVtep
            ? "df"
            : "non-df",
          requestedAlgorithm: segment.dfAlgorithm,
          effectiveAlgorithm: result.algorithm,
          fallbackReason,
          candidateWeights: result.weights,
        });
      }
    }
    return rows.sort((a, b) => a.esi.localeCompare(b.esi) || a.vlanId - b.vlanId);
  }

  /**
   * The algorithm a segment actually runs.
   *
   * HRW needs every operational participant to agree, so what each *candidate*
   * advertised is what is consulted — not merely every peer that ever announced
   * the ESI. A leaf whose Type 4 is gone is not electing anything, and letting
   * it veto the algorithm would make convergence depend on stale state.
   */
  private agreedAlgorithmFor(
    esi: Esi,
    requested: EvpnDfAlgorithm,
    candidates: readonly Ipv4[],
  ): { effective: EvpnDfAlgorithm; fallbackReason: EvpnDfFallbackReason | undefined } {
    const localVtep = this.hooks.localVtep();
    const algorithms = candidates.map((vtep) => vtep === localVtep
      ? requested
      : this.esRoutes.get(esi)?.get(vtep)?.dfAlgorithm ?? "default");
    return agreedDfAlgorithm(requested, algorithms);
  }

  /** The DF election one VTEP advertised for a segment. */
  dfAlgorithmOf(esi: Esi, vtep: Ipv4): EvpnDfAlgorithm | undefined {
    if (vtep === this.hooks.localVtep() && this.segmentForEsi(esi)) {
      return this.segmentForEsi(esi)!.dfAlgorithm ?? "default";
    }
    return this.esRoutes.get(esi)?.get(vtep)?.dfAlgorithm;
  }

  dfState(esi: Esi, vlanId: number): EvpnDfState | undefined {
    return this.dfStates().find((entry) => entry.esi === esi && entry.vlanId === vlanId);
  }

  /**
   * Whether this device forwards tenant traffic toward the CE for one segment
   * and VLAN.
   *
   * In Single-Active exactly one leaf does. A leaf that is alone on a segment is
   * trivially the DF, and a leaf whose segment is down is never one.
   */
  isLocalDesignatedForwarder(esi: Esi, vlanId: number): boolean {
    return this.dfState(esi, vlanId)?.localRole === "df";
  }

  /**
   * The one place a `<ESI, VLAN>` egress decision is made for an attachment.
   *
   * Every forwarding path asks this rather than testing `esi` itself, so the
   * rule lives in one function instead of being scattered across the ingress,
   * unicast egress and BUM egress paths.
   *
   * In **Single-Active** only the Designated Forwarder carries anything, which
   * is exactly the M10.16 behaviour. In **All-Active** every operational
   * attachment carries known unicast and the DF role narrows to one job: only
   * the DF delivers BUM toward the shared segment, so a broadcast reaches the CE
   * once rather than once per leaf.
   */
  attachmentForwards(port: string, vlanId: number, delivery: "unicast" | "bum" = "bum"): boolean {
    const segment = this.segmentForInterface(port);
    if (segment === undefined) return true;
    const state = this.dfState(segment.esi, vlanId);
    // A VLAN the segment does not carry is not multihomed traffic at all.
    if (!state) return true;
    if (segment.redundancyMode === "all-active" && delivery === "unicast") return true;
    return state.localRole === "df";
  }

  /**
   * Whether a frame arriving on one attachment may be relayed and learned.
   *
   * A Single-Active standby carries no tenant data in either direction, so it
   * refuses the frame *before* it is learned — otherwise the non-DF would
   * advertise a MAC it is not allowed to forward to. An All-Active attachment is
   * always live, so a CE-originated frame may enter through any of them.
   */
  attachmentAcceptsIngress(port: string, vlanId: number): boolean {
    const segment = this.segmentForInterface(port);
    if (segment === undefined) return true;
    if (segment.redundancyMode === "all-active") return true;
    const state = this.dfState(segment.esi, vlanId);
    if (!state) return true;
    return state.localRole === "df";
  }

  // --- All-Active aliasing -------------------------------------------------

  /**
   * The VTEPs that may carry traffic for one `<ESI, VNI>`, in canonical order.
   *
   * This is the **one** place aliasing eligibility is decided, so no forwarding
   * branch grows an `if (esi)` test of its own. A VTEP qualifies only when every
   * condition holds at once:
   *
   * - it advertised a Type 4 route for this ESI, or it is this device with an
   *   operational local attachment — the route target had to match for either;
   * - its per-ES Ethernet A-D route is present, so it still has a working
   *   attachment: one withdrawal removes it from every MAC behind the segment;
   * - its per-EVI Ethernet A-D route is present, so it can serve *this* EVI;
   * - the underlay can actually reach it;
   * - it advertised the same redundancy mode, because two leaves that disagree
   *   about who may forward would duplicate or black-hole traffic.
   *
   * The local VTEP is excluded: an address this leaf serves itself is behind a
   * local attachment, and ordinary flooding and learning find it.
   */
  aliasingCandidates(esi: Esi, vni: number): Ipv4[] {
    const localVtep = this.hooks.localVtep();
    const mode = this.segmentForEsi(esi)?.redundancyMode;
    return this.dfCandidates(esi).filter((vtep) => vtep !== localVtep
      && this.hasEsReachability(esi, vtep)
      && this.hasEviReachability(esi, vni, vtep)
      && this.hooks.underlayReachable(vtep)
      && (mode === undefined || this.redundancyModeOf(esi, vtep) === mode));
  }

  /**
   * Choose one eligible VTEP for one flow, deterministically.
   *
   * The candidate list is canonically ordered before the choice is made, so the
   * same flow always reaches the same leaf in the browser worker and in the
   * verifier — and adding or removing one path re-indexes the modulus, which
   * keeps reassignment bounded rather than a reshuffle of everything.
   *
   * This is educational ECMP-like selection over one Ethernet Segment. It is
   * deliberately not a general routing ECMP implementation.
   */
  selectAliasingVtep(candidates: readonly Ipv4[], flowKey: string): Ipv4 | undefined {
    return selectByFlowKey([...candidates].sort(compareAddresses), flowKey);
  }

  resetRuntime(): void {
    this.esRoutes.clear();
    this.adPerEs.clear();
    this.adPerEvi.clear();
  }
}

function eviKey(esi: Esi, vni: number): string {
  return `${esi}|${vni}`;
}

function signatureOfEsRoutes(table: ReadonlyMap<Esi, ReadonlyMap<Ipv4, EsRouteEntry>>): string {
  return [...table.entries()]
    .map(([esi, peers]) => `${esi}=${[...peers.values()]
      // The mode and the algorithm are part of the signature: a peer that
      // changed either has to re-run the election and rebuild every alias set,
      // exactly as an arriving or departing peer does.
      .map((entry) => [entry.vtep, entry.routerId ?? "", entry.redundancyMode, entry.dfAlgorithm].join("/"))
      .sort()
      .join(",")}`)
    .sort()
    .join(";");
}

function signatureOfAd(table: ReadonlyMap<string, ReadonlySet<Ipv4>>): string {
  return [...table.entries()]
    .map(([key, set]) => `${key}=${[...set].sort().join(",")}`)
    .sort()
    .join(";");
}

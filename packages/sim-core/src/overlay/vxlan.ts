import { isValidVni, MAXIMUM_VNI, MINIMUM_VNI } from "../packets/vxlan";
import {
  ControlProtocolConfigurationError,
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  enforceStructuralLimit,
} from "../protocols/limits";
import { ipToInt, type Ipv4 } from "../util/ipv4";
import { normalizeMac, type Mac } from "../util/mac";

/** The one NVE interface a VTEP owns. `nve1` is the only supported number. */
export const NVE_INTERFACE_ID = "nve1";

/**
 * How a VNI reaches the remote VTEPs that share its broadcast domain.
 *
 * `static` is a hand-configured ingress-replication list; `bgp-evpn` defers the
 * list to Inclusive Multicast (Type 3) routes. Multicast underlay replication is
 * deliberately not modelled.
 */
export type NveReplicationConfiguration =
  | { readonly type: "static"; readonly peerAddresses: readonly Ipv4[] }
  | { readonly type: "bgp-evpn" };

export interface NveMemberConfiguration {
  readonly vni: number;
  readonly vlanId: number;
  readonly replication: NveReplicationConfiguration;
}

/**
 * `member vni <vni> associate-vrf`: an **L3VNI**.
 *
 * It has no VLAN and no broadcast domain — it is the transit segment symmetric
 * IRB routes a tenant's packets through, and the VNI is what names the VRF on
 * the egress VTEP.
 */
export interface NveVrfMemberConfiguration {
  readonly vni: number;
  readonly vrfId: string;
}

/**
 * `interface nve1`: a logical interface with no cable.
 *
 * It has an administrative state, an IPv4 source loopback and a set of VNI
 * members — but it never appears in the connection modal, never anchors a canvas
 * edge and never becomes a `topology.links` entry.
 */
export interface NveInterfaceConfiguration {
  readonly id: string;
  readonly sourceInterfaceId: string;
  readonly adminUp: boolean;
  readonly members: readonly NveMemberConfiguration[];
  /** L3VNIs. Absent — every lab written before M10.15 — means bridging only. */
  readonly vrfMembers?: readonly NveVrfMemberConfiguration[];
}

/**
 * `fabric forwarding anycast-gateway-mac`: the one MAC every leaf answers a
 * tenant's default gateway with.
 *
 * It is deliberately fabric-wide rather than per-SVI: that is exactly what makes
 * the gateway *distributed*, so a host keeps the same gateway MAC in its ARP
 * cache no matter which leaf it is attached to.
 */
export interface EvpnFabricConfiguration {
  readonly anycastGatewayMac?: Mac;
}

/** `fabric forwarding mode anycast-gateway` on one SVI. */
export interface EvpnAnycastGatewayConfiguration {
  readonly enabled: boolean;
}

/** `evpn` → `vni <id> l2`: the RD and route targets one VNI advertises with. */
export interface EvpnVniConfiguration {
  readonly vni: number;
  readonly routeDistinguisher: string;
  readonly importRouteTargets: readonly string[];
  readonly exportRouteTargets: readonly string[];
}

/** Why an NVE or one of its VNIs is not operational. */
export type NveDownReason =
  | "administratively-down"
  | "source-interface-missing"
  | "source-interface-down"
  | "source-not-loopback"
  | "vlan-missing"
  | "vrf-missing";

export interface NveOperationalState {
  readonly up: boolean;
  readonly sourceAddress: Ipv4 | undefined;
  readonly reason: NveDownReason | undefined;
}

export interface VniOperationalState extends NveOperationalState {
  readonly vni: number;
  readonly vlanId: number;
  readonly replication: "static" | "bgp-evpn";
}

/**
 * One L3VNI's derived state. It is operational only when the NVE itself is up
 * and the VRF it names still exists — a VNI whose VRF was removed transports
 * nothing rather than silently leaking into the global table.
 */
export interface L3VniOperationalState extends NveOperationalState {
  readonly vni: number;
  readonly vrfId: string;
}

/** A remote VTEP this device replicates BUM traffic to, and where it came from. */
export interface VxlanPeerSummary {
  readonly vni: number;
  readonly address: Ipv4;
  readonly source: "static" | "bgp-evpn";
  readonly reachable: boolean;
}

export type RemoteMacSource = "data-plane" | "bgp-evpn";

export interface RemoteMacEntry {
  readonly vni: number;
  readonly mac: Mac;
  /**
   * The VTEP this MAC is forwarded to right now.
   *
   * For a MAC behind a multihomed Ethernet Segment this is the *current DF*,
   * which is not necessarily the VTEP whose Type 2 route announced it: the
   * segment's reachability decides, so a failover moves the entry without a
   * single MAC having to be relearned.
   */
  readonly remoteVtep: Ipv4;
  readonly source: RemoteMacSource;
  readonly lastSeenNs: number;
  /** The Ethernet Segment the MAC sits behind, when it is multihomed. */
  readonly ethernetSegmentId?: string;
  /**
   * The other VTEPs that could carry this MAC, in deterministic order.
   *
   * Single-Active never installs these for forwarding — that would be aliasing.
   * They exist so a failover is a selection rather than a relearn, and so the
   * state is visible before anything fails.
   */
  readonly backupVteps: readonly Ipv4[];
  /** How the segment is shared; absent for a single-homed address. */
  readonly redundancyMode?: "single-active" | "all-active";
  /**
   * **All-Active only**: every VTEP that may carry this address right now.
   *
   * This is deliberately not Single-Active's primary/backup shape. Each of
   * these is a live path, and which one a given flow takes is decided per flow
   * at forwarding time — so the table stores the *set*, never one winner with a
   * list of understudies. Empty for Single-Active and for a single-homed MAC.
   */
  readonly aliasVteps: readonly Ipv4[];
}

/**
 * The questions the overlay asks its device. The engine never reaches into the
 * switch: operational state is derived from these answers alone, exactly as the
 * GRE tunnel engine derives a tunnel's state from the underlay.
 */
export interface VxlanHooks {
  /** The usable IPv4 address of a logical interface, or `undefined`. */
  interfaceAddress(name: string): Ipv4 | undefined;
  /** Whether the named interface exists at all. */
  interfaceExists(name: string): boolean;
  /** Whether the named interface is a Loopback. A VTEP source must be one. */
  isLoopback(name: string): boolean;
  /** Whether the VLAN exists in this switch's VLAN database. */
  hasVlan(vlanId: number): boolean;
  /** Whether the underlay routing table can reach a remote VTEP address. */
  underlayReachable(address: Ipv4): boolean;
  /** Whether the VRF an L3VNI names is still defined on this device. */
  hasVrf(vrfId: string): boolean;
}

function compareAddresses(left: Ipv4, right: Ipv4): number {
  return ipToInt(left) - ipToInt(right);
}

/**
 * Persistent VXLAN configuration plus the isolated runtime tables a VTEP
 * rebuilds from scratch. The remote MAC table, the EVPN-learned peer list and
 * every counter are runtime: they are never serialized into a `LabDocument`.
 */
export class VxlanEngine {
  private nve: NveInterfaceConfiguration | undefined;
  private readonly evpnVnis = new Map<number, EvpnVniConfiguration>();
  /** `<vni>|<mac>` -> entry. Runtime only. */
  private readonly remoteMacs = new Map<string, RemoteMacEntry>();
  /** VNI → remote VTEPs learned from EVPN Type 3 routes. Runtime only. */
  private readonly evpnPeers = new Map<number, Set<Ipv4>>();
  /** `fabric forwarding anycast-gateway-mac`. Persistent, never runtime. */
  private fabric: EvpnFabricConfiguration = {};
  private hooks: VxlanHooks = {
    interfaceAddress: () => undefined,
    interfaceExists: () => false,
    isLoopback: () => false,
    hasVlan: () => false,
    underlayReachable: () => false,
    hasVrf: () => false,
  };

  useHooks(hooks: VxlanHooks): void {
    this.hooks = hooks;
  }

  get configured(): boolean {
    return this.nve !== undefined;
  }

  // --- configuration -------------------------------------------------------

  configure(configuration: NveInterfaceConfiguration): void {
    if (configuration.id !== NVE_INTERFACE_ID) {
      throw new ControlProtocolConfigurationError(`Only '${NVE_INTERFACE_ID}' is supported`, "id");
    }
    if (!configuration.sourceInterfaceId.trim()) {
      throw new ControlProtocolConfigurationError("An NVE interface needs a source interface", "sourceInterfaceId");
    }
    enforceStructuralLimit("maximumVnisPerVtep", configuration.members.length);
    const vnis = new Set<number>();
    const vlans = new Set<number>();
    const members = [...configuration.members]
      .map((member): NveMemberConfiguration => {
        if (!isValidVni(member.vni)) {
          throw new ControlProtocolConfigurationError(
            `VNI must be between ${MINIMUM_VNI} and ${MAXIMUM_VNI}`,
            "vni",
          );
        }
        if (!Number.isInteger(member.vlanId) || member.vlanId < 1 || member.vlanId > 4_094) {
          throw new ControlProtocolConfigurationError("VLAN id must be between 1 and 4094", "vlanId");
        }
        // One VLAN maps to at most one VNI, and one VNI to at most one VLAN.
        if (vnis.has(member.vni)) {
          throw new ControlProtocolConfigurationError(`VNI ${member.vni} is already mapped`, "vni");
        }
        if (vlans.has(member.vlanId)) {
          throw new ControlProtocolConfigurationError(`VLAN ${member.vlanId} is already mapped to a VNI`, "vlanId");
        }
        vnis.add(member.vni);
        vlans.add(member.vlanId);
        if (member.replication.type !== "static") return { ...member, replication: { type: "bgp-evpn" } };
        const peers: Ipv4[] = [];
        for (const peer of member.replication.peerAddresses) {
          ipToInt(peer);
          if (!peers.includes(peer)) peers.push(peer);
        }
        enforceStructuralLimit("maximumRemoteVtepsPerVni", peers.length);
        return {
          vni: member.vni,
          vlanId: member.vlanId,
          replication: { type: "static", peerAddresses: peers.sort(compareAddresses) },
        };
      })
      .sort((a, b) => a.vni - b.vni);
    const vrfMembers = this.normalizeVrfMembers(configuration.vrfMembers ?? [], vnis);
    this.nve = { ...configuration, members, vrfMembers };
    // Runtime state never survives a configuration change: the browser worker
    // and the verifier both relearn it from the rebuilt overlay.
    this.resetRuntime();
  }

  /**
   * `member vni <n> associate-vrf`. An L3VNI is unique per VTEP, belongs to
   * exactly one VRF, a VRF carries at most one, and it can never reuse a VNI
   * that already maps a VLAN — a segment is either bridged or routed.
   */
  private normalizeVrfMembers(
    members: readonly NveVrfMemberConfiguration[],
    l2Vnis: ReadonlySet<number>,
  ): NveVrfMemberConfiguration[] {
    enforceStructuralLimit("maximumL3VnisPerVtep", members.length);
    const seenVnis = new Set<number>();
    const seenVrfs = new Set<string>();
    return members
      .map((member): NveVrfMemberConfiguration => {
        if (!isValidVni(member.vni)) {
          throw new ControlProtocolConfigurationError(
            `VNI must be between ${MINIMUM_VNI} and ${MAXIMUM_VNI}`,
            "vni",
          );
        }
        if (!member.vrfId.trim()) {
          throw new ControlProtocolConfigurationError("An L3VNI needs a VRF", "vrfId");
        }
        if (l2Vnis.has(member.vni)) {
          throw new ControlProtocolConfigurationError(
            `VNI ${member.vni} already maps a VLAN and cannot also be an L3VNI`,
            "vni",
          );
        }
        if (seenVnis.has(member.vni)) {
          throw new ControlProtocolConfigurationError(`VNI ${member.vni} is already mapped`, "vni");
        }
        if (seenVrfs.has(member.vrfId)) {
          throw new ControlProtocolConfigurationError(
            `VRF ${member.vrfId} already has an L3VNI`,
            "vrfId",
          );
        }
        seenVnis.add(member.vni);
        seenVrfs.add(member.vrfId);
        return { vni: member.vni, vrfId: member.vrfId };
      })
      .sort((a, b) => a.vni - b.vni);
  }

  remove(): void {
    this.nve = undefined;
    this.resetRuntime();
  }

  // --- anycast gateway ------------------------------------------------------

  /** `fabric forwarding anycast-gateway-mac <mac>`; `undefined` clears it. */
  configureFabric(configuration: EvpnFabricConfiguration): void {
    const mac = configuration.anycastGatewayMac;
    if (mac === undefined) {
      this.fabric = {};
      return;
    }
    const normalized = normalizeMac(mac);
    // A gateway MAC every host will send unicast frames to must itself be a
    // unicast address: a group bit set here would never be a usable next hop.
    const firstOctet = Number.parseInt(normalized.slice(0, 2), 16);
    if (!Number.isInteger(firstOctet) || (firstOctet & 0x01) === 1) {
      throw new ControlProtocolConfigurationError(
        `Anycast gateway MAC '${mac}' must be a unicast address`,
        "anycastGatewayMac",
      );
    }
    if (/^0+(:0+)*$/u.test(normalized)) {
      throw new ControlProtocolConfigurationError("Anycast gateway MAC must not be all zeroes", "anycastGatewayMac");
    }
    this.fabric = { anycastGatewayMac: normalized };
  }

  fabricConfiguration(): EvpnFabricConfiguration {
    return { ...this.fabric };
  }

  get anycastGatewayMac(): Mac | undefined {
    return this.fabric.anycastGatewayMac;
  }

  configurationSnapshot(): NveInterfaceConfiguration | undefined {
    if (!this.nve) return undefined;
    const { vrfMembers = [], ...nve } = this.nve;
    return {
      ...nve,
      members: this.nve.members.map((member) => ({
        ...member,
        replication: member.replication.type === "static"
          ? { type: "static", peerAddresses: [...member.replication.peerAddresses] }
          : { type: "bgp-evpn" },
      })),
      // A bridging-only NVE keeps exactly its pre-M10.15 shape, so an older lab
      // round-trips without gaining an empty key.
      ...(vrfMembers.length === 0 ? {} : { vrfMembers: vrfMembers.map((member) => ({ ...member })) }),
    };
  }

  // --- L3VNI ----------------------------------------------------------------

  vrfMembers(): readonly NveVrfMemberConfiguration[] {
    return this.nve?.vrfMembers ?? [];
  }

  /** The L3VNI that transports one VRF's routed traffic, if it has one. */
  l3VniForVrf(vrfId: string): number | undefined {
    return this.vrfMembers().find((member) => member.vrfId === vrfId)?.vni;
  }

  /** The VRF an arriving L3VNI packet must be routed in. */
  vrfForL3Vni(vni: number): string | undefined {
    return this.vrfMembers().find((member) => member.vni === vni)?.vrfId;
  }

  /** Per-L3VNI state: the NVE's state plus the named VRF still existing. */
  l3VniStates(): L3VniOperationalState[] {
    const base = this.state();
    return this.vrfMembers().map((member) => {
      const vrfPresent = this.hooks.hasVrf(member.vrfId);
      return {
        vni: member.vni,
        vrfId: member.vrfId,
        up: base.up && vrfPresent,
        sourceAddress: base.sourceAddress,
        reason: base.up ? (vrfPresent ? undefined : "vrf-missing") : base.reason,
      };
    });
  }

  l3VniState(vni: number): L3VniOperationalState | undefined {
    return this.l3VniStates().find((state) => state.vni === vni);
  }

  defineEvpnVni(configuration: EvpnVniConfiguration): void {
    if (!isValidVni(configuration.vni)) {
      throw new ControlProtocolConfigurationError(`VNI must be between ${MINIMUM_VNI} and ${MAXIMUM_VNI}`, "vni");
    }
    validateRouteDistinguisherText(configuration.routeDistinguisher, "rd");
    for (const target of configuration.importRouteTargets) validateRouteDistinguisherText(target, "route-target");
    for (const target of configuration.exportRouteTargets) validateRouteDistinguisherText(target, "route-target");
    enforceStructuralLimit("maximumVnisPerVtep", this.evpnVnis.size + (this.evpnVnis.has(configuration.vni) ? 0 : 1));
    this.evpnVnis.set(configuration.vni, {
      ...configuration,
      importRouteTargets: [...new Set(configuration.importRouteTargets)].sort(),
      exportRouteTargets: [...new Set(configuration.exportRouteTargets)].sort(),
    });
  }

  removeEvpnVni(vni: number): void {
    this.evpnVnis.delete(vni);
  }

  evpnVniConfigurations(): EvpnVniConfiguration[] {
    return [...this.evpnVnis.values()]
      .map((entry) => ({
        ...entry,
        importRouteTargets: [...entry.importRouteTargets],
        exportRouteTargets: [...entry.exportRouteTargets],
      }))
      .sort((a, b) => a.vni - b.vni);
  }

  evpnVni(vni: number): EvpnVniConfiguration | undefined {
    return this.evpnVnis.get(vni);
  }

  // --- mapping lookups -----------------------------------------------------

  members(): readonly NveMemberConfiguration[] {
    return this.nve?.members ?? [];
  }

  memberForVlan(vlanId: number): NveMemberConfiguration | undefined {
    return this.nve?.members.find((member) => member.vlanId === vlanId);
  }

  memberForVni(vni: number): NveMemberConfiguration | undefined {
    return this.nve?.members.find((member) => member.vni === vni);
  }

  // --- operational state ---------------------------------------------------

  /** The NVE's own state: admin, source loopback and a usable IPv4 address. */
  state(): NveOperationalState {
    const nve = this.nve;
    if (!nve) return { up: false, sourceAddress: undefined, reason: "administratively-down" };
    if (!nve.adminUp) return { up: false, sourceAddress: undefined, reason: "administratively-down" };
    if (!this.hooks.interfaceExists(nve.sourceInterfaceId)) {
      return { up: false, sourceAddress: undefined, reason: "source-interface-missing" };
    }
    if (!this.hooks.isLoopback(nve.sourceInterfaceId)) {
      return { up: false, sourceAddress: undefined, reason: "source-not-loopback" };
    }
    const sourceAddress = this.hooks.interfaceAddress(nve.sourceInterfaceId);
    if (sourceAddress === undefined) {
      return { up: false, sourceAddress: undefined, reason: "source-interface-down" };
    }
    return { up: true, sourceAddress, reason: undefined };
  }

  /** Per-VNI state: the NVE's state plus the mapped VLAN having to exist. */
  vniStates(): VniOperationalState[] {
    const base = this.state();
    return this.members().map((member) => {
      const vlanPresent = this.hooks.hasVlan(member.vlanId);
      const up = base.up && vlanPresent;
      return {
        vni: member.vni,
        vlanId: member.vlanId,
        replication: member.replication.type,
        up,
        sourceAddress: base.sourceAddress,
        reason: base.up ? (vlanPresent ? undefined : "vlan-missing") : base.reason,
      };
    });
  }

  vniState(vni: number): VniOperationalState | undefined {
    return this.vniStates().find((state) => state.vni === vni);
  }

  // --- replication membership ---------------------------------------------

  /**
   * The remote VTEPs one VNI replicates BUM traffic to, in stable address order
   * and never including this device's own source address.
   */
  peersForVni(vni: number): Ipv4[] {
    const member = this.memberForVni(vni);
    if (!member) return [];
    const local = this.state().sourceAddress;
    const addresses = member.replication.type === "static"
      ? [...member.replication.peerAddresses]
      : [...(this.evpnPeers.get(vni) ?? [])];
    return addresses
      .filter((address) => address !== local)
      .sort(compareAddresses)
      .slice(0, DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumRemoteVtepsPerVni);
  }

  peerSummaries(): VxlanPeerSummary[] {
    const rows: VxlanPeerSummary[] = [];
    for (const member of this.members()) {
      for (const address of this.peersForVni(member.vni)) {
        rows.push({
          vni: member.vni,
          address,
          source: member.replication.type,
          reachable: this.hooks.underlayReachable(address),
        });
      }
    }
    return rows.sort((a, b) => a.vni - b.vni || compareAddresses(a.address, b.address));
  }

  /** Replace the EVPN-derived membership of one VNI. Runtime only. */
  replaceEvpnPeers(vni: number, addresses: readonly Ipv4[]): boolean {
    const next = new Set([...addresses].sort(compareAddresses)
      .slice(0, DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumRemoteVtepsPerVni));
    const current = this.evpnPeers.get(vni);
    if (!current && next.size === 0) return false;
    if (current && current.size === next.size && [...next].every((address) => current.has(address))) return false;
    if (next.size === 0) this.evpnPeers.delete(vni);
    else this.evpnPeers.set(vni, next);
    return true;
  }

  clearEvpnPeers(): void {
    this.evpnPeers.clear();
  }

  // --- remote MAC table ----------------------------------------------------

  /**
   * Learn or refresh a remote MAC. Returns `true` when something changed.
   *
   * `multihoming` is only ever set by the EVPN control plane: a data-plane
   * learn has no segment to attribute the address to.
   */
  learnRemoteMac(
    vni: number,
    mac: Mac,
    remoteVtep: Ipv4,
    nowNs: number,
    source: RemoteMacSource,
    multihoming?: {
      ethernetSegmentId?: string;
      backupVteps?: readonly Ipv4[];
      aliasVteps?: readonly Ipv4[];
      redundancyMode?: "single-active" | "all-active";
    },
  ): boolean {
    const key = this.macKey(vni, mac);
    const existing = this.remoteMacs.get(key);
    if (!existing && this.remoteMacs.size >= DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumRemoteMacsPerVtep) return false;
    const backupVteps = [...(multihoming?.backupVteps ?? [])].sort(compareAddresses);
    const aliasVteps = [...(multihoming?.aliasVteps ?? [])].sort(compareAddresses);
    const changed = existing?.remoteVtep !== remoteVtep
      || existing?.source !== source
      || existing?.ethernetSegmentId !== multihoming?.ethernetSegmentId
      || existing?.redundancyMode !== multihoming?.redundancyMode
      || (existing?.backupVteps ?? []).join(",") !== backupVteps.join(",")
      || (existing?.aliasVteps ?? []).join(",") !== aliasVteps.join(",");
    this.remoteMacs.set(key, {
      vni,
      mac: normalizeMac(mac),
      remoteVtep,
      source,
      lastSeenNs: nowNs,
      ethernetSegmentId: multihoming?.ethernetSegmentId,
      backupVteps,
      redundancyMode: multihoming?.redundancyMode,
      aliasVteps,
    });
    return changed;
  }

  forgetRemoteMac(vni: number, mac: Mac): boolean {
    return this.remoteMacs.delete(this.macKey(vni, mac));
  }

  /** Drop every remote MAC one source installed, before reprogramming it. */
  forgetRemoteMacsFrom(source: RemoteMacSource): void {
    for (const [key, entry] of [...this.remoteMacs]) {
      if (entry.source === source) this.remoteMacs.delete(key);
    }
  }

  remoteMac(vni: number, mac: Mac): RemoteMacEntry | undefined {
    return this.remoteMacs.get(this.macKey(vni, mac));
  }

  remoteMacEntries(): RemoteMacEntry[] {
    return [...this.remoteMacs.values()]
      .sort((a, b) => a.vni - b.vni || a.mac.localeCompare(b.mac));
  }

  resetRuntime(): void {
    this.remoteMacs.clear();
    this.evpnPeers.clear();
  }

  private macKey(vni: number, mac: Mac): string {
    // A pipe separates a numeric VNI from a normalized MAC unambiguously and
    // keeps this source file plain text: a raw control character here made
    // every tool that reads the repository treat the file as binary.
    return [vni, normalizeMac(mac)].join("|");
  }
}

/**
 * `<asn|ipv4>:<number>` — the same administrator:assigned shape a VRF route
 * distinguisher uses. EVPN reuses it rather than inventing a second format.
 */
export function validateRouteDistinguisherText(value: string, field: string): void {
  const match = /^([^:]+):(\d+)$/u.exec(value);
  if (!match) throw new ControlProtocolConfigurationError(`Invalid ${field} '${value}'`, field);
  const assigned = Number(match[2]!);
  if (!Number.isInteger(assigned) || assigned < 0 || assigned > 4_294_967_295) {
    throw new ControlProtocolConfigurationError(`Invalid ${field} '${value}'`, field);
  }
  const administrator = match[1]!;
  if (/^\d+$/u.test(administrator)) {
    const asn = Number(administrator);
    if (!Number.isInteger(asn) || asn < 1 || asn > 4_294_967_295) {
      throw new ControlProtocolConfigurationError(`Invalid ${field} '${value}'`, field);
    }
    return;
  }
  ipToInt(administrator);
}

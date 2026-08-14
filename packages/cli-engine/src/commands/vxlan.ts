import {
  type EvpnEthernetSegmentConfiguration,
  type EvpnRoute,
  type EvpnVniConfiguration,
  type Layer3Switch,
  type NveInterfaceConfiguration,
  type NveMemberConfiguration,
  ESI_ZERO,
  evpnRouteVni,
  maskToInt,
  MAXIMUM_VNI,
  MINIMUM_VNI,
  normalizeMac,
  NVE_INTERFACE_ID,
} from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import { table } from "../formatter/tables";
import type { CommandSpec, SessionApi } from "../types";
import { isLayer3Switch, parseIpv4 } from "./helpers";

/**
 * The VXLAN tunnel endpoint is an L3 Switch capability. A Router stays an
 * underlay router — and may reflect EVPN routes — but never becomes a VTEP, so
 * every command here refuses anything else.
 */
function vtepOf(session: SessionApi): Layer3Switch {
  if (!isLayer3Switch(session.device)) {
    throw new InvalidModeError("VXLAN and the NVE interface are supported only on an L3 Switch");
  }
  return session.device;
}

function parseVni(value: string): number {
  const vni = Number(value);
  if (!Number.isInteger(vni) || vni < MINIMUM_VNI || vni > MAXIMUM_VNI) {
    throw new ValidationError(`VNI must be between ${MINIMUM_VNI} and ${MAXIMUM_VNI}.`);
  }
  return vni;
}

function parseVlanId(value: string): number {
  const vlanId = Number(value);
  if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4_094) {
    throw new ValidationError("VLAN id must be between 1 and 4094.");
  }
  return vlanId;
}

/**
 * Every NVE change goes through one atomic reconfigure, so a rejected edit
 * never leaves the interface half-applied. The engine owns validation: VNI
 * range, the one-VLAN-one-VNI rule and every bound are enforced there.
 */
function updateNve(
  session: SessionApi,
  mutate: (current: NveInterfaceConfiguration | undefined) => NveInterfaceConfiguration,
): void {
  const device = vtepOf(session);
  try {
    device.configureNve(mutate(device.nveConfiguration()));
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid NVE configuration.");
  }
}

/** The NVE as it currently stands, or an empty admin-down interface. */
function nveBase(current: NveInterfaceConfiguration | undefined): NveInterfaceConfiguration {
  return current ?? { id: NVE_INTERFACE_ID, sourceInterfaceId: "", adminUp: false, members: [] };
}

function requireSource(current: NveInterfaceConfiguration | undefined): NveInterfaceConfiguration {
  const base = nveBase(current);
  if (!base.sourceInterfaceId) throw new ValidationError("Configure 'source-interface <Loopback>' first.");
  return base;
}

/** `shutdown`/`no shutdown`, which a learner may type before the source. */
function setNveAdminState(session: SessionApi, adminUp: boolean): void {
  const current = vtepOf(session).nveConfiguration();
  if (!current) {
    pendingState(session).adminUp = adminUp;
    return;
  }
  updateNve(session, () => ({ ...current, adminUp }));
}

/** Replace one member in place, preserving every other member untouched. */
function withMember(
  base: NveInterfaceConfiguration,
  vni: number,
  mutate: (member: NveMemberConfiguration | undefined) => NveMemberConfiguration,
): NveInterfaceConfiguration {
  const existing = base.members.find((member) => member.vni === vni);
  return {
    ...base,
    members: [...base.members.filter((member) => member.vni !== vni), mutate(existing)],
  };
}

function requireNveVni(session: SessionApi): number {
  const vni = session.nveCtx?.memberVni;
  if (vni === undefined) throw new InvalidModeError("Enter 'member vni <1-16777215>' first");
  return vni;
}

/**
 * Settings typed before the NVE can exist.
 *
 * `nve1` is only configurable once it has a source interface, and a VNI is only
 * a member once `vlan configuration <id>` binds a VLAN to it. A learner types
 * both halves in the natural order instead, so what cannot be applied yet is
 * parked here and flushed the moment the missing half arrives.
 *
 * The store hangs off the session, not the device, so it is collected with the
 * terminal tab and can never survive a rebuild into a reused device id.
 */
interface PendingNveState {
  adminUp: boolean | undefined;
  members: Map<number, NveMemberConfiguration["replication"]>;
}

const pendingBySession = new WeakMap<SessionApi, PendingNveState>();

function pendingState(session: SessionApi): PendingNveState {
  const store = pendingBySession.get(session) ?? { adminUp: undefined, members: new Map() };
  pendingBySession.set(session, store);
  return store;
}

function pendingMembers(session: SessionApi): Map<number, NveMemberConfiguration["replication"]> {
  return pendingState(session).members;
}

/** Apply a member edit, holding it aside while the VNI still has no VLAN. */
function updateMember(
  session: SessionApi,
  vni: number,
  mutate: (replication: NveMemberConfiguration["replication"]) => NveMemberConfiguration["replication"],
): void {
  const device = vtepOf(session);
  const existing = device.nveConfiguration()?.members.find((member) => member.vni === vni);
  if (existing) {
    updateNve(session, (current) => withMember(requireSource(current), vni, (member) => ({
      vni,
      vlanId: member?.vlanId ?? existing.vlanId,
      replication: mutate(member?.replication ?? existing.replication),
    })));
    return;
  }
  const pending = pendingMembers(session);
  pending.set(vni, mutate(pending.get(vni) ?? { type: "static", peerAddresses: [] }));
}

function evpnVniOf(session: SessionApi): EvpnVniConfiguration {
  const vni = session.evpnCtx?.vni;
  if (vni === undefined) throw new InvalidModeError("Enter 'vni <1-16777215> l2' first");
  return vtepOf(session).evpnVniConfigurations().find((entry) => entry.vni === vni)
    ?? { vni, routeDistinguisher: "", importRouteTargets: [], exportRouteTargets: [] };
}

function updateEvpnVni(
  session: SessionApi,
  mutate: (current: EvpnVniConfiguration) => EvpnVniConfiguration,
): void {
  const device = vtepOf(session);
  try {
    device.defineEvpnVni(mutate(evpnVniOf(session)));
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid EVPN VNI configuration.");
  }
}

// --- inspection -----------------------------------------------------------

function showNveInterfaces(session: SessionApi): string {
  const rows = vtepOf(session).nveSummaries();
  if (!rows.length) return "% No NVE interface configured.";
  return table(["Interface", "Source", "Address", "State", "VNIs", "Reason"], rows.map((row) => [
    row.id,
    row.sourceInterfaceId,
    row.sourceAddress ?? "unassigned",
    row.up ? "up" : "down",
    String(row.vniCount),
    row.reason ?? "—",
  ]));
}

function showNveVni(session: SessionApi): string {
  const rows = vtepOf(session).vniSummaries();
  if (!rows.length) return "% No VNI is mapped.";
  return table(["VNI", "VLAN", "Replication", "State", "Reason"], rows.map((row) => [
    String(row.vni),
    String(row.vlanId),
    row.replication === "bgp-evpn" ? "ingress-replication bgp" : "ingress-replication static",
    row.up ? "up" : "down",
    row.reason ?? "—",
  ]));
}

function showNvePeers(session: SessionApi): string {
  const rows = vtepOf(session).vxlanPeerSummaries();
  if (!rows.length) return "% No remote VTEP peers.";
  return table(["VNI", "Peer", "Learned from", "Underlay"], rows.map((row) => [
    String(row.vni),
    row.address,
    row.source === "bgp-evpn" ? "BGP EVPN" : "static",
    row.reachable ? "reachable" : "unreachable",
  ]));
}

function showRemoteMacs(session: SessionApi): string {
  const rows = vtepOf(session).remoteMacEntries();
  if (!rows.length) return "% No remote MAC addresses.";
  return table(["VNI", "MAC", "Remote VTEP", "Learned from"], rows.map((row) => [
    String(row.vni),
    row.mac,
    row.remoteVtep,
    row.source === "bgp-evpn" ? "BGP EVPN" : "data plane",
  ]));
}

/** `show vxlan`: the overlay in one screen — mappings, peers and remote MACs. */
function showVxlan(session: SessionApi): string {
  const device = vtepOf(session);
  const nve = device.nveSummaries()[0];
  if (!nve) return "% No NVE interface configured.";
  const remoteMacs = device.remoteMacEntries();
  return [
    `${nve.id} source ${nve.sourceInterfaceId} (${nve.sourceAddress ?? "unassigned"}) is ${nve.up ? "up" : `down: ${nve.reason}`}`,
    "",
    showNveVni(session),
    "",
    showNvePeers(session),
    "",
    `Remote MAC entries: ${remoteMacs.length}`,
  ].join("\n");
}

/**
 * `show bgp l2vpn evpn`, optionally narrowed to a route type or a VNI.
 *
 * The table is readable wherever the family is: a Route Reflector is an
 * ordinary Router that carries these routes on its BGP process without ever
 * being a VTEP, so the routes come from BGP rather than from an overlay.
 */
function showEvpnTable(
  session: SessionApi,
  filter: { routeType?: 1 | 2 | 3 | 4 | 5; vni?: number; routeTargets?: readonly string[] } = {},
): string {
  const device = session.device as { bgp?: Layer3Switch["bgp"] };
  if (!device.bgp) throw new InvalidModeError("BGP requires a Router or an L3 Switch");
  const wanted = filter.routeTargets === undefined ? undefined : new Set(filter.routeTargets);
  const routes = (isLayer3Switch(session.device) ? session.device.evpnRoutes() : device.bgp.evpnRoutes())
    .filter((route) => filter.routeType === undefined || route.type === filter.routeType)
    .filter((route) => filter.vni === undefined || evpnRouteVni(route) === filter.vni)
    .filter((route) => wanted === undefined || route.routeTargets.some((target) => wanted.has(target)));
  if (!routes.length) return "% EVPN table is empty.";
  // One table for every route type: a Type 5 names a prefix where a Type 2
  // names a MAC and a Type 3 its originating VTEP.
  return table(["Status", "Type", "RD", "VNI", "MAC / Prefix / VTEP", "Next Hop", "Route Targets", "Originator"], routes.map((route) => [
    route.best ? "*>" : "*",
    `[${route.type}]`,
    route.routeDistinguisher,
    String(evpnRouteVni(route)),
    evpnRouteSubject(route),
    route.nextHop,
    route.routeTargets.join(",") || "—",
    route.originatorId ?? "—",
  ]));
}

/** What one EVPN route is *about*, in the single column the table gives it. */
function evpnRouteSubject(route: EvpnRoute): string {
  if (route.type === 2) return route.macAddress;
  if (route.type === 5) return `${route.network}/${route.prefixLength}`;
  if (route.type === 4) return route.esi;
  if (route.type === 1) return `${route.esi} (${route.scope})`;
  return route.originatingVtep;
}

// --- EVPN multihoming ------------------------------------------------------

/**
 * The `config-if` context as an attachment name.
 *
 * An Ethernet Segment attaches a CE, so it lives on an access switchport or a
 * Port-channel: an SVI or a subinterface is refused here rather than reaching
 * the engine, which then applies the remaining eligibility rules.
 */
function accessPortName(session: SessionApi): string {
  const context = session.ifaceCtx;
  if (!context) throw new InvalidModeError("Enter 'interface <name>' first");
  if (context.sviVlan !== undefined || context.isSubinterface) {
    throw new InvalidModeError("An Ethernet Segment is configured on an access switchport or a Port-channel");
  }
  return context.physical;
}

/**
 * Every segment edit goes through one atomic reconfigure, as the NVE does.
 *
 * A segment only exists once it has a usable ESI, so an edit made before
 * `identifier` is accepted and simply has nothing to apply yet. `single-active`
 * stays the default, so a segment that never names a mode is unchanged.
 */
function updateEthernetSegment(
  session: SessionApi,
  mutate: (current: EvpnEthernetSegmentConfiguration) => EvpnEthernetSegmentConfiguration,
  options: { requireIdentifier?: boolean } = {},
): void {
  const device = vtepOf(session);
  const context = session.ethernetSegmentCtx;
  if (!context) throw new InvalidModeError("Enter 'evpn ethernet-segment <name>' first");
  const current = device.ethernetSegmentConfigurations().find((entry) => entry.id === context.id)
    ?? { id: context.id, esi: ESI_ZERO, redundancyMode: "single-active" as const, interfaces: [] };
  const next = mutate(current);
  // A setting typed before `identifier` has nothing to apply yet. That is only
  // true for the placeholder, never for an ESI the author actually typed: a
  // reserved value must still be reported rather than quietly dropped.
  if (options.requireIdentifier !== true && next.esi === ESI_ZERO) return;
  try {
    device.configureEthernetSegment(next);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Invalid Ethernet Segment configuration.");
  }
}

/** `show evpn ethernet-segment [detail] [esi <esi>]`. */
function showEthernetSegments(session: SessionApi, detail: boolean, esi?: string): string {
  const device = vtepOf(session);
  const wanted = esi === undefined ? undefined : esi.trim().toLowerCase();
  const states = device.ethernetSegmentStates().filter((state) => wanted === undefined || state.esi === wanted);
  if (!states.length) return "% No Ethernet Segment is configured.";
  const summary = table(
    ["Segment", "ESI", "Redundancy", "DF election", "Interfaces", "State", "Reason"],
    states.map((state) => [
      state.id,
      state.esi,
      state.redundancyMode,
      state.dfAlgorithm,
      state.interfaces.join(",") || "—",
      state.up ? "up" : "down",
      state.reason ?? "—",
    ]),
  );
  if (!detail) return summary;
  const peers = device.ethernetSegmentPeers().filter((peer) => wanted === undefined || peer.esi === wanted);
  const df = device.designatedForwarderStates().filter((entry) => wanted === undefined || entry.esi === wanted);
  return [
    summary,
    "",
    peers.length
      ? table(["ESI", "VTEP", "Origin", "Reachability", "Redundancy", "DF election"], peers.map((peer) => [
        peer.esi,
        peer.vtep,
        peer.local ? "local" : "remote",
        peer.reachable ? "ethernet-ad" : "no ethernet-ad",
        peer.modeAgrees ? peer.redundancyMode : `${peer.redundancyMode} (mismatch)`,
        peer.dfAlgorithm,
      ]))
      : "% No Ethernet Segment peer is known.",
    "",
    df.length
      ? table(["ESI", "VLAN", "Designated Forwarder", "Backup", "Local role"], df.map((entry) => [
        entry.esi,
        String(entry.vlanId),
        entry.designatedForwarder ?? "none",
        entry.backupDesignatedForwarder ?? "—",
        entry.localRole.toUpperCase(),
      ]))
      : "% No Designated Forwarder has been elected.",
  ].join("\n");
}

/** `show evpn df [vlan <id>]`: who forwards toward the CE, and who stands by. */
function showDfTable(session: SessionApi, vlanId?: number): string {
  const rows = vtepOf(session).designatedForwarderStates()
    .filter((entry) => vlanId === undefined || entry.vlanId === vlanId);
  if (!rows.length) return "% No Designated Forwarder has been elected.";
  return table(
    ["ESI", "VLAN", "Candidates", "Designated Forwarder", "Backup", "Algorithm", "Local role"],
    rows.map((row) => [
      row.esi,
      String(row.vlanId),
      row.candidates.join(",") || "—",
      row.designatedForwarder ?? "none",
      row.backupDesignatedForwarder ?? "—",
      row.effectiveAlgorithm,
      row.localRole.toUpperCase(),
    ]),
  );
}

/**
 * `show evpn df detail`: the election itself, including the weights.
 *
 * A fallback is reported as what it is — informational — because the segment
 * still elects exactly one forwarder either way.
 */
function showDfDetail(session: SessionApi): string {
  const rows = vtepOf(session).designatedForwarderStates();
  if (!rows.length) return "% No Designated Forwarder has been elected.";
  return rows.flatMap((row) => [
    `Ethernet Segment ${row.esi}, VLAN ${row.vlanId}`,
    `  Requested algorithm : ${row.requestedAlgorithm}`,
    `  Effective algorithm : ${row.effectiveAlgorithm}`
      + (row.fallbackReason === undefined ? "" : ` (fell back: ${row.fallbackReason})`),
    `  Designated Forwarder: ${row.designatedForwarder ?? "none"}`,
    `  Backup              : ${row.backupDesignatedForwarder ?? "—"}`,
    `  Local role          : ${row.localRole.toUpperCase()}`,
    row.candidateWeights.length === 0
      ? "  Candidate weights   : — (modulus election computes none)"
      : `  Candidate weights   : ${row.candidateWeights.map((entry) => `${entry.vtep}=${entry.weight}`).join(", ")}`,
    "",
  ]).join("\n").trimEnd();
}

/**
 * Accept the Cisco `0200.0000.0001` shape and the colon form alike.
 *
 * The shape is checked here rather than left to `normalizeMac`, which is
 * deliberately lenient: a typo at a prompt must be reported, never silently
 * turned into an address that then matches nothing.
 */
function parseMacText(value: string): string {
  const dotted = /^([0-9a-f]{4})\.([0-9a-f]{4})\.([0-9a-f]{4})$/iu.exec(value);
  const candidate = dotted
    ? `${dotted[1]}${dotted[2]}${dotted[3]}`.match(/.{2}/gu)!.join(":")
    : value;
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/iu.test(candidate)) {
    throw new ValidationError(`'${value}' is not a valid MAC address.`);
  }
  return normalizeMac(candidate);
}

/** `show evpn aliasing [mac <mac>]`: every live path of an All-Active address. */
function showAliasing(session: SessionApi, mac?: string): string {
  const wanted = mac === undefined ? undefined : parseMacText(mac);
  const rows = vtepOf(session).aliasingPathSets()
    .filter((row) => wanted === undefined || row.macAddress === wanted);
  if (!rows.length) return "% No All-Active aliasing path is programmed.";
  return table(
    ["MAC", "ESI", "VNI", "Advertised by", "Eligible", "Selected", "State"],
    rows.map((row) => [
      row.macAddress,
      row.esi,
      String(row.vni),
      row.advertisingVtep,
      row.eligibleVteps.join(",") || "—",
      row.selectedVtep,
      row.reason,
    ]),
  );
}

/** `show evpn mac-mobility`: where the fabric believes each address lives. */
function showMacMobility(session: SessionApi): string {
  const rows = vtepOf(session).macMobilityStates();
  if (!rows.length) return "% No MAC mobility state is tracked.";
  return table(
    ["VNI", "MAC", "Sequence", "Current owner", "Location", "Previous owner", "State"],
    rows.map((row) => [
      String(row.vni),
      row.macAddress,
      String(row.sequence),
      row.owner,
      row.location,
      row.previousOwner ?? "—",
      row.state,
    ]),
  );
}

/** A dotted subnet mask as a prefix length, rejecting a non-contiguous mask. */
function maskPrefixLength(mask: string): number {
  const value = maskToInt(parseIpv4(mask));
  const length = 32 - Math.log2((~value >>> 0) + 1);
  if (!Number.isInteger(length) || length < 0 || length > 32) {
    throw new ValidationError(`'${mask}' is not a valid subnet mask.`);
  }
  return length;
}

/** The logical interface the current `config-if` context is editing. */
function sviOrPortName(session: SessionApi): string {
  const context = session.ifaceCtx;
  if (!context) throw new InvalidModeError("Enter 'interface <name>' first");
  if (context.sviVlan !== undefined) return `Vlan${context.sviVlan}`;
  return context.isSubinterface ? context.label : context.physical;
}

function setSviAnycast(session: SessionApi, enabled: boolean): void {
  const context = session.ifaceCtx;
  if (!context || context.sviVlan === undefined) {
    throw new InvalidModeError("Anycast gateway mode is only valid on an SVI");
  }
  vtepOf(session).setSviAnycastGateway(context.sviVlan, enabled);
}

/**
 * Accept both the Cisco `0200.0000.0001` shape and the colon form the rest of
 * SimulatorNet uses, and normalize to one canonical spelling.
 */
function parseFabricMac(value: string): string {
  const dotted = /^([0-9a-f]{4})\.([0-9a-f]{4})\.([0-9a-f]{4})$/iu.exec(value);
  const hex = dotted ? `${dotted[1]}${dotted[2]}${dotted[3]}`.toLowerCase() : undefined;
  const colon = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/iu.test(value) ? value.toLowerCase() : undefined;
  const normalized = hex ? (hex.match(/../gu) ?? []).join(":") : colon;
  if (!normalized) throw new ValidationError(`'${value}' is not a MAC address.`);
  return normalized;
}

/** `show forwarding distribution evpn`: what the distributed gateway is. */
function showAnycastGateway(session: SessionApi): string {
  const device = vtepOf(session);
  const mac = device.fabricConfiguration().anycastGatewayMac;
  if (mac === undefined) return "% No anycast gateway MAC is configured.";
  const rows = device.sviSummaries()
    .filter((svi) => device.isAnycastGateway(svi.vlanId))
    .map((svi) => [
      `Vlan${svi.vlanId}`,
      svi.ip ?? "—",
      mac,
      device.interfaceVrf(`Vlan${svi.vlanId}`) ?? "default",
      svi.operUp ? "up" : "down",
    ]);
  if (!rows.length) return `Anycast gateway MAC: ${mac}\n% No SVI runs in anycast-gateway mode.`;
  return `Anycast gateway MAC: ${mac}\n${table(["Interface", "Gateway IP", "Gateway MAC", "VRF", "State"], rows)}`;
}

/** `show ip route vrf <name>`: one tenant's table, never the global one. */
function showVrfRoutes(session: SessionApi, name: string): string {
  const device = vtepOf(session);
  const vrf = device.vrfConfigurations().find((entry) => entry.id === name || entry.name === name);
  if (!vrf) throw new ValidationError(`Unknown VRF '${name}'.`);
  const routes = device.vrfRoutingTable(vrf.id);
  if (!routes.length) return `% VRF ${vrf.name} routing table is empty.`;
  return table(["Source", "Network", "Next Hop", "L3VNI", "AD/Metric"], routes.map((route) => [
    route.source,
    `${route.network}/${route.prefixLength}`,
    route.remoteVtep ?? route.nextHop ?? route.outgoingInterfaceId ?? "—",
    route.l3Vni === undefined ? "—" : String(route.l3Vni),
    `${route.administrativeDistance}/${route.metric}`,
  ]));
}

/**
 * Tenant VRFs on a VTEP.
 *
 * These mirror the Router's `vrf definition` subset, but they are scoped to the
 * L3 Switch and carry no MPLS: an EVPN tenant is a routing context an L3VNI
 * transports, never an LDP/VPN-label customer. MPLS and LDP stay Router-only.
 */
function updateVtepVrf(
  session: SessionApi,
  mutate: (current: ReturnType<Layer3Switch["vrfConfigurations"]>[number] | undefined) => Parameters<Layer3Switch["defineVrf"]>[0],
): void {
  const device = vtepOf(session);
  const context = session.vrfCtx;
  if (!context) throw new InvalidModeError("Enter 'vrf definition <name>' first");
  const current = device.vrfConfigurations().find((vrf) => vrf.id === context.id);
  const next = mutate(current);
  device.defineVrf(next);
  context.routeDistinguisher = next.routeDistinguisher;
}

/** Carry every setting the caller is not changing through `defineVrf`. */
function vtepVrfBase(session: SessionApi, current: ReturnType<Layer3Switch["vrfConfigurations"]>[number] | undefined) {
  return {
    id: session.vrfCtx!.id,
    name: session.vrfCtx!.name,
    routeDistinguisher: current?.routeDistinguisher ?? session.vrfCtx!.routeDistinguisher!,
    importRouteTargets: current?.importRouteTargets ?? [],
    exportRouteTargets: current?.exportRouteTargets ?? [],
    advertiseEvpn: current?.advertiseEvpn,
  };
}

export const vxlanCommands: CommandSpec[] = [
  // --- vrf definition <name> (tenant routing context) ---------------------
  {
    pattern: "vrf definition {name}", usage: "vrf definition <name>",
    modes: ["config"], device: "l3-switch",
    run: (s, p) => {
      const device = vtepOf(s);
      const existing = device.vrfConfigurations().find((vrf) => vrf.name === p.name || vrf.id === p.name);
      s.vrfCtx = {
        id: existing?.id ?? p.name!,
        name: existing?.name ?? p.name!,
        routeDistinguisher: existing?.routeDistinguisher,
      };
      s.enter("config-vrf");
    },
  },
  {
    pattern: "no vrf definition {name}", modes: ["config"], device: "l3-switch",
    run: (s, p) => {
      const device = vtepOf(s);
      const vrf = device.vrfConfigurations().find((entry) => entry.id === p.name || entry.name === p.name);
      if (vrf) device.removeVrf(vrf.id);
    },
  },
  {
    pattern: "rd {value}", usage: "rd <asn:number|ipv4:number>", modes: ["config-vrf"], device: "l3-switch",
    run: (s, p) => updateVtepVrf(s, (current) => ({ ...vtepVrfBase(s, current), routeDistinguisher: p.value! })),
  },
  {
    pattern: "route-target {direction} {value}", usage: "route-target import|export <asn:number|ipv4:number>",
    modes: ["config-vrf"], device: "l3-switch",
    run: (s, p) => updateVtepVrf(s, (current) => {
      if (!current && !s.vrfCtx?.routeDistinguisher) throw new ValidationError("Configure the route distinguisher first.");
      if (p.direction !== "import" && p.direction !== "export") {
        throw new ValidationError("Route-target direction must be import or export.");
      }
      const imports = [...(current?.importRouteTargets ?? [])];
      const exports = [...(current?.exportRouteTargets ?? [])];
      const list = p.direction === "import" ? imports : exports;
      if (!list.includes(p.value!)) list.push(p.value!);
      return { ...vtepVrfBase(s, current), importRouteTargets: imports, exportRouteTargets: exports };
    }),
  },
  {
    pattern: "exit-address-family", modes: ["config-vrf"], device: "l3-switch",
    run: () => undefined,
  },
  {
    pattern: "ip route vrf {vrf} {network} {mask} {nextHop}",
    usage: "ip route vrf <name> <network> <mask> <next-hop>",
    modes: ["config"], device: "l3-switch",
    run: (s, p) => {
      const device = vtepOf(s);
      const vrf = device.vrfConfigurations().find((entry) => entry.id === p.vrf || entry.name === p.vrf);
      if (!vrf) throw new ValidationError(`VRF '${p.vrf}' is not defined.`);
      device.addVrfStaticRoute(vrf.id, parseIpv4(p.network!), maskPrefixLength(p.mask!), parseIpv4(p.nextHop!));
    },
  },

  // --- fabric forwarding (distributed anycast gateway) ---------------------
  {
    pattern: "fabric forwarding anycast-gateway-mac {mac}",
    usage: "fabric forwarding anycast-gateway-mac <H.H.H|hh:hh:hh:hh:hh:hh>",
    modes: ["config"], device: "l3-switch",
    run: (s, p) => vtepOf(s).setFabricAnycastGatewayMac(parseFabricMac(p.mac!)),
  },
  {
    pattern: "no fabric forwarding anycast-gateway-mac", modes: ["config"], device: "l3-switch",
    run: (s) => vtepOf(s).setFabricAnycastGatewayMac(undefined),
  },

  // --- interface Vlan<n> (tenant SVI) -------------------------------------
  {
    pattern: "vrf forwarding {name}", usage: "vrf forwarding <vrf-name>",
    modes: ["config-if"], device: "l3-switch",
    run: (s, p) => {
      const device = vtepOf(s);
      const vrf = device.vrfConfigurations().find((entry) => entry.id === p.name || entry.name === p.name);
      if (!vrf) throw new ValidationError(`Unknown VRF '${p.name}'. Configure 'vrf definition ${p.name}' first.`);
      device.assignInterfaceVrf(sviOrPortName(s), vrf.id);
    },
  },
  {
    pattern: "no vrf forwarding {name}", modes: ["config-if"], device: "l3-switch",
    run: (s) => vtepOf(s).assignInterfaceVrf(sviOrPortName(s), undefined),
  },
  {
    /**
     * `fabric forwarding mode anycast-gateway` makes this SVI answer with the
     * fabric-wide MAC. Every leaf carrying the VLAN then presents the same
     * gateway IP and MAC, which is why it is never a duplicate-address error.
     */
    pattern: "fabric forwarding mode anycast-gateway", modes: ["config-if"], device: "l3-switch",
    run: (s) => setSviAnycast(s, true),
  },
  {
    pattern: "no fabric forwarding mode anycast-gateway", modes: ["config-if"], device: "l3-switch",
    run: (s) => setSviAnycast(s, false),
  },

  // --- interface nve1 -----------------------------------------------------
  {
    pattern: "interface nve1", modes: ["config"], device: "l3-switch",
    run: (s) => {
      vtepOf(s);
      s.nveCtx = { memberVni: undefined };
      s.enter("config-nve");
    },
  },
  {
    pattern: "no interface nve1", modes: ["config"], device: "l3-switch",
    run: (s) => {
      vtepOf(s).removeNve();
      pendingMembers(s).clear();
    },
  },
  {
    pattern: "source-interface {name}", usage: "source-interface <Loopback0-32>",
    modes: ["config-nve"], device: "l3-switch",
    run: (s, p) => {
      const device = vtepOf(s);
      const name = p.name!;
      // A VTEP sources from a Loopback so its endpoint survives any one port.
      if (!device.isLoopback(name)) throw new ValidationError(`'${name}' is not a Loopback interface.`);
      const pending = pendingState(s);
      updateNve(s, (current) => {
        const base = nveBase(current);
        return { ...base, sourceInterfaceId: name, adminUp: pending.adminUp ?? base.adminUp };
      });
      pending.adminUp = undefined;
    },
  },
  {
    pattern: "shutdown", modes: ["config-nve"], device: "l3-switch",
    run: (s) => setNveAdminState(s, false),
  },
  {
    pattern: "no shutdown", modes: ["config-nve"], device: "l3-switch",
    run: (s) => setNveAdminState(s, true),
  },
  {
    pattern: "member vni {vni}", usage: "member vni <1-16777215>",
    modes: ["config-nve"], device: "l3-switch",
    run: (s, p) => {
      const vni = parseVni(p.vni!);
      vtepOf(s);
      s.nveCtx = { memberVni: vni };
      s.enter("config-nve-vni");
    },
  },
  {
    pattern: "no member vni {vni}", modes: ["config-nve"], device: "l3-switch",
    run: (s, p) => {
      const vni = parseVni(p.vni!);
      pendingMembers(s).delete(vni);
      updateNve(s, (current) => {
        const base = nveBase(current);
        return { ...base, members: base.members.filter((member) => member.vni !== vni) };
      });
    },
  },
  {
    /**
     * `member vni <n> associate-vrf <name>` declares an **L3VNI**: a routed
     * transit segment with no VLAN, which is what symmetric IRB forwards
     * through. The VRF is named here rather than inferred from a separate
     * `vni` line, so the NVE block stays the one place a VNI is bound to a
     * routing context and the two can never drift apart.
     */
    pattern: "member vni {vni} associate-vrf {vrf}",
    usage: "member vni <1-16777215> associate-vrf <vrf-name>",
    modes: ["config-nve"], device: "l3-switch",
    run: (s, p) => {
      const vni = parseVni(p.vni!);
      const device = vtepOf(s);
      const target = device.vrfConfigurations().find((vrf) => vrf.id === p.vrf || vrf.name === p.vrf);
      if (!target) throw new ValidationError(`Unknown VRF '${p.vrf}'. Configure 'vrf definition ${p.vrf}' first.`);
      updateNve(s, (current) => {
        const base = nveBase(current);
        const others = (base.vrfMembers ?? []).filter((member) => member.vni !== vni);
        return { ...base, vrfMembers: [...others, { vni, vrfId: target.id }].sort((a, b) => a.vni - b.vni) };
      });
    },
  },
  {
    pattern: "no member vni {vni} associate-vrf", modes: ["config-nve"], device: "l3-switch",
    run: (s, p) => {
      const vni = parseVni(p.vni!);
      updateNve(s, (current) => {
        const base = nveBase(current);
        const rest = (base.vrfMembers ?? []).filter((member) => member.vni !== vni);
        return { ...base, vrfMembers: rest.length > 0 ? rest : undefined };
      });
    },
  },
  {
    pattern: "ingress-replication protocol bgp", modes: ["config-nve-vni"], device: "l3-switch",
    run: (s) => updateMember(s, requireNveVni(s), () => ({ type: "bgp-evpn" })),
  },
  {
    pattern: "peer-ip {address}", usage: "peer-ip <remote VTEP IPv4>",
    modes: ["config-nve-vni"], device: "l3-switch",
    run: (s, p) => {
      const address = parseIpv4(p.address!);
      updateMember(s, requireNveVni(s), (replication) => {
        if (replication.type !== "static") {
          throw new ValidationError("This VNI uses BGP EVPN ingress replication; remove it before adding a static peer.");
        }
        return replication.peerAddresses.includes(address)
          ? replication
          : { type: "static", peerAddresses: [...replication.peerAddresses, address] };
      });
    },
  },
  {
    pattern: "no peer-ip {address}", modes: ["config-nve-vni"], device: "l3-switch",
    run: (s, p) => {
      const address = parseIpv4(p.address!);
      updateMember(s, requireNveVni(s), (replication) => replication.type === "static"
        ? { type: "static", peerAddresses: replication.peerAddresses.filter((peer) => peer !== address) }
        : replication);
    },
  },

  // --- vlan configuration <id> --------------------------------------------
  {
    pattern: "vlan configuration {id}", usage: "vlan configuration <1-4094>",
    modes: ["config"], device: "l3-switch",
    run: (s, p) => {
      vtepOf(s);
      s.vlanConfigCtx = { vlanId: parseVlanId(p.id!) };
      s.enter("config-vlan-config");
    },
  },
  {
    pattern: "member vni {vni}", usage: "member vni <1-16777215>",
    modes: ["config-vlan-config"], device: "l3-switch",
    run: (s, p) => {
      const vni = parseVni(p.vni!);
      const vlanId = s.vlanConfigCtx!.vlanId;
      const pending = pendingMembers(s);
      updateNve(s, (current) => withMember(requireSource(current), vni, (member) => ({
        vni,
        vlanId,
        replication: member?.replication ?? pending.get(vni) ?? { type: "static", peerAddresses: [] },
      })));
      pending.delete(vni);
    },
  },
  {
    pattern: "no member vni {vni}", modes: ["config-vlan-config"], device: "l3-switch",
    run: (s, p) => {
      const vni = parseVni(p.vni!);
      updateNve(s, (current) => {
        const base = nveBase(current);
        return { ...base, members: base.members.filter((member) => member.vni !== vni) };
      });
    },
  },

  // --- evpn ---------------------------------------------------------------
  {
    pattern: "evpn", modes: ["config"], device: "l3-switch",
    run: (s) => {
      vtepOf(s);
      s.evpnCtx = { vni: undefined };
      s.enter("config-evpn");
    },
  },
  {
    pattern: "vni {vni} l2", usage: "vni <1-16777215> l2", modes: ["config-evpn"], device: "l3-switch",
    run: (s, p) => {
      const vni = parseVni(p.vni!);
      vtepOf(s);
      s.evpnCtx = { vni };
      s.enter("config-evpn-vni");
    },
  },
  {
    pattern: "no vni {vni} l2", modes: ["config-evpn"], device: "l3-switch",
    run: (s, p) => vtepOf(s).removeEvpnVni(parseVni(p.vni!)),
  },
  {
    pattern: "rd {value}", usage: "rd <asn:number|ipv4:number>", modes: ["config-evpn-vni"], device: "l3-switch",
    run: (s, p) => updateEvpnVni(s, (current) => ({ ...current, routeDistinguisher: p.value! })),
  },
  {
    pattern: "route-target {direction} {value}",
    usage: "route-target import|export <asn:number|ipv4:number>",
    modes: ["config-evpn-vni"], device: "l3-switch",
    run: (s, p) => updateEvpnVni(s, (current) => {
      if (!current.routeDistinguisher) throw new ValidationError("Configure the route distinguisher first.");
      if (p.direction !== "import" && p.direction !== "export") {
        throw new ValidationError("Route-target direction must be import or export.");
      }
      const key = p.direction === "import" ? "importRouteTargets" : "exportRouteTargets";
      const list = [...current[key]];
      if (!list.includes(p.value!)) list.push(p.value!);
      return { ...current, [key]: list };
    }),
  },
  {
    pattern: "exit-address-family", modes: ["config-evpn", "config-evpn-vni"], device: "l3-switch",
    run: () => undefined,
  },

  // --- evpn ethernet-segment (multihoming) --------------------------------
  {
    /**
     * `evpn ethernet-segment <name>` is its own top-level block, not a line
     * inside `evpn`: the segment exists before any interface joins it, exactly
     * as it is entered.
     */
    pattern: "evpn ethernet-segment {name}", usage: "evpn ethernet-segment <name>",
    modes: ["config"], device: "l3-switch",
    run: (s, p) => {
      vtepOf(s);
      s.ethernetSegmentCtx = { id: p.name! };
      s.enter("config-evpn-es");
    },
  },
  {
    pattern: "no evpn ethernet-segment {name}", modes: ["config"], device: "l3-switch",
    run: (s, p) => vtepOf(s).removeEthernetSegment(p.name!),
  },
  {
    pattern: "identifier {esi}", usage: "identifier <hhhh:hhhh:hhhh:hhhh:hhhh>",
    modes: ["config-evpn-es"], device: "l3-switch",
    run: (s, p) => updateEthernetSegment(s, (current) => ({ ...current, esi: p.esi! }), { requireIdentifier: true }),
  },
  {
    /**
     * Single-Active and All-Active are both modelled. Every other Cisco mode —
     * preference-based, port-active — is refused here rather than accepted and
     * quietly treated as something else.
     */
    pattern: "redundancy-mode {mode}", usage: "redundancy-mode single-active|all-active",
    modes: ["config-evpn-es"], device: "l3-switch",
    run: (s, p) => {
      const mode = p.mode?.toLowerCase();
      if (mode !== "single-active" && mode !== "all-active") {
        throw new ValidationError(
          "Only 'single-active' and 'all-active' redundancy are supported;"
          + " preference-based and port-active modes are not modelled.",
        );
      }
      updateEthernetSegment(s, (current) => ({ ...current, redundancyMode: mode }));
    },
  },
  {
    /**
     * `df-election hrw`. The modulus election of RFC 7432 §8.5 stays the
     * default, so a segment that never names one is unchanged — and HRW only
     * runs once every participant advertises it.
     */
    pattern: "df-election {algorithm}", usage: "df-election default|hrw",
    modes: ["config-evpn-es"], device: "l3-switch",
    run: (s, p) => {
      const algorithm = p.algorithm?.toLowerCase();
      if (algorithm !== "default" && algorithm !== "hrw") {
        throw new ValidationError(
          "Only 'default' and 'hrw' DF election are supported;"
          + " preference-based election and AC-DF are not modelled.",
        );
      }
      updateEthernetSegment(s, (current) => ({ ...current, dfAlgorithm: algorithm }));
    },
  },
  {
    pattern: "no df-election", modes: ["config-evpn-es"], device: "l3-switch",
    run: (s) => updateEthernetSegment(s, (current) => ({ ...current, dfAlgorithm: undefined })),
  },
  {
    pattern: "ethernet-segment {name}", usage: "ethernet-segment <name>",
    modes: ["config-if"], device: "l3-switch",
    run: (s, p) => {
      const device = vtepOf(s);
      try {
        device.attachEthernetSegment(accessPortName(s), p.name!);
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "Invalid Ethernet Segment attachment.");
      }
    },
  },
  {
    pattern: "no ethernet-segment", modes: ["config-if"], device: "l3-switch",
    run: (s) => vtepOf(s).detachEthernetSegment(accessPortName(s)),
  },

  // --- inspection ---------------------------------------------------------
  { pattern: "show nve interfaces", modes: ["exec", "privileged"], device: "l3-switch", run: showNveInterfaces },
  {
    pattern: "show evpn ethernet-segment", modes: ["exec", "privileged"], device: "l3-switch",
    run: (s) => showEthernetSegments(s, false),
  },
  {
    pattern: "show evpn ethernet-segment detail", modes: ["exec", "privileged"], device: "l3-switch",
    run: (s) => showEthernetSegments(s, true),
  },
  {
    pattern: "show evpn ethernet-segment esi {esi}", usage: "show evpn ethernet-segment esi <esi>",
    modes: ["exec", "privileged"], device: "l3-switch",
    run: (s, p) => showEthernetSegments(s, true, p.esi!),
  },
  { pattern: "show evpn df", modes: ["exec", "privileged"], device: "l3-switch", run: (s) => showDfTable(s) },
  { pattern: "show evpn df detail", modes: ["exec", "privileged"], device: "l3-switch", run: showDfDetail },
  {
    pattern: "show evpn df vlan {vlan}", usage: "show evpn df vlan <1-4094>",
    modes: ["exec", "privileged"], device: "l3-switch",
    run: (s, p) => showDfTable(s, parseVlanId(p.vlan!)),
  },
  {
    pattern: "show evpn aliasing", modes: ["exec", "privileged"], device: "l3-switch",
    run: (s) => showAliasing(s),
  },
  {
    pattern: "show evpn aliasing mac {mac}", usage: "show evpn aliasing mac <H.H.H>",
    modes: ["exec", "privileged"], device: "l3-switch",
    run: (s, p) => showAliasing(s, p.mac!),
  },
  {
    pattern: "show evpn mac-mobility", modes: ["exec", "privileged"], device: "l3-switch",
    run: showMacMobility,
  },
  { pattern: "show nve vni", modes: ["exec", "privileged"], device: "l3-switch", run: showNveVni },
  { pattern: "show nve peers", modes: ["exec", "privileged"], device: "l3-switch", run: showNvePeers },
  { pattern: "show vxlan", modes: ["exec", "privileged"], device: "l3-switch", run: showVxlan },
  {
    pattern: "show mac address-table remote", modes: ["exec", "privileged"], device: "l3-switch",
    run: showRemoteMacs,
  },
  {
    // The EVPN table is readable wherever the family is: a Route Reflector
    // carries these routes without ever being a VTEP.
    pattern: "show bgp l2vpn evpn", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => showEvpnTable(s),
  },
  {
    pattern: "show bgp l2vpn evpn route-type {type}", usage: "show bgp l2vpn evpn route-type 1|2|3|4|5",
    modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => {
      if (!["1", "2", "3", "4", "5"].includes(p.type ?? "")) {
        throw new ValidationError("Only EVPN route types 1, 2, 3, 4 and 5 are supported.");
      }
      return showEvpnTable(s, { routeType: Number(p.type) as 1 | 2 | 3 | 4 | 5 });
    },
  },
  {
    pattern: "show bgp l2vpn evpn route-type {type} vrf {vrf}",
    usage: "show bgp l2vpn evpn route-type 5 vrf <vrf-name>",
    modes: ["exec", "privileged"], device: "l3-switch",
    run: (s, p) => {
      if (p.type !== "5") throw new ValidationError("Only route type 5 is scoped to a VRF.");
      const device = vtepOf(s);
      const vrf = device.vrfConfigurations().find((entry) => entry.id === p.vrf || entry.name === p.vrf);
      if (!vrf) throw new ValidationError(`Unknown VRF '${p.vrf}'.`);
      // A VRF sees exactly the Type 5 prefixes its own route targets import.
      return showEvpnTable(s, { routeType: 5, routeTargets: vrf.importRouteTargets });
    },
  },
  {
    pattern: "show forwarding distribution evpn", modes: ["exec", "privileged"], device: "l3-switch",
    run: showAnycastGateway,
  },
  {
    pattern: "show ip route vrf {name}", usage: "show ip route vrf <vrf-name>",
    modes: ["exec", "privileged"], device: "l3-switch",
    run: (s, p) => showVrfRoutes(s, p.name!),
  },
  {
    pattern: "show bgp l2vpn evpn vni {vni}", modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => showEvpnTable(s, { vni: parseVni(p.vni!) }),
  },
  {
    pattern: "clear nve peers *", modes: ["privileged"], device: "l3-switch",
    run: (s) => s.requestConfirmation("Clear all learned VXLAN overlay state? [yes/no]: ", () => {
      vtepOf(s).resetVxlanRuntime();
      return "% VXLAN runtime cleared; configuration is unchanged.";
    }),
  },
];

import {
  type EvpnRoute,
  type EvpnVniConfiguration,
  type Layer3Switch,
  type NveInterfaceConfiguration,
  type NveMemberConfiguration,
  evpnRouteVni,
  MAXIMUM_VNI,
  MINIMUM_VNI,
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
function showEvpnTable(session: SessionApi, filter: { routeType?: 2 | 3 | 5; vni?: number } = {}): string {
  const device = session.device as { bgp?: Layer3Switch["bgp"] };
  if (!device.bgp) throw new InvalidModeError("BGP requires a Router or an L3 Switch");
  const routes = (isLayer3Switch(session.device) ? session.device.evpnRoutes() : device.bgp.evpnRoutes())
    .filter((route) => filter.routeType === undefined || route.type === filter.routeType)
    .filter((route) => filter.vni === undefined || evpnRouteVni(route) === filter.vni);
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
  return route.originatingVtep;
}

export const vxlanCommands: CommandSpec[] = [
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

  // --- inspection ---------------------------------------------------------
  { pattern: "show nve interfaces", modes: ["exec", "privileged"], device: "l3-switch", run: showNveInterfaces },
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
    pattern: "show bgp l2vpn evpn route-type {type}", usage: "show bgp l2vpn evpn route-type 2|3",
    modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => {
      if (p.type !== "2" && p.type !== "3") throw new ValidationError("Only EVPN route types 2 and 3 are supported.");
      return showEvpnTable(s, { routeType: p.type === "2" ? 2 : 3 });
    },
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

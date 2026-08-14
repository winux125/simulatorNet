import type { LabDocument } from "@sim/contracts";

/**
 * M10.17 EVPN All-Active multihoming demonstration labs.
 *
 * Both are explicitly loaded from the Demo Labs dialog and never opened
 * automatically. They carry configuration only: the discovered Ethernet Segment
 * peers, every alias path set, the elected Designated Forwarder, each HRW weight
 * and every MAC mobility sequence are runtime, and the browser worker and the
 * verifier rebuild all of them identically.
 */

const AS = 65_000;
const VLAN = 10;
const VNI = 10_010;
const ROUTE_TARGET = `${AS}:${VNI}`;
const RD = `${AS}:${VNI}`;
const SPINE_LOOPBACK = "10.255.0.9";

const ESI_A = "0000:0000:0000:0000:0001";
const ESI_B = "0000:0000:0000:0000:0002";

const pc = (id: string, name: string, x: number, y: number) => ({
  id,
  kind: "pc" as const,
  name,
  position: { x, y },
  interfaces: [{ id: "eth0" }],
});

const link = (id: string, a: string, ai: string, b: string, bi: string) => ({
  id,
  a: { node: a, iface: ai },
  b: { node: b, iface: bi },
});

const host = (hostname: string, address: string) => ({
  kind: "pc" as const,
  hostname,
  interfaces: [],
  // One stretched broadcast domain: neither host needs a gateway, because the
  // overlay is what makes them adjacent.
  ipv4: { address, prefixLength: 24 },
  dhcpEnabled: false,
});

interface EthernetSegmentOptions {
  id: string;
  esi: string;
  interfaceId: string;
  /** Absent leaves the modulus election, so an old lab is never read as HRW. */
  dfAlgorithm?: "hrw";
  /** Starts the attachment administratively down, ready for the learner. */
  shutdown?: boolean;
}

interface LeafOptions {
  hostname: string;
  loopback: string;
  uplink: string;
  /** An access port toward a directly attached host, when the leaf has one. */
  accessPort?: string;
  /** The All-Active segment this leaf attaches, when it attaches one. */
  segment?: EthernetSegmentOptions;
}

/**
 * One EVPN leaf: OSPF for the underlay, iBGP `l2vpn evpn` to the reflector, one
 * L2VNI and — where the CE is dual-attached — one All-Active Ethernet Segment.
 */
function evpnLeaf(options: LeafOptions) {
  const access = (id: string, shutdown = false) => ({
    id,
    shutdown,
    mode: "access" as const,
    accessVlan: VLAN,
    nativeVlan: 1,
  });
  return {
    kind: "l3-switch" as const,
    hostname: options.hostname,
    vlans: [{ id: VLAN, name: "TENANT-A" }],
    interfaces: [
      ...(options.accessPort ? [access(options.accessPort)] : []),
      {
        id: "Gi0/2",
        shutdown: false,
        mode: "routed" as const,
        ipv4: { address: options.uplink, prefixLength: 30 },
      },
      ...(options.segment
        ? [access(options.segment.interfaceId, options.segment.shutdown === true)]
        : []),
    ],
    svis: [],
    staticRoutes: [],
    ipRoutingEnabled: true,
    acls: [],
    aclBindings: [],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId: options.loopback,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
      passiveInterfaces: ["Loopback0"],
      interfaces: [{ interfaceId: "Gi0/2", networkType: "point-to-point" as const }],
    },
    bgp: {
      localAs: AS,
      routerId: options.loopback,
      neighbors: [{
        address: SPINE_LOOPBACK,
        remoteAs: AS,
        updateSource: "Loopback0",
        enabled: true,
        evpnActivated: true,
        sendCommunityExtended: true,
      }],
      networks: [],
      vrfAddressFamilies: [],
    },
    nve: {
      id: "nve1" as const,
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: VNI, vlanId: VLAN, replication: { type: "bgp-evpn" as const } }],
    },
    evpn: {
      vnis: [{
        vni: VNI,
        routeDistinguisher: RD,
        importRouteTargets: [ROUTE_TARGET],
        exportRouteTargets: [ROUTE_TARGET],
      }],
      // Leaves that attach the same CE share one ESI. That shared identifier and
      // the redundancy mode are the whole of the multihoming configuration: the
      // peers, the election, every alias path and each mobility sequence are
      // derived at run time and never persisted.
      ...(options.segment
        ? {
            ethernetSegments: [{
              id: options.segment.id,
              esi: options.segment.esi,
              redundancyMode: "all-active" as const,
              interfaces: [options.segment.interfaceId],
              ...(options.segment.dfAlgorithm ? { dfAlgorithm: options.segment.dfAlgorithm } : {}),
            }],
          }
        : {}),
    },
  };
}

/** The Route Reflector: an ordinary Router that is never a VTEP. */
function routeReflector(clients: readonly string[], portCount: number) {
  return {
    kind: "router" as const,
    hostname: "SPINE-RR",
    interfaces: Array.from({ length: portCount }, (_, index) => ({
      id: `Gi0/${index}`,
      routed: true,
      shutdown: false,
      ipv4: { address: `192.0.2.${index * 4 + 2}`, prefixLength: 30 },
    })),
    subinterfaces: [],
    staticRoutes: [],
    dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: SPINE_LOOPBACK, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId: SPINE_LOOPBACK,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
      passiveInterfaces: ["Loopback0"],
      interfaces: Array.from({ length: portCount }, (_, index) => ({
        interfaceId: `Gi0/${index}`,
        networkType: "point-to-point" as const,
      })),
    },
    // The reflector reflects Type 1 and Type 4 exactly as it reflects Type 2 and
    // Type 3, and it holds no tenant MAC, no alias path and no overlay of its own.
    bgp: {
      localAs: AS,
      routerId: SPINE_LOOPBACK,
      clusterId: SPINE_LOOPBACK,
      neighbors: clients.map((address) => ({
        address,
        remoteAs: AS,
        updateSource: "Loopback0",
        enabled: true,
        evpnActivated: true,
        sendCommunityExtended: true,
        routeReflectorClient: true,
      })),
      networks: [],
      vrfAddressFamilies: [],
    },
  };
}

/** An ordinary customer L2 switch: every port is an access port in VLAN 10. */
function customerSwitch(hostname: string, ports: ReadonlyArray<{ id: string; shutdown?: boolean }>) {
  return {
    kind: "l2-switch" as const,
    hostname,
    vlans: [{ id: VLAN, name: "TENANT-A" }],
    interfaces: ports.map((port) => ({
      id: port.id,
      shutdown: port.shutdown === true,
      mode: "access" as const,
      accessVlan: VLAN,
      nativeVlan: 1,
    })),
  };
}

// --- Demo 1: All-Active aliasing -------------------------------------------

/**
 *              ┌── LEAF1 ──┐
 * HOST-A — CE ─┤           ├── SPINE-RR ── LEAF3 — HOST-B
 *              └── LEAF2 ──┘
 *
 * CE is an ordinary L2 switch dual-attached to two leaves that share one ESI.
 * Under All-Active both attachments carry known unicast, so LEAF3 reaches
 * HOST-A over either leaf even though only one of them ever advertised it.
 */
const aliasingTopology = {
  schemaVersion: 1,
  nodes: [
    pc("host-a", "HOST-A", 40, 260),
    {
      id: "ce",
      kind: "l2-switch" as const,
      name: "CE",
      position: { x: 250, y: 260 },
      interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "leaf1",
      kind: "l3-switch" as const,
      name: "LEAF1",
      position: { x: 500, y: 130 },
      interfaces: [{ id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "leaf2",
      kind: "l3-switch" as const,
      name: "LEAF2",
      position: { x: 500, y: 400 },
      interfaces: [{ id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "spine",
      kind: "router" as const,
      name: "SPINE-RR",
      position: { x: 760, y: 260 },
      interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }],
    },
    {
      id: "leaf3",
      kind: "l3-switch" as const,
      name: "LEAF3",
      position: { x: 1_010, y: 260 },
      interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
    },
    pc("host-b", "HOST-B", 1_250, 260),
  ],
  links: [
    link("host-a-ce", "host-a", "eth0", "ce", "Gi0/1"),
    link("ce-leaf1", "ce", "Gi0/2", "leaf1", "Gi0/3"),
    link("ce-leaf2", "ce", "Gi0/3", "leaf2", "Gi0/3"),
    link("leaf1-spine", "leaf1", "Gi0/2", "spine", "Gi0/0"),
    link("leaf2-spine", "leaf2", "Gi0/2", "spine", "Gi0/1"),
    link("spine-leaf3", "spine", "Gi0/2", "leaf3", "Gi0/2"),
    link("leaf3-host-b", "leaf3", "Gi0/1", "host-b", "eth0"),
  ],
};

const aliasingConfigurations = {
  "host-a": host("HOST-A", "192.168.10.10"),
  ce: customerSwitch("CE", [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }]),
  leaf1: evpnLeaf({
    hostname: "LEAF1",
    loopback: "10.255.0.1",
    uplink: "192.0.2.1",
    segment: { id: "ES-CE1", esi: ESI_A, interfaceId: "Gi0/3" },
  }),
  leaf2: evpnLeaf({
    hostname: "LEAF2",
    loopback: "10.255.0.2",
    uplink: "192.0.2.5",
    segment: { id: "ES-CE1", esi: ESI_A, interfaceId: "Gi0/3" },
  }),
  spine: routeReflector(["10.255.0.1", "10.255.0.2", "10.255.0.3"], 3),
  leaf3: evpnLeaf({
    hostname: "LEAF3",
    loopback: "10.255.0.3",
    uplink: "192.0.2.9",
    accessPort: "Gi0/1",
  }),
  "host-b": host("HOST-B", "192.168.10.20"),
};

// --- Demo 2: MAC mobility and HRW ------------------------------------------

/**
 * STATION-A — CE-M ─┬── LEAF1 ──┐ ES-A (all-active, HRW)
 *                   └── LEAF2 ──┤
 *                               ├── SPINE-RR ── LEAF-R — HOST-R
 * STATION-B ─────────── LEAF3 ──┘ ES-B (all-active, HRW; starts shut)
 *
 * `STATION-A` and `STATION-B` deliberately carry the **same MAC and the same
 * IP**: they are one station in two places, never two hosts. Only one of them is
 * ever connected, so the address has exactly one location at a time and no
 * bridging loop can form between the two Ethernet Segments.
 *
 * That is what makes a real move producible without teleporting anything: taking
 * CE-M's station port down leaves the CE-to-leaf uplinks up, so ES-A keeps
 * advertising the address while LEAF3 learns it — and the sequence advances
 * exactly once, because the two locations genuinely compete.
 *
 * ES-A has two candidates, so it is the segment whose DF/BDF election is worth
 * reading. ES-B has one attachment: a segment is named by its ESI, not by how
 * many leaves happen to attach it.
 */
/** The one address that moves. Both stations carry it, one at a time. */
const MOBILE_MAC = "02:00:00:00:00:aa";
const MOBILE_IP = "192.168.10.30";
const mobilityTopology = {
  schemaVersion: 1,
  nodes: [
    {
      id: "station-a",
      kind: "pc" as const,
      name: "STATION-A",
      position: { x: 40, y: 190 },
      interfaces: [{ id: "eth0", mac: MOBILE_MAC }],
    },
    {
      id: "station-b",
      kind: "pc" as const,
      name: "STATION-B",
      position: { x: 250, y: 470 },
      interfaces: [{ id: "eth0", mac: MOBILE_MAC }],
    },
    {
      id: "ce-m",
      kind: "l2-switch" as const,
      name: "CE-M",
      position: { x: 250, y: 190 },
      interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "leaf1",
      kind: "l3-switch" as const,
      name: "LEAF1",
      position: { x: 520, y: 60 },
      interfaces: [{ id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "leaf2",
      kind: "l3-switch" as const,
      name: "LEAF2",
      position: { x: 520, y: 200 },
      interfaces: [{ id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "leaf3",
      kind: "l3-switch" as const,
      name: "LEAF3",
      position: { x: 520, y: 440 },
      interfaces: [{ id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "spine",
      kind: "router" as const,
      name: "SPINE-RR",
      position: { x: 800, y: 300 },
      interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
    },
    {
      id: "leaf-r",
      kind: "l3-switch" as const,
      name: "LEAF-R",
      position: { x: 1_060, y: 300 },
      interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
    },
    pc("host-r", "HOST-R", 1_290, 300),
  ],
  links: [
    link("station-a-ce", "station-a", "eth0", "ce-m", "Gi0/1"),
    link("ce-leaf1", "ce-m", "Gi0/2", "leaf1", "Gi0/3"),
    link("ce-leaf2", "ce-m", "Gi0/3", "leaf2", "Gi0/3"),
    // STATION-B attaches straight to LEAF3's Ethernet Segment port, which starts
    // shut so the address has exactly one location until the learner moves it.
    link("station-b-leaf3", "station-b", "eth0", "leaf3", "Gi0/3"),
    link("leaf1-spine", "leaf1", "Gi0/2", "spine", "Gi0/0"),
    link("leaf2-spine", "leaf2", "Gi0/2", "spine", "Gi0/1"),
    link("leaf3-spine", "leaf3", "Gi0/2", "spine", "Gi0/2"),
    link("spine-leaf-r", "spine", "Gi0/3", "leaf-r", "Gi0/2"),
    link("leaf-r-host-r", "leaf-r", "Gi0/1", "host-r", "eth0"),
  ],
};

const mobilityConfigurations = {
  // One station in two places: same MAC, same IP, only one ever connected.
  "station-a": host("STATION-A", MOBILE_IP),
  "station-b": host("STATION-B", MOBILE_IP),
  "ce-m": customerSwitch("CE-M", [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }]),
  leaf1: evpnLeaf({
    hostname: "LEAF1",
    loopback: "10.255.0.1",
    uplink: "192.0.2.1",
    segment: { id: "ES-A", esi: ESI_A, interfaceId: "Gi0/3", dfAlgorithm: "hrw" },
  }),
  leaf2: evpnLeaf({
    hostname: "LEAF2",
    loopback: "10.255.0.2",
    uplink: "192.0.2.5",
    segment: { id: "ES-A", esi: ESI_A, interfaceId: "Gi0/3", dfAlgorithm: "hrw" },
  }),
  leaf3: evpnLeaf({
    hostname: "LEAF3",
    loopback: "10.255.0.3",
    uplink: "192.0.2.9",
    segment: {
      id: "ES-B",
      esi: ESI_B,
      interfaceId: "Gi0/3",
      dfAlgorithm: "hrw",
      shutdown: true,
    },
  }),
  spine: routeReflector(["10.255.0.1", "10.255.0.2", "10.255.0.3", "10.255.0.4"], 4),
  "leaf-r": evpnLeaf({
    hostname: "LEAF-R",
    loopback: "10.255.0.4",
    uplink: "192.0.2.13",
    accessPort: "Gi0/1",
  }),
  "host-r": host("HOST-R", "192.168.10.40"),
};

const instructions = (objective: string, details: readonly string[]) => [
  `Objective: ${objective}`,
  ...details,
  "Use Auto for bounded convergence, or Step with the All-Active, Aliasing, MAC Mobility, HRW"
  + " and EVPN Multihoming Packet Trace filters.",
].join("\n");

export const EVPN_ALL_ACTIVE_ALIASING_DEMO = {
  schemaVersion: 1,
  id: "evpn-all-active-aliasing",
  title: "EVPN All-Active Aliasing",
  description:
    "One CE attached to two leaves through a shared All-Active Ethernet Segment: both attachments"
    + " carry known unicast, and Ethernet A-D per-EVI gives the remote leaf two usable paths.",
  expectedOutcome:
    "LEAF1 and LEAF2 discover the shared ESI in all-active mode, only one of them advertises HOST-A's"
    + " Type 2 route, and LEAF3 still programs two eligible aliasing paths — so shutting either"
    + " attachment leaves traffic flowing with the address never relearned.",
  instructions: instructions("Reach one MAC over two leaves that share an All-Active Ethernet Segment.", [
    "Topology: HOST-A — CE — {LEAF1, LEAF2} — SPINE-RR — LEAF3 — HOST-B; CE is dual-attached.",
    "Underlay: OSPF area 0 over 192.0.2.0/30, .4/30 and .8/30; Loopbacks 10.255.0.1, .2, .3 and .9.",
    "Control plane: iBGP AS 65000 to SPINE-RR, a Route Reflector with all three leaves as clients.",
    "Overlay: VLAN 10 maps to VNI 10010; RD 65000:10010 and route target 65000:10010 import and export.",
    "Multihoming: LEAF1 and LEAF2 both configure 'evpn ethernet-segment ES-CE1' with ESI"
    + " 0000:0000:0000:0000:0001 on Gi0/3, redundancy-mode all-active.",
    "Required CLI: show evpn ethernet-segment detail; show evpn aliasing; show evpn aliasing mac <mac>;"
    + " show evpn df; show bgp l2vpn evpn route-type 1; show bgp l2vpn evpn route-type 4;"
    + " show mac address-table remote.",
    "Step 1 — verify the segment: 'show evpn ethernet-segment detail' on LEAF1 reports all-active and"
    + " lists LEAF2 as a peer whose redundancy mode agrees.",
    "Step 2 — read the aliasing set: ping 192.168.10.20 from HOST-A, then run 'show evpn aliasing' on"
    + " LEAF3. HOST-A appears once, advertised by a single leaf, with both 10.255.0.1 and 10.255.0.2"
    + " listed as eligible and exactly one of them selected.",
    "Step 3 — understand the selection: one flow always takes one path. The selected leaf comes from a"
    + " stable hash over the ESI, VNI and addresses, so it is the same on every run and a known-unicast"
    + " frame is never duplicated to both leaves.",
    "Step 4 — break one path: on the leaf that is *not* the advertising one run 'configure terminal',"
    + " 'interface Gi0/3', 'shutdown'. Its Ethernet A-D per-EVI route is withdrawn.",
    "Step 5 — verify what did not happen: 'show evpn aliasing' on LEAF3 now lists one eligible leaf,"
    + " and 'show mac address-table remote' still holds HOST-A — no relearning was needed. Ping again.",
    "Expected: two eligible aliasing paths before the failure, one after it, and uninterrupted"
    + " connectivity across the change.",
    "Troubleshooting: if only one path is eligible from the start, check that both leaves use the same"
    + " ESI and the same redundancy mode ('show evpn ethernet-segment detail' reports a mismatch"
    + " explicitly), that route targets match, and that 'send-community extended' is set — an RT"
    + " mismatch isolates the segment entirely. Under All-Active the Designated Forwarder governs"
    + " overlay BUM only, so a non-DF leaf still carries known unicast.",
  ]),
  simulation: { seed: 11_171 },
  topology: aliasingTopology,
  configurations: aliasingConfigurations,
} as unknown as LabDocument;

export const EVPN_MAC_MOBILITY_HRW_DEMO = {
  schemaVersion: 1,
  id: "evpn-mac-mobility-hrw",
  title: "EVPN MAC Mobility and HRW DF Election",
  description:
    "A host moves from one All-Active Ethernet Segment to another: the mobility sequence advances,"
    + " the older Type 2 route becomes stale, and both segments elect their forwarder with HRW.",
  expectedOutcome:
    "The station starts behind ES-A with mobility sequence 0; after the move to ES-B LEAF3 advertises"
    + " sequence 1, the older route loses and is rejected as stale, and traffic from HOST-R follows the"
    + " new location. ES-A shows an HRW-elected DF and BDF, and losing a candidate recalculates it.",
  instructions: instructions("Move one MAC between Ethernet Segments and elect each forwarder with HRW.", [
    "Topology: STATION-A — CE-M — {LEAF1, LEAF2} (ES-A); STATION-B — LEAF3 (ES-B); all four leaves"
    + " peer with SPINE-RR, and HOST-R hangs off LEAF-R.",
    "STATION-A and STATION-B are one station in two places: they carry the same MAC and the same IP"
    + " 192.168.10.30, and only one is ever connected. That is what makes a move producible without"
    + " teleporting a device and without bridging the two segments into a loop.",
    "Underlay: OSPF area 0 over 192.0.2.0/30 … .12/30; Loopbacks 10.255.0.1 … .4 and 10.255.0.9.",
    "Control plane: iBGP AS 65000 to SPINE-RR, a Route Reflector with all four leaves as clients.",
    "Overlay: VLAN 10 maps to VNI 10010; RD 65000:10010 and route target 65000:10010 import and export.",
    "Segments: ES-A is 0000:0000:0000:0000:0001 on LEAF1 and LEAF2; ES-B is 0000:0000:0000:0000:0002"
    + " on LEAF3. Both are all-active and both request 'df-election hrw'. ES-A has two candidates, so"
    + " it is the segment whose DF and BDF are worth reading.",
    "LEAF3's Gi0/3 starts shut, so the address has exactly one location until the learner moves it.",
    "Required CLI: show evpn ethernet-segment detail; show evpn df; show evpn df detail;"
    + " show evpn mac-mobility; show evpn aliasing; show bgp l2vpn evpn route-type 1;"
    + " show bgp l2vpn evpn route-type 2; show bgp l2vpn evpn route-type 4.",
    "Step 1 — establish the starting state: ping 192.168.10.40 from STATION-A, then run"
    + " 'show evpn mac-mobility' on LEAF-R. The address is owned by an ES-A leaf at sequence 0, and"
    + " 'show evpn aliasing' lists both ES-A leaves as eligible.",
    "Step 2 — read the HRW election: 'show evpn df detail' on LEAF1 reports requested and effective"
    + " algorithm 'hrw', the elected DF, the BDF and every candidate weight. Both leaves compute the"
    + " same answer from the same candidate list without telling each other.",
    "Step 3 — move the station: on CE-M run 'configure terminal', 'interface Gi0/1', 'shutdown' —"
    + " which unplugs STATION-A while leaving the CE-to-leaf uplinks up, so ES-A still advertises the"
    + " address. Then on LEAF3 run 'interface Gi0/3', 'no shutdown' and ping 192.168.10.40 from"
    + " STATION-B so the address is seen at its new location.",
    "Step 4 — watch the move in Packet Trace under the MAC Mobility filter:"
    + " evpn-mac-mobility-detected, evpn-mac-mobility-sequence-incremented, evpn-mac-route-superseded"
    + " and evpn-stale-mac-route-rejected.",
    "Step 5 — verify the new owner: 'show evpn mac-mobility' on LEAF-R now shows sequence 1 behind"
    + " LEAF3, in state 'moved', with the previous owner recorded.",
    "Step 6 — recalculate an election: on ES-A's Designated Forwarder run 'interface Gi0/3',"
    + " 'shutdown'. 'show evpn df' recalculates deterministically and the former BDF takes over —"
    + " the same HRW function, run over one fewer candidate, on every participant at once.",
    "Expected: sequence 0 before the move and 1 after it, the older route rejected as stale, HRW"
    + " reported as the effective algorithm on both segments, and traffic following the new location.",
    "Troubleshooting: a sequence that never advances usually means the address never actually changed"
    + " location — a second leaf of the *same* All-Active segment seeing the frame is aliasing, not a"
    + " move, and deliberately does not increment. If 'show evpn df detail' reports effective algorithm"
    + " 'default' with a fallback reason, one participant did not advertise HRW; every leaf then falls"
    + " back together, because two leaves must never compute a different forwarder for one segment.",
  ]),
  simulation: { seed: 11_172 },
  topology: mobilityTopology,
  configurations: mobilityConfigurations,
} as unknown as LabDocument;

export const EVPN_ALL_ACTIVE_DEMO_LABS = [
  EVPN_ALL_ACTIVE_ALIASING_DEMO,
  EVPN_MAC_MOBILITY_HRW_DEMO,
] as const;

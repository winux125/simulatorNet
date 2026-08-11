import type { LabDocument } from "@sim/contracts";

/**
 * M10.16 EVPN Single-Active multihoming demonstration labs.
 *
 * Both are explicitly loaded from the Demo Labs dialog and never opened
 * automatically. They carry configuration only: the discovered Ethernet Segment
 * peers, the elected Designated Forwarder, every Type 1/4 route and each
 * primary/backup path are runtime and are rebuilt identically by the browser
 * worker and the verifier.
 */

const AS = 65_000;
const VLAN = 10;
const VNI = 10_010;
const ESI = "0000:0000:0000:0000:0001";
const ROUTE_TARGET = `${AS}:${VNI}`;

const pc = (id: string, name: string, x: number, y: number) => ({
  id,
  kind: "pc" as const,
  name,
  position: { x, y },
  interfaces: [{ id: "eth0" }],
});

const leaf = (id: string, name: string, x: number, y: number) => ({
  id,
  kind: "l3-switch" as const,
  name,
  position: { x, y },
  interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
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

interface LeafOptions {
  hostname: string;
  loopback: string;
  uplink: string;
  spineSide: string;
  /** Present on the two leaves that share one CE; absent on the remote leaf. */
  ethernetSegment?: boolean;
}

/**
 * One EVPN leaf: an access port toward the tenant, a routed uplink to the
 * spine, OSPF for the underlay and iBGP `l2vpn evpn` to the reflector.
 */
function evpnLeaf(options: LeafOptions) {
  return {
    kind: "l3-switch" as const,
    hostname: options.hostname,
    vlans: [{ id: VLAN, name: "TENANT-A" }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: VLAN, nativeVlan: 1 },
      {
        id: "Gi0/2",
        shutdown: false,
        mode: "routed" as const,
        ipv4: { address: options.uplink, prefixLength: 30 },
      },
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
        address: options.spineSide,
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
        routeDistinguisher: `${AS}:${VNI}`,
        importRouteTargets: [ROUTE_TARGET],
        exportRouteTargets: [ROUTE_TARGET],
      }],
      // The two leaves that attach the same CE share one ESI. That shared
      // identifier is the whole of the multihoming configuration: the peers, the
      // Designated Forwarder and every backup path are derived at run time.
      ...(options.ethernetSegment
        ? {
            ethernetSegments: [{
              id: "ES-CE1",
              esi: ESI,
              redundancyMode: "single-active" as const,
              interfaces: ["Gi0/1"],
            }],
          }
        : {}),
    },
  };
}

const spine = {
  kind: "router" as const,
  hostname: "SPINE-RR",
  interfaces: [
    { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "192.0.2.2", prefixLength: 30 } },
    { id: "Gi0/1", routed: true, shutdown: false, ipv4: { address: "192.0.2.6", prefixLength: 30 } },
    { id: "Gi0/2", routed: true, shutdown: false, ipv4: { address: "192.0.2.10", prefixLength: 30 } },
  ],
  subinterfaces: [],
  staticRoutes: [],
  dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
  loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.9", prefixLength: 32 } }],
  ospf: {
    processId: 1,
    routerId: "10.255.0.9",
    networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
    passiveInterfaces: ["Loopback0"],
    interfaces: [
      { interfaceId: "Gi0/0", networkType: "point-to-point" as const },
      { interfaceId: "Gi0/1", networkType: "point-to-point" as const },
      { interfaceId: "Gi0/2", networkType: "point-to-point" as const },
    ],
  },
  // The reflector is the same BGP process, not a second protocol: it reflects
  // Type 1 and Type 4 exactly as it reflects Type 2 and Type 3, and it never
  // becomes a VTEP or holds a tenant MAC.
  bgp: {
    localAs: AS,
    routerId: "10.255.0.9",
    clusterId: "10.255.0.9",
    neighbors: ["10.255.0.1", "10.255.0.2", "10.255.0.3"].map((address) => ({
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

/**
 *              ┌── LEAF1 ──┐
 * HOST-A — CE ─┤           ├── SPINE-RR ── LEAF3 — HOST-B
 *              └── LEAF2 ──┘
 *
 * CE is an ordinary L2 switch: it is dual-attached to two leaves that share one
 * ESI, which is what makes this multihoming rather than a loop. VLAN 10 maps to
 * VNI 10010 everywhere, and `10 mod 2 == 0` puts the numerically lowest VTEP —
 * LEAF1 at 10.255.0.1 — in the Designated Forwarder role for that VLAN.
 */
const topology = {
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
    leaf("leaf1", "LEAF1", 500, 130),
    leaf("leaf2", "LEAF2", 500, 400),
    {
      id: "spine",
      kind: "router" as const,
      name: "SPINE-RR",
      position: { x: 760, y: 260 },
      interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }],
    },
    leaf("leaf3", "LEAF3", 1_010, 260),
    pc("host-b", "HOST-B", 1_250, 260),
  ],
  links: [
    link("host-a-ce", "host-a", "eth0", "ce", "Gi0/1"),
    link("ce-leaf1", "ce", "Gi0/2", "leaf1", "Gi0/1"),
    link("ce-leaf2", "ce", "Gi0/3", "leaf2", "Gi0/1"),
    link("leaf1-spine", "leaf1", "Gi0/2", "spine", "Gi0/0"),
    link("leaf2-spine", "leaf2", "Gi0/2", "spine", "Gi0/1"),
    link("spine-leaf3", "spine", "Gi0/2", "leaf3", "Gi0/2"),
    link("leaf3-host-b", "leaf3", "Gi0/1", "host-b", "eth0"),
  ],
};

const configurations = {
  "host-a": host("HOST-A", "192.168.10.10"),
  ce: {
    kind: "l2-switch" as const,
    hostname: "CE",
    vlans: [{ id: VLAN, name: "TENANT-A" }],
    interfaces: ["Gi0/1", "Gi0/2", "Gi0/3"].map((id) => ({
      id,
      shutdown: false,
      mode: "access" as const,
      accessVlan: VLAN,
      nativeVlan: 1,
    })),
  },
  leaf1: evpnLeaf({
    hostname: "LEAF1",
    loopback: "10.255.0.1",
    uplink: "192.0.2.1",
    spineSide: "10.255.0.9",
    ethernetSegment: true,
  }),
  leaf2: evpnLeaf({
    hostname: "LEAF2",
    loopback: "10.255.0.2",
    uplink: "192.0.2.5",
    spineSide: "10.255.0.9",
    ethernetSegment: true,
  }),
  spine,
  leaf3: evpnLeaf({
    hostname: "LEAF3",
    loopback: "10.255.0.3",
    uplink: "192.0.2.9",
    spineSide: "10.255.0.9",
  }),
  "host-b": host("HOST-B", "192.168.10.20"),
};

const instructions = (objective: string, details: readonly string[]) => [
  `Objective: ${objective}`,
  ...details,
  "Use Auto for bounded convergence, or Step with the EVPN Multihoming, Ethernet Segment,"
  + " DF Election and Fast Failover Packet Trace filters.",
].join("\n");

export const EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO = {
  schemaVersion: 1,
  id: "evpn-single-active-multihoming",
  title: "EVPN Single-Active Multihoming",
  description:
    "One CE attached to two leaves through a shared Ethernet Segment: Type 4 discovery, Ethernet A-D"
    + " Type 1 and a deterministic Designated Forwarder election.",
  expectedOutcome:
    "LEAF1 and LEAF2 discover the shared ESI, LEAF1 is elected DF for VLAN 10, LEAF2 stands by, and"
    + " LEAF3 programs HOST-A behind LEAF1 with LEAF2 as its backup.",
  instructions: instructions("Discover one Ethernet Segment from two leaves and elect one forwarder.", [
    "Topology: HOST-A — CE — {LEAF1, LEAF2} — SPINE-RR — LEAF3 — HOST-B; CE is dual-attached.",
    "Underlay: OSPF area 0 over 192.0.2.0/30, .4/30 and .8/30; Loopbacks 10.255.0.1, .2, .3 and .9.",
    "Control plane: iBGP AS 65000 to SPINE-RR, a Route Reflector with all three leaves as clients.",
    "Overlay: VLAN 10 maps to VNI 10010; RD 65000:10010 and route target 65000:10010 import and export.",
    "Multihoming: LEAF1 and LEAF2 both configure 'evpn ethernet-segment ES-CE1' with ESI"
    + " 0000:0000:0000:0000:0001 on Gi0/1, redundancy-mode single-active.",
    "Required CLI: show evpn ethernet-segment detail; show evpn df; show bgp l2vpn evpn route-type 4;"
    + " show bgp l2vpn evpn route-type 1; show mac address-table remote.",
    "Expected: one DF and one non-DF for VLAN 10, and HOST-A reaches HOST-B through the DF only.",
    "Troubleshooting: check that both leaves use the same ESI, that route targets match, and that"
    + " 'send-community extended' is set — an RT mismatch isolates the segment entirely.",
  ]),
  simulation: { seed: 11_161 },
  topology,
  configurations,
} as unknown as LabDocument;

export const EVPN_FAST_FAILOVER_DEMO = {
  schemaVersion: 1,
  id: "evpn-fast-failover",
  title: "EVPN Fast Failover",
  description:
    "The Designated Forwarder's attachment fails: one Ethernet A-D per-ES withdrawal invalidates"
    + " everything behind it and the backup leaf takes over.",
  expectedOutcome:
    "Traffic succeeds through LEAF1, then LEAF1's Gi0/1 is shut; the mass withdrawal moves remote"
    + " forwarding to LEAF2, which becomes DF, and traffic recovers with no rebuild and no relearning.",
  instructions: instructions("Break the Designated Forwarder and watch the fabric converge on the backup.", [
    "Topology: HOST-A — CE — {LEAF1, LEAF2} — SPINE-RR — LEAF3 — HOST-B; CE is dual-attached.",
    "Required CLI: show evpn df; show evpn ethernet-segment detail; show mac address-table remote.",
    "Step 1 — verify the healthy path: ping 192.168.10.20 from HOST-A and confirm 'show evpn df' puts"
    + " LEAF1 in the DF role for VLAN 10.",
    "Step 2 — read the state that makes failover possible: 'show mac address-table remote' on LEAF3"
    + " shows HOST-A behind 10.255.0.1 with 10.255.0.2 as its backup.",
    "Step 3 — break it: on LEAF1 run 'configure terminal', 'interface Gi0/1', 'shutdown'.",
    "Step 4 — watch the convergence in Packet Trace under the Fast Failover filter:"
    + " evpn-ad-route-withdrawn, evpn-es-mass-withdraw, then evpn-df-role-changed on LEAF2.",
    "Step 5 — verify recovery: 'show evpn df' now puts LEAF2 in the DF role and ping again from HOST-A.",
    "Troubleshooting: if traffic does not recover, check that LEAF2's segment is still up"
    + " ('show evpn ethernet-segment detail'), that its route targets still match, and that the"
    + " underlay route to 10.255.0.2 exists. No topology rebuild is ever needed.",
    "Restore with 'no shutdown' on LEAF1 Gi0/1: LEAF1 becomes DF again by the same election.",
  ]),
  simulation: { seed: 11_162 },
  topology,
  configurations,
} as unknown as LabDocument;

export const EVPN_MULTIHOMING_DEMO_LABS = [
  EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO,
  EVPN_FAST_FAILOVER_DEMO,
] as const;

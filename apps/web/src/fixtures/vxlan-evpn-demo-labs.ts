import type { LabDocument } from "@sim/contracts";

/**
 * M10.14 VXLAN and BGP EVPN demonstration labs.
 *
 * Both are explicitly loaded from the Demo Labs dialog and never opened
 * automatically. They carry configuration only: the remote MAC table, learned
 * Type 2/3 routes, VTEP membership and every counter are runtime and are
 * rebuilt identically by the browser worker and the verifier.
 */

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
  interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
});

const router = (id: string, name: string, x: number, y: number) => ({
  id,
  kind: "router" as const,
  name,
  position: { x, y },
  interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }],
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
  // Both hosts sit in one stretched broadcast domain, so neither needs a
  // gateway: the VXLAN overlay is what makes them adjacent.
  ipv4: { address, prefixLength: 24 },
  dhcpEnabled: false,
});

interface VtepOptions {
  hostname: string;
  accessVlan: { id: number; name: string };
  loopback: string;
  uplink: { address: string; prefixLength: number };
  vni: number;
  replication: { type: "static"; peerAddresses: string[] } | { type: "bgp-evpn" };
  staticRoutes?: ReadonlyArray<{ network: string; prefixLength: number; nextHop: string }>;
  ospf?: boolean;
  bgp?: { localAs: number; neighbor: string };
  evpn?: { routeDistinguisher: string; routeTarget: string };
}

function vtep(options: VtepOptions) {
  return {
    kind: "l3-switch" as const,
    hostname: options.hostname,
    vlans: [{ id: options.accessVlan.id, name: options.accessVlan.name }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: options.accessVlan.id, nativeVlan: 1 },
      {
        id: "Gi0/2",
        shutdown: false,
        mode: "routed" as const,
        ipv4: { address: options.uplink.address, prefixLength: options.uplink.prefixLength },
      },
      { id: "Gi0/3", shutdown: false, mode: "access" as const, accessVlan: 1, nativeVlan: 1 },
    ],
    svis: [],
    staticRoutes: [...(options.staticRoutes ?? [])],
    ipRoutingEnabled: true,
    acls: [],
    aclBindings: [],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }],
    ospf: options.ospf
      ? {
          processId: 1,
          routerId: options.loopback,
          networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
          passiveInterfaces: ["Loopback0"],
          interfaces: [{ interfaceId: "Gi0/2", networkType: "point-to-point" as const }],
        }
      : undefined,
    bgp: options.bgp
      ? {
          localAs: options.bgp.localAs,
          routerId: options.loopback,
          neighbors: [{
            address: options.bgp.neighbor,
            remoteAs: options.bgp.localAs,
            updateSource: "Loopback0",
            enabled: true,
            evpnActivated: true,
            sendCommunityExtended: true,
          }],
          networks: [],
          vrfAddressFamilies: [],
        }
      : undefined,
    // The NVE is a logical interface: it has no cable, never appears in the
    // connection modal and never becomes a topology link.
    nve: {
      id: "nve1" as const,
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: options.vni, vlanId: options.accessVlan.id, replication: options.replication }],
    },
    evpn: options.evpn
      ? {
          vnis: [{
            vni: options.vni,
            routeDistinguisher: options.evpn.routeDistinguisher,
            importRouteTargets: [options.evpn.routeTarget],
            exportRouteTargets: [options.evpn.routeTarget],
          }],
        }
      : undefined,
  };
}

const instructions = (objective: string, details: readonly string[]) => [
  `Objective: ${objective}`,
  ...details,
  "Use Auto for bounded convergence, or Step with the VXLAN, EVPN, BUM and VTEP Packet Trace filters.",
].join("\n");

export const STATIC_VXLAN_STRETCH_DEMO = {
  schemaVersion: 1,
  id: "vxlan-static-stretch",
  title: "Static VXLAN VLAN Stretch",
  description: "Two L3 Switch VTEPs stretch one VLAN across a routed IPv4 underlay using hand-configured ingress replication.",
  expectedOutcome: "PC-A reaches PC-B inside VLAN 10 through VNI 10010; the underlay router never learns a tenant MAC.",
  instructions: instructions("Stretch VLAN 10 across PC-A — VTEP1 — CORE — VTEP2 — PC-B.", [
    "Underlay: 192.0.2.0/30 and 192.0.2.4/30; VTEP Loopbacks 10.255.0.1 and 10.255.0.2, reached by static routes.",
    "Overlay: VLAN 10 maps to VNI 10010; each VTEP lists the other as a static peer-ip.",
    "Tenants: PC-A 192.168.10.10/24 and PC-B 192.168.10.20/24 — one broadcast domain, no gateway.",
    "Required CLI: show nve interfaces; show nve vni; show nve peers; show mac address-table remote.",
    "Expected: ARP floods as BUM to the remote VTEP, the reply is unicast back, and both remote MAC tables fill.",
    "Troubleshooting: check the Loopback source, the underlay route to the peer, UDP 4789 and the VLAN-to-VNI mapping.",
  ]),
  simulation: { seed: 11_141 },
  topology: {
    schemaVersion: 1,
    nodes: [
      pc("pc-a", "PC-A", 60, 250),
      leaf("vtep1", "VTEP1", 320, 250),
      router("core", "CORE", 590, 250),
      leaf("vtep2", "VTEP2", 860, 250),
      pc("pc-b", "PC-B", 1_120, 250),
    ],
    links: [
      link("pc-a-vtep1", "pc-a", "eth0", "vtep1", "Gi0/1"),
      link("vtep1-core", "vtep1", "Gi0/2", "core", "Gi0/0"),
      link("core-vtep2", "core", "Gi0/1", "vtep2", "Gi0/2"),
      link("vtep2-pc-b", "vtep2", "Gi0/1", "pc-b", "eth0"),
    ],
  },
  configurations: {
    "pc-a": host("PC-A", "192.168.10.10"),
    vtep1: vtep({
      hostname: "VTEP1",
      accessVlan: { id: 10, name: "TENANT-A" },
      loopback: "10.255.0.1",
      uplink: { address: "192.0.2.1", prefixLength: 30 },
      vni: 10_010,
      replication: { type: "static", peerAddresses: ["10.255.0.2"] },
      staticRoutes: [{ network: "10.255.0.2", prefixLength: 32, nextHop: "192.0.2.2" }],
    }),
    core: {
      kind: "router" as const,
      hostname: "CORE",
      interfaces: [
        { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "192.0.2.2", prefixLength: 30 } },
        { id: "Gi0/1", routed: true, shutdown: false, ipv4: { address: "192.0.2.5", prefixLength: 30 } },
      ],
      subinterfaces: [],
      staticRoutes: [
        { network: "10.255.0.1", prefixLength: 32, nextHop: "192.0.2.1" },
        { network: "10.255.0.2", prefixLength: 32, nextHop: "192.0.2.6" },
      ],
      dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
    },
    vtep2: vtep({
      hostname: "VTEP2",
      accessVlan: { id: 10, name: "TENANT-A" },
      loopback: "10.255.0.2",
      uplink: { address: "192.0.2.6", prefixLength: 30 },
      vni: 10_010,
      replication: { type: "static", peerAddresses: ["10.255.0.1"] },
      staticRoutes: [{ network: "10.255.0.1", prefixLength: 32, nextHop: "192.0.2.5" }],
    }),
    "pc-b": host("PC-B", "192.168.10.20"),
  },
} as unknown as LabDocument;

export const BGP_EVPN_STRETCH_DEMO = {
  schemaVersion: 1,
  id: "vxlan-evpn-stretch",
  title: "BGP EVPN VLAN Stretch",
  description: "Two leaf VTEPs learn each other through BGP EVPN Type 3 membership and Type 2 MAC routes reflected by a spine.",
  expectedOutcome: "Type 3 builds head-end replication, Type 2 installs each remote MAC, and Host A reaches Host B with reduced unknown flooding.",
  instructions: instructions("Stretch VLAN 20 across Host A — Leaf1 — Spine (RR) — Leaf2 — Host B.", [
    "Underlay: OSPF area 0 over 192.0.2.0/30 and 192.0.2.4/30; Loopbacks 10.255.0.1, 10.255.0.2 and 10.255.0.9.",
    "Control plane: iBGP AS 65000 to the Spine, which is a Route Reflector with both leaves as clients.",
    "The Spine carries and reflects EVPN routes but is never a VTEP and holds no tenant MAC.",
    "Overlay: VLAN 20 maps to VNI 20020; RD 65000:20020 and route target 65000:20020 import and export.",
    "Required CLI: show bgp l2vpn evpn; show bgp l2vpn evpn route-type 3; show bgp l2vpn evpn route-type 2; show nve peers.",
    "Expected: Type 3 lists the remote VTEP before any traffic, and Type 2 installs the remote MAC so unicast is not flooded.",
    "Troubleshooting: check 'address-family l2vpn evpn', 'send-community extended', matching route targets and the OSPF underlay.",
  ]),
  simulation: { seed: 11_142 },
  topology: {
    schemaVersion: 1,
    nodes: [
      pc("host-a", "HOST-A", 60, 120),
      leaf("leaf1", "LEAF1", 320, 120),
      router("spine", "SPINE-RR", 600, 260),
      leaf("leaf2", "LEAF2", 320, 400),
      pc("host-b", "HOST-B", 60, 400),
    ],
    links: [
      link("host-a-leaf1", "host-a", "eth0", "leaf1", "Gi0/1"),
      link("leaf1-spine", "leaf1", "Gi0/2", "spine", "Gi0/0"),
      link("spine-leaf2", "spine", "Gi0/1", "leaf2", "Gi0/2"),
      link("leaf2-host-b", "leaf2", "Gi0/1", "host-b", "eth0"),
    ],
  },
  configurations: {
    "host-a": host("HOST-A", "192.168.20.10"),
    leaf1: vtep({
      hostname: "LEAF1",
      accessVlan: { id: 20, name: "TENANT-B" },
      loopback: "10.255.0.1",
      uplink: { address: "192.0.2.1", prefixLength: 30 },
      vni: 20_020,
      replication: { type: "bgp-evpn" },
      ospf: true,
      bgp: { localAs: 65_000, neighbor: "10.255.0.9" },
      evpn: { routeDistinguisher: "65000:20020", routeTarget: "65000:20020" },
    }),
    spine: {
      kind: "router" as const,
      hostname: "SPINE-RR",
      interfaces: [
        { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "192.0.2.2", prefixLength: 30 } },
        { id: "Gi0/1", routed: true, shutdown: false, ipv4: { address: "192.0.2.5", prefixLength: 30 } },
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
        ],
      },
      // The reflector is the same BGP process, not a second protocol: it serves
      // l2vpn evpn with both leaves as clients and never becomes a VTEP.
      bgp: {
        localAs: 65_000,
        routerId: "10.255.0.9",
        clusterId: "10.255.0.9",
        neighbors: [
          {
            address: "10.255.0.1", remoteAs: 65_000, updateSource: "Loopback0", enabled: true,
            evpnActivated: true, sendCommunityExtended: true, routeReflectorClient: true,
          },
          {
            address: "10.255.0.2", remoteAs: 65_000, updateSource: "Loopback0", enabled: true,
            evpnActivated: true, sendCommunityExtended: true, routeReflectorClient: true,
          },
        ],
        networks: [],
        vrfAddressFamilies: [],
      },
    },
    leaf2: vtep({
      hostname: "LEAF2",
      accessVlan: { id: 20, name: "TENANT-B" },
      loopback: "10.255.0.2",
      uplink: { address: "192.0.2.6", prefixLength: 30 },
      vni: 20_020,
      replication: { type: "bgp-evpn" },
      ospf: true,
      bgp: { localAs: 65_000, neighbor: "10.255.0.9" },
      evpn: { routeDistinguisher: "65000:20020", routeTarget: "65000:20020" },
    }),
    "host-b": host("HOST-B", "192.168.20.20"),
  },
} as unknown as LabDocument;

export const VXLAN_EVPN_DEMO_LABS = [STATIC_VXLAN_STRETCH_DEMO, BGP_EVPN_STRETCH_DEMO] as const;

import type { LabDocument } from "@sim/contracts";

/**
 * M10.15 routed EVPN demonstration labs.
 *
 * Both are explicitly loaded from the Demo Labs dialog and never opened
 * automatically. They carry configuration only: the anycast gateway state, the
 * L3VNI state, learned Type 2/3/5 routes, imported tenant prefixes and every
 * counter are runtime, and the browser worker and the verifier rebuild all of
 * them identically from the same structured configuration.
 */

/** The one MAC the whole fabric answers a tenant's default gateway with. */
const ANYCAST_MAC = "02:00:00:ff:00:01";

const pc = (id: string, name: string, x: number, y: number) => ({
  id,
  kind: "pc" as const,
  name,
  position: { x, y },
  interfaces: [{ id: "eth0" }],
});

const leafNode = (id: string, name: string, x: number, y: number) => ({
  id,
  kind: "l3-switch" as const,
  name,
  position: { x, y },
  interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
});

const spineNode = (id: string, name: string, x: number, y: number) => ({
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

const host = (hostname: string, address: string, gateway: string) => ({
  kind: "pc" as const,
  hostname,
  interfaces: [],
  // The gateway is the *local* leaf's anycast SVI, which is exactly why the
  // same address works on both sides of the fabric.
  ipv4: { address, prefixLength: 24, defaultGateway: gateway },
  dhcpEnabled: false,
});

/** The IPv4 underlay every leaf reaches its peers and the reflector through. */
function underlay(options: { uplink: string; nextHop: string; peerLoopback: string }) {
  return [
    { network: options.peerLoopback, prefixLength: 32, nextHop: options.nextHop },
    { network: "10.255.0.9", prefixLength: 32, nextHop: options.nextHop },
  ];
}

const spine = (options: { hostname: string; clients: readonly string[] }) => ({
  kind: "router" as const,
  hostname: options.hostname,
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
  loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.9", prefixLength: 32 } }],
  // The reflector is the same BGP process serving one more family. It carries
  // and reflects EVPN routes without ever becoming a VTEP: no overlay, no
  // tenant VRF, no tenant MAC and no tenant route.
  bgp: {
    localAs: 65_000,
    routerId: "10.255.0.9",
    clusterId: "10.255.0.9",
    networks: [],
    vrfAddressFamilies: [],
    neighbors: options.clients.map((address) => ({
      address,
      remoteAs: 65_000,
      updateSource: "Loopback0",
      enabled: true,
      evpnActivated: true,
      sendCommunityExtended: true,
      routeReflectorClient: true,
    })),
  },
});

const instructions = (objective: string, details: readonly string[]) => [
  `Objective: ${objective}`,
  ...details,
  "Use Auto for bounded convergence, or Step with the L3VNI, IRB and Type 5 Packet Trace filters.",
].join("\n");

// --- Demo 1: distributed anycast gateway ----------------------------------

interface StretchedLeafOptions {
  hostname: string;
  loopback: string;
  uplink: string;
  nextHop: string;
  peerLoopback: string;
}

/**
 * A leaf in one stretched tenant subnet.
 *
 * Both leaves carry the same VLAN, the same L2VNI, the same gateway IPv4 and
 * the same fabric MAC. That shared address is a *distributed* gateway, not a
 * duplicate: a host always talks to its own local leaf, and its ARP cache stays
 * valid if it moves to the other one.
 */
function stretchedLeaf(options: StretchedLeafOptions) {
  return {
    kind: "l3-switch" as const,
    hostname: options.hostname,
    vlans: [{ id: 10, name: "TENANT-A-WEB" }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: 10, nativeVlan: 1 },
      { id: "Gi0/2", shutdown: false, mode: "routed" as const, ipv4: { address: options.uplink, prefixLength: 30 } },
      { id: "Gi0/3", shutdown: false, mode: "access" as const, accessVlan: 1, nativeVlan: 1 },
    ],
    svis: [{
      vlanId: 10,
      ipAddress: "10.10.10.1",
      prefixLength: 24,
      adminUp: true,
      description: "TENANT-A distributed gateway",
      vrfId: "TENANT-A",
      anycastGateway: true,
    }],
    vrfs: [{
      id: "TENANT-A",
      name: "TENANT-A",
      routeDistinguisher: `65000:5000${options.loopback.endsWith("1") ? 1 : 2}`,
      importRouteTargets: ["65000:50001"],
      exportRouteTargets: ["65000:50001"],
      staticRoutes: [],
      advertiseEvpn: true,
    }],
    staticRoutes: underlay({ uplink: options.uplink, nextHop: options.nextHop, peerLoopback: options.peerLoopback }),
    ipRoutingEnabled: true,
    acls: [],
    aclBindings: [],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }],
    nve: {
      id: "nve1" as const,
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" as const } }],
      vrfMembers: [{ vni: 50_001, vrfId: "TENANT-A" }],
    },
    evpn: {
      vnis: [{
        vni: 10_010,
        routeDistinguisher: "65000:10010",
        importRouteTargets: ["65000:10010"],
        exportRouteTargets: ["65000:10010"],
      }],
      anycastGatewayMac: ANYCAST_MAC,
    },
    bgp: {
      localAs: 65_000,
      routerId: options.loopback,
      networks: [],
      vrfAddressFamilies: [],
      neighbors: [{
        address: "10.255.0.9",
        remoteAs: 65_000,
        updateSource: "Loopback0",
        enabled: true,
        evpnActivated: true,
        sendCommunityExtended: true,
      }],
    },
  };
}

export const ANYCAST_GATEWAY_DEMO = {
  schemaVersion: 1,
  id: "evpn-anycast-gateway",
  title: "EVPN Distributed Anycast Gateway",
  description: "One stretched tenant subnet whose default gateway lives on every leaf at the same IPv4 address and the same MAC.",
  expectedOutcome: "Both hosts reach 10.10.10.1 on their own local leaf and each other across VNI 10010; the gateway MAC is never advertised as a Type 2 route.",
  instructions: instructions("Give one stretched subnet a gateway that exists on both leaves at once.", [
    "Topology: HOST-A - LEAF1 - SPINE-RR - LEAF2 - HOST-B. The spine is the underlay and the EVPN Route Reflector, never a VTEP.",
    "Underlay: 192.0.2.0/30 and 192.0.2.4/30; Loopbacks 10.255.0.1, 10.255.0.2 and 10.255.0.9, reached by static routes.",
    "Overlay: VLAN 10 maps to L2VNI 10010 with RD 65000:10010 and route target 65000:10010 import and export.",
    "Gateway: 'fabric forwarding anycast-gateway-mac 0200.00ff.0001' plus 'fabric forwarding mode anycast-gateway' on interface Vlan10 of both leaves.",
    "Tenants: HOST-A 10.10.10.10/24 and HOST-B 10.10.10.20/24, both using 10.10.10.1 as their default gateway.",
    "Required CLI: show nve interfaces; show nve vni; show fabric forwarding; show bgp l2vpn evpn route-type 3; show bgp l2vpn evpn route-type 2.",
    "Expected: each leaf answers ARP for 10.10.10.1 locally and never replicates that request across the fabric, Type 3 builds head-end replication before any traffic, and Type 2 installs each remote host MAC.",
    "Troubleshooting: check that both leaves declare the same fabric MAC, that interface Vlan10 has the same address on both, that the VLAN exists in the database, and that 'send-community extended' is present so route targets cross the session.",
  ]),
  simulation: { seed: 11_154 },
  topology: {
    schemaVersion: 1,
    nodes: [
      pc("host-a", "HOST-A", 60, 120),
      leafNode("leaf1", "LEAF1", 330, 120),
      spineNode("spine", "SPINE-RR", 610, 265),
      leafNode("leaf2", "LEAF2", 330, 410),
      pc("host-b", "HOST-B", 60, 410),
    ],
    links: [
      link("host-a-leaf1", "host-a", "eth0", "leaf1", "Gi0/1"),
      link("leaf1-spine", "leaf1", "Gi0/2", "spine", "Gi0/0"),
      link("spine-leaf2", "spine", "Gi0/1", "leaf2", "Gi0/2"),
      link("leaf2-host-b", "leaf2", "Gi0/1", "host-b", "eth0"),
    ],
  },
  configurations: {
    "host-a": host("HOST-A", "10.10.10.10", "10.10.10.1"),
    leaf1: stretchedLeaf({
      hostname: "LEAF1",
      loopback: "10.255.0.1",
      uplink: "192.0.2.1",
      nextHop: "192.0.2.2",
      peerLoopback: "10.255.0.2",
    }),
    spine: spine({ hostname: "SPINE-RR", clients: ["10.255.0.1", "10.255.0.2"] }),
    leaf2: stretchedLeaf({
      hostname: "LEAF2",
      loopback: "10.255.0.2",
      uplink: "192.0.2.6",
      nextHop: "192.0.2.5",
      peerLoopback: "10.255.0.1",
    }),
    "host-b": host("HOST-B", "10.10.10.20", "10.10.10.1"),
  },
} as unknown as LabDocument;

// --- Demo 2: symmetric IRB with EVPN Type 5 -------------------------------

interface TenantLeafOptions {
  hostname: string;
  loopback: string;
  uplink: string;
  nextHop: string;
  peerLoopback: string;
  /** TENANT-A's local VLAN, L2VNI and gateway. */
  vlanId: number;
  l2Vni: number;
  gateway: string;
  /** TENANT-B's local VLAN, L2VNI and gateway; a separate tenant entirely. */
  tenantBVlanId: number;
  tenantBL2Vni: number;
  tenantBGateway: string;
}

/**
 * A leaf carrying two tenants.
 *
 * TENANT-A is stretched across the fabric through L3VNI 50001; TENANT-B has its
 * own L3VNI and its own route targets, so it shares nothing with TENANT-A. That
 * route-target intersection - never the VNI number - is what keeps the two
 * tenants isolated.
 */
function tenantLeaf(options: TenantLeafOptions) {
  return {
    kind: "l3-switch" as const,
    hostname: options.hostname,
    vlans: [
      { id: options.vlanId, name: `TENANT-A-${options.vlanId}` },
      { id: options.tenantBVlanId, name: `TENANT-B-${options.tenantBVlanId}` },
    ],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: options.vlanId, nativeVlan: 1 },
      { id: "Gi0/2", shutdown: false, mode: "routed" as const, ipv4: { address: options.uplink, prefixLength: 30 } },
      { id: "Gi0/3", shutdown: false, mode: "access" as const, accessVlan: options.tenantBVlanId, nativeVlan: 1 },
    ],
    svis: [
      {
        vlanId: options.vlanId,
        ipAddress: options.gateway,
        prefixLength: 24,
        adminUp: true,
        description: "TENANT-A distributed gateway",
        vrfId: "TENANT-A",
        anycastGateway: true,
      },
      {
        vlanId: options.tenantBVlanId,
        ipAddress: options.tenantBGateway,
        prefixLength: 24,
        adminUp: true,
        description: "TENANT-B distributed gateway",
        vrfId: "TENANT-B",
        anycastGateway: true,
      },
    ],
    vrfs: [
      {
        id: "TENANT-A",
        name: "TENANT-A",
        routeDistinguisher: `65000:${options.l2Vni}`,
        importRouteTargets: ["65000:50001"],
        exportRouteTargets: ["65000:50001"],
        staticRoutes: [],
        advertiseEvpn: true,
      },
      {
        id: "TENANT-B",
        name: "TENANT-B",
        routeDistinguisher: `65001:${options.tenantBL2Vni}`,
        importRouteTargets: ["65001:50002"],
        exportRouteTargets: ["65001:50002"],
        staticRoutes: [],
        advertiseEvpn: true,
      },
    ],
    staticRoutes: underlay({ uplink: options.uplink, nextHop: options.nextHop, peerLoopback: options.peerLoopback }),
    ipRoutingEnabled: true,
    acls: [],
    aclBindings: [],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }],
    nve: {
      id: "nve1" as const,
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [
        { vni: options.l2Vni, vlanId: options.vlanId, replication: { type: "bgp-evpn" as const } },
        { vni: options.tenantBL2Vni, vlanId: options.tenantBVlanId, replication: { type: "bgp-evpn" as const } },
      ],
      // A routed transit segment per tenant: no VLAN, no broadcast domain.
      vrfMembers: [
        { vni: 50_001, vrfId: "TENANT-A" },
        { vni: 50_002, vrfId: "TENANT-B" },
      ],
    },
    evpn: {
      vnis: [
        {
          vni: options.l2Vni,
          routeDistinguisher: `65000:${options.l2Vni}`,
          importRouteTargets: [`65000:${options.l2Vni}`],
          exportRouteTargets: [`65000:${options.l2Vni}`],
        },
        {
          vni: options.tenantBL2Vni,
          routeDistinguisher: `65001:${options.tenantBL2Vni}`,
          importRouteTargets: [`65001:${options.tenantBL2Vni}`],
          exportRouteTargets: [`65001:${options.tenantBL2Vni}`],
        },
      ],
      anycastGatewayMac: ANYCAST_MAC,
    },
    bgp: {
      localAs: 65_000,
      routerId: options.loopback,
      networks: [],
      vrfAddressFamilies: [],
      neighbors: [{
        address: "10.255.0.9",
        remoteAs: 65_000,
        updateSource: "Loopback0",
        enabled: true,
        evpnActivated: true,
        sendCommunityExtended: true,
      }],
    },
  };
}

export const SYMMETRIC_IRB_DEMO = {
  schemaVersion: 1,
  id: "evpn-symmetric-irb",
  title: "EVPN Symmetric IRB and Type 5",
  description: "Two tenant subnets on different leaves routed to each other through an L3VNI, while a second tenant with different route targets stays isolated.",
  expectedOutcome: "HOST-A and HOST-B reach each other in both directions through L3VNI 50001; TENANT-B installs no TENANT-A prefix and the spine holds no tenant route or MAC.",
  instructions: instructions("Route between two tenant subnets across the fabric with symmetric IRB.", [
    "Topology: HOST-A 10.10.10.10/24 - VLAN 10 / L2VNI 10010 - LEAF1 - L3VNI 50001 (TENANT-A) - SPINE-RR - LEAF2 - VLAN 20 / L2VNI 10020 - HOST-B 10.20.20.20/24.",
    "Underlay: 192.0.2.0/30 and 192.0.2.4/30; Loopbacks 10.255.0.1, 10.255.0.2 and 10.255.0.9, reached by static routes.",
    "Gateways: 'fabric forwarding anycast-gateway-mac 0200.00ff.0001', then 'fabric forwarding mode anycast-gateway' on each tenant SVI. HOST-A uses 10.10.10.1 and HOST-B uses 10.20.20.1, each answered by its own local leaf.",
    "Tenants: TENANT-A imports and exports 65000:50001 on L3VNI 50001; TENANT-B imports and exports 65001:50002 on L3VNI 50002 and shares nothing with it.",
    "Origination: 'router bgp 65000' then 'address-family ipv4 vrf TENANT-A' and 'advertise l2vpn evpn'. Without that statement nothing is redistributed.",
    "Required CLI: show ip route vrf TENANT-A; show ip route vrf TENANT-B; show bgp l2vpn evpn route-type 5; show nve vni; show fabric forwarding.",
    "Expected: each leaf originates its own connected tenant prefix as a Type 5 route, the reflector passes it on with ORIGINATOR_ID and CLUSTER_LIST, the remote leaf imports it into TENANT-A by route target, and traffic is routed at both ends through L3VNI 50001. TENANT-B's table stays free of TENANT-A prefixes and the spine has no VRF at all.",
    "Troubleshooting: check 'advertise l2vpn evpn' on the tenant address family, that the VRF has an RD and an export route target, that 'member vni 50001 associate-vrf TENANT-A' exists on nve1, that route targets match on both sides, and that the underlay reaches the remote Loopback.",
  ]),
  simulation: { seed: 11_155 },
  topology: {
    schemaVersion: 1,
    nodes: [
      pc("host-a", "HOST-A", 60, 120),
      leafNode("leaf1", "LEAF1", 330, 120),
      spineNode("spine", "SPINE-RR", 610, 265),
      leafNode("leaf2", "LEAF2", 330, 410),
      pc("host-b", "HOST-B", 60, 410),
      pc("host-c", "HOST-C", 60, 560),
    ],
    links: [
      link("host-a-leaf1", "host-a", "eth0", "leaf1", "Gi0/1"),
      link("leaf1-spine", "leaf1", "Gi0/2", "spine", "Gi0/0"),
      link("spine-leaf2", "spine", "Gi0/1", "leaf2", "Gi0/2"),
      link("leaf2-host-b", "leaf2", "Gi0/1", "host-b", "eth0"),
      // HOST-C belongs to TENANT-B and must never reach TENANT-A.
      link("leaf2-host-c", "leaf2", "Gi0/3", "host-c", "eth0"),
    ],
  },
  configurations: {
    "host-a": host("HOST-A", "10.10.10.10", "10.10.10.1"),
    leaf1: tenantLeaf({
      hostname: "LEAF1",
      loopback: "10.255.0.1",
      uplink: "192.0.2.1",
      nextHop: "192.0.2.2",
      peerLoopback: "10.255.0.2",
      vlanId: 10,
      l2Vni: 10_010,
      gateway: "10.10.10.1",
      tenantBVlanId: 110,
      tenantBL2Vni: 10_110,
      tenantBGateway: "172.16.10.1",
    }),
    spine: spine({ hostname: "SPINE-RR", clients: ["10.255.0.1", "10.255.0.2"] }),
    leaf2: tenantLeaf({
      hostname: "LEAF2",
      loopback: "10.255.0.2",
      uplink: "192.0.2.6",
      nextHop: "192.0.2.5",
      peerLoopback: "10.255.0.1",
      vlanId: 20,
      l2Vni: 10_020,
      gateway: "10.20.20.1",
      tenantBVlanId: 120,
      tenantBL2Vni: 10_120,
      tenantBGateway: "172.16.20.1",
    }),
    "host-b": host("HOST-B", "10.20.20.20", "10.20.20.1"),
    "host-c": host("HOST-C", "172.16.20.30", "172.16.20.1"),
  },
} as unknown as LabDocument;

export const ROUTED_EVPN_DEMO_LABS = [ANYCAST_GATEWAY_DEMO, SYMMETRIC_IRB_DEMO] as const;

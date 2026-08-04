import type { LabDocument } from "@sim/contracts";

/**
 * M10.13 MP-BGP IPv6 unicast and MPLS VPNv6 demos. Like every demo lab these
 * are only ever opened from the Demo Labs dialog and are never auto-loaded.
 *
 * Each document stores configuration only: no BGP session, learned route,
 * VPNv6 RIB, allocated label, LFIB entry or NDP cache is persisted. The browser
 * worker and the verifier each rebuild that runtime from these bytes.
 */

const routerPorts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `Gi0/${index}` }));

const node = (id: string, name: string, x: number, y: number, ports: number) => ({
  id, kind: "router" as const, name, position: { x, y }, interfaces: routerPorts(ports),
});

const link = (id: string, a: string, ai: string, b: string, bi: string) => ({
  id, a: { node: a, iface: ai }, b: { node: b, iface: bi },
});

interface DemoInterface {
  id: string;
  ipv4?: { address: string; prefixLength: number };
  ipv6?: { address: string; prefixLength: number };
  mpls?: boolean;
  vrfId?: string;
}

/**
 * One shared Router builder. Every demo below is a plain structured document,
 * so a reader can compare the three scenarios line by line.
 */
function router(
  hostname: string,
  interfaces: readonly DemoInterface[],
  options: {
    loopback?: string;
    ospf?: boolean;
    ldp?: boolean;
    ipv6Routing?: boolean;
    ipv6StaticRoutes?: ReadonlyArray<{ network: string; prefixLength: number; nextHop: string }>;
    ipv6PrefixLists?: ReadonlyArray<{
      id: string;
      entries: ReadonlyArray<{
        sequence: number; action: "permit" | "deny"; prefix: string; prefixLength: number; ge?: number; le?: number;
      }>;
    }>;
    routeMaps?: ReadonlyArray<{
      id: string;
      sequences: ReadonlyArray<Record<string, unknown>>;
    }>;
    vrfs?: ReadonlyArray<{
      id: string; name: string; rd: string; rt: string;
      ipv6?: boolean;
      ipv6StaticRoutes?: ReadonlyArray<{ network: string; prefixLength: number; nextHop: string }>;
    }>;
    bgp?: Record<string, unknown>;
  } = {},
) {
  return {
    kind: "router" as const,
    hostname,
    interfaces: interfaces.map((iface) => ({
      id: iface.id,
      routed: true,
      shutdown: false,
      ipv4: iface.ipv4,
      ipv6: iface.ipv6 ? [iface.ipv6] : undefined,
      mplsEnabled: iface.mpls || undefined,
      vrfId: iface.vrfId,
    })),
    subinterfaces: [],
    staticRoutes: [],
    ipv6UnicastRoutingEnabled: options.ipv6Routing || undefined,
    ipv6StaticRoutes: options.ipv6StaticRoutes ? [...options.ipv6StaticRoutes] : undefined,
    dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
    loopbacks: options.loopback
      ? [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }]
      : [],
    ospf: options.ospf && options.loopback ? {
      processId: 1,
      routerId: options.loopback,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 }],
      passiveInterfaces: ["Loopback0"],
      interfaces: interfaces.filter((iface) => iface.mpls)
        .map((iface) => ({ interfaceId: iface.id, networkType: "point-to-point" as const })),
    } : undefined,
    ldp: options.ldp ? { routerIdInterface: "Loopback0" } : undefined,
    ipv6PrefixLists: options.ipv6PrefixLists ? options.ipv6PrefixLists.map((list) => ({
      id: list.id,
      entries: list.entries.map((entry) => ({ ...entry })),
    })) : undefined,
    routeMaps: options.routeMaps ? options.routeMaps.map((map) => ({ id: map.id, sequences: [...map.sequences] })) : [],
    vrfs: (options.vrfs ?? []).map((vrf) => ({
      id: vrf.id,
      name: vrf.name,
      routeDistinguisher: vrf.rd,
      importRouteTargets: [vrf.rt],
      exportRouteTargets: [vrf.rt],
      staticRoutes: [],
      addressFamilyIpv6: vrf.ipv6 || undefined,
      ipv6StaticRoutes: vrf.ipv6StaticRoutes ? [...vrf.ipv6StaticRoutes] : undefined,
    })),
    bgp: options.bgp,
  };
}

const instructions = (lines: readonly string[]) => lines.join("\n");

// --- 1. eBGP over IPv6 -----------------------------------------------------

export const EBGP_IPV6_DEMO = {
  schemaVersion: 1,
  id: "mbgp-ebgp-ipv6",
  title: "eBGP over IPv6",
  description: "Two autonomous systems peer over an IPv6 transport address and exchange IPv6 unicast prefixes.",
  expectedOutcome: "The IPv6 BGP session reaches Established, both /64 LAN prefixes install with AD 20, and each LAN reaches the other.",
  instructions: instructions([
    "Objective: establish a BGP session over an IPv6 neighbor address and exchange IPv6 unicast NLRI.",
    "AS numbers: R1 65001; R2 65002.",
    "Addressing: transit 2001:db8:12::/64 (R1 ::1, R2 ::2); LAN A 2001:db8:a::/64; LAN B 2001:db8:b::/64.",
    "Route targets: none — this is global IPv6 unicast, not a VPN.",
    "Required CLI: show bgp ipv6 unicast summary; show bgp ipv6 unicast; show ipv6 route bgp.",
    "Expected route state: R1 holds 2001:db8:b::/64 and R2 holds 2001:db8:a::/64, each learned from the IPv6 peer.",
    "Troubleshooting: the session runs over real simulated TCP/179, so check IPv6 reachability and NDP first; a network statement advertises only when an exact IPv6 route already exists locally.",
  ]),
  simulation: { seed: 10_131 },
  topology: {
    schemaVersion: 1,
    nodes: [node("r1", "R1", 300, 240, 2), node("r2", "R2", 700, 240, 2)],
    links: [link("r1-r2", "r1", "Gi0/0", "r2", "Gi0/0")],
  },
  configurations: {
    r1: router("R1", [
      { id: "Gi0/0", ipv6: { address: "2001:db8:12::1", prefixLength: 64 } },
      { id: "Gi0/1", ipv6: { address: "2001:db8:a::1", prefixLength: 64 } },
    ], {
      loopback: "10.255.0.1",
      ipv6Routing: true,
      bgp: {
        localAs: 65_001,
        routerId: "10.255.0.1",
        neighbors: [{ address: "2001:db8:12::2", remoteAs: 65_002, enabled: true, ipv6: { activated: true } }],
        networks: [],
        ipv6Networks: [{ network: "2001:db8:a::", prefixLength: 64 }],
        vrfAddressFamilies: [],
      },
    }),
    r2: router("R2", [
      { id: "Gi0/0", ipv6: { address: "2001:db8:12::2", prefixLength: 64 } },
      { id: "Gi0/1", ipv6: { address: "2001:db8:b::1", prefixLength: 64 } },
    ], {
      loopback: "10.255.0.2",
      ipv6Routing: true,
      bgp: {
        localAs: 65_002,
        routerId: "10.255.0.2",
        neighbors: [{ address: "2001:db8:12::1", remoteAs: 65_001, enabled: true, ipv6: { activated: true } }],
        networks: [],
        ipv6Networks: [{ network: "2001:db8:b::", prefixLength: 64 }],
        vrfAddressFamilies: [],
      },
    }),
  },
} as unknown as LabDocument;

// --- 2. Dual-stack BGP -----------------------------------------------------

export const DUAL_STACK_BGP_DEMO = {
  schemaVersion: 1,
  id: "mbgp-dual-stack",
  title: "Dual-Stack BGP",
  description: "One eBGP TCP session carries IPv4 and IPv6 unicast, with independent RIBs and independent policy per family.",
  expectedOutcome: "A single session negotiates both families; the IPv6 prefix-list denies one /64 while the IPv4 prefix is untouched.",
  instructions: instructions([
    "Objective: show that one BGP relationship carries two address families with separate RIBs and separate policy.",
    "AS numbers: R1 65001; R2 65002.",
    "Addressing: transit 192.0.2.0/30 and 2001:db8:12::/64; R1 advertises 10.10.0.0/24, 2001:db8:100::/64 and 2001:db8:200::/64.",
    "Policy table: R2 applies ipv6 prefix-list CUSTOMER6 inbound — permit 2001:db8:100::/48 le 64, implicit deny for everything else.",
    "Route targets: none — both families are global unicast.",
    "Required CLI: show ip bgp summary; show bgp ipv6 unicast; show ipv6 prefix-list; show bgp ipv6 unicast neighbors.",
    "Expected route state: R2 installs 10.10.0.0/24 and 2001:db8:100::/64 but never 2001:db8:200::/64.",
    "Troubleshooting: one TCP session serves both families, so an IPv4 problem and an IPv6 policy problem look very different — compare the Address Family selector in Monitor ▸ BGP against the Packet Trace Family column.",
  ]),
  simulation: { seed: 10_132 },
  topology: {
    schemaVersion: 1,
    nodes: [node("r1", "R1", 300, 240, 2), node("r2", "R2", 700, 240, 2)],
    links: [link("r1-r2", "r1", "Gi0/0", "r2", "Gi0/0")],
  },
  configurations: {
    r1: router("R1", [
      {
        id: "Gi0/0",
        ipv4: { address: "192.0.2.1", prefixLength: 30 },
        ipv6: { address: "2001:db8:12::1", prefixLength: 64 },
      },
      {
        id: "Gi0/1",
        ipv4: { address: "10.10.0.1", prefixLength: 24 },
        ipv6: { address: "2001:db8:100::1", prefixLength: 64 },
      },
    ], {
      loopback: "10.255.0.1",
      ipv6Routing: true,
      // A second local /64 exists only so the inbound IPv6 policy on R2 has
      // something to deny; nothing about it is IPv4-specific.
      ipv6StaticRoutes: [{ network: "2001:db8:200::", prefixLength: 64, nextHop: "2001:db8:100::2" }],
      bgp: {
        localAs: 65_001,
        routerId: "10.255.0.1",
        neighbors: [{
          address: "192.0.2.2",
          remoteAs: 65_002,
          enabled: true,
          ipv6: { activated: true, nextHopSelf: true },
        }],
        networks: [{ network: "10.10.0.0", prefixLength: 24 }],
        ipv6Networks: [
          { network: "2001:db8:100::", prefixLength: 64 },
          { network: "2001:db8:200::", prefixLength: 64 },
        ],
        vrfAddressFamilies: [],
      },
    }),
    r2: router("R2", [
      {
        id: "Gi0/0",
        ipv4: { address: "192.0.2.2", prefixLength: 30 },
        ipv6: { address: "2001:db8:12::2", prefixLength: 64 },
      },
      {
        id: "Gi0/1",
        ipv4: { address: "10.20.0.1", prefixLength: 24 },
        ipv6: { address: "2001:db8:b::1", prefixLength: 64 },
      },
    ], {
      loopback: "10.255.0.2",
      ipv6Routing: true,
      ipv6PrefixLists: [{
        id: "CUSTOMER6",
        entries: [{ sequence: 10, action: "permit", prefix: "2001:db8:100::", prefixLength: 48, le: 64 }],
      }],
      routeMaps: [{
        id: "FROM-R1",
        sequences: [
          { sequence: 10, action: "permit", match: { ipv6PrefixListIds: ["CUSTOMER6"] } },
          { sequence: 100, action: "deny" },
        ],
      }],
      bgp: {
        localAs: 65_002,
        routerId: "10.255.0.2",
        neighbors: [{
          address: "192.0.2.1",
          remoteAs: 65_001,
          enabled: true,
          ipv6: { activated: true, routeMapIn: "FROM-R1" },
        }],
        networks: [{ network: "10.20.0.0", prefixLength: 24 }],
        ipv6Networks: [{ network: "2001:db8:b::", prefixLength: 64 }],
        vrfAddressFamilies: [],
      },
    }),
  },
} as unknown as LabDocument;

// --- 3. VPNv6 over MPLS ----------------------------------------------------

const customerA = { id: "customer-a", name: "CUSTOMER-A", rd: "65000:100", rt: "65000:100" } as const;
const customerB = { id: "customer-b", name: "CUSTOMER-B", rd: "65000:200", rt: "65000:200" } as const;

const pePeer = (peer: string, vrfIds: readonly string[]) => ({
  localAs: 65_000,
  routerId: undefined as string | undefined,
  neighbors: [{
    address: peer,
    remoteAs: 65_000,
    updateSource: "Loopback0",
    enabled: true,
    vpnv6Activated: true,
    sendCommunityExtended: true,
  }],
  networks: [],
  vrfAddressFamilies: vrfIds.map((vrfId) => ({
    vrfId,
    redistributeConnectedIpv6: true,
    redistributeStaticIpv6: true,
  })),
});

export const VPNV6_OVER_MPLS_DEMO = {
  schemaVersion: 1,
  id: "mbgp-vpnv6-over-mpls",
  title: "VPNv6 Over MPLS",
  description: "Two customers reuse the same IPv6 /64 in separate VRFs while MP-BGP VPNv6 carries them over an IPv4 OSPF/LDP core.",
  expectedOutcome: "Each customer reaches only its own remote site; the P router holds no customer IPv6 route and forwards labels only.",
  instructions: instructions([
    "Objective: carry customer IPv6 prefixes across an IPv4 MPLS core and prove two identical /64s stay isolated.",
    "AS numbers: the whole provider is AS 65000; PE1 and PE2 are iBGP peers over their Loopback0 addresses.",
    "Core addressing: 192.0.2.0/30 and 192.0.2.4/30; Loopbacks 10.255.0.1 (PE1), 10.255.0.2 (P) and 10.255.0.3 (PE2); OSPF area 0 with LDP.",
    "Customer addressing: CUSTOMER-A and CUSTOMER-B both use 2001:db8:100::/64 at site 1; A site 2 is 2001:db8:a2::/64 and B site 2 is 2001:db8:b2::/64.",
    "Route distinguishers and targets: CUSTOMER-A RD/RT 65000:100; CUSTOMER-B RD/RT 65000:200. The RD makes the overlapping /64 unique; the RT decides import.",
    "Required CLI: show bgp vpnv6 unicast all; show bgp vpnv6 unicast vrf CUSTOMER-A; show ipv6 route vrf CUSTOMER-A; show mpls forwarding-table.",
    "Expected label state: a VPN label is allocated per VRF *and* address family, so CUSTOMER-A's IPv6 label differs from its IPv4 label; the transport label resolves the remote PE's IPv4 loopback through LDP.",
    "Expected route state: PE2 imports 2001:db8:100::/64 twice — once per RD — and each copy stays inside its own VRF; P has no customer IPv6 route at all.",
    "Troubleshooting: remove `send-community extended` and route targets stop crossing; shut a core link and the transport label disappears while the VPNv6 route may briefly remain in the RIB.",
  ]),
  simulation: { seed: 10_133 },
  topology: {
    schemaVersion: 1,
    nodes: [
      node("a1", "CE-A1", 40, 110, 1), node("b1", "CE-B1", 40, 400, 1),
      node("pe1", "PE1", 300, 255, 3), node("p", "P", 560, 255, 2), node("pe2", "PE2", 820, 255, 3),
      node("a2", "CE-A2", 1070, 110, 1), node("b2", "CE-B2", 1070, 400, 1),
    ],
    links: [
      link("a1-pe1", "a1", "Gi0/0", "pe1", "Gi0/1"), link("b1-pe1", "b1", "Gi0/0", "pe1", "Gi0/2"),
      link("pe1-p", "pe1", "Gi0/0", "p", "Gi0/0"), link("p-pe2", "p", "Gi0/1", "pe2", "Gi0/0"),
      link("pe2-a2", "pe2", "Gi0/1", "a2", "Gi0/0"), link("pe2-b2", "pe2", "Gi0/2", "b2", "Gi0/0"),
    ],
  },
  configurations: {
    // Both customer site-1 routers deliberately use the same /64.
    a1: router("CE-A1", [{ id: "Gi0/0", ipv6: { address: "2001:db8:100::2", prefixLength: 64 } }], {
      ipv6Routing: true,
      ipv6StaticRoutes: [{ network: "2001:db8:a2::", prefixLength: 64, nextHop: "2001:db8:100::1" }],
    }),
    b1: router("CE-B1", [{ id: "Gi0/0", ipv6: { address: "2001:db8:100::2", prefixLength: 64 } }], {
      ipv6Routing: true,
      ipv6StaticRoutes: [{ network: "2001:db8:b2::", prefixLength: 64, nextHop: "2001:db8:100::1" }],
    }),
    pe1: router("PE1", [
      { id: "Gi0/0", ipv4: { address: "192.0.2.1", prefixLength: 30 }, mpls: true },
      { id: "Gi0/1", ipv6: { address: "2001:db8:100::1", prefixLength: 64 }, vrfId: customerA.id },
      { id: "Gi0/2", ipv6: { address: "2001:db8:100::1", prefixLength: 64 }, vrfId: customerB.id },
    ], {
      loopback: "10.255.0.1", ospf: true, ldp: true, ipv6Routing: true,
      vrfs: [{ ...customerA, ipv6: true }, { ...customerB, ipv6: true }],
      bgp: { ...pePeer("10.255.0.3", [customerA.id, customerB.id]), routerId: "10.255.0.1" },
    }),
    // The P router runs the IPv4 core only: no VRF, no BGP, no customer route.
    p: router("P", [
      { id: "Gi0/0", ipv4: { address: "192.0.2.2", prefixLength: 30 }, mpls: true },
      { id: "Gi0/1", ipv4: { address: "192.0.2.5", prefixLength: 30 }, mpls: true },
    ], { loopback: "10.255.0.2", ospf: true, ldp: true }),
    pe2: router("PE2", [
      { id: "Gi0/0", ipv4: { address: "192.0.2.6", prefixLength: 30 }, mpls: true },
      { id: "Gi0/1", ipv6: { address: "2001:db8:a2::1", prefixLength: 64 }, vrfId: customerA.id },
      { id: "Gi0/2", ipv6: { address: "2001:db8:b2::1", prefixLength: 64 }, vrfId: customerB.id },
    ], {
      loopback: "10.255.0.3", ospf: true, ldp: true, ipv6Routing: true,
      vrfs: [{ ...customerA, ipv6: true }, { ...customerB, ipv6: true }],
      bgp: { ...pePeer("10.255.0.1", [customerA.id, customerB.id]), routerId: "10.255.0.3" },
    }),
    a2: router("CE-A2", [{ id: "Gi0/0", ipv6: { address: "2001:db8:a2::2", prefixLength: 64 } }], {
      ipv6Routing: true,
      ipv6StaticRoutes: [{ network: "2001:db8:100::", prefixLength: 64, nextHop: "2001:db8:a2::1" }],
    }),
    b2: router("CE-B2", [{ id: "Gi0/0", ipv6: { address: "2001:db8:b2::2", prefixLength: 64 } }], {
      ipv6Routing: true,
      ipv6StaticRoutes: [{ network: "2001:db8:100::", prefixLength: 64, nextHop: "2001:db8:b2::1" }],
    }),
  },
} as unknown as LabDocument;

export const MBGP_IPV6_DEMO_LABS = [
  EBGP_IPV6_DEMO,
  DUAL_STACK_BGP_DEMO,
  VPNV6_OVER_MPLS_DEMO,
] as const;

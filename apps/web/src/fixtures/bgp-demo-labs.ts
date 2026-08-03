import type {
  AsPathListConfig,
  BgpProcessConfig,
  CommunityListConfig,
  LabDocument,
  PrefixListConfig,
  RouteMapConfig,
} from "@sim/contracts";

type DemoBgpConfig = Omit<BgpProcessConfig, "vrfAddressFamilies"> & Partial<Pick<BgpProcessConfig, "vrfAddressFamilies">>;

const routerNode = (id: string, name: string, x: number, y: number, ports: number) => ({
  id, kind: "router" as const, name, position: { x, y },
  interfaces: Array.from({ length: ports }, (_, index) => ({ id: `Gi0/${index}` })),
});

interface RouterOptions {
  loopback?: string;
  loopbacks?: ReadonlyArray<{ id: number; address: string; prefixLength?: number }>;
  staticRoutes?: ReadonlyArray<{ network: string; prefixLength: number; nextHop: string }>;
  prefixLists?: PrefixListConfig[];
  routeMaps?: RouteMapConfig[];
  communityLists?: CommunityListConfig[];
  asPathLists?: AsPathListConfig[];
}

const routerConfig = (
  hostname: string,
  addresses: readonly string[],
  bgp: DemoBgpConfig,
  options: RouterOptions = {},
) => ({
  kind: "router" as const,
  hostname,
  interfaces: addresses.map((address, index) => ({
    id: `Gi0/${index}`, routed: true, shutdown: false,
    ipv4: { address: address.split("/")[0]!, prefixLength: Number(address.split("/")[1]) },
  })),
  subinterfaces: [], staticRoutes: options.staticRoutes ? [...options.staticRoutes] : [],
  dhcpPools: [], acls: [], aclBindings: [],
  natPools: [], natRules: [], natInterfaceRoles: [],
  loopbacks: options.loopbacks
    ? options.loopbacks.map((loopback) => ({
      id: loopback.id, shutdown: false,
      ipv4: { address: loopback.address, prefixLength: loopback.prefixLength ?? 24 },
    }))
    : options.loopback ? [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 24 } }] : [],
  prefixLists: options.prefixLists ?? [], routeMaps: options.routeMaps ?? [],
  communityLists: options.communityLists, asPathLists: options.asPathLists,
  bgp: { ...bgp, vrfAddressFamilies: bgp.vrfAddressFamilies ?? [] },
});

const pcConfig = (hostname: string, address: string, gateway: string) => ({
  kind: "pc" as const,
  hostname,
  interfaces: [],
  ipv4: { address, prefixLength: 24, defaultGateway: gateway },
  dhcpEnabled: false,
});

function instructions(lines: readonly string[]): string {
  return lines.join("\n");
}

export const EBGP_BASIC_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "bgp-ebgp-basic",
  title: "eBGP Basic",
  description: "Two autonomous systems exchange their directly connected LAN prefixes over simulated TCP 179.",
  expectedOutcome: "The eBGP neighbor reaches Established, both /24 prefixes are installed with AD 20, and PC1 reaches PC2.",
  instructions: instructions([
    "Objective: establish eBGP between R1 AS65001 and R2 AS65002 and verify remote LAN connectivity.",
    "AS numbers: R1 65001; R2 65002.",
    "Addressing: transit 192.0.2.0/30; LAN A 10.10.0.0/24; LAN B 10.20.0.0/24.",
    "Required CLI: show ip bgp summary; show ip bgp; show ip route bgp.",
    "Expected route table: R1 learns 10.20.0.0/24 and R2 learns 10.10.0.0/24 with administrative distance 20.",
    "Troubleshooting: verify remote-as, interface state, TCP 179 reachability, and exact local routes for network statements.",
  ]),
  simulation: { seed: 10_101 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-a", kind: "pc", name: "PC-A", position: { x: 60, y: 220 }, interfaces: [{ id: "eth0" }] },
      routerNode("r1", "R1", 320, 220, 2), routerNode("r2", "R2", 650, 220, 2),
      { id: "pc-b", kind: "pc", name: "PC-B", position: { x: 920, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "pc-a-r1", a: { node: "pc-a", iface: "eth0" }, b: { node: "r1", iface: "Gi0/1" } },
      { id: "r1-r2", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } },
      { id: "r2-pc-b", a: { node: "r2", iface: "Gi0/1" }, b: { node: "pc-b", iface: "eth0" } },
    ],
  },
  configurations: {
    "pc-a": pcConfig("PC-A", "10.10.0.10", "10.10.0.1"),
    r1: routerConfig("R1", ["192.0.2.1/30", "10.10.0.1/24"], { localAs: 65_001, routerId: "1.1.1.1", neighbors: [{ address: "192.0.2.2", remoteAs: 65_002, enabled: true }], networks: [{ network: "10.10.0.0", prefixLength: 24 }] }),
    r2: routerConfig("R2", ["192.0.2.2/30", "10.20.0.1/24"], { localAs: 65_002, routerId: "2.2.2.2", neighbors: [{ address: "192.0.2.1", remoteAs: 65_001, enabled: true }], networks: [{ network: "10.20.0.0", prefixLength: 24 }] }),
    "pc-b": pcConfig("PC-B", "10.20.0.10", "10.20.0.1"),
  },
};

export const DUAL_ISP_BEST_PATH_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "bgp-dual-isp-best-path",
  title: "Dual ISP Best Path",
  description: "A customer uses inbound route maps to prefer ISP1 while retaining deterministic ISP2 failover.",
  expectedOutcome: "Both eBGP sessions establish; local preference 200 selects ISP1 and ISP2 becomes the alternate path.",
  instructions: instructions([
    "Objective: compare two paths to 203.0.113.0/24 and observe deterministic failover.",
    "AS numbers: CUSTOMER 65000; ISP1 65100; ISP2 65200.",
    "Addressing: ISP1 link 192.0.2.0/30; ISP2 link 198.51.100.0/30.",
    "Required CLI: show ip bgp 203.0.113.0/24; show route-map; show ip bgp neighbors.",
    "Expected route table: ISP1 is best because CUSTOMER-IN sets local preference 200; shutting its link selects ISP2.",
    "Troubleshooting: inspect BGP Updates and Route Policy filters; policy has first-match semantics and implicit deny.",
  ]),
  simulation: { seed: 10_102 },
  topology: {
    schemaVersion: 1,
    nodes: [routerNode("customer", "CUSTOMER", 470, 330, 2), routerNode("isp1", "ISP1", 220, 100, 1), routerNode("isp2", "ISP2", 720, 100, 1)],
    links: [
      { id: "customer-isp1", a: { node: "customer", iface: "Gi0/0" }, b: { node: "isp1", iface: "Gi0/0" } },
      { id: "customer-isp2", a: { node: "customer", iface: "Gi0/1" }, b: { node: "isp2", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    customer: routerConfig("CUSTOMER", ["192.0.2.1/30", "198.51.100.1/30"], {
      localAs: 65_000, routerId: "10.0.0.1",
      neighbors: [
        { address: "192.0.2.2", remoteAs: 65_100, enabled: true, routeMapIn: "CUSTOMER-IN" },
        { address: "198.51.100.2", remoteAs: 65_200, enabled: true },
      ], networks: [],
    }, { routeMaps: [{ id: "CUSTOMER-IN", sequences: [{ sequence: 10, action: "permit", set: { localPreference: 200 } }] }] }),
    isp1: routerConfig("ISP1", ["192.0.2.2/30"], { localAs: 65_100, routerId: "10.0.1.1", neighbors: [{ address: "192.0.2.1", remoteAs: 65_000, enabled: true }], networks: [{ network: "203.0.113.0", prefixLength: 24 }] }, { loopback: "203.0.113.1" }),
    isp2: routerConfig("ISP2", ["198.51.100.2/30"], { localAs: 65_200, routerId: "10.0.2.1", neighbors: [{ address: "198.51.100.1", remoteAs: 65_000, enabled: true }], networks: [{ network: "203.0.113.0", prefixLength: 24 }] }, { loopback: "203.0.113.2" }),
  },
};

export const IBGP_POLICY_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "bgp-ibgp-route-policy",
  title: "iBGP and Route Policies",
  description: "A three-router iBGP full mesh applies a prefix list and route map without route reflection.",
  expectedOutcome: "All three iBGP sessions establish, next-hop-self keeps paths usable, and CUSTOMER-IN permits only the expected /24.",
  instructions: instructions([
    "Objective: inspect basic iBGP split horizon, next-hop-self, inbound prefix filtering, and local preference.",
    "AS numbers: EDGE1, CORE and EDGE2 all use AS65000; route reflectors are intentionally not implemented.",
    "Addressing: triangle transit links use 10.0.12.0/30, 10.0.23.0/30 and 10.0.13.0/30; loopbacks advertise 10.1.0.0/24 and 10.2.0.0/24.",
    "Required CLI: show ip bgp summary; show ip prefix-list; show route-map; show ip bgp.",
    "Expected route table: CUSTOMER permits 10.1.0.0/24 and sets local preference 150 on EDGE2.",
    "Troubleshooting: an iBGP-learned route is not advertised to another iBGP peer; use a full mesh in this milestone.",
  ]),
  simulation: { seed: 10_103 },
  topology: {
    schemaVersion: 1,
    nodes: [routerNode("edge1", "EDGE1", 180, 120, 2), routerNode("core", "CORE", 500, 350, 2), routerNode("edge2", "EDGE2", 820, 120, 2)],
    links: [
      { id: "edge1-core", a: { node: "edge1", iface: "Gi0/0" }, b: { node: "core", iface: "Gi0/0" } },
      { id: "core-edge2", a: { node: "core", iface: "Gi0/1" }, b: { node: "edge2", iface: "Gi0/0" } },
      { id: "edge1-edge2", a: { node: "edge1", iface: "Gi0/1" }, b: { node: "edge2", iface: "Gi0/1" } },
    ],
  },
  configurations: {
    edge1: routerConfig("EDGE1", ["10.0.12.1/30", "10.0.13.1/30"], { localAs: 65_000, routerId: "1.1.1.1", neighbors: [{ address: "10.0.12.2", remoteAs: 65_000, enabled: true, nextHopSelf: true }, { address: "10.0.13.2", remoteAs: 65_000, enabled: true, nextHopSelf: true }], networks: [{ network: "10.1.0.0", prefixLength: 24 }] }, { loopback: "10.1.0.1" }),
    core: routerConfig("CORE", ["10.0.12.2/30", "10.0.23.1/30"], { localAs: 65_000, routerId: "2.2.2.2", neighbors: [{ address: "10.0.12.1", remoteAs: 65_000, enabled: true, nextHopSelf: true }, { address: "10.0.23.2", remoteAs: 65_000, enabled: true, nextHopSelf: true }], networks: [] }),
    edge2: routerConfig("EDGE2", ["10.0.23.2/30", "10.0.13.2/30"], { localAs: 65_000, routerId: "3.3.3.3", neighbors: [{ address: "10.0.23.1", remoteAs: 65_000, enabled: true, nextHopSelf: true }, { address: "10.0.13.1", remoteAs: 65_000, enabled: true, nextHopSelf: true, prefixListIn: "CUSTOMER", routeMapIn: "CUSTOMER-IN" }], networks: [{ network: "10.2.0.0", prefixLength: 24 }] }, {
      loopback: "10.2.0.1",
      prefixLists: [{ id: "CUSTOMER", entries: [{ sequence: 10, action: "permit", prefix: "10.1.0.0", prefixLength: 24 }] }],
      routeMaps: [{ id: "CUSTOMER-IN", sequences: [{ sequence: 10, action: "permit", match: { prefixListIds: ["CUSTOMER"] }, set: { localPreference: 150 } }, { sequence: 100, action: "deny" }] }],
    }),
  },
};

/**
 * M10.12 iBGP Route Reflector: three clients, one reflector and one edge, with
 * no client-to-client sessions at all. The reflector's clients reach each
 * other only because reflection replaces the full mesh.
 */
export const IBGP_ROUTE_REFLECTOR_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "bgp-ibgp-route-reflector",
  title: "iBGP Route Reflector",
  description: "Three iBGP clients exchange prefixes through one route reflector instead of a full mesh.",
  expectedOutcome: "Every client learns the other clients' loopback prefixes with ORIGINATOR_ID and CLUSTER_LIST set by RR.",
  instructions: instructions([
    "Objective: replace an iBGP full mesh with a route reflector and observe the reflection attributes.",
    "AS numbers: CLIENT1, CLIENT2, CLIENT3, RR and EDGE all use AS65000; EDGE peers eBGP with nobody in this lab.",
    "Addressing: RR links use 10.0.1.0/30, 10.0.2.0/30, 10.0.3.0/30 and 10.0.4.0/30; clients advertise 172.16.1.0/24, 172.16.2.0/24 and 172.16.3.0/24.",
    "Policy table: RR marks CLIENT1, CLIENT2 and CLIENT3 as route-reflector-client; EDGE stays a non-client iBGP peer; cluster ID is 10.255.0.1.",
    "Required CLI: show ip bgp summary; show ip bgp neighbors 10.0.1.2 advertised-routes; show ip bgp 172.16.1.0/24.",
    "Expected BGP table: CLIENT2 holds 172.16.1.0/24 with Originator 1.1.1.1 and Cluster list 10.255.0.1.",
    "Troubleshooting: a client route reaches every peer, a non-client route only reaches clients, and a route whose ORIGINATOR_ID or CLUSTER_LIST already names this device is rejected as a loop.",
  ]),
  simulation: { seed: 10_120 },
  topology: {
    schemaVersion: 1,
    nodes: [
      routerNode("client1", "CLIENT1", 120, 90, 1),
      routerNode("client2", "CLIENT2", 120, 300, 1),
      routerNode("client3", "CLIENT3", 120, 510, 1),
      routerNode("rr", "RR", 480, 300, 4),
      routerNode("edge", "EDGE", 840, 300, 1),
    ],
    links: [
      { id: "client1-rr", a: { node: "client1", iface: "Gi0/0" }, b: { node: "rr", iface: "Gi0/0" } },
      { id: "client2-rr", a: { node: "client2", iface: "Gi0/0" }, b: { node: "rr", iface: "Gi0/1" } },
      { id: "client3-rr", a: { node: "client3", iface: "Gi0/0" }, b: { node: "rr", iface: "Gi0/2" } },
      { id: "rr-edge", a: { node: "rr", iface: "Gi0/3" }, b: { node: "edge", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    client1: routerConfig("CLIENT1", ["10.0.1.2/30"], {
      localAs: 65_000, routerId: "1.1.1.1",
      neighbors: [{ address: "10.0.1.1", remoteAs: 65_000, enabled: true }],
      networks: [{ network: "172.16.1.0", prefixLength: 24 }],
    }, { loopback: "172.16.1.1" }),
    client2: routerConfig("CLIENT2", ["10.0.2.2/30"], {
      localAs: 65_000, routerId: "2.2.2.2",
      neighbors: [{ address: "10.0.2.1", remoteAs: 65_000, enabled: true }],
      networks: [{ network: "172.16.2.0", prefixLength: 24 }],
    }, { loopback: "172.16.2.1" }),
    client3: routerConfig("CLIENT3", ["10.0.3.2/30"], {
      localAs: 65_000, routerId: "3.3.3.3",
      neighbors: [{ address: "10.0.3.1", remoteAs: 65_000, enabled: true }],
      networks: [{ network: "172.16.3.0", prefixLength: 24 }],
    }, { loopback: "172.16.3.1" }),
    rr: routerConfig("RR", ["10.0.1.1/30", "10.0.2.1/30", "10.0.3.1/30", "10.0.4.1/30"], {
      localAs: 65_000, routerId: "10.255.0.1", clusterId: "10.255.0.1",
      neighbors: [
        { address: "10.0.1.2", remoteAs: 65_000, enabled: true, routeReflectorClient: true },
        { address: "10.0.2.2", remoteAs: 65_000, enabled: true, routeReflectorClient: true },
        { address: "10.0.3.2", remoteAs: 65_000, enabled: true, routeReflectorClient: true },
        { address: "10.0.4.2", remoteAs: 65_000, enabled: true },
      ],
      networks: [],
    }),
    edge: routerConfig("EDGE", ["10.0.4.2/30"], {
      localAs: 65_000, routerId: "10.255.0.2",
      neighbors: [{ address: "10.0.4.1", remoteAs: 65_000, enabled: true }],
      networks: [],
    }),
  },
};

/**
 * M10.12 BGP communities: a customer tags its prefixes, the provider acts on
 * the tag with a community list, and `no-export` keeps one prefix inside the
 * provider AS.
 */
export const BGP_COMMUNITIES_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "bgp-communities",
  title: "BGP Communities",
  description: "A customer tags routes with standard communities; the provider filters and re-prices them before the upstream sees anything.",
  expectedOutcome: "PROVIDER raises local preference for 65000:100, and the no-export prefix never reaches UPSTREAM.",
  instructions: instructions([
    "Objective: tag routes at the customer edge and act on the tag inside the provider AS.",
    "AS numbers: CUSTOMER 65001; PROVIDER 65000; UPSTREAM 65002.",
    "Addressing: customer link 10.0.1.0/30; upstream link 10.0.3.0/30; customer prefixes 198.51.100.0/24 (tagged 65000:100) and 198.51.101.0/24 (tagged no-export).",
    "Policy table: CUSTOMER route-map TAG-OUT sets the community; PROVIDER community-list CUSTOMER-ROUTES matches 65000:100 and route-map CUSTOMER-IN sets local preference 250; send-community is on for the customer and upstream sessions.",
    "Required CLI: show ip community-list; show ip bgp community 65000:100; show ip bgp neighbors 10.0.3.2 advertised-routes.",
    "Expected BGP table: PROVIDER shows 198.51.100.0/24 with local preference 250; UPSTREAM never receives 198.51.101.0/24.",
    "Troubleshooting: without 'neighbor <a> send-community' the attribute never leaves the device, so the receiving policy can never match it.",
  ]),
  simulation: { seed: 10_121 },
  topology: {
    schemaVersion: 1,
    nodes: [
      routerNode("customer", "CUSTOMER", 120, 260, 1),
      routerNode("provider", "PROVIDER", 470, 260, 2),
      routerNode("upstream", "UPSTREAM", 830, 260, 1),
    ],
    links: [
      { id: "customer-provider", a: { node: "customer", iface: "Gi0/0" }, b: { node: "provider", iface: "Gi0/0" } },
      { id: "provider-upstream", a: { node: "provider", iface: "Gi0/1" }, b: { node: "upstream", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    customer: routerConfig("CUSTOMER", ["10.0.1.1/30"], {
      localAs: 65_001, routerId: "1.1.1.1",
      neighbors: [{ address: "10.0.1.2", remoteAs: 65_000, enabled: true, sendCommunityStandard: true, routeMapOut: "TAG-OUT" }],
      networks: [
        { network: "198.51.100.0", prefixLength: 24 },
        { network: "198.51.101.0", prefixLength: 24 },
      ],
    }, {
      loopbacks: [{ id: 0, address: "198.51.100.1" }, { id: 1, address: "198.51.101.1" }],
      prefixLists: [{ id: "PUBLIC", entries: [{ sequence: 10, action: "permit", prefix: "198.51.100.0", prefixLength: 24 }] }],
      routeMaps: [{
        id: "TAG-OUT",
        sequences: [
          { sequence: 10, action: "permit", match: { prefixListIds: ["PUBLIC"] }, set: { communities: ["65000:100"] } },
          { sequence: 20, action: "permit", set: { communities: ["no-export"] } },
        ],
      }],
    }),
    provider: routerConfig("PROVIDER", ["10.0.1.2/30", "10.0.3.1/30"], {
      localAs: 65_000, routerId: "2.2.2.2",
      neighbors: [
        { address: "10.0.1.1", remoteAs: 65_001, enabled: true, sendCommunityStandard: true, routeMapIn: "CUSTOMER-IN" },
        { address: "10.0.3.2", remoteAs: 65_002, enabled: true, sendCommunityStandard: true },
      ],
      networks: [],
    }, {
      communityLists: [{ id: "CUSTOMER-ROUTES", entries: [{ sequence: 10, action: "permit", communities: ["65000:100"] }] }],
      routeMaps: [{
        id: "CUSTOMER-IN",
        sequences: [
          { sequence: 10, action: "permit", match: { communityListIds: ["CUSTOMER-ROUTES"] }, set: { localPreference: 250 } },
          { sequence: 20, action: "permit" },
        ],
      }],
    }),
    upstream: routerConfig("UPSTREAM", ["10.0.3.2/30"], {
      localAs: 65_002, routerId: "3.3.3.3",
      neighbors: [{ address: "10.0.3.1", remoteAs: 65_000, enabled: true }],
      networks: [],
    }),
  },
};

/**
 * M10.12 aggregation and advanced policy: one edge summarizes three site
 * prefixes to two upstreams, filters transit with an AS-path list, prepends
 * towards the backup and originates a default only towards ISP1.
 */
export const BGP_AGGREGATION_POLICY_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "bgp-aggregation-advanced-policy",
  title: "Aggregation and Advanced Policy",
  description: "One edge router summarizes three site prefixes, suppresses the specifics, prepends towards the backup ISP and originates a default.",
  expectedOutcome: "Both ISPs see only 10.20.0.0/16; ISP2's copy carries a longer AS path and only ISP1 receives 0.0.0.0/0.",
  instructions: instructions([
    "Objective: summarize with aggregate-address, suppress the more-specific routes and steer traffic with an AS-path list and a prepend.",
    "AS numbers: EDGE 65000; ISP1 65100; ISP2 65200.",
    "Addressing: ISP1 link 192.0.2.0/30; ISP2 link 198.51.100.0/30; site prefixes 10.20.1.0/24, 10.20.2.0/24 and 10.20.3.0/24 inside 10.20.0.0/16.",
    "Policy table: aggregate-address 10.20.0.0 255.255.0.0 summary-only; AS-path list NO-TRANSIT denies _65100_ inbound from ISP2; route-map BACKUP-OUT prepends 65000 twice towards ISP2; neighbor 192.0.2.2 default-originate.",
    "Required CLI: show ip bgp 10.20.0.0/16; show ip bgp suppressed-paths; show ip as-path-access-list; clear ip bgp 192.0.2.2 soft out.",
    "Expected BGP table: EDGE keeps all three /24s in its Loc-RIB while advertising only the /16; ISP1 also receives 0.0.0.0/0.",
    "Troubleshooting: an aggregate needs at least one contributing route, summary-only hides advertisements and never the local table, and a soft clear reevaluates policy without resetting TCP.",
  ]),
  simulation: { seed: 10_122 },
  topology: {
    schemaVersion: 1,
    nodes: [
      routerNode("edge", "EDGE", 470, 340, 2),
      routerNode("isp1", "ISP1", 180, 110, 1),
      routerNode("isp2", "ISP2", 760, 110, 1),
    ],
    links: [
      { id: "edge-isp1", a: { node: "edge", iface: "Gi0/0" }, b: { node: "isp1", iface: "Gi0/0" } },
      { id: "edge-isp2", a: { node: "edge", iface: "Gi0/1" }, b: { node: "isp2", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    edge: routerConfig("EDGE", ["192.0.2.1/30", "198.51.100.1/30"], {
      localAs: 65_000, routerId: "10.0.0.1",
      neighbors: [
        { address: "192.0.2.2", remoteAs: 65_100, enabled: true, defaultOriginate: true },
        { address: "198.51.100.2", remoteAs: 65_200, enabled: true, routeMapIn: "NO-TRANSIT-IN", routeMapOut: "BACKUP-OUT" },
      ],
      networks: [
        { network: "10.20.1.0", prefixLength: 24 },
        { network: "10.20.2.0", prefixLength: 24 },
        { network: "10.20.3.0", prefixLength: 24 },
      ],
      aggregates: [{ prefix: "10.20.0.0", prefixLength: 16, summaryOnly: true }],
    }, {
      loopbacks: [
        { id: 0, address: "10.20.1.1" },
        { id: 1, address: "10.20.2.1" },
        { id: 2, address: "10.20.3.1" },
      ],
      asPathLists: [{ id: "NO-TRANSIT", entries: [{ sequence: 10, action: "permit", matcher: { kind: "contains", asn: 65_100 } }] }],
      routeMaps: [
        {
          id: "NO-TRANSIT-IN",
          sequences: [
            { sequence: 10, action: "deny", match: { asPathListIds: ["NO-TRANSIT"] } },
            { sequence: 20, action: "permit" },
          ],
        },
        { id: "BACKUP-OUT", sequences: [{ sequence: 10, action: "permit", set: { prependAsns: [65_000, 65_000] } }] },
      ],
    }),
    isp1: routerConfig("ISP1", ["192.0.2.2/30"], {
      localAs: 65_100, routerId: "10.0.1.1",
      neighbors: [{ address: "192.0.2.1", remoteAs: 65_000, enabled: true }],
      networks: [{ network: "203.0.113.0", prefixLength: 24 }],
    }, { loopback: "203.0.113.1" }),
    isp2: routerConfig("ISP2", ["198.51.100.2/30"], {
      localAs: 65_200, routerId: "10.0.2.1",
      neighbors: [{ address: "198.51.100.1", remoteAs: 65_000, enabled: true }],
      networks: [],
    }),
  },
};

export const BGP_DEMO_LABS = [
  EBGP_BASIC_DEMO,
  DUAL_ISP_BEST_PATH_DEMO,
  IBGP_POLICY_DEMO,
  IBGP_ROUTE_REFLECTOR_DEMO,
  BGP_COMMUNITIES_DEMO,
  BGP_AGGREGATION_POLICY_DEMO,
] as const;

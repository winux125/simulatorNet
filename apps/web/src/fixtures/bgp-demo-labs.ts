import type { BgpProcessConfig, LabDocument, PrefixListConfig, RouteMapConfig } from "@sim/contracts";

const routerNode = (id: string, name: string, x: number, y: number, ports: number) => ({
  id, kind: "router" as const, name, position: { x, y },
  interfaces: Array.from({ length: ports }, (_, index) => ({ id: `Gi0/${index}` })),
});

const routerConfig = (
  hostname: string,
  addresses: readonly string[],
  bgp: BgpProcessConfig,
  options: { loopback?: string; prefixLists?: PrefixListConfig[]; routeMaps?: RouteMapConfig[] } = {},
) => ({
  kind: "router" as const,
  hostname,
  interfaces: addresses.map((address, index) => ({
    id: `Gi0/${index}`, routed: true, shutdown: false,
    ipv4: { address: address.split("/")[0]!, prefixLength: Number(address.split("/")[1]) },
  })),
  subinterfaces: [], staticRoutes: [], dhcpPools: [], acls: [], aclBindings: [],
  natPools: [], natRules: [], natInterfaceRoles: [],
  loopbacks: options.loopback ? [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 24 } }] : [],
  prefixLists: options.prefixLists ?? [], routeMaps: options.routeMaps ?? [], bgp,
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

export const BGP_DEMO_LABS = [EBGP_BASIC_DEMO, DUAL_ISP_BEST_PATH_DEMO, IBGP_POLICY_DEMO] as const;

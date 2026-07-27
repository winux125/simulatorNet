import type { LabDocument } from "@sim/contracts";

const switchPorts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `Gi0/${index + 1}` }));
const routerPorts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `Gi0/${index}` }));

export const IPV6_STATIC_LAN_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "ipv6-static-lan",
  title: "IPv6 Static LAN",
  description: "Two statically addressed IPv6 hosts communicate through an L2 switch.",
  instructions: "Start the lab, open PC1, and run ping -6 2001:db8:10::20. Inspect NDP in ipconfig /all and Packet Trace.",
  expectedOutcome: "PC1 resolves PC2 with NDP and receives ICMPv6 echo replies without a router.",
  simulation: { seed: 10_511 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc1", kind: "pc", name: "PC1", position: { x: 100, y: 220 }, interfaces: [{ id: "eth0" }] },
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 360, y: 220 }, interfaces: switchPorts(2) },
      { id: "pc2", kind: "pc", name: "PC2", position: { x: 620, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "pc1-sw1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
      { id: "pc2-sw1", a: { node: "pc2", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/2" } },
    ],
  },
  configurations: {
    pc1: { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false, ipv6: { mode: "static", address: "2001:db8:10::10", prefixLength: 64 } },
    sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] },
    pc2: { kind: "pc", hostname: "PC2", interfaces: [], dhcpEnabled: false, ipv6: { mode: "static", address: "2001:db8:10::20", prefixLength: 64 } },
  },
};

export const SLAAC_RA_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "ipv6-slaac-ra",
  title: "SLAAC and Router Advertisement",
  description: "A router advertises an IPv6 /64 and a default route to two hosts.",
  instructions: "Start the lab and inspect PC1/PC2 IPv6 configuration. Step through Router Solicitation, Router Advertisement and DAD.",
  expectedOutcome: "Both PCs derive deterministic global addresses and install R1 as their default router.",
  simulation: { seed: 10_512 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "r1", kind: "router", name: "R1", position: { x: 360, y: 80 }, interfaces: routerPorts(1) },
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 360, y: 260 }, interfaces: switchPorts(3) },
      { id: "pc1", kind: "pc", name: "PC1", position: { x: 140, y: 420 }, interfaces: [{ id: "eth0" }] },
      { id: "pc2", kind: "pc", name: "PC2", position: { x: 580, y: 420 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "r1-sw1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "sw1", iface: "Gi0/1" } },
      { id: "pc1-sw1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/2" } },
      { id: "pc2-sw1", a: { node: "pc2", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/3" } },
    ],
  },
  configurations: {
    r1: {
      kind: "router",
      hostname: "R1",
      interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv6: [{ address: "2001:db8:20::1", prefixLength: 64 }] }],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      acls: [],
      aclBindings: [],
      natPools: [],
      natRules: [],
      natInterfaceRoles: [],
      ipv6UnicastRoutingEnabled: true,
      routerAdvertisements: [{
        interfaceName: "Gi0/0",
        managed: false,
        otherConfiguration: false,
        routerLifetimeSeconds: 1_800,
        dnsServers: [],
        prefixes: [{
          prefix: "2001:db8:20::",
          prefixLength: 64,
          autonomous: true,
          onLink: true,
          validLifetimeSeconds: 7_200,
          preferredLifetimeSeconds: 3_600,
        }],
      }],
    },
    sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] },
    pc1: { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false, ipv6: { mode: "slaac" } },
    pc2: { kind: "pc", hostname: "PC2", interfaces: [], dhcpEnabled: false, ipv6: { mode: "slaac" } },
  },
} as unknown as LabDocument;

export const DHCPV6_DNS_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "ipv6-dhcpv6-dns",
  title: "DHCPv6 and DNS AAAA",
  description: "A server assigns IPv6 addresses and serves DNS AAAA plus HTTP over the same transport stack.",
  instructions: "Start the lab, renew DHCPv6 on PC1, run nslookup portal6.lab, then sim http get http://[2001:db8:30::10]/.",
  expectedOutcome: "PC1 receives a DHCPv6 address and DNS server, resolves an AAAA record, and loads HTTP over IPv6.",
  simulation: { seed: 10_513 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc1", kind: "pc", name: "PC1", position: { x: 100, y: 220 }, interfaces: [{ id: "eth0" }] },
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 360, y: 220 }, interfaces: switchPorts(2) },
      { id: "srv1", kind: "server", name: "SRV1", position: { x: 620, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "pc1-sw1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
      { id: "srv1-sw1", a: { node: "srv1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/2" } },
    ],
  },
  configurations: {
    pc1: { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false, ipv6: { mode: "dhcpv6" } },
    sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] },
    srv1: {
      kind: "server",
      hostname: "SRV1",
      interfaces: [],
      dhcpClientEnabled: false,
      ipv6: { mode: "static", address: "2001:db8:30::10", prefixLength: 64 },
      dhcpv6Pools: [{
        id: "LAN6",
        prefix: "2001:db8:30::",
        prefixLength: 64,
        rangeStart: "2001:db8:30::100",
        rangeEnd: "2001:db8:30::1ff",
        dnsServers: ["2001:db8:30::10"],
        preferredLifetimeSeconds: 3_600,
        validLifetimeSeconds: 7_200,
      }],
      enabledServices: [
        { id: "dns6", type: "dns", enabled: true, port: 53, records: [{ name: "portal6.lab", address: "2001:db8:30::10", recordType: "AAAA" }] },
        { id: "http6", type: "http", enabled: true, port: 80, resources: [{ path: "/", contentType: "text/plain", body: "SimulatorNet IPv6" }] },
      ],
    },
  },
} as unknown as LabDocument;

const ospfv3Router = (
  hostname: string,
  routerId: string,
  interfaces: Array<{ id: string; address: string; prefixLength: number }>,
  passiveInterfaces: string[] = [],
) => ({
  kind: "router",
  hostname,
  interfaces: interfaces.map((iface) => ({
    id: iface.id,
    routed: true,
    shutdown: false,
    ipv6: [{ address: iface.address, prefixLength: iface.prefixLength }],
  })),
  subinterfaces: [],
  staticRoutes: [],
  dhcpPools: [],
  acls: [],
  aclBindings: [],
  natPools: [],
  natRules: [],
  natInterfaceRoles: [],
  ipv6UnicastRoutingEnabled: true,
  ospfv3: {
    processId: 1,
    routerId,
    passiveInterfaces,
    interfaces: interfaces.map((iface) => ({ interfaceId: iface.id, area: 0, enabled: true, cost: 10 })),
  },
});

export const OSPFV3_ACL_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "ipv6-ospfv3-acl",
  title: "OSPFv3 and IPv6 ACL",
  description: "Three routers exchange IPv6 prefixes while an egress ACL permits HTTP and denies other application traffic.",
  instructions: "Inspect show ipv6 ospf neighbor and show ipv6 route. Fail the R2-R3 link to watch reconvergence, then inspect WEB6 counters.",
  expectedOutcome: "OSPFv3 forms Full adjacencies, installs remote prefixes, and WEB6 permits HTTP while denying unmatched traffic.",
  simulation: { seed: 10_514 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc1", kind: "pc", name: "PC1", position: { x: 20, y: 250 }, interfaces: [{ id: "eth0" }] },
      { id: "r1", kind: "router", name: "R1", position: { x: 230, y: 250 }, interfaces: routerPorts(2) },
      { id: "r2", kind: "router", name: "R2", position: { x: 470, y: 250 }, interfaces: routerPorts(2) },
      { id: "r3", kind: "router", name: "R3", position: { x: 710, y: 250 }, interfaces: routerPorts(2) },
      { id: "srv1", kind: "server", name: "WEB6", position: { x: 940, y: 250 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "pc1-r1", a: { node: "pc1", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
      { id: "r1-r2", a: { node: "r1", iface: "Gi0/1" }, b: { node: "r2", iface: "Gi0/0" } },
      { id: "r2-r3", a: { node: "r2", iface: "Gi0/1" }, b: { node: "r3", iface: "Gi0/0" } },
      { id: "r3-srv1", a: { node: "r3", iface: "Gi0/1" }, b: { node: "srv1", iface: "eth0" } },
    ],
  },
  configurations: {
    pc1: { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false, ipv6: { mode: "static", address: "2001:db8:101::10", prefixLength: 64, defaultRouter: "2001:db8:101::1" } },
    r1: ospfv3Router("R1", "1.1.1.1", [
      { id: "Gi0/0", address: "2001:db8:101::1", prefixLength: 64 },
      { id: "Gi0/1", address: "2001:db8:12::1", prefixLength: 64 },
    ], ["Gi0/0"]),
    r2: ospfv3Router("R2", "2.2.2.2", [
      { id: "Gi0/0", address: "2001:db8:12::2", prefixLength: 64 },
      { id: "Gi0/1", address: "2001:db8:23::2", prefixLength: 64 },
    ]),
    r3: {
      ...ospfv3Router("R3", "3.3.3.3", [
        { id: "Gi0/0", address: "2001:db8:23::3", prefixLength: 64 },
        { id: "Gi0/1", address: "2001:db8:103::1", prefixLength: 64 },
      ], ["Gi0/1"]),
      ipv6Acls: [{
        id: "WEB6",
        type: "ipv6",
        rules: [
          { sequence: 5, action: "permit", protocol: 58, source: { kind: "any" }, destination: { kind: "any" } },
          { sequence: 10, action: "permit", protocol: 6, source: { kind: "prefix", address: "2001:db8:101::", prefixLength: 64 }, destination: { kind: "host", address: "2001:db8:103::10" }, destinationPort: { kind: "eq", port: 80 } },
          { sequence: 20, action: "deny", protocol: "ipv6", source: { kind: "any" }, destination: { kind: "any" } },
        ],
      }],
      ipv6AclBindings: [{ interfaceName: "Gi0/1", direction: "out", aclId: "WEB6" }],
    },
    srv1: {
      kind: "server",
      hostname: "WEB6",
      interfaces: [],
      dhcpClientEnabled: false,
      ipv6: { mode: "static", address: "2001:db8:103::10", prefixLength: 64, defaultRouter: "2001:db8:103::1" },
      enabledServices: [{ id: "http6", type: "http", enabled: true, port: 80, resources: [{ path: "/", contentType: "text/plain", body: "OSPFv3 reached WEB6" }] }],
    },
  },
} as unknown as LabDocument;

export const IPV6_DEMO_LABS = [
  IPV6_STATIC_LAN_DEMO,
  SLAAC_RA_DEMO,
  DHCPV6_DNS_DEMO,
  OSPFV3_ACL_DEMO,
] as const;

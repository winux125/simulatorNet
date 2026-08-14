import type { LabDocument } from "@sim/contracts";
import { DEMO_LAB } from "./demo-lab";
import { PROTOCOL_DEMO_LABS } from "./protocol-demo-labs";
import { IPV6_DEMO_LABS } from "./ipv6-demo-labs";
import { SECURITY_DEMO_LABS } from "./security-demo-labs";
import { WIRELESS_DEMO_LABS } from "./wireless-demo-labs";
import { MANAGEMENT_DEMO_LABS } from "./management-demo-labs";
import { QOS_DEMO_LABS } from "./qos-demo-labs";
import { VPN_DEMO_LABS } from "./vpn-demo-labs";
import { BGP_DEMO_LABS } from "./bgp-demo-labs";
import { MPLS_DEMO_LABS } from "./mpls-demo-labs";
import { MBGP_IPV6_DEMO_LABS } from "./mbgp-ipv6-demo-labs";
import { VXLAN_EVPN_DEMO_LABS } from "./vxlan-evpn-demo-labs";
import { ROUTED_EVPN_DEMO_LABS } from "./routed-evpn-demo-labs";
import { EVPN_MULTIHOMING_DEMO_LABS } from "./evpn-multihoming-demo-labs";
import { EVPN_ALL_ACTIVE_DEMO_LABS } from "./evpn-all-active-demo-labs";
import { ALL_DEVICES_ICON_DEMO } from "./icon-profile-demo";

function ports(prefix: string, count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}` }));
}

export const HUB_ETHERNET_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-hub-ethernet",
  title: "Hub Ethernet Basics",
  description: "Observe a shared Ethernet segment as the hub repeats every frame.",
  simulation: { seed: 10_101 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-1", kind: "pc", name: "PC1", position: { x: 90, y: 130 }, interfaces: [{ id: "eth0" }] },
      { id: "hub-1", kind: "hub", name: "HUB1", position: { x: 390, y: 220 }, interfaces: ports("Eth0/", 8) },
      { id: "pc-2", kind: "pc", name: "PC2", position: { x: 700, y: 310 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "hub-1", iface: "Eth0/1" } },
      { id: "link-2", a: { node: "hub-1", iface: "Eth0/2" }, b: { node: "pc-2", iface: "eth0" } },
    ],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], ipv4: { address: "192.168.10.10", prefixLength: 24 }, dhcpEnabled: false },
    "hub-1": { kind: "hub", hostname: "HUB1", interfaces: [] },
    "pc-2": { kind: "pc", hostname: "PC2", interfaces: [], ipv4: { address: "192.168.10.20", prefixLength: 24 }, dhcpEnabled: false },
  },
};

export const BRIDGE_MAC_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-bridge-mac",
  title: "Bridge MAC Learning",
  description: "Generate traffic and inspect deterministic two-port bridge learning.",
  simulation: { seed: 10_102 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-1", kind: "pc", name: "PC1", position: { x: 80, y: 220 }, interfaces: [{ id: "eth0" }] },
      { id: "bridge-1", kind: "bridge", name: "BR1", position: { x: 390, y: 220 }, interfaces: [{ id: "Eth0/1" }, { id: "Eth0/2" }] },
      { id: "pc-2", kind: "pc", name: "PC2", position: { x: 710, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "bridge-1", iface: "Eth0/1" } },
      { id: "link-2", a: { node: "bridge-1", iface: "Eth0/2" }, b: { node: "pc-2", iface: "eth0" } },
    ],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], ipv4: { address: "192.168.30.10", prefixLength: 24 }, dhcpEnabled: false },
    "bridge-1": { kind: "bridge", hostname: "BR1", interfaces: [], agingTimeNs: 300_000_000_000 },
    "pc-2": { kind: "pc", hostname: "PC2", interfaces: [], ipv4: { address: "192.168.30.20", prefixLength: 24 }, dhcpEnabled: false },
  },
};

export const L3_SWITCH_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-l3-switch-routing",
  title: "L3 Switch Inter-VLAN Routing",
  description: "Configure access ports and SVIs, enable IP routing, then verify inter-VLAN reachability.",
  simulation: { seed: 10_103 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-1", kind: "pc", name: "PC1", position: { x: 80, y: 120 }, interfaces: [{ id: "eth0" }] },
      { id: "l3-switch-1", kind: "l3-switch", name: "DSW1", position: { x: 410, y: 220 }, interfaces: ports("Gi0/", 8) },
      { id: "pc-2", kind: "pc", name: "PC2", position: { x: 740, y: 320 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "l3-switch-1", iface: "Gi0/1" } },
      { id: "link-2", a: { node: "l3-switch-1", iface: "Gi0/2" }, b: { node: "pc-2", iface: "eth0" } },
    ],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], ipv4: { address: "192.168.10.10", prefixLength: 24, defaultGateway: "192.168.10.1" }, dhcpEnabled: false },
    "l3-switch-1": {
      kind: "l3-switch",
      hostname: "DSW1",
      vlans: [{ id: 10, name: "USERS" }, { id: 20, name: "SERVERS" }],
      interfaces: [
        { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
        { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 20, nativeVlan: 1 },
      ],
      svis: [
        { vlanId: 10, ipAddress: "192.168.10.1", prefixLength: 24, adminUp: true },
        { vlanId: 20, ipAddress: "192.168.20.1", prefixLength: 24, adminUp: true },
      ],
      staticRoutes: [],
      ipRoutingEnabled: true,
      acls: [],
      aclBindings: [],
    },
    "pc-2": { kind: "pc", hostname: "PC2", interfaces: [], ipv4: { address: "192.168.20.10", prefixLength: 24, defaultGateway: "192.168.20.1" }, dhcpEnabled: false },
  },
};

export const SERVER_CONNECTIVITY_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-server-connectivity",
  title: "Server Connectivity",
  description: "Verify IPv4 connectivity to a server end host; application services arrive in M10.2.",
  simulation: { seed: 10_104 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-1", kind: "pc", name: "PC1", position: { x: 80, y: 220 }, interfaces: [{ id: "eth0" }] },
      { id: "switch-1", kind: "l2-switch", name: "SW1", position: { x: 390, y: 220 }, interfaces: ports("Gi0/", 8) },
      { id: "server-1", kind: "server", name: "SRV1", position: { x: 720, y: 220 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
    ],
    links: [
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
      { id: "link-2", a: { node: "switch-1", iface: "Gi0/2" }, b: { node: "server-1", iface: "eth0" } },
    ],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], ipv4: { address: "172.16.10.10", prefixLength: 24 }, dhcpEnabled: false },
    "switch-1": { kind: "l2-switch", hostname: "SW1", interfaces: [], vlans: [] },
    "server-1": {
      kind: "server",
      hostname: "SRV1",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "172.16.10.100", prefixLength: 24 } }],
      dhcpClientEnabled: false,
      enabledServices: [],
    },
  },
};

function serviceDemo(
  id: string,
  title: string,
  description: string,
  seed: number,
  services: Extract<LabDocument["configurations"][string], { kind: "server" }>["enabledServices"],
): LabDocument {
  return {
    schemaVersion: 1,
    id,
    title,
    description,
    simulation: { seed },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc-1", kind: "pc", name: "PC1", position: { x: 80, y: 220 }, interfaces: [{ id: "eth0" }] },
        { id: "switch-1", kind: "l2-switch", name: "SW1", position: { x: 390, y: 220 }, interfaces: ports("Gi0/", 8) },
        { id: "server-1", kind: "server", name: "SRV1", position: { x: 720, y: 220 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
      ],
      links: [
        { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
        { id: "link-2", a: { node: "switch-1", iface: "Gi0/2" }, b: { node: "server-1", iface: "eth0" } },
      ],
    },
    configurations: {
      "pc-1": {
        kind: "pc",
        hostname: "PC1",
        interfaces: [],
        ipv4: { address: "172.20.10.20", prefixLength: 24 },
        dhcpEnabled: false,
        dnsServer: "172.20.10.10",
      },
      "switch-1": { kind: "l2-switch", hostname: "SW1", interfaces: [], vlans: [] },
      "server-1": {
        kind: "server",
        hostname: "SRV1",
        interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "172.20.10.10", prefixLength: 24 } }],
        dhcpClientEnabled: false,
        enabledServices: services,
      },
    },
  };
}

export const DNS_WEB_DEMO = serviceDemo(
  "demo-dns-web",
  "DNS + Web Services",
  "Resolve portal.lab and retrieve a deterministic HTTP resource over TCP.",
  10_105,
  [
    { id: "dns-main", type: "dns", enabled: true, port: 53, records: [{ name: "portal.lab", address: "172.20.10.10" }] },
    { id: "http-main", type: "http", enabled: true, port: 80, resources: [{ path: "/", contentType: "text/plain", body: "Welcome to SimulatorNet" }] },
  ],
);

export const TFTP_BACKUP_DEMO = serviceDemo(
  "demo-tftp-backup",
  "TFTP Configuration Backup",
  "Download a bounded read-only configuration file with RRQ, DATA, and ACK.",
  10_106,
  [{ id: "tftp-main", type: "tftp", enabled: true, port: 69, files: [{ filename: "branch-r1.cfg", content: "hostname BRANCH-R1\ninterface Gi0/0\n no shutdown\n" }] }],
);

export const NTP_SYSLOG_DEMO = serviceDemo(
  "demo-ntp-syslog",
  "NTP + Syslog Operations",
  "Query deterministic virtual time and send structured operational events.",
  10_107,
  [
    { id: "ntp-main", type: "ntp", enabled: true, port: 123, offsetNs: 3_600_000_000_000 },
    { id: "syslog-main", type: "syslog", enabled: true, port: 514, retention: 100 },
  ],
);

export const LARGE_TOPOLOGY_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-large-campus",
  title: "Large Campus Topology",
  description: "A dense multi-tier diagram for exploring visual profiles, port labels and annotations.",
  instructions: "Inspect the core, distribution and access layers. Diagram annotations do not affect simulation.",
  expectedOutcome: "The same topology identity is preserved while visual profiles change.",
  simulation: { seed: 10_108 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "router-1", kind: "router", name: "CORE-R1", position: { x: 450, y: 60 }, interfaces: ports("Gi0/", 4) },
      { id: "router-2", kind: "router", name: "CORE-R2", position: { x: 700, y: 60 }, interfaces: ports("Gi0/", 4) },
      { id: "l3-switch-1", kind: "l3-switch", name: "DIST-A", position: { x: 330, y: 230 }, interfaces: ports("Gi0/", 8) },
      { id: "l3-switch-2", kind: "l3-switch", name: "DIST-B", position: { x: 820, y: 230 }, interfaces: ports("Gi0/", 8) },
      { id: "switch-1", kind: "l2-switch", name: "ACCESS-A1", position: { x: 100, y: 410 }, interfaces: ports("Gi0/", 8) },
      { id: "switch-2", kind: "l2-switch", name: "ACCESS-A2", position: { x: 380, y: 410 }, interfaces: ports("Gi0/", 8) },
      { id: "switch-3", kind: "l2-switch", name: "ACCESS-B1", position: { x: 770, y: 410 }, interfaces: ports("Gi0/", 8) },
      { id: "switch-4", kind: "l2-switch", name: "ACCESS-B2", position: { x: 1050, y: 410 }, interfaces: ports("Gi0/", 8) },
      { id: "pc-1", kind: "pc", name: "ENG-PC1", position: { x: 70, y: 590 }, interfaces: [{ id: "eth0" }] },
      { id: "pc-2", kind: "pc", name: "ENG-PC2", position: { x: 350, y: 590 }, interfaces: [{ id: "eth0" }] },
      { id: "server-1", kind: "server", name: "LAB-SRV", position: { x: 570, y: 590 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
      { id: "pc-3", kind: "pc", name: "OPS-PC1", position: { x: 820, y: 590 }, interfaces: [{ id: "eth0" }] },
      { id: "pc-4", kind: "pc", name: "OPS-PC2", position: { x: 1100, y: 590 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "core-wan", a: { node: "router-1", iface: "Gi0/1" }, b: { node: "router-2", iface: "Gi0/1" } },
      { id: "core-a", a: { node: "router-1", iface: "Gi0/2" }, b: { node: "l3-switch-1", iface: "Gi0/1" } },
      { id: "core-b", a: { node: "router-2", iface: "Gi0/2" }, b: { node: "l3-switch-2", iface: "Gi0/1" } },
      { id: "dist-a1", a: { node: "l3-switch-1", iface: "Gi0/2" }, b: { node: "switch-1", iface: "Gi0/1" } },
      { id: "dist-a2", a: { node: "l3-switch-1", iface: "Gi0/3" }, b: { node: "switch-2", iface: "Gi0/1" } },
      { id: "dist-b1", a: { node: "l3-switch-2", iface: "Gi0/2" }, b: { node: "switch-3", iface: "Gi0/1" } },
      { id: "dist-b2", a: { node: "l3-switch-2", iface: "Gi0/3" }, b: { node: "switch-4", iface: "Gi0/1" } },
      { id: "edge-1", a: { node: "switch-1", iface: "Gi0/2" }, b: { node: "pc-1", iface: "eth0" } },
      { id: "edge-2", a: { node: "switch-2", iface: "Gi0/2" }, b: { node: "pc-2", iface: "eth0" } },
      { id: "server-edge", a: { node: "switch-2", iface: "Gi0/3" }, b: { node: "server-1", iface: "eth0" } },
      { id: "edge-3", a: { node: "switch-3", iface: "Gi0/2" }, b: { node: "pc-3", iface: "eth0" } },
      { id: "edge-4", a: { node: "switch-4", iface: "Gi0/2" }, b: { node: "pc-4", iface: "eth0" } },
    ],
  },
  configurations: {
    "router-1": {
      kind: "router", hostname: "CORE-R1", interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [],
      acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
    },
    "router-2": {
      kind: "router", hostname: "CORE-R2", interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [],
      acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
    },
    "l3-switch-1": {
      kind: "l3-switch", hostname: "DIST-A", interfaces: [], vlans: [], svis: [], staticRoutes: [],
      ipRoutingEnabled: false, acls: [], aclBindings: [],
    },
    "l3-switch-2": {
      kind: "l3-switch", hostname: "DIST-B", interfaces: [], vlans: [], svis: [], staticRoutes: [],
      ipRoutingEnabled: false, acls: [], aclBindings: [],
    },
    "switch-1": { kind: "l2-switch", hostname: "ACCESS-A1", interfaces: [], vlans: [] },
    "switch-2": { kind: "l2-switch", hostname: "ACCESS-A2", interfaces: [], vlans: [] },
    "switch-3": { kind: "l2-switch", hostname: "ACCESS-B1", interfaces: [], vlans: [] },
    "switch-4": { kind: "l2-switch", hostname: "ACCESS-B2", interfaces: [], vlans: [] },
    "pc-1": { kind: "pc", hostname: "ENG-PC1", interfaces: [], dhcpEnabled: false },
    "pc-2": { kind: "pc", hostname: "ENG-PC2", interfaces: [], dhcpEnabled: false },
    "pc-3": { kind: "pc", hostname: "OPS-PC1", interfaces: [], dhcpEnabled: false },
    "pc-4": { kind: "pc", hostname: "OPS-PC2", interfaces: [], dhcpEnabled: false },
    "server-1": { kind: "server", hostname: "LAB-SRV", interfaces: [], dhcpClientEnabled: false, enabledServices: [] },
  },
  diagram: {
    annotations: [
      {
        id: "campus-title",
        type: "text",
        position: { x: 520, y: 5 },
        width: 260,
        content: "Campus Core",
        fontSize: 18,
        bold: true,
        italic: false,
        alignment: "center",
        foreground: "auto",
        zIndex: 2,
        rotation: 0,
      },
    ],
    linkLabels: [
      { linkId: "core-wan", text: "WAN 10.0.0.0/31", position: 0.5, followLink: true, offset: -16, visible: true },
    ],
    linkStyles: [],
  },
};

export const DEMO_LABS = [
  { id: "router-on-a-stick", label: "Router-on-a-stick + DHCP", document: DEMO_LAB },
  { id: "all-device-icons", label: ALL_DEVICES_ICON_DEMO.title, document: ALL_DEVICES_ICON_DEMO },
  { id: "large-campus", label: LARGE_TOPOLOGY_DEMO.title, document: LARGE_TOPOLOGY_DEMO },
  { id: "hub-ethernet", label: HUB_ETHERNET_DEMO.title, document: HUB_ETHERNET_DEMO },
  { id: "bridge-mac", label: BRIDGE_MAC_DEMO.title, document: BRIDGE_MAC_DEMO },
  { id: "l3-switch", label: L3_SWITCH_DEMO.title, document: L3_SWITCH_DEMO },
  { id: "server-connectivity", label: SERVER_CONNECTIVITY_DEMO.title, document: SERVER_CONNECTIVITY_DEMO },
  { id: "dns-web", label: DNS_WEB_DEMO.title, document: DNS_WEB_DEMO },
  { id: "tftp-backup", label: TFTP_BACKUP_DEMO.title, document: TFTP_BACKUP_DEMO },
  { id: "ntp-syslog", label: NTP_SYSLOG_DEMO.title, document: NTP_SYSLOG_DEMO },
  ...SECURITY_DEMO_LABS,
  // M10.4 control protocols. Like every demo, they are only ever opened from
  // the Demo Labs dialog, never loaded automatically.
  ...PROTOCOL_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  ...IPV6_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  ...WIRELESS_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.7 management plane: remote CLI, AAA and SNMP.
  ...MANAGEMENT_DEMO_LABS.map((entry) => ({ id: entry.id, label: entry.title, document: entry.document })),
  // M10.8 deterministic quality of service.
  ...QOS_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.9 GRE tunnels and deterministic site-to-site IPsec.
  ...VPN_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.10 BGPv4 multi-AS routing; explicitly selected, never auto-loaded.
  ...BGP_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.11 deterministic MPLS, LDP and MP-BGP Layer 3 VPN.
  ...MPLS_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.13 MP-BGP IPv6 unicast and MPLS VPNv6.
  ...MBGP_IPV6_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.14 deterministic VXLAN and BGP EVPN Layer 2 overlays.
  ...VXLAN_EVPN_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.15 routed EVPN: distributed anycast gateway, L3VNI and symmetric IRB.
  ...ROUTED_EVPN_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.16 EVPN Single-Active multihoming: Ethernet Segments, DF and failover.
  ...EVPN_MULTIHOMING_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
  // M10.17 EVPN All-Active multihoming: aliasing, MAC mobility and HRW.
  ...EVPN_ALL_ACTIVE_DEMO_LABS.map((document) => ({ id: document.id, label: document.title, document })),
] as const;

export type DemoLabId = (typeof DEMO_LABS)[number]["id"];

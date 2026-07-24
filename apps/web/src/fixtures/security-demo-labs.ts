import { IpProtocol, type LabDocument } from "@sim/contracts";

const emptyNat = () => ({
  natPools: [],
  natRules: [],
  natInterfaceRoles: [],
});

export const STANDARD_ACL_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-standard-acl",
  title: "Standard ACL: Admin and Guest",
  description: "Objective: permit the Admin subnet and block the Guest subnet from the protected server network.",
  instructions: [
    "Addressing: ADMIN 10.10.10.10/24, GUEST 10.20.20.10/24, SERVER 172.16.0.10/24.",
    "Inspect ACL 10 on R1 Gi0/2 outbound. Test both sources and review ACL counters in Packet Trace.",
    "Troubleshooting hint: a standard ACL matches only the source address and ends with implicit deny.",
  ].join("\n"),
  expectedOutcome: "ADMIN reaches the protected network; GUEST is denied deterministically.",
  simulation: { seed: 10_301 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "admin", kind: "pc", name: "ADMIN", position: { x: 90, y: 90 }, interfaces: [{ id: "eth0" }] },
      { id: "guest", kind: "pc", name: "GUEST", position: { x: 90, y: 330 }, interfaces: [{ id: "eth0" }] },
      {
        id: "router",
        kind: "router",
        name: "R1",
        position: { x: 470, y: 210 },
        interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }],
      },
      { id: "server", kind: "server", name: "PROTECTED", position: { x: 840, y: 210 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "admin-r1", a: { node: "admin", iface: "eth0" }, b: { node: "router", iface: "Gi0/0" } },
      { id: "guest-r1", a: { node: "guest", iface: "eth0" }, b: { node: "router", iface: "Gi0/1" } },
      { id: "r1-server", a: { node: "router", iface: "Gi0/2" }, b: { node: "server", iface: "eth0" } },
    ],
  },
  configurations: {
    admin: {
      kind: "pc", hostname: "ADMIN", interfaces: [],
      ipv4: { address: "10.10.10.10", prefixLength: 24, defaultGateway: "10.10.10.1" }, dhcpEnabled: false,
    },
    guest: {
      kind: "pc", hostname: "GUEST", interfaces: [],
      ipv4: { address: "10.20.20.10", prefixLength: 24, defaultGateway: "10.20.20.1" }, dhcpEnabled: false,
    },
    router: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.10.10.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "10.20.20.1", prefixLength: 24 } },
        { id: "Gi0/2", shutdown: false, routed: true, ipv4: { address: "172.16.0.1", prefixLength: 24 } },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      acls: [{
        id: "10",
        type: "standard",
        rules: [
          { sequence: 10, action: "permit", source: { kind: "network", address: "10.10.10.0", wildcard: "0.0.0.255" } },
          { sequence: 20, action: "deny", source: { kind: "any" } },
        ],
      }],
      aclBindings: [{ interfaceName: "Gi0/2", direction: "out", aclId: "10" }],
      ...emptyNat(),
    },
    server: {
      kind: "server",
      hostname: "PROTECTED",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "172.16.0.10", prefixLength: 24 } }],
      defaultGateway: "172.16.0.1",
      dhcpClientEnabled: false,
      enabledServices: [],
    },
  },
};

export const EXTENDED_ACL_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-extended-acl",
  title: "Extended ACL: Web Only",
  description: "Objective: permit HTTP to the application server and deny other IPv4 traffic.",
  instructions: [
    "Addressing: CLIENT 192.168.10.10/24, WEB 203.0.113.10/24.",
    "ACL WEB permits TCP destination port 80, then denies all other IPv4.",
    "Troubleshooting hint: check rule order, destination address and outbound binding on R1 Gi0/1.",
  ].join("\n"),
  expectedOutcome: "HTTP is permitted; ICMP and other TCP destinations are denied.",
  simulation: { seed: 10_302 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "client", kind: "pc", name: "CLIENT", position: { x: 100, y: 220 }, interfaces: [{ id: "eth0" }] },
      { id: "router", kind: "router", name: "R1", position: { x: 470, y: 220 }, interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      { id: "web", kind: "server", name: "WEB", position: { x: 840, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "client-r1", a: { node: "client", iface: "eth0" }, b: { node: "router", iface: "Gi0/0" } },
      { id: "r1-web", a: { node: "router", iface: "Gi0/1" }, b: { node: "web", iface: "eth0" } },
    ],
  },
  configurations: {
    client: {
      kind: "pc", hostname: "CLIENT", interfaces: [],
      ipv4: { address: "192.168.10.10", prefixLength: 24, defaultGateway: "192.168.10.1" }, dhcpEnabled: false,
    },
    router: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "192.168.10.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.1", prefixLength: 24 } },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      acls: [{
        id: "WEB",
        type: "extended",
        rules: [
          {
            sequence: 10,
            action: "permit",
            protocol: IpProtocol.TCP,
            source: { kind: "any" },
            destination: { kind: "host", address: "203.0.113.10" },
            destinationPort: { kind: "eq", port: 80 },
          },
          {
            sequence: 20,
            action: "deny",
            protocol: "ip",
            source: { kind: "any" },
            destination: { kind: "any" },
          },
        ],
      }],
      aclBindings: [{ interfaceName: "Gi0/1", direction: "out", aclId: "WEB" }],
      ...emptyNat(),
    },
    web: {
      kind: "server",
      hostname: "WEB",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "203.0.113.10", prefixLength: 24 } }],
      defaultGateway: "203.0.113.1",
      dhcpClientEnabled: false,
      enabledServices: [{
        id: "http",
        type: "http",
        enabled: true,
        port: 80,
        resources: [{ path: "/", contentType: "text/plain", body: "ACL permitted this HTTP response." }],
      }],
    },
  },
};

export const PAT_INTERNET_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-pat-internet",
  title: "PAT Internet Access",
  description: "Objective: translate two private clients through one simulated public interface address.",
  instructions: [
    "Addressing: PC1 10.0.0.10/24, PC2 10.0.0.20/24, R1 outside 203.0.113.1/24.",
    "Generate traffic from both PCs and inspect distinct deterministic PAT tokens.",
    "Troubleshooting hint: verify ACL 10, inside/outside roles and the overload rule.",
  ].join("\n"),
  expectedOutcome: "Both private clients reach PUBLIC using distinct translations on 203.0.113.1.",
  simulation: { seed: 10_303 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc1", kind: "pc", name: "PC1", position: { x: 70, y: 100 }, interfaces: [{ id: "eth0" }] },
      { id: "pc2", kind: "pc", name: "PC2", position: { x: 70, y: 330 }, interfaces: [{ id: "eth0" }] },
      {
        id: "switch",
        kind: "l2-switch",
        name: "SW1",
        position: { x: 330, y: 210 },
        interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
      },
      { id: "router", kind: "router", name: "R1", position: { x: 600, y: 210 }, interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      { id: "public", kind: "server", name: "PUBLIC", position: { x: 920, y: 210 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "pc1-sw", a: { node: "pc1", iface: "eth0" }, b: { node: "switch", iface: "Gi0/1" } },
      { id: "pc2-sw", a: { node: "pc2", iface: "eth0" }, b: { node: "switch", iface: "Gi0/2" } },
      { id: "sw-r1", a: { node: "switch", iface: "Gi0/3" }, b: { node: "router", iface: "Gi0/0" } },
      { id: "r1-public", a: { node: "router", iface: "Gi0/1" }, b: { node: "public", iface: "eth0" } },
    ],
  },
  configurations: {
    pc1: {
      kind: "pc", hostname: "PC1", interfaces: [],
      ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" }, dhcpEnabled: false,
    },
    pc2: {
      kind: "pc", hostname: "PC2", interfaces: [],
      ipv4: { address: "10.0.0.20", prefixLength: 24, defaultGateway: "10.0.0.1" }, dhcpEnabled: false,
    },
    switch: { kind: "l2-switch", hostname: "SW1", interfaces: [], vlans: [] },
    router: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.1", prefixLength: 24 } },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      acls: [{
        id: "10",
        type: "standard",
        rules: [{ sequence: 10, action: "permit", source: { kind: "network", address: "10.0.0.0", wildcard: "0.0.0.255" } }],
      }],
      aclBindings: [],
      natPools: [],
      natRules: [{
        id: "PAT",
        sequence: 10,
        kind: "pat",
        source: { kind: "acl", aclId: "10" },
        outsideAddress: "interface",
      }],
      natInterfaceRoles: [
        { interfaceName: "Gi0/0", role: "inside" },
        { interfaceName: "Gi0/1", role: "outside" },
      ],
    },
    public: {
      kind: "server",
      hostname: "PUBLIC",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "203.0.113.10", prefixLength: 24 } }],
      defaultGateway: "203.0.113.1",
      dhcpClientEnabled: false,
      enabledServices: [],
    },
  },
};

export const DMZ_FIREWALL_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-dmz-firewall",
  title: "DMZ Stateful Firewall",
  description: "Objective: publish a DMZ web server while keeping unsolicited traffic away from inside.",
  instructions: [
    "Addressing: INSIDE 10.0.0.10/24, OUTSIDE 203.0.113.10/24, DMZ-WEB 172.16.0.10/24.",
    "Review inside/outside/dmz zones, ordered policies, static NAT and established return state.",
    "Troubleshooting hint: missing zone assignments are denied before a session is created.",
  ].join("\n"),
  expectedOutcome: "Permitted HTTP/inside sessions create state; unsolicited outside-to-inside traffic is denied.",
  simulation: { seed: 10_304 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "inside", kind: "pc", name: "INSIDE", position: { x: 80, y: 90 }, interfaces: [{ id: "eth0" }] },
      { id: "outside", kind: "pc", name: "OUTSIDE", position: { x: 80, y: 360 }, interfaces: [{ id: "eth0" }] },
      {
        id: "firewall",
        kind: "firewall",
        name: "FW1",
        position: { x: 470, y: 220 },
        interfaces: [{ id: "Eth0/0" }, { id: "Eth0/1" }, { id: "Eth0/2" }, { id: "Eth0/3" }],
      },
      { id: "dmz", kind: "server", name: "DMZ-WEB", position: { x: 860, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "inside-fw", a: { node: "inside", iface: "eth0" }, b: { node: "firewall", iface: "Eth0/0" } },
      { id: "outside-fw", a: { node: "outside", iface: "eth0" }, b: { node: "firewall", iface: "Eth0/1" } },
      { id: "fw-dmz", a: { node: "firewall", iface: "Eth0/2" }, b: { node: "dmz", iface: "eth0" } },
    ],
  },
  configurations: {
    inside: {
      kind: "pc", hostname: "INSIDE", interfaces: [],
      ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" }, dhcpEnabled: false,
    },
    outside: {
      kind: "pc", hostname: "OUTSIDE", interfaces: [],
      ipv4: { address: "203.0.113.10", prefixLength: 24, defaultGateway: "203.0.113.1" }, dhcpEnabled: false,
    },
    firewall: {
      kind: "firewall",
      hostname: "FW1",
      interfaces: [
        { id: "Eth0/0", shutdown: false, routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Eth0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.1", prefixLength: 24 } },
        { id: "Eth0/2", shutdown: false, routed: true, ipv4: { address: "172.16.0.1", prefixLength: 24 } },
        { id: "Eth0/3", shutdown: false, routed: false },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      acls: [],
      aclBindings: [],
      natPools: [],
      natRules: [{
        id: "DMZ-WEB",
        sequence: 10,
        kind: "static",
        insideLocal: "172.16.0.10",
        insideGlobal: "203.0.113.100",
      }],
      natInterfaceRoles: [
        { interfaceName: "Eth0/0", role: "inside" },
        { interfaceName: "Eth0/2", role: "inside" },
        { interfaceName: "Eth0/1", role: "outside" },
      ],
      zones: [
        { interfaceName: "Eth0/0", zone: "inside" },
        { interfaceName: "Eth0/1", zone: "outside" },
        { interfaceName: "Eth0/2", zone: "dmz" },
      ],
      firewallPolicies: [
        {
          id: "inside-out",
          sequence: 10,
          sourceZone: "inside",
          destinationZone: "outside",
          action: "permit",
          protocol: "ip",
        },
        {
          id: "outside-web",
          sequence: 20,
          sourceZone: "outside",
          destinationZone: "dmz",
          action: "permit",
          protocol: IpProtocol.TCP,
          destination: { kind: "host", address: "172.16.0.10" },
          destinationPort: { kind: "eq", port: 80 },
        },
      ],
      defaultPolicy: "deny",
    },
    dmz: {
      kind: "server",
      hostname: "DMZ-WEB",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "172.16.0.10", prefixLength: 24 } }],
      defaultGateway: "172.16.0.1",
      dhcpClientEnabled: false,
      enabledServices: [{
        id: "dmz-http",
        type: "http",
        enabled: true,
        port: 80,
        resources: [{ path: "/", contentType: "text/plain", body: "SimulatorNet DMZ" }],
      }],
    },
  },
};

export const PACKET_LOSS_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-cloud-packet-loss",
  title: "Packet Loss Troubleshooting",
  description: "Objective: measure a bounded ICMP flow across a simulated impaired provider network.",
  instructions: [
    "Addressing: TG1 10.0.0.10/24, ISP 10.0.0.1 + 198.51.100.1, TARGET 198.51.100.10.",
    "Run flow WAN-ICMP, compare Auto and Step, then filter Packet Trace by CLOUD and TRAFFIC.",
    "Troubleshooting hint: loss decisions are seeded and repeat exactly after rebuild.",
  ].join("\n"),
  expectedOutcome: "The finite flow completes with deterministic delay/loss counters and no real Internet access.",
  simulation: { seed: 10_305 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "tg", kind: "traffic-generator", name: "TG1", position: { x: 100, y: 220 }, interfaces: [{ id: "eth0" }] },
      {
        id: "cloud",
        kind: "cloud",
        name: "ISP1",
        position: { x: 480, y: 220 },
        interfaces: [{ id: "Eth0/0" }, { id: "Eth0/1" }, { id: "Eth0/2" }, { id: "Eth0/3" }],
      },
      { id: "target", kind: "server", name: "TARGET", position: { x: 860, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "tg-cloud", a: { node: "tg", iface: "eth0" }, b: { node: "cloud", iface: "Eth0/0" } },
      { id: "cloud-target", a: { node: "cloud", iface: "Eth0/1" }, b: { node: "target", iface: "eth0" } },
    ],
  },
  configurations: {
    tg: {
      kind: "traffic-generator",
      hostname: "TG1",
      interfaces: [],
      ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" },
      dhcpEnabled: false,
      flows: [{
        id: "WAN-ICMP",
        protocol: "icmp",
        destination: "198.51.100.10",
        count: 8,
        intervalNs: 10_000_000,
        payloadBytes: 64,
      }],
    },
    cloud: {
      kind: "cloud",
      hostname: "ISP1",
      interfaces: [
        { id: "Eth0/0", shutdown: false, routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Eth0/1", shutdown: false, routed: true, ipv4: { address: "198.51.100.1", prefixLength: 24 } },
        { id: "Eth0/2", shutdown: false, routed: false },
        { id: "Eth0/3", shutdown: false, routed: false },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      acls: [],
      aclBindings: [],
      ...emptyNat(),
      impairments: [
        {
          interfaceName: "Eth0/0",
          additionalLatencyNs: 5_000_000,
          packetLossRate: 0.25,
          note: "Seeded access-side loss",
        },
        {
          interfaceName: "Eth0/1",
          additionalLatencyNs: 15_000_000,
          packetLossRate: 0.25,
          note: "Seeded provider-side loss",
        },
      ],
    },
    target: {
      kind: "server",
      hostname: "TARGET",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "198.51.100.10", prefixLength: 24 } }],
      defaultGateway: "198.51.100.1",
      dhcpClientEnabled: false,
      enabledServices: [],
    },
  },
};

export const SECURITY_DEMO_LABS = [
  { id: "standard-acl", label: STANDARD_ACL_DEMO.title, document: STANDARD_ACL_DEMO },
  { id: "extended-acl", label: EXTENDED_ACL_DEMO.title, document: EXTENDED_ACL_DEMO },
  { id: "pat-internet", label: PAT_INTERNET_DEMO.title, document: PAT_INTERNET_DEMO },
  { id: "dmz-firewall", label: DMZ_FIREWALL_DEMO.title, document: DMZ_FIREWALL_DEMO },
  { id: "packet-loss", label: PACKET_LOSS_DEMO.title, document: PACKET_LOSS_DEMO },
] as const;

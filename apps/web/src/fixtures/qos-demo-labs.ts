import type { LabDocument } from "@sim/contracts";

/**
 * M10.8 Quality of Service demos.
 *
 * Like every demo they are only ever opened from the Demo Labs dialog, never
 * loaded automatically. Each one states its objective, addressing, traffic
 * classes, the CLI it expects, the expected result and troubleshooting hints.
 */

const emptyRoutedSecurity = () => ({
  acls: [],
  aclBindings: [],
  natPools: [],
  natRules: [],
  natInterfaceRoles: [],
});

export const DSCP_CLASSIFICATION_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-qos-dscp-classification",
  title: "QoS: DSCP Classification",
  description: "Objective: classify voice and web traffic on R1 and mark them EF and AF31.",
  instructions: [
    "Addressing: VOICE 10.0.10.10/24, WEB 10.0.20.10/24, SERVER 10.0.30.10/24, R1 .1 in each subnet.",
    "Traffic classes: REALTIME matches destination port 5060 or the 10.0.10.0/24 voice subnet;",
    "  WEB-CLASS matches destination port 80 or the 10.0.20.0/24 web subnet.",
    "Required CLI: class-map match-any REALTIME / match destination-port 5060 / match source 10.0.10.0 0.0.0.255;",
    "  policy-map EDGE-MARK; class REALTIME / set dscp ef; class WEB-CLASS / set dscp af31;",
    "  interface Gi0/2 / service-policy output EDGE-MARK.",
    "Expected result: Packet Trace filtered by Marking shows dscp 0→46 for voice and 0→26 for web.",
    "Troubleshooting hints: a class only matches on the interface its policy is attached to, and an",
    "  unmatched packet always falls to class-default — check `show policy-map interface` counters.",
  ].join("\n"),
  expectedOutcome: "Voice is marked EF (46) and web is marked AF31 (26) on the R1 egress interface.",
  simulation: { seed: 10_801 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "voice", kind: "pc", name: "VOICE", position: { x: 90, y: 100 }, interfaces: [{ id: "eth0" }] },
      { id: "web", kind: "pc", name: "WEB", position: { x: 90, y: 330 }, interfaces: [{ id: "eth0" }] },
      {
        id: "router",
        kind: "router",
        name: "R1",
        position: { x: 470, y: 215 },
        interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }],
      },
      { id: "server", kind: "server", name: "SERVER", position: { x: 860, y: 215 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "voice-r1", a: { node: "voice", iface: "eth0" }, b: { node: "router", iface: "Gi0/0" } },
      { id: "web-r1", a: { node: "web", iface: "eth0" }, b: { node: "router", iface: "Gi0/1" } },
      {
        id: "r1-server",
        a: { node: "router", iface: "Gi0/2" },
        b: { node: "server", iface: "eth0" },
        capacityBps: 10_000_000,
        queueLimitPackets: 64,
      },
    ],
  },
  configurations: {
    voice: {
      kind: "pc", hostname: "VOICE", interfaces: [],
      ipv4: { address: "10.0.10.10", prefixLength: 24, defaultGateway: "10.0.10.1" }, dhcpEnabled: false,
    },
    web: {
      kind: "pc", hostname: "WEB", interfaces: [],
      ipv4: { address: "10.0.20.10", prefixLength: 24, defaultGateway: "10.0.20.1" }, dhcpEnabled: false,
    },
    router: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.0.10.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "10.0.20.1", prefixLength: 24 } },
        { id: "Gi0/2", shutdown: false, routed: true, ipv4: { address: "10.0.30.1", prefixLength: 24 } },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      ...emptyRoutedSecurity(),
      qos: {
        classMaps: [
          {
            id: "REALTIME",
            matchType: "match-any",
            matches: [
              { kind: "destination-port", port: { kind: "eq", port: 5060 } },
              { kind: "source-prefix", ipv4: { kind: "network", address: "10.0.10.0", wildcard: "0.0.0.255" } },
            ],
          },
          {
            id: "WEB-CLASS",
            matchType: "match-any",
            matches: [
              { kind: "destination-port", port: { kind: "eq", port: 80 } },
              { kind: "source-prefix", ipv4: { kind: "network", address: "10.0.20.0", wildcard: "0.0.0.255" } },
            ],
          },
        ],
        policyMaps: [{
          id: "EDGE-MARK",
          classes: [
            { className: "REALTIME", marking: { dscp: 46 } },
            { className: "WEB-CLASS", marking: { dscp: 26 } },
            { className: "class-default", marking: { dscp: 0 } },
          ],
        }],
        servicePolicies: [{ interfaceName: "Gi0/2", direction: "output", policyMapId: "EDGE-MARK" }],
      },
    },
    server: {
      kind: "server",
      hostname: "SERVER",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.0.30.10", prefixLength: 24 } }],
      defaultGateway: "10.0.30.1",
      dhcpClientEnabled: false,
      enabledServices: [{
        id: "http",
        type: "http",
        enabled: true,
        port: 80,
        resources: [{ path: "/", contentType: "text/plain", body: "Marked AF31 by the edge policy." }],
      }],
    },
  },
};

export const VOICE_VS_BULK_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-qos-voice-vs-bulk",
  title: "QoS: Voice vs Bulk",
  description: "Objective: protect a voice flow from a large bulk transfer across a slow WAN link.",
  instructions: [
    "Addressing: TG-VOICE 10.0.10.10/24, TG-BULK 10.0.20.10/24, SERVER 10.0.30.10/24, R1 .1 in each subnet.",
    "Traffic classes: REALTIME matches UDP destination port 5060 and is a priority class capped at 30%;",
    "  class-default carries the bulk transfer with the remaining bandwidth.",
    "Required CLI: policy-map WAN-EDGE; class REALTIME / priority percent 30 / set dscp ef;",
    "  class class-default / bandwidth percent 60; interface Gi0/2 / service-policy output WAN-EDGE.",
    "Expected result: run BULK first and VOICE second — the voice flow still reports a lower average",
    "  virtual delay, and Packet Trace shows qos-priority-served ahead of qos-weighted-served.",
    "Troubleshooting hints: the WAN link is deliberately 1 Mbps, so the queue is what creates the delay.",
    "  Raise the link capacity in the link inspector and the difference shrinks — that is the point.",
  ].join("\n"),
  expectedOutcome: "The priority voice flow reports a lower average virtual delay than the bulk flow.",
  simulation: { seed: 10_802 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "tg-voice", kind: "traffic-generator", name: "TG-VOICE", position: { x: 90, y: 100 }, interfaces: [{ id: "eth0" }] },
      { id: "tg-bulk", kind: "traffic-generator", name: "TG-BULK", position: { x: 90, y: 330 }, interfaces: [{ id: "eth0" }] },
      {
        id: "router",
        kind: "router",
        name: "R1",
        position: { x: 470, y: 215 },
        interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }],
      },
      { id: "server", kind: "server", name: "SERVER", position: { x: 860, y: 215 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "voice-r1", a: { node: "tg-voice", iface: "eth0" }, b: { node: "router", iface: "Gi0/0" } },
      { id: "bulk-r1", a: { node: "tg-bulk", iface: "eth0" }, b: { node: "router", iface: "Gi0/1" } },
      {
        id: "r1-wan",
        a: { node: "router", iface: "Gi0/2" },
        b: { node: "server", iface: "eth0" },
        capacityBps: 1_000_000,
        queueLimitPackets: 128,
      },
    ],
  },
  configurations: {
    "tg-voice": {
      kind: "traffic-generator",
      hostname: "TG-VOICE",
      interfaces: [],
      ipv4: { address: "10.0.10.10", prefixLength: 24, defaultGateway: "10.0.10.1" },
      dhcpEnabled: false,
      flows: [{
        id: "VOICE",
        protocol: "udp",
        destination: "10.0.30.10",
        destinationPort: 5060,
        count: 12,
        intervalNs: 2_000_000,
        payloadBytes: 160,
        dscp: 46,
      }],
    },
    "tg-bulk": {
      kind: "traffic-generator",
      hostname: "TG-BULK",
      interfaces: [],
      ipv4: { address: "10.0.20.10", prefixLength: 24, defaultGateway: "10.0.20.1" },
      dhcpEnabled: false,
      flows: [{
        id: "BULK",
        protocol: "udp",
        destination: "10.0.30.10",
        destinationPort: 9000,
        count: 24,
        intervalNs: 1_000_000,
        payloadBytes: 1_400,
      }],
    },
    router: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.0.10.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "10.0.20.1", prefixLength: 24 } },
        { id: "Gi0/2", shutdown: false, routed: true, ipv4: { address: "10.0.30.1", prefixLength: 24 } },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      ...emptyRoutedSecurity(),
      qos: {
        classMaps: [{
          id: "REALTIME",
          matchType: "match-any",
          matches: [{ kind: "destination-port", port: { kind: "eq", port: 5060 } }],
        }],
        policyMaps: [{
          id: "WAN-EDGE",
          classes: [
            { className: "REALTIME", priority: { percent: 30 }, marking: { dscp: 46 } },
            { className: "class-default", bandwidthPercent: 60 },
          ],
        }],
        servicePolicies: [{ interfaceName: "Gi0/2", direction: "output", policyMapId: "WAN-EDGE" }],
      },
    },
    server: {
      kind: "server",
      hostname: "SERVER",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.0.30.10", prefixLength: 24 } }],
      defaultGateway: "10.0.30.1",
      dhcpClientEnabled: false,
      enabledServices: [],
    },
  },
};

export const POLICING_AND_SHAPING_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-qos-policing-shaping",
  title: "QoS: Guest Policing and WAN Shaping",
  description: "Objective: police guest traffic on ingress and shape the whole WAN egress.",
  instructions: [
    "Addressing: GUEST 10.0.40.10/24, SERVER 10.0.30.10/24, R1 10.0.40.1 and 10.0.30.1.",
    "Traffic classes: GUEST matches any IPv4 traffic arriving on Gi0/0; class-default is shaped on Gi0/1.",
    "Required CLI: class-map match-any GUEST / match any; policy-map GUEST-POLICE;",
    "  class GUEST / police 2000000 16000 conform-action transmit exceed-action drop;",
    "  policy-map WAN-SHAPE / class class-default / shape average 512000;",
    "  interface Gi0/0 / service-policy input GUEST-POLICE; interface Gi0/1 / service-policy output WAN-SHAPE.",
    "Expected result: run flow GUEST-BURST. Packet Trace shows qos-police-conform and",
    "  qos-police-dropped on ingress, and qos-shape-delayed / qos-shape-released on egress.",
    "Troubleshooting hints: a policer drops immediately and never delays; a shaper delays and only",
    "  drops once its queue is full. Compare the two in `show policy-map interface`.",
  ].join("\n"),
  expectedOutcome: "Excess guest traffic is policed away, and what survives leaves at the shaped rate.",
  simulation: { seed: 10_803 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "guest", kind: "traffic-generator", name: "GUEST", position: { x: 110, y: 215 }, interfaces: [{ id: "eth0" }] },
      {
        id: "router",
        kind: "router",
        name: "R1",
        position: { x: 480, y: 215 },
        interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }],
      },
      { id: "server", kind: "server", name: "SERVER", position: { x: 860, y: 215 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "guest-r1", a: { node: "guest", iface: "eth0" }, b: { node: "router", iface: "Gi0/0" } },
      {
        id: "r1-wan",
        a: { node: "router", iface: "Gi0/1" },
        b: { node: "server", iface: "eth0" },
        capacityBps: 4_000_000,
        queueLimitPackets: 256,
      },
    ],
  },
  configurations: {
    guest: {
      kind: "traffic-generator",
      hostname: "GUEST",
      interfaces: [],
      ipv4: { address: "10.0.40.10", prefixLength: 24, defaultGateway: "10.0.40.1" },
      dhcpEnabled: false,
      flows: [{
        id: "GUEST-BURST",
        protocol: "udp",
        destination: "10.0.30.10",
        destinationPort: 9000,
        count: 24,
        intervalNs: 1_000_000,
        payloadBytes: 1_400,
        dscp: 0,
      }],
    },
    router: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.0.40.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "10.0.30.1", prefixLength: 24 } },
      ],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [],
      ...emptyRoutedSecurity(),
      qos: {
        classMaps: [{ id: "GUEST", matchType: "match-any", matches: [{ kind: "any" }] }],
        policyMaps: [
          {
            id: "GUEST-POLICE",
            classes: [{
              className: "GUEST",
              police: { rateBps: 2_000_000, burstBytes: 16_000, exceedAction: "drop" },
            }],
          },
          {
            id: "WAN-SHAPE",
            classes: [{ className: "class-default", shape: { averageRateBps: 512_000, burstBytes: 3_000 } }],
          },
        ],
        servicePolicies: [
          { interfaceName: "Gi0/0", direction: "input", policyMapId: "GUEST-POLICE" },
          { interfaceName: "Gi0/1", direction: "output", policyMapId: "WAN-SHAPE" },
        ],
      },
    },
    server: {
      kind: "server",
      hostname: "SERVER",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.0.30.10", prefixLength: 24 } }],
      defaultGateway: "10.0.30.1",
      dhcpClientEnabled: false,
      enabledServices: [],
    },
  },
};

export const QOS_DEMO_LABS = [
  DSCP_CLASSIFICATION_DEMO,
  VOICE_VS_BULK_DEMO,
  POLICING_AND_SHAPING_DEMO,
] as const;

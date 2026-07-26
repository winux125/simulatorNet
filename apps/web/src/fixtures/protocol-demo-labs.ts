import type { LabDocument } from "@sim/contracts";

/**
 * M10.4 demo labs for the layer-2 control protocols, neighbour discovery and
 * OSPFv2. Every lab is explicitly loaded from the Demo Labs dialog — none of
 * them is opened automatically — and each one carries its objective, addressing
 * table, required configuration, expected result and troubleshooting hints in
 * its instructions so it can be worked through without any other material.
 */

interface DemoNarrative {
  readonly objective: string;
  readonly addressing: readonly string[];
  readonly required: readonly string[];
  readonly expected: readonly string[];
  readonly hints: readonly string[];
}

function instructions(narrative: DemoNarrative): string {
  return [
    `Objective: ${narrative.objective}`,
    "",
    "Addressing table:",
    ...narrative.addressing.map((line) => `  ${line}`),
    "",
    "Required configuration:",
    ...narrative.required.map((line) => `  ${line}`),
    "",
    "Expected result:",
    ...narrative.expected.map((line) => `  ${line}`),
    "",
    "Troubleshooting hints:",
    ...narrative.hints.map((line) => `  ${line}`),
  ].join("\n");
}

const switchPorts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `Gi0/${index + 1}` }));
const routerPorts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `Gi0/${index}` }));

// --- STP: redundant triangle ------------------------------------------------

export const STP_TRIANGLE_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "stp-redundant-triangle",
  title: "STP Redundant Triangle",
  description: "Three switches in a loop; PVST elects a root and blocks one path.",
  instructions: instructions({
    objective: "Watch PVST elect a root bridge, block one redundant link, and reconverge after a failure.",
    addressing: [
      "PC1  10.0.0.11/24  -> SW1 Gi0/3",
      "PC3  10.0.0.13/24  -> SW3 Gi0/3",
      "SW1/SW2/SW3 trunk each other on Gi0/1 and Gi0/2 (VLAN 1)",
    ],
    required: [
      "spanning-tree mode pvst on all three switches",
      "spanning-tree vlan 1 priority 4096 on SW1 to force the root",
    ],
    expected: [
      "SW1 is the root bridge for VLAN 1",
      "Exactly one port is alternate/blocking (SW3 Gi0/1)",
      "PC1 can ping PC3 and no frame loops",
    ],
    hints: [
      "show spanning-tree — compare the Root ID and Bridge ID rows",
      "Shut the forwarding link and Step through the reconvergence in Packet Trace",
      "A blocking port still exchanges BPDUs; only user data is stopped",
    ],
  }),
  expectedOutcome: "SW1 is root, one link blocks, and traffic still reaches PC3 after a link failure.",
  simulation: { seed: 1_041 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 320, y: 80 }, interfaces: switchPorts(3) },
      { id: "sw2", kind: "l2-switch", name: "SW2", position: { x: 160, y: 300 }, interfaces: switchPorts(3) },
      { id: "sw3", kind: "l2-switch", name: "SW3", position: { x: 480, y: 300 }, interfaces: switchPorts(3) },
      { id: "pc1", kind: "pc", name: "PC1", position: { x: 320, y: -60 }, interfaces: [{ id: "eth0" }] },
      { id: "pc3", kind: "pc", name: "PC3", position: { x: 640, y: 400 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "sw1-sw2", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } },
      { id: "sw2-sw3", a: { node: "sw2", iface: "Gi0/2" }, b: { node: "sw3", iface: "Gi0/1" } },
      { id: "sw3-sw1", a: { node: "sw3", iface: "Gi0/2" }, b: { node: "sw1", iface: "Gi0/2" } },
      { id: "pc1-sw1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/3" } },
      { id: "pc3-sw3", a: { node: "pc3", iface: "eth0" }, b: { node: "sw3", iface: "Gi0/3" } },
    ],
  },
  configurations: {
    sw1: {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [],
      interfaces: [],
      spanningTree: { mode: "stp", vlans: [{ vlanId: 1, priority: 4_096 }] },
    },
    sw2: { kind: "l2-switch", hostname: "SW2", vlans: [], interfaces: [], spanningTree: { mode: "stp" } },
    sw3: { kind: "l2-switch", hostname: "SW3", vlans: [], interfaces: [], spanningTree: { mode: "stp" } },
    pc1: { kind: "pc", hostname: "PC1", interfaces: [], ipv4: { address: "10.0.0.11", prefixLength: 24 } },
    pc3: { kind: "pc", hostname: "PC3", interfaces: [], ipv4: { address: "10.0.0.13", prefixLength: 24 } },
  },
} as unknown as LabDocument;

// --- Rapid-PVST failover ----------------------------------------------------

export const RAPID_PVST_DEMO: LabDocument = {
  ...STP_TRIANGLE_DEMO,
  id: "rapid-pvst-failover",
  title: "Rapid-PVST Failover",
  description: "The same triangle running 802.1w; compare the number of virtual transitions.",
  instructions: instructions({
    objective: "Compare Rapid-PVST convergence with 802.1D on an identical redundant topology.",
    addressing: [
      "PC1  10.0.0.11/24  -> SW1 Gi0/3",
      "PC3  10.0.0.13/24  -> SW3 Gi0/3",
    ],
    required: [
      "spanning-tree mode rapid-pvst on all three switches",
      "Shut SW3 Gi0/2 to fail the active path",
    ],
    expected: [
      "Proposal/agreement replaces the listening and learning waits",
      "The alternate port becomes root and forwards without a 30-second delay",
      "Fewer stp-port-state-changed events than the 802.1D demo",
    ],
    hints: [
      "Filter Packet Trace by RSTP to see the proposal and agreement",
      "show spanning-tree — Rapid-PVST shows discarding instead of blocking",
      "Virtual time is deterministic: Auto and Step reach the same result",
    ],
  }),
  expectedOutcome: "Rapid-PVST reconverges in fewer transitions and less virtual time than PVST.",
  simulation: { seed: 1_042 },
  configurations: {
    ...STP_TRIANGLE_DEMO.configurations,
    sw1: {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [],
      interfaces: [],
      spanningTree: { mode: "rstp", vlans: [{ vlanId: 1, priority: 4_096 }] },
    },
    sw2: { kind: "l2-switch", hostname: "SW2", vlans: [], interfaces: [], spanningTree: { mode: "rstp" } },
    sw3: { kind: "l2-switch", hostname: "SW3", vlans: [], interfaces: [], spanningTree: { mode: "rstp" } },
  },
} as unknown as LabDocument;

// --- BPDU Guard -------------------------------------------------------------

export const BPDU_GUARD_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "bpdu-guard-edge-port",
  title: "BPDU Guard",
  description: "An access port with PortFast and BPDU Guard meets an unexpected switch.",
  instructions: instructions({
    objective: "Protect an edge port so an unexpected switch cannot join the spanning tree.",
    addressing: ["SW1 Gi0/1 is an edge port; SW2 is the unexpected switch"],
    required: [
      "spanning-tree mode pvst on SW1 and SW2",
      "interface Gi0/1 -> spanning-tree portfast + spanning-tree bpduguard enable on SW1",
    ],
    expected: [
      "SW1 Gi0/1 goes error-disabled as soon as it receives a BPDU",
      "The Problems panel reports bpdu-guard-triggered",
      "errdisable recovery Gi0/1 clears the runtime state; configuration is unchanged",
    ],
    hints: [
      "Error-disabled state is runtime only — it is never saved in the lab file",
      "PortFast alone would simply stop being an edge port; the guard is what disables it",
      "Filter Packet Trace by STP to find the offending BPDU",
    ],
  }),
  expectedOutcome: "SW1 Gi0/1 is error-disabled until it is explicitly recovered.",
  simulation: { seed: 1_043 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 200, y: 160 }, interfaces: switchPorts(2) },
      { id: "sw2", kind: "l2-switch", name: "SW2", position: { x: 480, y: 160 }, interfaces: switchPorts(2) },
    ],
    links: [{ id: "sw1-sw2", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } }],
  },
  configurations: {
    sw1: {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [],
      interfaces: [],
      spanningTree: {
        mode: "stp",
        ports: [{ interfaceId: "Gi0/1", portFast: true, bpduGuard: true }],
      },
    },
    sw2: { kind: "l2-switch", hostname: "SW2", vlans: [], interfaces: [], spanningTree: { mode: "stp" } },
  },
} as unknown as LabDocument;

// --- LACP trunk -------------------------------------------------------------

export const LACP_TRUNK_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "lacp-trunk",
  title: "LACP Trunk",
  description: "Two physical links bundled into Port-channel1 carrying VLANs 10 and 20.",
  instructions: instructions({
    objective: "Bundle two links with LACP and keep the trunk up when one member fails.",
    addressing: [
      "PC10 10.0.10.11/24 -> SW1 Gi0/3 (VLAN 10)",
      "PC20 10.0.10.12/24 -> SW2 Gi0/3 (VLAN 10)",
      "SW1 Gi0/1-2 <-> SW2 Gi0/1-2 form Port-channel1",
    ],
    required: [
      "interface range Gi0/1 - 2 -> channel-group 1 mode active on SW1",
      "interface range Gi0/1 - 2 -> channel-group 1 mode passive on SW2",
      "interface Port-channel1 -> switchport mode trunk + switchport trunk allowed vlan 10,20",
    ],
    expected: [
      "show etherchannel summary reports Port-channel1(SU) with both members bundled",
      "Spanning tree sees one logical port, so the parallel links are not a loop",
      "Shutting one member keeps the bundle up and traffic flowing",
    ],
    hints: [
      "active + passive bundles; passive + passive never does",
      "A member with its own conflicting switchport configuration is suspended, not rewritten",
      "One flow always leaves through the same member — the selection is a pure hash",
    ],
  }),
  expectedOutcome: "Port-channel1 forms, spanning tree treats it as one port, and a member failure is survivable.",
  simulation: { seed: 1_044 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 200, y: 180 }, interfaces: switchPorts(3) },
      { id: "sw2", kind: "l2-switch", name: "SW2", position: { x: 520, y: 180 }, interfaces: switchPorts(3) },
      { id: "pc10", kind: "pc", name: "PC10", position: { x: 120, y: 380 }, interfaces: [{ id: "eth0" }] },
      { id: "pc20", kind: "pc", name: "PC20", position: { x: 600, y: 380 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "po-a", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } },
      { id: "po-b", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "sw2", iface: "Gi0/2" } },
      { id: "pc10-sw1", a: { node: "pc10", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/3" } },
      { id: "pc20-sw2", a: { node: "pc20", iface: "eth0" }, b: { node: "sw2", iface: "Gi0/3" } },
    ],
  },
  configurations: {
    sw1: {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [{ id: 10, name: "DATA" }, { id: 20, name: "VOICE" }],
      interfaces: [{ id: "Gi0/3", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 }],
      spanningTree: { mode: "rstp" },
      etherChannels: [{
        channelId: 1,
        mode: "active",
        members: ["Gi0/1", "Gi0/2"],
        switchport: { mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [10, 20] },
      }],
    },
    sw2: {
      kind: "l2-switch",
      hostname: "SW2",
      vlans: [{ id: 10, name: "DATA" }, { id: 20, name: "VOICE" }],
      interfaces: [{ id: "Gi0/3", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 }],
      spanningTree: { mode: "rstp" },
      etherChannels: [{
        channelId: 1,
        mode: "passive",
        members: ["Gi0/1", "Gi0/2"],
        switchport: { mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [10, 20] },
      }],
    },
    pc10: { kind: "pc", hostname: "PC10", interfaces: [], ipv4: { address: "10.0.10.11", prefixLength: 24 } },
    pc20: { kind: "pc", hostname: "PC20", interfaces: [], ipv4: { address: "10.0.10.12", prefixLength: 24 } },
  },
} as unknown as LabDocument;

// --- PAgP negotiation -------------------------------------------------------

export const PAGP_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "pagp-negotiation",
  title: "PAgP Negotiation",
  description: "desirable meets auto; then try auto with auto and watch it stay down.",
  instructions: instructions({
    objective: "Learn which PAgP mode combinations aggregate and which never do.",
    addressing: ["SW1 Gi0/1-2 <-> SW2 Gi0/1-2"],
    required: [
      "SW1: interface range Gi0/1 - 2 -> channel-group 1 mode desirable",
      "SW2: interface range Gi0/1 - 2 -> channel-group 1 mode auto",
      "Then set SW1 to auto as well and re-run to see it fail",
    ],
    expected: [
      "desirable + auto forms Port-channel1",
      "auto + auto never forms, because neither side speaks first",
      "show pagp neighbor lists the partner device on each bundled port",
    ],
    hints: [
      "Only desirable initiates; auto answers",
      "The Problems panel explains auto/auto as a configuration issue, not a fault",
      "PAgP and LACP cannot be mixed in the same channel group",
    ],
  }),
  expectedOutcome: "desirable/auto bundles; auto/auto stays down with a clear reason.",
  simulation: { seed: 1_045 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 220, y: 180 }, interfaces: switchPorts(2) },
      { id: "sw2", kind: "l2-switch", name: "SW2", position: { x: 520, y: 180 }, interfaces: switchPorts(2) },
    ],
    links: [
      { id: "po-a", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } },
      { id: "po-b", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "sw2", iface: "Gi0/2" } },
    ],
  },
  configurations: {
    sw1: {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [],
      interfaces: [],
      etherChannels: [{ channelId: 1, mode: "desirable", members: ["Gi0/1", "Gi0/2"] }],
    },
    sw2: {
      kind: "l2-switch",
      hostname: "SW2",
      vlans: [],
      interfaces: [],
      etherChannels: [{ channelId: 1, mode: "auto", members: ["Gi0/1", "Gi0/2"] }],
    },
  },
} as unknown as LabDocument;

// --- CDP and LLDP discovery -------------------------------------------------

export const DISCOVERY_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "cdp-lldp-discovery",
  title: "CDP and LLDP Discovery",
  description: "A router, an L2 switch, an L3 switch and a server compare discovery tables.",
  instructions: instructions({
    objective: "Discover directly connected neighbours with CDP and with vendor-neutral LLDP.",
    addressing: [
      "R1   Gi0/0 10.0.0.1/24   -> SW1 Gi0/1",
      "L3SW Vlan1 10.0.0.2/24   -> SW1 Gi0/2",
      "SRV1 eth0  10.0.0.9/24   -> SW1 Gi0/3",
    ],
    required: [
      "cdp run and lldp run on R1, SW1 and L3SW",
      "lldp run on SRV1 (a server never speaks CDP)",
    ],
    expected: [
      "show cdp neighbors on SW1 lists R1 and L3SW, but never SRV1",
      "show lldp neighbors additionally lists SRV1 as a Station",
      "Advancing virtual time past the hold time ages the entries out",
    ],
    hints: [
      "Discovery is link-local: it never crosses R1 and no ACL can filter it",
      "no cdp enable on a port sends a withdrawal so the neighbour clears at once",
      "A spanning-tree blocking port still exchanges discovery frames",
    ],
  }),
  expectedOutcome: "CDP and LLDP tables agree on the network devices; only LLDP sees the server.",
  simulation: { seed: 1_046 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 340, y: 200 }, interfaces: switchPorts(3) },
      { id: "r1", kind: "router", name: "R1", position: { x: 100, y: 200 }, interfaces: routerPorts(2) },
      { id: "l3sw", kind: "l3-switch", name: "L3SW", position: { x: 340, y: 20 }, interfaces: switchPorts(2) },
      { id: "srv1", kind: "server", name: "SRV1", position: { x: 340, y: 400 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
    ],
    links: [
      { id: "r1-sw1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "sw1", iface: "Gi0/1" } },
      { id: "l3sw-sw1", a: { node: "l3sw", iface: "Gi0/1" }, b: { node: "sw1", iface: "Gi0/2" } },
      { id: "srv1-sw1", a: { node: "srv1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/3" } },
    ],
  },
  configurations: {
    sw1: {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [],
      interfaces: [],
      discovery: { cdpEnabled: true, lldpEnabled: true },
    },
    r1: {
      kind: "router",
      hostname: "R1",
      interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.0.1", prefixLength: 24 } }],
      discovery: { cdpEnabled: true, lldpEnabled: true },
    },
    l3sw: {
      kind: "l3-switch",
      hostname: "L3SW",
      vlans: [{ id: 1, name: "default" }],
      interfaces: [],
      svis: [{ vlanId: 1, ipAddress: "10.0.0.2", prefixLength: 24, adminUp: true }],
      staticRoutes: [],
      ipRoutingEnabled: true,
      discovery: { cdpEnabled: true, lldpEnabled: true },
    },
    srv1: {
      kind: "server",
      hostname: "SRV1",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.0.0.9", prefixLength: 24 } }],
      enabledServices: [],
      discovery: { lldpEnabled: true },
    },
  },
} as unknown as LabDocument;

// --- OSPF basic -------------------------------------------------------------

export const OSPF_BASIC_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "ospf-basic",
  title: "OSPF Basic",
  description: "R1 — R2 — R3 in area 0 with loopbacks advertised as stub networks.",
  instructions: instructions({
    objective: "Bring three routers to Full in area 0 and reach every remote loopback.",
    addressing: [
      "R1 Lo0 1.1.1.1/32   Gi0/0 10.0.12.1/24",
      "R2 Lo0 2.2.2.2/32   Gi0/0 10.0.12.2/24   Gi0/1 10.0.23.2/24",
      "R3 Lo0 3.3.3.3/32   Gi0/0 10.0.23.3/24",
    ],
    required: [
      "router ospf 1 with an explicit router-id on each router",
      "network 0.0.0.0 255.255.255.255 area 0",
      "passive-interface Loopback0",
      "ip ospf network point-to-point on the router-to-router links",
    ],
    expected: [
      "show ip ospf neighbor reports full on both sides",
      "R1 learns 3.3.3.3/32 via 10.0.12.2 with administrative distance 110",
      "The link-state database holds one Router LSA per router",
    ],
    hints: [
      "A passive interface is advertised but never forms an adjacency",
      "Mismatched hello or dead intervals refuse the adjacency and say why",
      "Step mode shows Hello, the neighbour states, the LSAs, SPF and route installation",
    ],
  }),
  expectedOutcome: "All neighbours reach Full and every loopback is reachable through OSPF.",
  simulation: { seed: 1_047 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "r1", kind: "router", name: "R1", position: { x: 100, y: 200 }, interfaces: routerPorts(2) },
      { id: "r2", kind: "router", name: "R2", position: { x: 340, y: 200 }, interfaces: routerPorts(2) },
      { id: "r3", kind: "router", name: "R3", position: { x: 580, y: 200 }, interfaces: routerPorts(2) },
    ],
    links: [
      { id: "r1-r2", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } },
      { id: "r2-r3", a: { node: "r2", iface: "Gi0/1" }, b: { node: "r3", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    r1: ospfRouter("R1", "1.1.1.1", [{ id: "Gi0/0", address: "10.0.12.1" }]),
    r2: ospfRouter("R2", "2.2.2.2", [
      { id: "Gi0/0", address: "10.0.12.2" },
      { id: "Gi0/1", address: "10.0.23.2" },
    ]),
    r3: ospfRouter("R3", "3.3.3.3", [{ id: "Gi0/0", address: "10.0.23.3" }]),
  },
} as unknown as LabDocument;

function ospfRouter(
  hostname: string,
  routerId: string,
  interfaces: ReadonlyArray<{ id: string; address: string }>,
): unknown {
  return {
    kind: "router",
    hostname,
    interfaces: interfaces.map((iface) => ({
      id: iface.id,
      routed: true,
      shutdown: false,
      ipv4: { address: iface.address, prefixLength: 24 },
    })),
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: routerId, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 }],
      passiveInterfaces: ["Loopback0"],
      interfaces: interfaces.map((iface) => ({ interfaceId: iface.id, networkType: "point-to-point" })),
    },
  };
}

// --- OSPF redundant path ----------------------------------------------------

export const OSPF_REDUNDANT_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "ospf-redundant-path",
  title: "OSPF Redundant Path",
  description: "A square of four routers; interface cost decides the path and a failure reroutes it.",
  instructions: instructions({
    objective: "Steer OSPF with interface cost and watch SPF reroute after a link failure.",
    addressing: [
      "R1 Lo0 1.1.1.1/32  Gi0/0 10.0.12.1/24  Gi0/1 10.0.13.1/24",
      "R2 Lo0 2.2.2.2/32  Gi0/0 10.0.12.2/24  Gi0/1 10.0.24.2/24",
      "R3 Lo0 3.3.3.3/32  Gi0/0 10.0.13.3/24  Gi0/1 10.0.34.3/24",
      "R4 Lo0 4.4.4.4/32  Gi0/0 10.0.24.4/24  Gi0/1 10.0.34.4/24",
    ],
    required: [
      "router ospf 1 with area 0 on every router",
      "interface Gi0/0 on R1 -> ip ospf cost 500 to push traffic the other way",
    ],
    expected: [
      "R1 reaches 4.4.4.4/32 through R3 once Gi0/0 is expensive",
      "Shutting the chosen path reconverges onto the alternative",
      "show ip route ospf shows the cost as the metric",
    ],
    hints: [
      "Cost is configured explicitly; SimulatorNet never invents a bandwidth",
      "ospf-spf-started / ospf-spf-completed appear in Packet Trace on every recalculation",
      "A withdrawn route emits ospf-route-withdrawn before the new one is installed",
    ],
  }),
  expectedOutcome: "The lower-cost path wins and SPF reroutes deterministically after a failure.",
  simulation: { seed: 1_048 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "r1", kind: "router", name: "R1", position: { x: 140, y: 120 }, interfaces: routerPorts(2) },
      { id: "r2", kind: "router", name: "R2", position: { x: 460, y: 120 }, interfaces: routerPorts(2) },
      { id: "r3", kind: "router", name: "R3", position: { x: 140, y: 360 }, interfaces: routerPorts(2) },
      { id: "r4", kind: "router", name: "R4", position: { x: 460, y: 360 }, interfaces: routerPorts(2) },
    ],
    links: [
      { id: "r1-r2", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } },
      { id: "r1-r3", a: { node: "r1", iface: "Gi0/1" }, b: { node: "r3", iface: "Gi0/0" } },
      { id: "r2-r4", a: { node: "r2", iface: "Gi0/1" }, b: { node: "r4", iface: "Gi0/0" } },
      { id: "r3-r4", a: { node: "r3", iface: "Gi0/1" }, b: { node: "r4", iface: "Gi0/1" } },
    ],
  },
  configurations: {
    r1: withCost(ospfRouter("R1", "1.1.1.1", [
      { id: "Gi0/0", address: "10.0.12.1" },
      { id: "Gi0/1", address: "10.0.13.1" },
    ]), "Gi0/0", 500),
    r2: ospfRouter("R2", "2.2.2.2", [
      { id: "Gi0/0", address: "10.0.12.2" },
      { id: "Gi0/1", address: "10.0.24.2" },
    ]),
    r3: ospfRouter("R3", "3.3.3.3", [
      { id: "Gi0/0", address: "10.0.13.3" },
      { id: "Gi0/1", address: "10.0.34.3" },
    ]),
    r4: ospfRouter("R4", "4.4.4.4", [
      { id: "Gi0/0", address: "10.0.24.4" },
      { id: "Gi0/1", address: "10.0.34.4" },
    ]),
  },
} as unknown as LabDocument;

function withCost(config: unknown, interfaceId: string, cost: number): unknown {
  const router = config as { ospf: { interfaces: Array<{ interfaceId: string; cost?: number }> } };
  return {
    ...router,
    ospf: {
      ...router.ospf,
      interfaces: router.ospf.interfaces.map((iface) =>
        iface.interfaceId === interfaceId ? { ...iface, cost } : iface),
    },
  };
}

// --- OSPF DR/BDR ------------------------------------------------------------

export const OSPF_DR_BDR_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "ospf-dr-bdr",
  title: "OSPF DR/BDR",
  description: "Three routers on one broadcast segment elect a designated router.",
  instructions: instructions({
    objective: "Elect a DR and a BDR on a broadcast segment and watch a deterministic re-election.",
    addressing: [
      "R1 10.0.0.1/24 priority 10   R2 10.0.0.2/24 priority 200   R3 10.0.0.3/24 priority 100",
      "All three connect to SW1 in VLAN 1",
    ],
    required: [
      "router ospf 1 and network 10.0.0.0 0.0.0.255 area 0 on every router",
      "ip ospf priority on each Gi0/0 to steer the election",
    ],
    expected: [
      "R2 (priority 200) is DR and R3 (priority 100) is BDR",
      "A router with priority 0 never takes part",
      "Failing the DR re-elects deterministically once the dead interval expires",
    ],
    hints: [
      "The election waits two hello intervals so every neighbour is known first",
      "The DR is non-preemptive: a better router joining later does not take over",
      "The DR originates the Network LSA for the segment",
    ],
  }),
  expectedOutcome: "R2 becomes DR, R3 becomes BDR, and re-election is deterministic.",
  simulation: { seed: 1_049 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 340, y: 260 }, interfaces: switchPorts(3) },
      { id: "r1", kind: "router", name: "R1", position: { x: 120, y: 100 }, interfaces: routerPorts(1) },
      { id: "r2", kind: "router", name: "R2", position: { x: 340, y: 60 }, interfaces: routerPorts(1) },
      { id: "r3", kind: "router", name: "R3", position: { x: 560, y: 100 }, interfaces: routerPorts(1) },
    ],
    links: [
      { id: "r1-sw1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "sw1", iface: "Gi0/1" } },
      { id: "r2-sw1", a: { node: "r2", iface: "Gi0/0" }, b: { node: "sw1", iface: "Gi0/2" } },
      { id: "r3-sw1", a: { node: "r3", iface: "Gi0/0" }, b: { node: "sw1", iface: "Gi0/3" } },
    ],
  },
  configurations: {
    sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] },
    r1: broadcastRouter("R1", "1.1.1.1", "10.0.0.1", 10),
    r2: broadcastRouter("R2", "2.2.2.2", "10.0.0.2", 200),
    r3: broadcastRouter("R3", "3.3.3.3", "10.0.0.3", 100),
  },
} as unknown as LabDocument;

function broadcastRouter(hostname: string, routerId: string, address: string, priority: number): unknown {
  return {
    kind: "router",
    hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address, prefixLength: 24 } }],
    ospf: {
      processId: 1,
      routerId,
      networks: [{ network: "10.0.0.0", wildcard: "0.0.0.255", area: 0 }],
      passiveInterfaces: [],
      interfaces: [{ interfaceId: "Gi0/0", priority, networkType: "broadcast" }],
    },
  };
}

export const PROTOCOL_DEMO_LABS = [
  STP_TRIANGLE_DEMO,
  RAPID_PVST_DEMO,
  BPDU_GUARD_DEMO,
  LACP_TRUNK_DEMO,
  PAGP_DEMO,
  DISCOVERY_DEMO,
  OSPF_BASIC_DEMO,
  OSPF_REDUNDANT_DEMO,
  OSPF_DR_BDR_DEMO,
] as const;

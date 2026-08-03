import type { LabDocument } from "@sim/contracts";

type AddressedInterface = { id: string; address: string; prefixLength: number; mpls?: boolean; vrfId?: string };

const node = (id: string, name: string, x: number, y: number, ports: number) => ({
  id,
  kind: "router" as const,
  name,
  position: { x, y },
  interfaces: Array.from({ length: ports }, (_, index) => ({ id: `Gi0/${index}` })),
});

function router(
  hostname: string,
  interfaces: readonly AddressedInterface[],
  options: {
    loopback?: string;
    ospf?: boolean;
    ldp?: boolean;
    vrfs?: readonly {
      id: string;
      name: string;
      rd: string;
      rt: string;
      staticRoutes?: readonly { network: string; prefixLength: number; nextHop: string }[];
    }[];
    staticRoutes?: readonly { network: string; prefixLength: number; nextHop: string }[];
    bgpPeer?: string;
    bgpVrfIds?: readonly string[];
  } = {},
) {
  return {
    kind: "router" as const,
    hostname,
    interfaces: interfaces.map((iface) => ({
      id: iface.id,
      routed: true,
      shutdown: false,
      ipv4: { address: iface.address, prefixLength: iface.prefixLength },
      mplsEnabled: iface.mpls || undefined,
      vrfId: iface.vrfId,
    })),
    subinterfaces: [],
    staticRoutes: [...(options.staticRoutes ?? [])],
    dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
    loopbacks: options.loopback ? [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }] : [],
    ospf: options.ospf && options.loopback ? {
      processId: 1,
      routerId: options.loopback,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 }],
      passiveInterfaces: ["Loopback0"],
      interfaces: interfaces.filter((iface) => iface.mpls).map((iface) => ({ interfaceId: iface.id, networkType: "point-to-point" as const })),
    } : undefined,
    ldp: options.ldp ? { routerIdInterface: "Loopback0" } : undefined,
    vrfs: (options.vrfs ?? []).map((vrf) => ({
      id: vrf.id,
      name: vrf.name,
      routeDistinguisher: vrf.rd,
      importRouteTargets: [vrf.rt],
      exportRouteTargets: [vrf.rt],
      staticRoutes: [...(vrf.staticRoutes ?? [])],
    })),
    bgp: options.bgpPeer && options.loopback ? {
      localAs: 65_000,
      routerId: options.loopback,
      neighbors: [{
        address: options.bgpPeer,
        remoteAs: 65_000,
        updateSource: "Loopback0",
        enabled: true,
        vpnv4Activated: true,
        sendCommunityExtended: true,
      }],
      networks: [],
      vrfAddressFamilies: (options.bgpVrfIds ?? []).map((vrfId) => ({ vrfId, redistributeConnected: true, redistributeStatic: true })),
    } : undefined,
  };
}

const link = (id: string, a: string, ai: string, b: string, bi: string) => ({
  id,
  a: { node: a, iface: ai },
  b: { node: b, iface: bi },
});

const instructions = (objective: string, details: readonly string[]) => [
  `Objective: ${objective}`,
  ...details,
  "Use Auto for bounded convergence or Step with the MPLS, LDP, VPNv4 and L3VPN Packet Trace filters.",
  "Troubleshooting: verify OSPF underlay, LDP Operational state, VPNv4 activation, extended communities, RT import and the two-label stack.",
].join("\n");

export const MPLS_LDP_CORE_DEMO = {
  schemaVersion: 1,
  id: "mpls-ldp-core",
  title: "MPLS LDP Core",
  description: "Four provider routers build an OSPF underlay, deterministic LDP bindings and an LFIB with push/swap/PHP behavior.",
  expectedOutcome: "All adjacent LDP sessions are Operational and label forwarding uses deterministic bindings with implicit-null PHP.",
  instructions: instructions("Inspect label distribution and forwarding across R1—P1—P2—R2.", [
    "Provider addressing: 192.0.2.0/30, 192.0.2.4/30 and 192.0.2.8/30; Loopbacks 1.1.1.1–4.4.4.4/32.",
    "Required CLI: show mpls interfaces; show mpls ldp neighbor; show mpls ldp bindings; show mpls forwarding-table.",
  ]),
  simulation: { seed: 10_111 },
  topology: {
    schemaVersion: 1,
    nodes: [node("r1", "R1", 100, 250, 1), node("p1", "P1", 370, 250, 2), node("p2", "P2", 640, 250, 2), node("r2", "R2", 910, 250, 1)],
    links: [link("r1-p1", "r1", "Gi0/0", "p1", "Gi0/0"), link("p1-p2", "p1", "Gi0/1", "p2", "Gi0/0"), link("p2-r2", "p2", "Gi0/1", "r2", "Gi0/0")],
  },
  configurations: {
    r1: router("R1", [{ id: "Gi0/0", address: "192.0.2.1", prefixLength: 30, mpls: true }], { loopback: "1.1.1.1", ospf: true, ldp: true }),
    p1: router("P1", [{ id: "Gi0/0", address: "192.0.2.2", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "192.0.2.5", prefixLength: 30, mpls: true }], { loopback: "2.2.2.2", ospf: true, ldp: true }),
    p2: router("P2", [{ id: "Gi0/0", address: "192.0.2.6", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "192.0.2.9", prefixLength: 30, mpls: true }], { loopback: "3.3.3.3", ospf: true, ldp: true }),
    r2: router("R2", [{ id: "Gi0/0", address: "192.0.2.10", prefixLength: 30, mpls: true }], { loopback: "4.4.4.4", ospf: true, ldp: true }),
  },
} as unknown as LabDocument;

const customer = { id: "customer-a", name: "CUSTOMER-A", rd: "65000:100", rt: "65000:100" } as const;

export const SINGLE_CUSTOMER_L3VPN_DEMO = {
  schemaVersion: 1,
  id: "mpls-single-customer-l3vpn",
  title: "Single-Customer L3VPN",
  description: "Two PE routers exchange one customer VRF through MP-BGP VPNv4 while the P router carries labels only.",
  expectedOutcome: "CE1 reaches CE2 through a VPN and transport label; P has no 10.1.1.0/24 or 10.2.1.0/24 customer route.",
  instructions: instructions("Verify one CUSTOMER-A VPN across CE1—PE1—P—PE2—CE2.", [
    "Provider: AS 65000, PE loopbacks 1.1.1.1 and 3.3.3.3, OSPF area 0 and LDP transport.",
    "Customer: CE1 10.1.1.2/24, CE2 10.2.1.2/24; VRF CUSTOMER-A; RD/RT 65000:100.",
    "Required CLI: show vrf; show ip route vrf customer-a; show bgp vpnv4 unicast all.",
  ]),
  simulation: { seed: 10_112 },
  topology: {
    schemaVersion: 1,
    nodes: [node("ce1", "CE1", 40, 260, 1), node("pe1", "PE1", 270, 260, 2), node("p", "P", 530, 260, 2), node("pe2", "PE2", 790, 260, 2), node("ce2", "CE2", 1020, 260, 1)],
    links: [link("ce1-pe1", "ce1", "Gi0/0", "pe1", "Gi0/1"), link("pe1-p", "pe1", "Gi0/0", "p", "Gi0/0"), link("p-pe2", "p", "Gi0/1", "pe2", "Gi0/0"), link("pe2-ce2", "pe2", "Gi0/1", "ce2", "Gi0/0")],
  },
  configurations: {
    ce1: router("CE1", [{ id: "Gi0/0", address: "10.1.1.2", prefixLength: 24 }], { staticRoutes: [{ network: "10.2.1.0", prefixLength: 24, nextHop: "10.1.1.1" }] }),
    pe1: router("PE1", [{ id: "Gi0/0", address: "192.0.2.1", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "10.1.1.1", prefixLength: 24, vrfId: customer.id }], { loopback: "1.1.1.1", ospf: true, ldp: true, vrfs: [customer], bgpPeer: "3.3.3.3", bgpVrfIds: [customer.id] }),
    p: router("P", [{ id: "Gi0/0", address: "192.0.2.2", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "192.0.2.5", prefixLength: 30, mpls: true }], { loopback: "2.2.2.2", ospf: true, ldp: true }),
    pe2: router("PE2", [{ id: "Gi0/0", address: "192.0.2.6", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "10.2.1.1", prefixLength: 24, vrfId: customer.id }], { loopback: "3.3.3.3", ospf: true, ldp: true, vrfs: [customer], bgpPeer: "1.1.1.1", bgpVrfIds: [customer.id] }),
    ce2: router("CE2", [{ id: "Gi0/0", address: "10.2.1.2", prefixLength: 24 }], { staticRoutes: [{ network: "10.1.1.0", prefixLength: 24, nextHop: "10.2.1.1" }] }),
  },
} as unknown as LabDocument;

const customerB = { id: "customer-b", name: "CUSTOMER-B", rd: "65000:200", rt: "65000:200" } as const;

export const OVERLAPPING_CUSTOMER_L3VPN_DEMO = {
  ...SINGLE_CUSTOMER_L3VPN_DEMO,
  id: "mpls-overlapping-customers",
  title: "Overlapping Customer Networks",
  description: "CUSTOMER-A and CUSTOMER-B both use 10.0.0.0/24 at one site while distinct RD/RT policy keeps their VPN routes isolated.",
  expectedOutcome: "Each customer reaches only its matching remote site; no route target imports the other customer's overlapping prefix.",
  instructions: instructions("Compare two isolated VPNs that reuse 10.0.0.0/24.", [
    "CUSTOMER-A: RD/RT 65000:100; sites 10.0.0.0/24 and 10.1.0.0/24.",
    "CUSTOMER-B: RD/RT 65000:200; sites 10.0.0.0/24 and 10.2.0.0/24.",
    "The P router remains unaware of every customer prefix; inter-VRF route leaking is not configured.",
  ]),
  simulation: { seed: 10_113 },
  topology: {
    schemaVersion: 1,
    nodes: [
      node("a1", "A-SITE1", 30, 120, 1), node("b1", "B-SITE1", 30, 400, 1), node("pe1", "PE1", 280, 260, 3),
      node("p", "P", 540, 260, 2), node("pe2", "PE2", 800, 260, 3), node("a2", "A-SITE2", 1050, 120, 1), node("b2", "B-SITE2", 1050, 400, 1),
    ],
    links: [
      link("a1-pe1", "a1", "Gi0/0", "pe1", "Gi0/1"), link("b1-pe1", "b1", "Gi0/0", "pe1", "Gi0/2"),
      link("pe1-p", "pe1", "Gi0/0", "p", "Gi0/0"), link("p-pe2", "p", "Gi0/1", "pe2", "Gi0/0"),
      link("pe2-a2", "pe2", "Gi0/1", "a2", "Gi0/0"), link("pe2-b2", "pe2", "Gi0/2", "b2", "Gi0/0"),
    ],
  },
  configurations: {
    a1: router("A-SITE1", [{ id: "Gi0/0", address: "10.0.0.2", prefixLength: 24 }], { staticRoutes: [{ network: "10.1.0.0", prefixLength: 24, nextHop: "10.0.0.1" }] }),
    b1: router("B-SITE1", [{ id: "Gi0/0", address: "10.0.0.2", prefixLength: 24 }], { staticRoutes: [{ network: "10.2.0.0", prefixLength: 24, nextHop: "10.0.0.1" }] }),
    pe1: router("PE1", [{ id: "Gi0/0", address: "192.0.2.1", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "10.0.0.1", prefixLength: 24, vrfId: customer.id }, { id: "Gi0/2", address: "10.0.0.1", prefixLength: 24, vrfId: customerB.id }], { loopback: "1.1.1.1", ospf: true, ldp: true, vrfs: [customer, customerB], bgpPeer: "3.3.3.3", bgpVrfIds: [customer.id, customerB.id] }),
    p: router("P", [{ id: "Gi0/0", address: "192.0.2.2", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "192.0.2.5", prefixLength: 30, mpls: true }], { loopback: "2.2.2.2", ospf: true, ldp: true }),
    pe2: router("PE2", [{ id: "Gi0/0", address: "192.0.2.6", prefixLength: 30, mpls: true }, { id: "Gi0/1", address: "10.1.0.1", prefixLength: 24, vrfId: customer.id }, { id: "Gi0/2", address: "10.2.0.1", prefixLength: 24, vrfId: customerB.id }], { loopback: "3.3.3.3", ospf: true, ldp: true, vrfs: [customer, customerB], bgpPeer: "1.1.1.1", bgpVrfIds: [customer.id, customerB.id] }),
    a2: router("A-SITE2", [{ id: "Gi0/0", address: "10.1.0.2", prefixLength: 24 }], { staticRoutes: [{ network: "10.0.0.0", prefixLength: 24, nextHop: "10.1.0.1" }] }),
    b2: router("B-SITE2", [{ id: "Gi0/0", address: "10.2.0.2", prefixLength: 24 }], { staticRoutes: [{ network: "10.0.0.0", prefixLength: 24, nextHop: "10.2.0.1" }] }),
  },
} as unknown as LabDocument;

export const MPLS_DEMO_LABS = [MPLS_LDP_CORE_DEMO, SINGLE_CUSTOMER_L3VPN_DEMO, OVERLAPPING_CUSTOMER_L3VPN_DEMO] as const;

import type { LabDocument } from "@sim/contracts";

export const DEMO_LAB: LabDocument = {
  schemaVersion: 1,
  id: "demo-router-on-a-stick",
  title: "VLAN Routing Lab",
  description: "Two DHCP clients routed through 802.1Q subinterfaces",
  simulation: { seed: 2025 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-1", kind: "pc", name: "PC1", position: { x: 70, y: 80 }, interfaces: [{ id: "eth0" }] },
      { id: "pc-2", kind: "pc", name: "PC2", position: { x: 70, y: 310 }, interfaces: [{ id: "eth0" }] },
      {
        id: "switch-1",
        kind: "l2-switch",
        name: "SW1",
        position: { x: 390, y: 190 },
        interfaces: Array.from({ length: 8 }, (_, index) => ({ id: `Gi0/${index + 1}` })),
      },
      {
        id: "router-1",
        kind: "router",
        name: "R1",
        position: { x: 720, y: 190 },
        interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }],
      },
    ],
    links: [
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
      { id: "link-2", a: { node: "pc-2", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/2" } },
      { id: "link-3", a: { node: "switch-1", iface: "Gi0/8" }, b: { node: "router-1", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: true },
    "pc-2": { kind: "pc", hostname: "PC2", interfaces: [], dhcpEnabled: true },
    "switch-1": {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [{ id: 10, name: "STUDENTS" }, { id: 20, name: "SERVERS" }],
      interfaces: [
        { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
        { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 20, nativeVlan: 1 },
        { id: "Gi0/8", shutdown: false, mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [10, 20] },
      ],
    },
    "router-1": {
      kind: "router",
      hostname: "R1",
      interfaces: [],
      subinterfaces: [
        { id: "Gi0/0.10", parentInterface: "Gi0/0", vlan: 10, native: false, ipv4: { address: "192.168.10.1", prefixLength: 24 } },
        { id: "Gi0/0.20", parentInterface: "Gi0/0", vlan: 20, native: false, ipv4: { address: "192.168.20.1", prefixLength: 24 } },
      ],
      staticRoutes: [],
      dhcpPools: [
        {
          id: "VLAN10",
          network: "192.168.10.0",
          prefixLength: 24,
          defaultGateway: "192.168.10.1",
          rangeStart: "192.168.10.10",
          rangeEnd: "192.168.10.50",
          leaseSeconds: 3600,
        },
        {
          id: "VLAN20",
          network: "192.168.20.0",
          prefixLength: 24,
          defaultGateway: "192.168.20.1",
          rangeStart: "192.168.20.10",
          rangeEnd: "192.168.20.50",
          leaseSeconds: 3600,
        },
      ],
    },
  },
};

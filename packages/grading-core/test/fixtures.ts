import type { LabDocument, LabSubmissionDocument } from "@sim/contracts";
import type { GradingSpec, VerificationRequest } from "@sim/contracts/grading";

export function demoLabDocument(): LabDocument {
  return {
    schemaVersion: 1,
    id: "demo-router-on-a-stick",
    title: "VLAN Routing Lab",
    description: "Two DHCP clients routed through 802.1Q subinterfaces",
    simulation: { seed: 2025 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc-1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
        { id: "pc-2", kind: "pc", name: "PC2", interfaces: [{ id: "eth0" }] },
        {
          id: "switch-1",
          kind: "l2-switch",
          name: "SW1",
          interfaces: Array.from({ length: 8 }, (_, index) => ({ id: `Gi0/${index + 1}` })),
        },
        { id: "router-1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
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
        staticRoutes: [{ network: "172.16.0.0", prefixLength: 16, nextHop: "192.168.10.2" }],
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
        acls: [],
        aclBindings: [],
        natPools: [],
        natRules: [],
        natInterfaceRoles: [],
      },
    },
  };
}

export function submissionFrom(document: LabDocument = demoLabDocument()): LabSubmissionDocument {
  return {
    labId: document.id,
    labVersion: 1,
    schemaVersion: 1,
    simulation: document.simulation,
    snapshot: {
      topology: document.topology,
      configurations: document.configurations,
      startupConfigurations: document.startupConfigurations,
    },
    clientRevision: "fixture-1",
  };
}

export function gradingSpec(): GradingSpec {
  return {
    schemaVersion: 1,
    id: "demo-grade",
    checks: [
      {
        id: "ping-pc1-pc2",
        title: "PC1 reaches PC2",
        type: "ping",
        points: 3,
        visibility: "hidden",
        configuration: { sourceDeviceId: "pc-1", destinationIp: "192.168.20.10", expected: "success" },
      },
      {
        id: "vlan-10",
        title: "VLAN 10 exists",
        type: "vlan-exists",
        points: 1,
        visibility: "visible",
        configuration: { deviceId: "switch-1", vlanId: 10 },
      },
      {
        id: "access-vlan-10",
        title: "PC1 access port",
        type: "switchport",
        points: 2,
        visibility: "visible",
        configuration: { deviceId: "switch-1", interfaceId: "Gi0/1", expectedMode: "access", expectedAccessVlan: 10 },
      },
      {
        id: "interface-up",
        title: "PC1 interface enabled",
        type: "interface-state",
        points: 1,
        visibility: "visible",
        configuration: { deviceId: "switch-1", interfaceId: "Gi0/1", expectedAdminUp: true },
      },
      {
        id: "static-route",
        title: "Static route exists",
        type: "route-exists",
        points: 1,
        visibility: "visible",
        configuration: { deviceId: "router-1", network: "172.16.0.0", prefixLength: 16 },
      },
      {
        id: "dhcp-pc1",
        title: "PC1 receives VLAN 10 address",
        type: "dhcp-address",
        points: 2,
        visibility: "hidden",
        configuration: { deviceId: "pc-1", expectedSubnet: "192.168.10.0/24" },
      },
    ],
  };
}

export function verificationRequest(resultView: "student" | "instructor" = "student"): VerificationRequest {
  return { submission: submissionFrom(), gradingSpec: gradingSpec(), resultView };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

import type { GradingCheck, LabDocument, VerificationRequest } from "@sim/contracts";
import { verifySubmission } from "@sim/grading-core";
import { describe, expect, it } from "vitest";

/**
 * M10.15.1 — grading the routed overlay.
 *
 * The verifier accepts structured topology and configuration only and rebuilds
 * every EVPN table itself, so nothing here is trusted from the browser. A
 * hidden expectation — the gateway MAC, an RD, a route target or a VNI — is
 * never echoed back into a student result.
 */

const ANYCAST_MAC = "02:00:00:ff:00:01";

const host = (hostname: string, address: string, gateway: string) => ({
  kind: "pc" as const,
  hostname,
  interfaces: [],
  ipv4: { address, prefixLength: 24, defaultGateway: gateway },
  dhcpEnabled: false,
});

interface LeafOptions {
  hostname: string;
  loopback: string;
  uplink: string;
  peerLoopback: string;
  uplinkNextHop: string;
  vlanId: number;
  l2Vni: number;
  gateway: string;
}

/**
 * One leaf: a stretched tenant VLAN behind a distributed anycast gateway, a
 * TENANT-A routing context transported by L3VNI 50001, and a TENANT-B context
 * that exists but shares no route target — which is what proves isolation.
 */
function leaf(options: LeafOptions) {
  return {
    kind: "l3-switch" as const,
    hostname: options.hostname,
    vlans: [{ id: options.vlanId, name: `TENANT-A-${options.vlanId}` }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: options.vlanId, nativeVlan: 1 },
      { id: "Gi0/2", shutdown: false, mode: "routed" as const, ipv4: { address: options.uplink, prefixLength: 30 } },
    ],
    svis: [{
      vlanId: options.vlanId,
      ipAddress: options.gateway,
      prefixLength: 24,
      adminUp: true,
      vrfId: "TENANT-A",
      anycastGateway: true,
    }],
    vrfs: [
      {
        id: "TENANT-A",
        name: "TENANT-A",
        routeDistinguisher: `65000:${options.l2Vni}`,
        importRouteTargets: ["65000:50001"],
        exportRouteTargets: ["65000:50001"],
        staticRoutes: [],
        advertiseEvpn: true,
      },
      {
        id: "TENANT-B",
        name: "TENANT-B",
        routeDistinguisher: `65001:${options.l2Vni}`,
        importRouteTargets: ["65001:50002"],
        exportRouteTargets: ["65001:50002"],
        staticRoutes: [],
      },
    ],
    staticRoutes: [
      { network: options.peerLoopback, prefixLength: 32, nextHop: options.uplinkNextHop },
      { network: "10.255.0.9", prefixLength: 32, nextHop: options.uplinkNextHop },
    ],
    ipRoutingEnabled: true,
    acls: [],
    aclBindings: [],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }],
    nve: {
      id: "nve1" as const,
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: options.l2Vni, vlanId: options.vlanId, replication: { type: "bgp-evpn" as const } }],
      vrfMembers: [{ vni: 50_001, vrfId: "TENANT-A" }],
    },
    evpn: {
      vnis: [{
        vni: options.l2Vni,
        routeDistinguisher: `65000:${options.l2Vni}`,
        importRouteTargets: [`65000:${options.l2Vni}`],
        exportRouteTargets: [`65000:${options.l2Vni}`],
      }],
      anycastGatewayMac: ANYCAST_MAC,
    },
    bgp: {
      localAs: 65_000,
      routerId: options.loopback,
      networks: [],
      vrfAddressFamilies: [],
      neighbors: [{
        address: "10.255.0.9",
        remoteAs: 65_000,
        updateSource: "Loopback0",
        enabled: true,
        evpnActivated: true,
        sendCommunityExtended: true,
      }],
    },
  };
}

function routedFabric(): LabDocument {
  return {
    schemaVersion: 1,
    id: "routed-evpn-grading",
    title: "Routed EVPN grading",
    simulation: { seed: 11_153 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "host-a", kind: "pc", name: "HOST-A", interfaces: [{ id: "eth0" }] },
        { id: "leaf1", kind: "l3-switch", name: "LEAF1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "spine", kind: "router", name: "SPINE-RR", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "leaf2", kind: "l3-switch", name: "LEAF2", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "host-b", kind: "pc", name: "HOST-B", interfaces: [{ id: "eth0" }] },
      ],
      links: [
        { id: "host-a-leaf1", a: { node: "host-a", iface: "eth0" }, b: { node: "leaf1", iface: "Gi0/1" } },
        { id: "leaf1-spine", a: { node: "leaf1", iface: "Gi0/2" }, b: { node: "spine", iface: "Gi0/0" } },
        { id: "spine-leaf2", a: { node: "spine", iface: "Gi0/1" }, b: { node: "leaf2", iface: "Gi0/2" } },
        { id: "leaf2-host-b", a: { node: "leaf2", iface: "Gi0/1" }, b: { node: "host-b", iface: "eth0" } },
      ],
    },
    configurations: {
      "host-a": host("HOST-A", "10.10.10.10", "10.10.10.1"),
      leaf1: leaf({
        hostname: "LEAF1",
        loopback: "10.255.0.1",
        uplink: "192.0.2.1",
        peerLoopback: "10.255.0.2",
        uplinkNextHop: "192.0.2.2",
        vlanId: 10,
        l2Vni: 10_010,
        gateway: "10.10.10.1",
      }),
      spine: {
        kind: "router" as const,
        hostname: "SPINE-RR",
        interfaces: [
          { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "192.0.2.2", prefixLength: 30 } },
          { id: "Gi0/1", routed: true, shutdown: false, ipv4: { address: "192.0.2.5", prefixLength: 30 } },
        ],
        subinterfaces: [],
        staticRoutes: [
          { network: "10.255.0.1", prefixLength: 32, nextHop: "192.0.2.1" },
          { network: "10.255.0.2", prefixLength: 32, nextHop: "192.0.2.6" },
        ],
        dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
        loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.9", prefixLength: 32 } }],
        // The reflector serves the EVPN family and is never a VTEP: it holds no
        // overlay, no tenant VRF and no tenant MAC.
        bgp: {
          localAs: 65_000,
          routerId: "10.255.0.9",
          clusterId: "10.255.0.9",
          networks: [],
          vrfAddressFamilies: [],
          neighbors: [
            { address: "10.255.0.1", remoteAs: 65_000, updateSource: "Loopback0", enabled: true, evpnActivated: true, sendCommunityExtended: true, routeReflectorClient: true },
            { address: "10.255.0.2", remoteAs: 65_000, updateSource: "Loopback0", enabled: true, evpnActivated: true, sendCommunityExtended: true, routeReflectorClient: true },
          ],
        },
      },
      leaf2: leaf({
        hostname: "LEAF2",
        loopback: "10.255.0.2",
        uplink: "192.0.2.6",
        peerLoopback: "10.255.0.1",
        uplinkNextHop: "192.0.2.5",
        vlanId: 20,
        l2Vni: 10_020,
        gateway: "10.20.20.1",
      }),
      "host-b": host("HOST-B", "10.20.20.20", "10.20.20.1"),
    },
  } as unknown as LabDocument;
}

const check = (
  partial: Omit<GradingCheck, "id" | "title" | "points" | "visibility">,
  visibility: "visible" | "hidden" = "visible",
): GradingCheck => ({
  id: `check-${partial.type}`,
  title: `Check ${partial.type}`,
  points: 1,
  visibility,
  ...partial,
} as GradingCheck);

function grade(
  document: LabDocument,
  checks: readonly GradingCheck[],
  resultView: "student" | "instructor" = "instructor",
) {
  const request: VerificationRequest = {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: "routed-evpn-spec", checks: [...checks] },
    resultView,
  };
  return verifySubmission(request);
}

describe("routed EVPN grading", () => {
  it("checks the anycast gateway, the L3VNI, Type 5 origination and import", () => {
    const result = grade(routedFabric(), [
      check({ type: "evpn-anycast-gateway", configuration: { deviceId: "leaf1", vlanId: 10, expectedGatewayAddress: "10.10.10.1", expectedGatewayMac: ANYCAST_MAC, expectedVrfId: "TENANT-A", expected: "operational" } }),
      check({ type: "evpn-l3vni", configuration: { deviceId: "leaf1", vni: 50_001, expectedVrfId: "TENANT-A", expectedAdvertiseEvpn: true, expected: "operational" } }),
      check({ type: "evpn-type5-route", configuration: { deviceId: "leaf1", network: "10.10.10.0", prefixLength: 24, expectedL3Vni: 50_001, expectedOrigin: "local", expected: "present" } }),
      check({ type: "evpn-type5-imported", configuration: { deviceId: "leaf1", vrfId: "TENANT-A", network: "10.20.20.0", prefixLength: 24, expectedRemoteVtep: "10.255.0.2", expectedL3Vni: 50_001, expected: "present" } }),
      check({ type: "evpn-remote-prefix", configuration: { deviceId: "leaf1", vrfId: "TENANT-A", network: "10.20.20.0", prefixLength: 24, expectedRemoteVtep: "10.255.0.2", requireUnderlayReachable: true } }),
      check({ type: "evpn-routed-overlay-operational", configuration: { deviceId: "leaf2", minimumImportedPrefixes: 1, minimumOriginatedPrefixes: 1, expected: "operational" } }),
    ]);
    expect(result.checks.map((entry) => `${entry.id}:${entry.status}`)).toEqual([
      "check-evpn-anycast-gateway:passed",
      "check-evpn-l3vni:passed",
      "check-evpn-type5-route:passed",
      "check-evpn-type5-imported:passed",
      "check-evpn-remote-prefix:passed",
      "check-evpn-routed-overlay-operational:passed",
    ]);
    expect(result.score).toBe(100);
  });

  it("checks symmetric IRB in both directions, reflection and tenant isolation", () => {
    const result = grade(routedFabric(), [
      check({ type: "evpn-irb-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "10.20.20.20", expected: "success", requireL3VniTransit: true } }),
      check({ type: "evpn-irb-connectivity", configuration: { sourceDeviceId: "host-b", destinationIp: "10.10.10.10", expected: "success", requireL3VniTransit: true }, }),
      check({ type: "evpn-route-reflected", configuration: { deviceId: "leaf1", routeType: 5, expectedClusterId: "10.255.0.9" } }),
      // TENANT-B shares no route target with TENANT-A, so it installs nothing;
      // the reflector holds no tenant routing context at all.
      check({ type: "evpn-vrf-isolation", configuration: { deviceId: "leaf1", vrfId: "TENANT-B", foreignNetwork: "10.20.20.0", foreignPrefixLength: 24, underlayDeviceId: "spine" } }),
    ].map((entry, index) => ({ ...entry, id: `${entry.id}-${index}` })));
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "passed", "passed"]);
  });

  it("fails an incomplete tenant and never names the expected value", () => {
    const document = routedFabric();
    // The one explicit statement that starts origination is removed.
    const leaf1 = document.configurations.leaf1 as { vrfs: Array<{ advertiseEvpn?: boolean }> };
    leaf1.vrfs[0]!.advertiseEvpn = false;
    const result = grade(document, [
      check({ type: "evpn-l3vni", configuration: { deviceId: "leaf1", vni: 50_001, expectedVrfId: "TENANT-A", expectedAdvertiseEvpn: true, expected: "operational" } }, "hidden"),
      check({ type: "evpn-type5-imported", configuration: { deviceId: "leaf2", vrfId: "TENANT-A", network: "10.10.10.0", prefixLength: 24, expected: "absent" } }, "hidden"),
    ], "student");
    expect(result.checks.map((entry) => entry.status)).toEqual(["failed", "passed"]);
    // A student result redacts the hidden expectation and every diagnostic.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("TENANT-A");
    expect(serialized).not.toContain(ANYCAST_MAC);
    expect(serialized).not.toContain("50001");
    expect(serialized).not.toContain("65000:");
  });
});

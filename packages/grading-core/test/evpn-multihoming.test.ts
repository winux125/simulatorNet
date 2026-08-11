import type { GradingCheck, LabDocument, VerificationRequest } from "@sim/contracts";
import { verifySubmission } from "@sim/grading-core";
import { buildLabFromDocument, canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";

/**
 * M10.16 — grading EVPN Single-Active multihoming.
 *
 * The verifier accepts structured topology and configuration only and rebuilds
 * the Ethernet Segment peers, the Designated Forwarder election and every
 * primary/backup path itself. A hidden expectation — the ESI, the candidate
 * list, which leaf was supposed to win — is never echoed back to a student.
 */

const ESI = "0000:0000:0000:0000:0001";
const VNI = 10_010;

const host = (hostname: string, address: string) => ({
  kind: "pc" as const,
  hostname,
  interfaces: [],
  ipv4: { address, prefixLength: 24 },
  dhcpEnabled: false,
});

function leaf(name: string, loopback: string, uplink: string, segment: boolean) {
  return {
    kind: "l3-switch" as const,
    hostname: name,
    vlans: [{ id: 10, name: "TENANT-A" }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: 10, nativeVlan: 1 },
      { id: "Gi0/2", shutdown: false, mode: "routed" as const, ipv4: { address: uplink, prefixLength: 30 } },
    ],
    svis: [],
    staticRoutes: [],
    ipRoutingEnabled: true,
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: loopback, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId: loopback,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
      passiveInterfaces: ["Loopback0"],
      interfaces: [{ interfaceId: "Gi0/2", networkType: "point-to-point" as const }],
    },
    bgp: {
      localAs: 65_000,
      routerId: loopback,
      networks: [],
      vrfAddressFamilies: [],
      neighbors: [{
        address: "10.255.0.9",
        remoteAs: 65_000,
        updateSource: "Loopback0",
        evpnActivated: true,
        sendCommunityExtended: true,
      }],
    },
    nve: {
      id: "nve1" as const,
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: VNI, vlanId: 10, replication: { type: "bgp-evpn" as const } }],
    },
    evpn: {
      vnis: [{
        vni: VNI,
        routeDistinguisher: "65000:10010",
        importRouteTargets: ["65000:10010"],
        exportRouteTargets: ["65000:10010"],
      }],
      ...(segment
        ? {
            ethernetSegments: [{
              id: "ES-CE1",
              esi: ESI,
              redundancyMode: "single-active" as const,
              interfaces: ["Gi0/1"],
            }],
          }
        : {}),
    },
  };
}

/**
 * HOST-A — CE — {LEAF1, LEAF2} — SPINE — LEAF3 — HOST-B.
 *
 * LEAF1 and LEAF2 share one ESI; `10 mod 2` makes LEAF1 the DF for VLAN 10.
 */
function multihomedFabric(): LabDocument {
  return {
    schemaVersion: 1,
    id: "evpn-multihoming-grading",
    title: "EVPN multihoming grading",
    simulation: { seed: 11_164 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "host-a", kind: "pc", name: "HOST-A", interfaces: [{ id: "eth0" }] },
        { id: "ce", kind: "l2-switch", name: "CE", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }] },
        { id: "leaf1", kind: "l3-switch", name: "LEAF1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "leaf2", kind: "l3-switch", name: "LEAF2", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "spine", kind: "router", name: "SPINE", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "leaf3", kind: "l3-switch", name: "LEAF3", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "host-b", kind: "pc", name: "HOST-B", interfaces: [{ id: "eth0" }] },
      ],
      links: [
        { id: "host-a-ce", a: { node: "host-a", iface: "eth0" }, b: { node: "ce", iface: "Gi0/1" } },
        { id: "ce-leaf1", a: { node: "ce", iface: "Gi0/2" }, b: { node: "leaf1", iface: "Gi0/1" } },
        { id: "ce-leaf2", a: { node: "ce", iface: "Gi0/3" }, b: { node: "leaf2", iface: "Gi0/1" } },
        { id: "leaf1-spine", a: { node: "leaf1", iface: "Gi0/2" }, b: { node: "spine", iface: "Gi0/0" } },
        { id: "leaf2-spine", a: { node: "leaf2", iface: "Gi0/2" }, b: { node: "spine", iface: "Gi0/1" } },
        { id: "spine-leaf3", a: { node: "spine", iface: "Gi0/2" }, b: { node: "leaf3", iface: "Gi0/2" } },
        { id: "leaf3-host-b", a: { node: "leaf3", iface: "Gi0/1" }, b: { node: "host-b", iface: "eth0" } },
      ],
    },
    configurations: {
      "host-a": host("HOST-A", "192.168.10.10"),
      ce: {
        kind: "l2-switch",
        hostname: "CE",
        vlans: [{ id: 10, name: "TENANT-A" }],
        interfaces: ["Gi0/1", "Gi0/2", "Gi0/3"].map((id) => ({
          id, shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1,
        })),
      },
      leaf1: leaf("LEAF1", "10.255.0.1", "192.0.2.1", true),
      leaf2: leaf("LEAF2", "10.255.0.2", "192.0.2.5", true),
      spine: {
        kind: "router",
        hostname: "SPINE",
        interfaces: [
          { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "192.0.2.2", prefixLength: 30 } },
          { id: "Gi0/1", routed: true, shutdown: false, ipv4: { address: "192.0.2.6", prefixLength: 30 } },
          { id: "Gi0/2", routed: true, shutdown: false, ipv4: { address: "192.0.2.10", prefixLength: 30 } },
        ],
        subinterfaces: [],
        staticRoutes: [],
        dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
        loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.9", prefixLength: 32 } }],
        ospf: {
          processId: 1,
          routerId: "10.255.0.9",
          networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
          passiveInterfaces: ["Loopback0"],
          interfaces: ["Gi0/0", "Gi0/1", "Gi0/2"].map((interfaceId) => ({
            interfaceId, networkType: "point-to-point" as const,
          })),
        },
        bgp: {
          localAs: 65_000,
          routerId: "10.255.0.9",
          clusterId: "10.255.0.9",
          networks: [],
          vrfAddressFamilies: [],
          neighbors: ["10.255.0.1", "10.255.0.2", "10.255.0.3"].map((address) => ({
            address,
            remoteAs: 65_000,
            updateSource: "Loopback0",
            evpnActivated: true,
            sendCommunityExtended: true,
            routeReflectorClient: true,
          })),
        },
      },
      leaf3: leaf("LEAF3", "10.255.0.3", "192.0.2.9", false),
      "host-b": host("HOST-B", "192.168.10.20"),
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
  checks: readonly GradingCheck[],
  resultView: "student" | "instructor" = "instructor",
) {
  const document = multihomedFabric();
  const request: VerificationRequest = {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: "evpn-multihoming-spec", checks: [...checks] },
    resultView,
  };
  return verifySubmission(request);
}

/**
 * The MAC the topology gives HOST-A.
 *
 * It is read from a built lab rather than hard-coded: the address is canonical
 * and deterministic, but it belongs to the topology and not to this test.
 */
const hostAMac = (() => {
  const lab = buildLabFromDocument(canonicalizeLabDocument(multihomedFabric()));
  return lab.getPc("host-a")!.interfaces.get("eth0")!.mac;
})();

describe("EVPN multihoming grading", () => {
  it("checks the segment, its ESI, the DF role and both new route types", () => {
    const result = grade([
      check({ type: "evpn-ethernet-segment", configuration: { deviceId: "leaf1", segmentId: "ES-CE1", expectedInterfaces: ["Gi0/1"], expected: "operational" } }),
      check({ type: "evpn-esi", configuration: { deviceId: "leaf2", segmentId: "ES-CE1", esi: ESI } }),
      check({ type: "evpn-df-role", configuration: { deviceId: "leaf1", esi: ESI, vlanId: 10, expectedRole: "df", expectedDesignatedForwarder: "10.255.0.1" } }),
      check({ type: "evpn-df-role", configuration: { deviceId: "leaf2", esi: ESI, vlanId: 10, expectedRole: "non-df" } }),
      check({ type: "evpn-type4-route", configuration: { deviceId: "leaf3", esi: ESI, originatingVtep: "10.255.0.1", expected: "present" } }),
      check({ type: "evpn-type1-route", configuration: { deviceId: "leaf3", esi: ESI, scope: "per-es", originatingVtep: "10.255.0.2", expected: "present" } }),
      check({ type: "evpn-type1-route", configuration: { deviceId: "leaf3", esi: ESI, scope: "per-evi", vni: VNI, expected: "present" } }),
    ]);
    expect(result.checks.every((entry) => entry.status === "passed"), JSON.stringify(result.checks)).toBe(true);
  });

  it("grades the primary and backup a multihomed MAC keeps", () => {
    const result = grade([
      check({ type: "vxlan-l2-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20", expected: "success", requireEncapsulation: true } }),
      check({ type: "evpn-multihoming-primary", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, expectedPrimary: "10.255.0.1", expectedEsi: ESI, expected: "present" } }),
      check({ type: "evpn-multihoming-backup", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, expectedBackup: "10.255.0.2", minimumBackups: 1 } }),
      check({ type: "evpn-split-horizon", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20", nonDesignatedDeviceId: "leaf2" } }),
    ]);
    expect(result.checks.map((entry) => `${entry.id}:${entry.status}`)).toEqual([
      "check-vxlan-l2-connectivity:passed",
      "check-evpn-multihoming-primary:passed",
      "check-evpn-multihoming-backup:passed",
      "check-evpn-split-horizon:passed",
    ]);
  });

  it("grades the failover as one bounded deterministic action", () => {
    const result = grade([
      check({
        type: "evpn-single-active-failover",
        configuration: {
          sourceDeviceId: "host-a",
          destinationIp: "192.168.10.20",
          failDeviceId: "leaf1",
          failInterfaceId: "Gi0/1",
          expectedNewDesignatedForwarderDeviceId: "leaf2",
          requireMassWithdraw: true,
        },
      }),
    ]);
    expect(result.checks[0]?.status, JSON.stringify(result.checks[0])).toBe("passed");
    expect(result.checks[0]?.diagnostics).toMatchObject({
      beforeFailure: true,
      afterFailure: true,
      massWithdrawn: true,
    });
  });

  it("never echoes a hidden ESI or candidate list into a student result", () => {
    const result = grade([
      check({ type: "evpn-esi", configuration: { deviceId: "leaf1", segmentId: "ES-CE1", esi: ESI } }, "hidden"),
      check({ type: "evpn-df-role", configuration: { deviceId: "leaf1", esi: ESI, vlanId: 10, expectedRole: "df", expectedDesignatedForwarder: "10.255.0.1" } }, "hidden"),
    ], "student");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ESI);
    expect(serialized).not.toContain("10.255.0.1");
    expect(serialized).not.toContain("ES-CE1");
  });
});

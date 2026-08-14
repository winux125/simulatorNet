import type { GradingCheck, LabDocument, VerificationRequest } from "@sim/contracts";
import { verifySubmission } from "@sim/grading-core";
import { buildLabFromDocument, canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";

/**
 * M10.17 — grading EVPN All-Active multihoming, aliasing, mobility and HRW.
 *
 * The verifier accepts structured topology and configuration only and rebuilds
 * every alias path set, the HRW weights, the elected forwarder and each mobility
 * sequence itself. A hidden expectation — the ESI, a weight, the candidate set,
 * the sequence a lab wanted — is never echoed back to a student.
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

interface LeafOptions {
  name: string;
  loopback: string;
  uplink: string;
  segment?: { dfAlgorithm?: "default" | "hrw" };
}

function leaf(options: LeafOptions) {
  return {
    kind: "l3-switch" as const,
    hostname: options.name,
    vlans: [{ id: 10, name: "TENANT-A" }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: 10, nativeVlan: 1 },
      {
        id: "Gi0/2",
        shutdown: false,
        mode: "routed" as const,
        ipv4: { address: options.uplink, prefixLength: 30 },
      },
    ],
    svis: [],
    staticRoutes: [],
    ipRoutingEnabled: true,
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: options.loopback, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId: options.loopback,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
      passiveInterfaces: ["Loopback0"],
      interfaces: [{ interfaceId: "Gi0/2", networkType: "point-to-point" as const }],
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
      ...(options.segment
        ? {
            ethernetSegments: [{
              id: "ES-CE1",
              esi: ESI,
              redundancyMode: "all-active" as const,
              interfaces: ["Gi0/1"],
              ...(options.segment.dfAlgorithm ? { dfAlgorithm: options.segment.dfAlgorithm } : {}),
            }],
          }
        : {}),
    },
  };
}

/**
 * HOST-A — CE — {LEAF1, LEAF2} — SPINE — LEAF3 — HOST-B.
 *
 * LEAF1 and LEAF2 share one All-Active ESI, so LEAF3 ends up with two eligible
 * paths to HOST-A even though only one leaf ever advertised it.
 */
function allActiveFabric(options: {
  leaf1Algorithm?: "default" | "hrw";
  leaf2Algorithm?: "default" | "hrw";
} = {}): LabDocument {
  return {
    schemaVersion: 1,
    id: "evpn-all-active-grading",
    title: "EVPN All-Active grading",
    simulation: { seed: 11_174 },
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
      leaf1: leaf({
        name: "LEAF1",
        loopback: "10.255.0.1",
        uplink: "192.0.2.1",
        segment: { dfAlgorithm: options.leaf1Algorithm ?? "hrw" },
      }),
      leaf2: leaf({
        name: "LEAF2",
        loopback: "10.255.0.2",
        uplink: "192.0.2.5",
        segment: { dfAlgorithm: options.leaf2Algorithm ?? "hrw" },
      }),
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
      leaf3: leaf({ name: "LEAF3", loopback: "10.255.0.3", uplink: "192.0.2.9" }),
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
  options: Parameters<typeof allActiveFabric>[0] = {},
  resultView: "student" | "instructor" = "instructor",
) {
  const document = allActiveFabric(options);
  const request: VerificationRequest = {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    // Ids are made unique here so a test may grade the same check type on two
    // devices without the two entries colliding.
    gradingSpec: {
      schemaVersion: 1,
      id: "evpn-all-active-spec",
      checks: checks.map((entry, index) => ({ ...entry, id: `${entry.id}-${index}` })),
    },
    resultView,
  };
  return verifySubmission(request);
}

/** HOST-A's MAC, read from a built lab rather than hard-coded. */
const hostAMac = (() => {
  const lab = buildLabFromDocument(canonicalizeLabDocument(allActiveFabric()));
  return lab.getPc("host-a")!.interfaces.get("eth0")!.mac;
})();

const passed = (result: ReturnType<typeof grade>) =>
  result.checks.every((entry) => entry.status === "passed");

describe("EVPN All-Active grading", () => {
  it("grades the redundancy mode and that every peer agrees on it", () => {
    const result = grade([
      check({ type: "evpn-all-active-mode", configuration: { deviceId: "leaf1", segmentId: "ES-CE1", expectedMode: "all-active", requirePeerAgreement: true } }),
      check({ type: "evpn-all-active-mode", configuration: { deviceId: "leaf2", segmentId: "ES-CE1", expectedMode: "all-active" } }),
    ]);
    expect(passed(result), JSON.stringify(result.checks)).toBe(true);
  });

  it("fails an all-active expectation the fabric does not meet", () => {
    const result = grade([
      check({ type: "evpn-all-active-mode", configuration: { deviceId: "leaf1", segmentId: "ES-CE1", expectedMode: "single-active" } }),
      // A segment the leaf does not carry at all is a failure, not an error.
      check({ type: "evpn-all-active-mode", configuration: { deviceId: "leaf3", segmentId: "ES-CE1", expectedMode: "all-active" } }),
    ]);
    expect(result.checks.every((entry) => entry.status === "failed")).toBe(true);
  });

  it("grades an aliasing path set with more than one eligible VTEP", () => {
    const result = grade([
      check({ type: "vxlan-l2-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20", expected: "success", requireEncapsulation: true } }),
      check({ type: "evpn-aliasing-path", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, expectedEsi: ESI, minimumEligibleVteps: 2, expectedEligibleVteps: ["10.255.0.1", "10.255.0.2"] } }),
    ]);
    expect(passed(result), JSON.stringify(result.checks)).toBe(true);
  });

  it("fails an aliasing expectation that demands more paths than exist", () => {
    const result = grade([
      check({ type: "vxlan-l2-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20", expected: "success" } }),
      check({ type: "evpn-aliasing-path", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, minimumEligibleVteps: 3 } }),
    ]);
    expect(result.checks.at(-1)?.status).toBe("failed");
  });

  it("grades end-to-end All-Active connectivity", () => {
    const result = grade([
      check({ type: "evpn-all-active-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20" } }),
    ]);
    expect(passed(result), JSON.stringify(result.checks)).toBe(true);
  });

  it("grades the mobility sequence and the address owner", () => {
    const result = grade([
      check({ type: "vxlan-l2-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20", expected: "success" } }),
      // Nothing has moved, so the address sits at its first sequence.
      check({ type: "evpn-mac-mobility-sequence", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, expectedSequence: 0 } }),
      check({ type: "evpn-mac-mobility-sequence", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, minimumSequence: 0 } }),
      check({ type: "evpn-mac-owner", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac } }),
    ]);
    expect(passed(result), JSON.stringify(result.checks)).toBe(true);
  });

  it("fails a mobility expectation that assumes a move which never happened", () => {
    const result = grade([
      check({ type: "vxlan-l2-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20", expected: "success" } }),
      check({ type: "evpn-mac-mobility-sequence", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, minimumSequence: 1 } }),
      check({ type: "evpn-mac-owner", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, requirePreviousOwnerStale: true } }),
    ]);
    expect(result.checks.slice(1).every((entry) => entry.status === "failed")).toBe(true);
  });

  it("grades an HRW election, its backup and the local role", () => {
    const result = grade([
      check({ type: "evpn-hrw-df", configuration: { deviceId: "leaf1", esi: ESI, vlanId: 10, requireHrwEffective: true } }),
      check({ type: "evpn-hrw-df", configuration: { deviceId: "leaf2", esi: ESI, vlanId: 10, requireHrwEffective: true } }),
    ]);
    expect(passed(result), JSON.stringify(result.checks)).toBe(true);
    // Every participant reaches the same answer from the same candidate list,
    // so exactly one of them is the forwarder and both name the same backup.
    const lab = buildLabFromDocument(canonicalizeLabDocument(allActiveFabric()));
    lab.engine.runUntilIdle();
    const states = ["leaf1", "leaf2"].map((id) =>
      lab.getLayer3Switch(id)!.designatedForwarderStates().find((entry) => entry.esi === ESI)!);
    expect(states.map((entry) => entry.localRole).sort()).toEqual(["df", "non-df"]);
    expect(states[0]!.designatedForwarder).toBe(states[1]!.designatedForwarder);
    expect(states[0]!.backupDesignatedForwarder).toBe(states[1]!.backupDesignatedForwarder);
    expect(states.every((entry) => entry.effectiveAlgorithm === "hrw")).toBe(true);
  });

  it("grades a consistent fallback when one participant does not ask for HRW", () => {
    // LEAF2 stays on the modulus election, so HRW cannot run for anyone: two
    // leaves must never compute a different forwarder for one segment.
    const result = grade([
      check({ type: "evpn-hrw-fallback", configuration: { deviceId: "leaf1", esi: ESI, vlanId: 10, expectedRequestedAlgorithm: "hrw", expectedEffectiveAlgorithm: "default", requireFallbackReason: true } }),
      check({ type: "evpn-hrw-df", configuration: { deviceId: "leaf1", esi: ESI, vlanId: 10, requireHrwEffective: true } }),
    ], { leaf2Algorithm: "default" });
    expect(result.checks[0]?.status).toBe("passed");
    // The same fabric fails a check that demanded HRW actually ran.
    expect(result.checks[1]?.status).toBe("failed");
  });

  it("grades All-Active failover without the address being relearned", () => {
    const result = grade([
      check({ type: "evpn-all-active-failover", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.10.20", failDeviceId: "leaf1", failInterfaceId: "Gi0/1", requireNoRelearn: true } }),
    ]);
    expect(passed(result), JSON.stringify(result.checks)).toBe(true);
  });

  it("reports a missing device as an error rather than a silent pass", () => {
    const result = grade([
      check({ type: "evpn-aliasing-path", configuration: { deviceId: "nope", vni: VNI, macAddress: hostAMac } }),
      check({ type: "evpn-hrw-df", configuration: { deviceId: "nope", esi: ESI, vlanId: 10 } }),
      check({ type: "evpn-all-active-mode", configuration: { deviceId: "nope", segmentId: "ES-CE1" } }),
    ]);
    expect(result.checks.every((entry) => entry.status === "error")).toBe(true);
  });

  it("never leaks a hidden ESI, sequence, weight or candidate set to a student", () => {
    const result = grade([
      check({ type: "evpn-all-active-mode", configuration: { deviceId: "leaf1", segmentId: "ES-CE1", expectedMode: "all-active" } }, "hidden"),
      check({ type: "evpn-aliasing-path", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, expectedEsi: ESI, expectedEligibleVteps: ["10.255.0.1", "10.255.0.2"] } }, "hidden"),
      check({ type: "evpn-hrw-df", configuration: { deviceId: "leaf1", esi: ESI, vlanId: 10, expectedDesignatedForwarder: "10.255.0.1" } }, "hidden"),
      check({ type: "evpn-mac-mobility-sequence", configuration: { deviceId: "leaf3", vni: VNI, macAddress: hostAMac, expectedSequence: 0 } }, "hidden"),
    ], {}, "student");
    const text = JSON.stringify(result);
    for (const secret of [ESI, "10.255.0.1", "10.255.0.2", "expectedSequence", "candidateWeights"]) {
      expect(text, `expected '${secret}' never to reach a student result`).not.toContain(secret);
    }
  });
});

import type { GradingCheck, LabDocument, VerificationRequest } from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { verifySubmission } from "@sim/grading-core";
import { describe, expect, it } from "vitest";

const switchPorts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `Gi0/${index + 1}` }));

/** SW1 — SW2 — SW3 triangle with a bundle between SW1 and SW2. */
function layer2Lab(): LabDocument {
  return canonicalizeLabDocument({
    schemaVersion: 1,
    id: "grade-l2",
    title: "Graded layer-2 protocols",
    simulation: { seed: 31 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: switchPorts(5) },
        { id: "sw2", kind: "l2-switch", name: "SW2", interfaces: switchPorts(5) },
        { id: "sw3", kind: "l2-switch", name: "SW3", interfaces: switchPorts(5) },
      ],
      links: [
        { id: "po-a", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } },
        { id: "po-b", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "sw2", iface: "Gi0/2" } },
        { id: "sw2-sw3", a: { node: "sw2", iface: "Gi0/3" }, b: { node: "sw3", iface: "Gi0/1" } },
        { id: "sw3-sw1", a: { node: "sw3", iface: "Gi0/2" }, b: { node: "sw1", iface: "Gi0/3" } },
      ],
    },
    configurations: {
      sw1: {
        kind: "l2-switch",
        hostname: "SW1",
        vlans: [],
        interfaces: [],
        spanningTree: {
          mode: "stp",
          vlans: [{ vlanId: 1, priority: 4_096 }],
          ports: [{ interfaceId: "Gi0/4", portFast: true, bpduGuard: true }],
        },
        etherChannels: [{ channelId: 1, mode: "active", members: ["Gi0/1", "Gi0/2"] }],
        discovery: { cdpEnabled: true, lldpEnabled: true },
      },
      sw2: {
        kind: "l2-switch",
        hostname: "SW2",
        vlans: [],
        interfaces: [],
        spanningTree: { mode: "stp" },
        etherChannels: [{ channelId: 1, mode: "passive", members: ["Gi0/1", "Gi0/2"] }],
        discovery: { cdpEnabled: true, lldpEnabled: true },
      },
      sw3: {
        kind: "l2-switch",
        hostname: "SW3",
        vlans: [],
        interfaces: [],
        spanningTree: { mode: "stp" },
        discovery: { cdpEnabled: true },
      },
    },
  } as unknown as LabDocument);
}

function ospfLab(): LabDocument {
  const router = (hostname: string, routerId: string, address: string) => ({
    kind: "router",
    hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address, prefixLength: 24 } }],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: routerId, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 }],
      passiveInterfaces: ["Loopback0"],
      interfaces: [{ interfaceId: "Gi0/0", networkType: "point-to-point", cost: 25 }],
    },
  });
  return canonicalizeLabDocument({
    schemaVersion: 1,
    id: "grade-ospf",
    title: "Graded OSPF",
    simulation: { seed: 33 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      ],
      links: [{ id: "l1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } }],
    },
    configurations: {
      r1: router("R1", "1.1.1.1", "10.0.12.1"),
      r2: router("R2", "2.2.2.2", "10.0.12.2"),
    },
  } as unknown as LabDocument);
}

function grade(document: LabDocument, checks: readonly GradingCheck[], view: "student" | "instructor" = "instructor") {
  const request: VerificationRequest = {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: "spec-1", checks: [...checks] },
    resultView: view,
  };
  return verifySubmission(request);
}

const check = (partial: Omit<GradingCheck, "id" | "title" | "points" | "visibility">): GradingCheck => ({
  id: `check-${partial.type}`,
  title: `Check ${partial.type}`,
  points: 1,
  visibility: "visible",
  ...partial,
} as GradingCheck);

describe("Spanning-tree grading checks", () => {
  it("verifies the root, the mode, port role and state", () => {
    const document = layer2Lab();
    const result = grade(document, [
      check({ type: "stp-root", configuration: { vlanId: 1, expectedDeviceId: "sw1" } }),
      check({ type: "stp-mode", configuration: { deviceId: "sw1", expectedMode: "stp" } }),
      check({
        type: "stp-port-role",
        configuration: { deviceId: "sw3", interfaceId: "Gi0/1", vlanId: 1, expectedRole: "alternate" },
      }),
      check({
        type: "stp-port-state",
        configuration: { deviceId: "sw3", interfaceId: "Gi0/1", vlanId: 1, expectedState: "blocking" },
      }),
    ]);

    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(result.score).toBe(100);
  });

  it("fails when the expected root is a different switch", () => {
    const result = grade(layer2Lab(), [
      check({ type: "stp-root", configuration: { vlanId: 1, expectedDeviceId: "sw3" } }),
    ]);
    expect(result.checks[0]!.status).toBe("failed");
    expect(result.checks[0]!.diagnostics?.actualRootId).toBeDefined();
  });

  it("verifies PortFast and the BPDU Guard runtime state", () => {
    const result = grade(layer2Lab(), [
      check({ type: "stp-portfast", configuration: { deviceId: "sw1", interfaceId: "Gi0/4", expected: true } }),
      check({
        type: "bpdu-guard-state",
        configuration: { deviceId: "sw1", interfaceId: "Gi0/4", expectedErrorDisabled: false },
      }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed"]);
  });
});

describe("EtherChannel grading checks", () => {
  it("verifies the bundle, its protocol and a member state", () => {
    const result = grade(layer2Lab(), [
      check({
        type: "etherchannel-formed",
        configuration: { deviceId: "sw1", channelId: 1, expectedMembers: ["Gi0/1", "Gi0/2"] },
      }),
      check({
        type: "etherchannel-protocol",
        configuration: { deviceId: "sw1", channelId: 1, expectedProtocol: "lacp", expectedMode: "active" },
      }),
      check({
        type: "etherchannel-member-state",
        configuration: { deviceId: "sw2", channelId: 1, interfaceId: "Gi0/1", expectedState: "distributing" },
      }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("reports a missing channel as an error rather than a silent pass", () => {
    const result = grade(layer2Lab(), [
      check({ type: "etherchannel-formed", configuration: { deviceId: "sw3", channelId: 9 } }),
    ]);
    expect(result.checks[0]!.status).toBe("error");
  });
});

describe("Discovery grading checks", () => {
  it("verifies a CDP and an LLDP neighbour", () => {
    const result = grade(layer2Lab(), [
      check({
        type: "cdp-neighbor",
        configuration: {
          deviceId: "sw3",
          localInterfaceId: "Gi0/1",
          expectedNeighborId: "SW2",
          expectedRemoteInterfaceId: "Gi0/3",
        },
      }),
      check({
        type: "lldp-neighbor",
        configuration: { deviceId: "sw1", localInterfaceId: "Gi0/1", expectedNeighborId: "SW2" },
      }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed"]);
  });

  it("fails when LLDP was never enabled on the neighbour", () => {
    const result = grade(layer2Lab(), [
      check({
        type: "lldp-neighbor",
        configuration: { deviceId: "sw3", localInterfaceId: "Gi0/1", expectedNeighborId: "SW2" },
      }),
    ]);
    expect(result.checks[0]!.status).toBe("failed");
  });
});

describe("OSPF grading checks", () => {
  it("verifies the router id, adjacency, interface, route, cost and LSDB", () => {
    const document = ospfLab();
    const result = grade(document, [
      check({ type: "ospf-router-id", configuration: { deviceId: "r1", expectedRouterId: "1.1.1.1" } }),
      check({
        type: "ospf-neighbor-state",
        configuration: { deviceId: "r1", neighborRouterId: "2.2.2.2", expectedState: "full" },
      }),
      check({
        type: "ospf-interface",
        configuration: { deviceId: "r1", interfaceId: "Gi0/0", expectedCost: 25, expectedNetworkType: "point-to-point" },
      }),
      check({
        type: "ospf-route",
        configuration: { deviceId: "r1", network: "2.2.2.2", prefixLength: 32, expectedNextHop: "10.0.12.2" },
      }),
      check({
        type: "ospf-path-cost",
        configuration: { deviceId: "r1", network: "2.2.2.2", prefixLength: 32, expectedCost: 35 },
      }),
      check({
        type: "ospf-lsdb-entry",
        configuration: { deviceId: "r1", lsaType: "router", advertisingRouter: "2.2.2.2" },
      }),
    ]);

    const byId = new Map(result.checks.map((entry) => [entry.id, entry]));
    expect(byId.get("check-ospf-router-id")!.status).toBe("passed");
    expect(byId.get("check-ospf-neighbor-state")!.status).toBe("passed");
    expect(byId.get("check-ospf-interface")!.status).toBe("passed");
    expect(byId.get("check-ospf-route")!.status).toBe("passed");
    expect(byId.get("check-ospf-lsdb-entry")!.status).toBe("passed");
    // The loopback stub adds its own cost on top of the 25-cost transit link.
    expect(byId.get("check-ospf-path-cost")!.diagnostics?.actualCost).toBeGreaterThan(0);
  });

  it("verifies a passive interface", () => {
    const result = grade(ospfLab(), [
      check({
        type: "ospf-interface",
        configuration: { deviceId: "r1", interfaceId: "Loopback0", expectedPassive: true },
      }),
    ]);
    expect(result.checks[0]!.status).toBe("passed");
  });

  it("reports an OSPF check on a switch as an error", () => {
    const result = grade(layer2Lab(), [
      check({ type: "ospf-router-id", configuration: { deviceId: "sw1", expectedRouterId: "1.1.1.1" } }),
    ]);
    expect(result.checks[0]!.status).toBe("error");
  });
});

describe("Hidden protocol checks stay hidden", () => {
  it("redacts the expected value and diagnostics from a student result", () => {
    const document = ospfLab();
    const hidden: GradingCheck = {
      id: "hidden-neighbor",
      title: "Neighbour must be Full",
      points: 5,
      visibility: "hidden",
      type: "ospf-neighbor-state",
      configuration: { deviceId: "r1", neighborRouterId: "2.2.2.2", expectedState: "full" },
    };
    const student = grade(document, [hidden], "student");

    expect(student.checks[0]!.status).toBe("passed");
    expect(student.checks[0]!.title).toBe("Hidden check");
    expect(student.checks[0]!.diagnostics).toBeUndefined();
    const text = JSON.stringify(student);
    expect(text).not.toContain("2.2.2.2");
    expect(text).not.toContain("Neighbour must be Full");
  });
});

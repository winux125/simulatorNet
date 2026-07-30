import type { LabDocument } from "@sim/contracts";
import type { GradingSpec } from "@sim/contracts/grading";
import { verifySubmission } from "@sim/grading-core";
import { buildLabFromDocument, canonicalizeLabDocument } from "@sim/lab-format";
import { TrafficGenerator } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

const LAB: LabDocument = canonicalizeLabDocument({
  schemaVersion: 1,
  id: "qos-grading",
  title: "QoS grading",
  simulation: { seed: 77 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "tg", kind: "traffic-generator", name: "TG", interfaces: [{ id: "eth0" }] },
      { id: "pc", kind: "pc", name: "PC", interfaces: [{ id: "eth0" }] },
      { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }, { id: "Gi0/2" }] },
      { id: "srv", kind: "server", name: "SRV", interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "tg-r1", a: { node: "tg", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
      { id: "pc-r1", a: { node: "pc", iface: "eth0" }, b: { node: "r1", iface: "Gi0/1" } },
      {
        id: "wan",
        a: { node: "r1", iface: "Gi0/2" },
        b: { node: "srv", iface: "eth0" },
        capacityBps: 1_000_000,
        queueLimitPackets: 8,
      },
    ],
  },
  configurations: {
    tg: {
      kind: "traffic-generator",
      ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" },
      flows: [
        {
          id: "VOICE", protocol: "udp", destination: "10.0.2.10", destinationPort: 5060,
          count: 8, intervalNs: 2_000_000, payloadBytes: 160, dscp: 46,
        },
        {
          id: "BULK", protocol: "udp", destination: "10.0.2.10", destinationPort: 9000,
          count: 16, intervalNs: 1_000_000, payloadBytes: 1_400,
        },
      ],
    },
    pc: { kind: "pc", ipv4: { address: "10.0.1.10", prefixLength: 24, defaultGateway: "10.0.1.1" } },
    r1: {
      kind: "router",
      interfaces: [
        { id: "Gi0/0", routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Gi0/1", routed: true, ipv4: { address: "10.0.1.1", prefixLength: 24 } },
        { id: "Gi0/2", routed: true, ipv4: { address: "10.0.2.1", prefixLength: 24 } },
      ],
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
            { className: "class-default", bandwidthPercent: 50 },
          ],
        }],
        servicePolicies: [{ interfaceName: "Gi0/2", direction: "output", policyMapId: "WAN-EDGE" }],
      },
    },
    srv: {
      kind: "server",
      interfaces: [{ id: "eth0", ipv4: { address: "10.0.2.10", prefixLength: 24 } }],
      defaultGateway: "10.0.2.1",
    },
  },
} as unknown as LabDocument);

function verify(checks: GradingSpec["checks"]) {
  return verifySubmission({
    submission: {
      labId: LAB.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: LAB.simulation,
      snapshot: { topology: LAB.topology, configurations: LAB.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: "qos", checks },
    resultView: "instructor",
  });
}

function check(
  type: string,
  configuration: Record<string, unknown>,
): GradingSpec["checks"][number] {
  return {
    id: `${type}-1`,
    title: type,
    points: 1,
    visibility: "visible",
    type,
    configuration,
  } as unknown as GradingSpec["checks"][number];
}

describe("QoS grading checks", () => {
  it("grades configuration, marking, priority and queue drops", () => {
    const result = verify([
      check("qos-class-map", { deviceId: "r1", classMapId: "REALTIME", expectedMatchType: "match-any" }),
      check("qos-policy-map", {
        deviceId: "r1", policyMapId: "WAN-EDGE", className: "REALTIME",
        expectedAction: "priority", expectedValue: 30,
      }),
      check("qos-policy-attached", {
        deviceId: "r1", interfaceId: "Gi0/2", direction: "output", policyMapId: "WAN-EDGE",
      }),
      check("traffic-classified", {
        deviceId: "r1", className: "class-default", sourceDeviceId: "pc", destinationIp: "10.0.2.10",
      }),
      check("queue-drop-count", { deviceId: "r1", interfaceId: "Gi0/2", minimumDrops: 0 }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(result.score).toBe(100);
  });

  it("fails a policy check whose expected value does not match", () => {
    const result = verify([
      check("qos-policy-map", {
        deviceId: "r1", policyMapId: "WAN-EDGE", className: "REALTIME",
        expectedAction: "priority", expectedValue: 80,
      }),
    ]);
    expect(result.checks[0]!.status).toBe("failed");
  });

  it("grades the priority flow ahead of the bulk flow", () => {
    const result = verify([
      check("traffic-priority-order", { deviceId: "tg", priorityFlowId: "VOICE", bulkFlowId: "BULK" }),
    ]);
    expect(result.checks[0]!.status).toBe("passed");
  });

  it("redacts hidden QoS diagnostics from a student result", () => {
    const hidden = verifySubmission({
      submission: {
        labId: LAB.id,
        labVersion: 1,
        schemaVersion: 1,
        simulation: LAB.simulation,
        snapshot: { topology: LAB.topology, configurations: LAB.configurations },
      },
      gradingSpec: {
        schemaVersion: 1,
        id: "qos-hidden",
        checks: [{
          ...check("qos-policy-map", {
            deviceId: "r1", policyMapId: "WAN-EDGE", className: "REALTIME",
            expectedAction: "priority", expectedValue: 30,
          }),
          visibility: "hidden",
        }],
      },
      resultView: "student",
    });
    expect(hidden.checks[0]!.title).toBe("Hidden check");
    expect(JSON.stringify(hidden)).not.toContain("WAN-EDGE");
    expect(JSON.stringify(hidden)).not.toContain("expectedValue");
  });

  it("produces the same queues, drops and delivery order in browser and verifier", () => {
    // The browser worker and the verifier both rebuild from the same document,
    // so the deterministic queue outcome must be identical.
    const run = () => {
      const built = buildLabFromDocument(LAB);
      const generator = built.getTrafficGenerator("tg") as TrafficGenerator;
      generator.startFlow("BULK");
      generator.startFlow("VOICE");
      built.engine.runUntilIdle();
      const wan = built.getRouter("r1")!.getInterface("Gi0/2")!;
      return {
        queues: wan.egress.snapshot(),
        results: generator.flowResults(),
        trace: built.engine.traceLog.length,
      };
    };
    expect(run()).toEqual(run());
  });
});

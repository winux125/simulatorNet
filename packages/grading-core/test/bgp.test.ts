import type { LabDocument } from "@sim/contracts";
import type { GradingCheck, VerificationRequest } from "@sim/contracts/grading";
import { verifySubmission } from "@sim/grading-core";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { submissionFrom } from "./fixtures";

function lab(): LabDocument {
  const router = (hostname: string, address: string, localAs: number, remoteAddress: string, remoteAs: number, prefix: string, policy = false) => ({
    kind: "router" as const, hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address, prefixLength: 30 } }],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: `${prefix}.1`, prefixLength: 24 } }],
    prefixLists: policy ? [{ id: "REMOTE", entries: [{ sequence: 10, action: "permit" as const, prefix: "10.2.0.0", prefixLength: 24 }] }] : [],
    routeMaps: policy ? [{ id: "REMOTE-IN", sequences: [{ sequence: 10, action: "permit" as const, match: { prefixListIds: ["REMOTE"] }, set: { localPreference: 175 } }] }] : [],
    bgp: {
      localAs, routerId: localAs === 65_001 ? "1.1.1.1" : "2.2.2.2",
      neighbors: [{ address: remoteAddress, remoteAs, enabled: true, ...(policy ? { prefixListIn: "REMOTE", routeMapIn: "REMOTE-IN" } : {}) }],
      networks: [{ network: `${prefix}.0`, prefixLength: 24 }],
    },
  });
  return canonicalizeLabDocument({
    schemaVersion: 1, id: "grade-bgp", title: "Grade BGP", simulation: { seed: 110 },
    topology: { schemaVersion: 1, nodes: [
      { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
      { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }] },
    ], links: [{ id: "r1-r2", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } }] },
    configurations: {
      r1: router("R1", "192.0.2.1", 65_001, "192.0.2.2", 65_002, "10.1.0", true),
      r2: router("R2", "192.0.2.2", 65_002, "192.0.2.1", 65_001, "10.2.0"),
    },
  } as unknown as LabDocument);
}

function check(value: Omit<GradingCheck, "id" | "title" | "points" | "visibility">, visibility: "hidden" | "visible" = "visible"): GradingCheck {
  return { ...value, id: value.type, title: value.type, points: 1, visibility } as GradingCheck;
}

function grade(checks: readonly GradingCheck[], resultView: "student" | "instructor" = "instructor") {
  return verifySubmission({
    submission: submissionFrom(lab()), gradingSpec: { schemaVersion: 1, id: "bgp", checks }, resultView,
  } satisfies VerificationRequest);
}

describe("BGP grading checks", () => {
  it("verifies process identity, Established state and network statements", () => {
    const result = grade([
      check({ type: "bgp-local-as", configuration: { deviceId: "r1", expectedLocalAs: 65_001 } }),
      check({ type: "bgp-neighbor-state", configuration: { deviceId: "r1", neighborAddress: "192.0.2.2", expectedState: "established" } }),
      check({ type: "bgp-network", configuration: { deviceId: "r1", network: "10.1.0.0", prefixLength: 24 } }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("verifies installed route, best path and next hop", () => {
    const result = grade([
      check({ type: "bgp-route", configuration: { deviceId: "r1", network: "10.2.0.0", prefixLength: 24, expectedNextHop: "192.0.2.2", expectedAdministrativeDistance: 20 } }),
      check({ type: "bgp-best-path", configuration: { deviceId: "r1", network: "10.2.0.0", prefixLength: 24, expectedNeighborAddress: "192.0.2.2", expectedAsPath: [65_002] } }),
      check({ type: "bgp-next-hop", configuration: { deviceId: "r1", network: "10.2.0.0", prefixLength: 24, expectedNextHop: "192.0.2.2" } }),
    ]);
    expect(result.checks.every((entry) => entry.status === "passed")).toBe(true);
  });

  it("verifies prefix-list, route-map and accepted/received route state", () => {
    const result = grade([
      check({ type: "prefix-list-entry", configuration: { deviceId: "r1", prefixListId: "REMOTE", sequence: 10, expectedAction: "permit" } }),
      check({ type: "route-map-sequence", configuration: { deviceId: "r1", routeMapId: "REMOTE-IN", sequence: 10, expectedAction: "permit" } }),
      check({ type: "route-policy-result", configuration: { deviceId: "r1", neighborAddress: "192.0.2.2", direction: "in", network: "10.2.0.0", prefixLength: 24, expected: "permitted" } }),
      check({ type: "bgp-received-route", configuration: { deviceId: "r1", neighborAddress: "192.0.2.2", network: "10.2.0.0", prefixLength: 24 } }),
      check({ type: "bgp-advertised-route", configuration: { deviceId: "r1", neighborAddress: "192.0.2.2", network: "10.1.0.0", prefixLength: 24 } }),
    ]);
    expect(result.checks.every((entry) => entry.status === "passed")).toBe(true);
  });

  it("fails a wrong expectation rather than trusting the browser", () => {
    const result = verifySubmission({
      submission: submissionFrom(lab()),
      gradingSpec: { schemaVersion: 1, id: "wrong", checks: [check({ type: "bgp-local-as", configuration: { deviceId: "r1", expectedLocalAs: 64_512 } })] },
      resultView: "instructor", score: 100,
    });
    expect(result.score).toBe(0);
    expect(result.checks[0]?.status).toBe("failed");
  });

  it("redacts hidden BGP policy expectations from the student result", () => {
    const result = grade([check({ type: "route-policy-result", configuration: { deviceId: "r1", neighborAddress: "192.0.2.2", direction: "in", network: "10.2.0.0", prefixLength: 24, expected: "permitted" } }, "hidden")], "student");
    const text = JSON.stringify(result);
    expect(result.checks[0]).toMatchObject({ title: "Hidden check", message: "Hidden check passed" });
    expect(text).not.toContain("192.0.2.2");
    expect(text).not.toContain("10.2.0.0");
  });
});

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

/**
 * RR with two clients that never peer with each other; CLIENT1 tags its prefix
 * so one lab exercises reflection, communities, policy lists and aggregation.
 */
function reflectorLab(): LabDocument {
  const spoke = (hostname: string, routerId: string, slot: number, prefix: string, tag?: string) => ({
    kind: "router" as const, hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: `10.0.${slot}.2`, prefixLength: 30 } }],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: `${prefix}.1`, prefixLength: 24 } }],
    communityLists: tag ? [{ id: "TAGGED", entries: [{ sequence: 10, action: "permit" as const, communities: [tag] }] }] : undefined,
    asPathLists: [{ id: "LOCAL", entries: [{ sequence: 10, action: "permit" as const, matcher: { kind: "empty" as const } }] }],
    routeMaps: tag ? [{ id: "TAG-OUT", sequences: [{ sequence: 10, action: "permit" as const, set: { communities: [tag] } }] }] : [],
    bgp: {
      localAs: 65_000, routerId,
      neighbors: [{
        address: `10.0.${slot}.1`, remoteAs: 65_000, enabled: true,
        sendCommunityStandard: true, ...(tag ? { routeMapOut: "TAG-OUT" } : {}),
      }],
      networks: [{ network: `${prefix}.0`, prefixLength: 24 }],
      aggregates: tag ? [{ prefix: "172.16.0.0", prefixLength: 16, summaryOnly: true }] : undefined,
    },
  });
  return canonicalizeLabDocument({
    schemaVersion: 1, id: "grade-rr", title: "Grade RR", simulation: { seed: 111 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "client1", kind: "router", name: "CLIENT1", interfaces: [{ id: "Gi0/0" }] },
        { id: "client2", kind: "router", name: "CLIENT2", interfaces: [{ id: "Gi0/0" }] },
        { id: "rr", kind: "router", name: "RR", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      ],
      links: [
        { id: "c1-rr", a: { node: "client1", iface: "Gi0/0" }, b: { node: "rr", iface: "Gi0/0" } },
        { id: "c2-rr", a: { node: "client2", iface: "Gi0/0" }, b: { node: "rr", iface: "Gi0/1" } },
      ],
    },
    configurations: {
      client1: spoke("CLIENT1", "1.1.1.1", 1, "172.16.1", "65000:100"),
      client2: spoke("CLIENT2", "2.2.2.2", 2, "172.16.2"),
      rr: {
        kind: "router", hostname: "RR",
        interfaces: [
          { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.1.1", prefixLength: 30 } },
          { id: "Gi0/1", routed: true, shutdown: false, ipv4: { address: "10.0.2.1", prefixLength: 30 } },
        ],
        bgp: {
          localAs: 65_000, routerId: "10.255.0.1", clusterId: "10.255.0.1",
          neighbors: [
            { address: "10.0.1.2", remoteAs: 65_000, enabled: true, routeReflectorClient: true, sendCommunityStandard: true },
            { address: "10.0.2.2", remoteAs: 65_000, enabled: true, routeReflectorClient: true, sendCommunityStandard: true, defaultOriginate: true },
          ],
          networks: [],
        },
      },
    },
  } as unknown as LabDocument);
}

function gradeReflector(checks: readonly GradingCheck[], resultView: "student" | "instructor" = "instructor") {
  return verifySubmission({
    submission: submissionFrom(reflectorLab()), gradingSpec: { schemaVersion: 1, id: "rr", checks }, resultView,
  } satisfies VerificationRequest);
}

describe("M10.12 BGP grading checks", () => {
  it("verifies reflection identity, the reflected path and its community", () => {
    const result = gradeReflector([
      check({ type: "bgp-route-reflector-client", configuration: { deviceId: "rr", neighborAddress: "10.0.1.2" } }),
      check({ type: "bgp-cluster-id", configuration: { deviceId: "rr", expectedClusterId: "10.255.0.1" } }),
      // CLIENT1 advertises only its summary, so that is the path RR reflects.
      check({ type: "bgp-route-reflected", configuration: { deviceId: "client2", network: "172.16.0.0", prefixLength: 16, expectedOriginatorId: "1.1.1.1", expectedClusterId: "10.255.0.1" } }),
      check({ type: "bgp-community", configuration: { deviceId: "client2", network: "172.16.0.0", prefixLength: 16, expectedCommunity: "65000:100", expected: "present" } }),
    ]);
    expect(result.checks.map((entry) => `${entry.id}:${entry.status}`)).toEqual([
      "bgp-route-reflector-client:passed",
      "bgp-cluster-id:passed",
      "bgp-route-reflected:passed",
      "bgp-community:passed",
    ]);
  });

  it("verifies policy lists, aggregation, suppression and per-neighbor default-originate", () => {
    const result = gradeReflector([
      check({ type: "bgp-community-list", configuration: { deviceId: "client1", communityListId: "TAGGED", sequence: 10, expectedAction: "permit" } }),
      check({ type: "bgp-as-path-list", configuration: { deviceId: "client1", asPathListId: "LOCAL", sequence: 10, expectedAction: "permit" } }),
      check({ type: "bgp-route-policy-result", configuration: { deviceId: "client1", routeMapId: "TAG-OUT", sequence: 10 } }),
      check({ type: "bgp-aggregate", configuration: { deviceId: "client1", network: "172.16.0.0", prefixLength: 16, expectedSummaryOnly: true, expectedActive: true } }),
      check({ type: "bgp-specific-suppressed", configuration: { deviceId: "client1", network: "172.16.1.0", prefixLength: 24 } }),
      check({ type: "bgp-default-advertised", configuration: { deviceId: "rr", neighborAddress: "10.0.2.2", expected: "advertised" } }),
      check({ type: "bgp-default-advertised", configuration: { deviceId: "rr", neighborAddress: "10.0.1.2", expected: "withheld" } }),
    ]);
    expect(result.checks.filter((entry) => entry.status !== "passed")).toEqual([]);
  });

  it("keeps hidden expected communities out of a student result", () => {
    const result = gradeReflector([check({
      type: "bgp-community",
      configuration: { deviceId: "client2", network: "172.16.0.0", prefixLength: 16, expectedCommunity: "65000:100", expected: "present" },
    }, "hidden")], "student");
    const text = JSON.stringify(result);
    expect(result.checks[0]).toMatchObject({ title: "Hidden check" });
    expect(text).not.toContain("65000:100");
    expect(text).not.toContain("172.16.0.0");
  });
});

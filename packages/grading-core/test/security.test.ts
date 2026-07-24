import type { GradingCheck, GradingSpec } from "@sim/contracts/grading";
import { verifySubmission } from "@sim/grading-core";
import {
  DMZ_FIREWALL_DEMO,
  PACKET_LOSS_DEMO,
  PAT_INTERNET_DEMO,
  STANDARD_ACL_DEMO,
} from "../../../apps/web/src/fixtures/security-demo-labs";
import { describe, expect, it } from "vitest";
import { clone, submissionFrom } from "./fixtures";

function spec(id: string, checks: GradingCheck[]): GradingSpec {
  return { schemaVersion: 1, id, checks };
}

const identity = (id: string, title: string, visibility: "hidden" | "visible" = "visible") => ({
  id,
  title,
  points: 1,
  visibility,
});

describe("M10.3d deterministic security grading", () => {
  it("grades ACL rules, bindings, permitted packets, and denied packets", () => {
    const gradingSpec = spec("acl-security", [
      {
        ...identity("rule", "Permit rule"),
        type: "acl-rule",
        configuration: { deviceId: "router", aclId: "10", sequence: 10, expectedAction: "permit" },
      },
      {
        ...identity("binding", "Outbound binding"),
        type: "acl-binding",
        configuration: { deviceId: "router", interfaceId: "Gi0/2", direction: "out", aclId: "10" },
      },
      {
        ...identity("permit", "Admin permitted"),
        type: "packet-permitted",
        configuration: { sourceDeviceId: "admin", destinationIp: "172.16.0.10" },
      },
      {
        ...identity("deny", "Guest denied", "hidden"),
        type: "packet-denied",
        configuration: { sourceDeviceId: "guest", destinationIp: "172.16.0.10" },
      },
    ]);
    const result = verifySubmission({
      submission: submissionFrom(STANDARD_ACL_DEMO),
      gradingSpec,
      resultView: "instructor",
    });
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
    expect(result.score).toBe(100);
  });

  it("grades PAT configuration, translation creation, and external connectivity", () => {
    const gradingSpec = spec("nat-security", [
      {
        ...identity("nat-rule", "PAT rule"),
        type: "nat-rule",
        configuration: { deviceId: "router", ruleId: "PAT", expectedKind: "pat" },
      },
      {
        ...identity("translation", "PAT translation"),
        type: "nat-translation",
        configuration: {
          deviceId: "router",
          sourceDeviceId: "pc1",
          destinationIp: "203.0.113.10",
          expectedInsideGlobalAddress: "203.0.113.1",
        },
      },
      {
        ...identity("connectivity", "Public reachability"),
        type: "external-connectivity",
        configuration: {
          sourceDeviceId: "pc2",
          destinationIp: "203.0.113.10",
          expected: "success",
        },
      },
    ]);
    const result = verifySubmission({
      submission: submissionFrom(PAT_INTERNET_DEMO),
      gradingSpec,
      resultView: "instructor",
    });
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("grades Firewall policy and stateful session creation", () => {
    const gradingSpec = spec("firewall-security", [
      {
        ...identity("policy", "Inside policy"),
        type: "firewall-rule",
        configuration: { deviceId: "firewall", ruleId: "inside-out", expectedAction: "permit" },
      },
      {
        ...identity("session", "Stateful session"),
        type: "firewall-session",
        configuration: {
          deviceId: "firewall",
          sourceDeviceId: "inside",
          destinationIp: "203.0.113.10",
        },
      },
    ]);
    const result = verifySubmission({
      submission: submissionFrom(DMZ_FIREWALL_DEMO),
      gradingSpec,
      resultView: "instructor",
    });
    expect(result.checks).toEqual([
      expect.objectContaining({ id: "policy", status: "passed" }),
      expect.objectContaining({ id: "session", status: "passed" }),
    ]);
  });

  it("grades a seeded Traffic Generator result", () => {
    const gradingSpec = spec("traffic-security", [{
      ...identity("flow", "WAN ICMP", "hidden"),
      type: "traffic-flow-result",
      configuration: {
        deviceId: "tg",
        flowId: "WAN-ICMP",
        minimumReceived: 1,
        maximumDropped: 7,
      },
    }]);
    const request = {
      submission: submissionFrom(PACKET_LOSS_DEMO),
      gradingSpec,
      resultView: "instructor" as const,
    };
    const first = verifySubmission(request);
    expect(first.checks[0]).toMatchObject({
      id: "flow",
      status: "passed",
      diagnostics: {
        sent: 8,
        minimumReceived: 1,
        maximumDropped: 7,
      },
    });
    expect(verifySubmission(clone(request))).toEqual(first);
  });

  it("redacts new hidden security check details from the student view", () => {
    const gradingSpec = spec("hidden-security", [{
      ...identity("secret-deny", "Guest must not reach protected server", "hidden"),
      type: "packet-denied",
      configuration: { sourceDeviceId: "guest", destinationIp: "172.16.0.10" },
    }]);
    const result = verifySubmission({
      submission: submissionFrom(STANDARD_ACL_DEMO),
      gradingSpec,
      resultView: "student",
    });
    expect(result.checks[0]).toEqual({
      id: "secret-deny",
      title: "Hidden check",
      status: "passed",
      awardedPoints: 1,
      maximumPoints: 1,
      message: "Hidden check passed",
    });
    expect(JSON.stringify(result)).not.toContain("172.16.0.10");
  });
});

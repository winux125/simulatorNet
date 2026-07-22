import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_LIMITS,
  VerificationError,
  VerificationResourceLimitError,
  verifySubmission,
} from "@sim/grading-core";
import { clone, demoLabDocument, gradingSpec, submissionFrom, verificationRequest } from "./fixtures";

describe("deterministic grading checks", () => {
  it("passes a valid routed ping", () => {
    const result = verifySubmission(verificationRequest("instructor"));
    expect(result.checks.find((check) => check.id === "ping-pc1-pc2")?.status).toBe("passed");
  });

  it("fails routed ping when the access VLAN is broken", () => {
    const document = demoLabDocument();
    const config = document.configurations["switch-1"]!;
    if (config.kind !== "l2-switch") throw new Error("fixture mismatch");
    config.interfaces.find((iface) => iface.id === "Gi0/1")!.accessVlan = 20;
    const request = verificationRequest("instructor");
    request.submission = submissionFrom(document);
    const result = verifySubmission(request);
    expect(result.checks.find((check) => check.id === "ping-pc1-pc2")?.status).toBe("failed");
  });

  it("passes and fails switchport and VLAN configuration checks", () => {
    const request = verificationRequest("instructor");
    request.gradingSpec.checks.push({
      id: "wrong-vlan",
      title: "Wrong VLAN expectation",
      type: "switchport",
      points: 1,
      visibility: "visible",
      configuration: { deviceId: "switch-1", interfaceId: "Gi0/1", expectedMode: "access", expectedAccessVlan: 99 },
    });
    const result = verifySubmission(request);
    expect(result.checks.find((check) => check.id === "vlan-10")?.status).toBe("passed");
    expect(result.checks.find((check) => check.id === "access-vlan-10")?.status).toBe("passed");
    expect(result.checks.find((check) => check.id === "wrong-vlan")?.status).toBe("failed");
  });

  it("checks interface administrative shutdown state", () => {
    const document = demoLabDocument();
    const config = document.configurations["switch-1"]!;
    if (config.kind !== "l2-switch") throw new Error("fixture mismatch");
    config.interfaces.find((iface) => iface.id === "Gi0/1")!.shutdown = true;
    const request = verificationRequest("instructor");
    request.submission = submissionFrom(document);
    expect(verifySubmission(request).checks.find((check) => check.id === "interface-up")?.status).toBe("failed");
  });

  it("finds a configured static route", () => {
    const check = verifySubmission(verificationRequest("instructor")).checks.find((candidate) => candidate.id === "static-route");
    expect(check).toMatchObject({ status: "passed", awardedPoints: 1 });
  });

  it("checks deterministic DHCP assignment subnet", () => {
    const check = verifySubmission(verificationRequest("instructor")).checks.find((candidate) => candidate.id === "dhcp-pc1");
    expect(check).toMatchObject({ status: "passed", diagnostics: { actualAddress: "192.168.10.10" } });
  });

  it("calculates weighted points and percentage exclusively from checks", () => {
    const request = verificationRequest();
    request.gradingSpec.checks[1]!.configuration = { deviceId: "switch-1", vlanId: 99 };
    const result = verifySubmission(request);
    expect(result).toMatchObject({ awardedPoints: 9, maximumPoints: 10, score: 90 });
  });

  it("removes hidden titles, messages and expected values from student results", () => {
    const hidden = verifySubmission(verificationRequest("student")).checks.find((check) => check.id === "ping-pc1-pc2")!;
    expect(hidden).toEqual({
      id: "ping-pc1-pc2",
      title: "Hidden check",
      status: "passed",
      awardedPoints: 3,
      maximumPoints: 3,
      message: "Hidden check passed",
    });
    expect(JSON.stringify(hidden)).not.toContain("192.168.20.10");
  });

  it("includes bounded diagnostics in instructor results", () => {
    const check = verifySubmission(verificationRequest("instructor")).checks.find((candidate) => candidate.id === "ping-pc1-pc2")!;
    expect(check).toMatchObject({ visibility: "hidden", diagnostics: { actual: "success", expected: "success" } });
  });

  it("returns byte-identical output for identical input", () => {
    const request = verificationRequest("instructor");
    expect(JSON.stringify(verifySubmission(request))).toBe(JSON.stringify(verifySubmission(clone(request))));
  });

  it("ignores a fake client-provided score", () => {
    const request = { ...verificationRequest(), score: 1_000_000 };
    expect(verifySubmission(request).score).toBe(100);
  });

  it("rejects an invalid submission before build", () => {
    expect(() => verifySubmission({ ...verificationRequest(), submission: {} })).toThrowError(VerificationError);
    try {
      verifySubmission({ ...verificationRequest(), submission: {} });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-submission" });
    }
  });

  it("enforces static resource limits before build", () => {
    expect(() => verifySubmission(verificationRequest(), { ...DEFAULT_VERIFICATION_LIMITS, maximumNodes: 1 }))
      .toThrowError(VerificationResourceLimitError);
    expect(() => verifySubmission(verificationRequest(), { ...DEFAULT_VERIFICATION_LIMITS, maximumJsonPayloadBytes: 100 }))
      .toThrowError(expect.objectContaining({ limit: "maximumJsonPayloadBytes" }));
  });

  it("stops event processing at the configured hard limit", () => {
    const looped = demoLabDocument();
    looped.id = "looped-lab";
    looped.topology = {
      schemaVersion: 1,
      nodes: [
        { id: "pc", kind: "pc", name: "PC", interfaces: [{ id: "eth0" }] },
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] },
        { id: "sw2", kind: "l2-switch", name: "SW2", interfaces: [{ id: "p1" }, { id: "p2" }] },
      ],
      links: [
        { id: "pc-link", a: { node: "pc", iface: "eth0" }, b: { node: "sw1", iface: "p1" } },
        { id: "loop-a", a: { node: "sw1", iface: "p2" }, b: { node: "sw2", iface: "p1" } },
        { id: "loop-b", a: { node: "sw1", iface: "p3" }, b: { node: "sw2", iface: "p2" } },
      ],
    };
    looped.configurations = {
      pc: {
        kind: "pc",
        hostname: "PC",
        interfaces: [],
        ipv4: { address: "10.0.0.2", prefixLength: 24 },
        dhcpEnabled: false,
      },
      sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] },
      sw2: { kind: "l2-switch", hostname: "SW2", vlans: [], interfaces: [] },
    };
    const loopingRequest = {
      submission: submissionFrom(looped),
      resultView: "student",
      gradingSpec: {
        schemaVersion: 1,
        id: "loop-check",
        checks: [{
          id: "loop-ping",
          title: "Loop must be bounded",
          type: "ping",
          points: 1,
          visibility: "hidden",
          configuration: { sourceDeviceId: "pc", destinationIp: "10.0.0.99", expected: "failure" },
        }],
      },
    };
    expect(() => verifySubmission(loopingRequest, { ...DEFAULT_VERIFICATION_LIMITS, maximumVirtualEvents: 3 }))
      .toThrowError(VerificationResourceLimitError);
  });

  it("rejects an invalid grading specification independently", () => {
    expect(() => verifySubmission({ submission: submissionFrom(), gradingSpec: { ...gradingSpec(), checks: [{ type: "eval" }] } }))
      .toThrowError(expect.objectContaining({ code: "invalid-grading-spec" }));
  });
});

import { verifySubmission } from "@sim/grading-core";
import type { GradingSpec } from "@sim/contracts/grading";
import { describe, expect, it } from "vitest";
import { demoLabDocument, submissionFrom } from "./fixtures";

function savedSpec(deviceId: string): GradingSpec {
  return {
    schemaVersion: 1,
    id: "configuration-grade",
    checks: [{
      id: "saved",
      title: "Configuration saved to startup",
      type: "configuration-saved",
      points: 1,
      visibility: "visible",
      configuration: { deviceId },
    }],
  };
}

function verify(document: ReturnType<typeof demoLabDocument>, deviceId = "switch-1") {
  return verifySubmission({
    submission: submissionFrom(document),
    gradingSpec: savedSpec(deviceId),
    audience: "instructor",
  });
}

describe("configuration-saved grading check", () => {
  it("passes when no startup snapshot was ever stored", () => {
    // An older submission has no snapshot at all: startup equals running, so a
    // lab written before startup snapshots existed is not graded as unsaved.
    const result = verify(demoLabDocument());
    expect(result.checks[0]?.status).toBe("passed");
  });

  it("passes when the stored startup snapshot matches the running configuration", () => {
    const document = demoLabDocument();
    document.startupConfigurations = {
      "switch-1": { state: "saved", configuration: document.configurations["switch-1"]! },
    };
    expect(verify(document).checks[0]?.status).toBe("passed");
  });

  it("fails when the running configuration was never saved", () => {
    const document = demoLabDocument();
    const stored = document.configurations["switch-1"]!;
    document.startupConfigurations = {
      "switch-1": { state: "saved", configuration: { ...stored, hostname: "OLD-SW" } },
    };
    const result = verify(document);
    expect(result.checks[0]?.status).toBe("failed");
    expect(result.checks[0]?.message).toContain("unsaved");
  });

  it("fails when the NVRAM was erased", () => {
    const document = demoLabDocument();
    document.startupConfigurations = { "switch-1": { state: "absent" } };
    const result = verify(document);
    expect(result.checks[0]?.status).toBe("failed");
    expect(result.checks[0]?.message).toContain("no startup configuration");
  });

  it("reports an unknown device as an error rather than a failure", () => {
    const result = verify(demoLabDocument(), "missing-device");
    expect(result.checks[0]?.status).toBe("error");
  });

  it("does not change the result of any other check", () => {
    const document = demoLabDocument();
    const withoutSnapshot = verifySubmission({
      submission: submissionFrom(document),
      gradingSpec: savedSpec("switch-1"),
      audience: "instructor",
    });
    document.startupConfigurations = {
      "switch-1": { state: "saved", configuration: document.configurations["switch-1"]! },
    };
    const withSnapshot = verifySubmission({
      submission: submissionFrom(document),
      gradingSpec: savedSpec("switch-1"),
      audience: "instructor",
    });
    // A startup snapshot is configuration the verifier stores but never runs:
    // grading the same running configuration produces the same score.
    expect(withSnapshot.score).toBe(withoutSnapshot.score);
  });
});

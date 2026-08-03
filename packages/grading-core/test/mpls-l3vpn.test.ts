import type { GradingCheck, LabDocument, VerificationRequest } from "@sim/contracts";
import { verifySubmission } from "@sim/grading-core";
import {
  MPLS_LDP_CORE_DEMO,
  OVERLAPPING_CUSTOMER_L3VPN_DEMO,
  SINGLE_CUSTOMER_L3VPN_DEMO,
} from "../../../apps/web/src/fixtures/mpls-demo-labs";
import { describe, expect, it } from "vitest";

const check = (partial: Omit<GradingCheck, "id" | "title" | "points" | "visibility">, visibility: "visible" | "hidden" = "visible"): GradingCheck => ({
  id: `check-${partial.type}`,
  title: `Check ${partial.type}`,
  points: 1,
  visibility,
  ...partial,
} as GradingCheck);

function grade(document: LabDocument, checks: readonly GradingCheck[], resultView: "student" | "instructor" = "instructor") {
  const request: VerificationRequest = {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: "mpls-spec", checks: [...checks] },
    resultView,
  };
  return verifySubmission(request);
}

describe("MPLS and L3VPN grading", () => {
  it("checks Router-only MPLS interfaces, Operational LDP, bindings and LFIB", () => {
    const result = grade(MPLS_LDP_CORE_DEMO, [
      check({ type: "mpls-interface-enabled", deviceId: "p1", interfaceId: "Gi0/1" }),
      check({ type: "ldp-neighbor-state", deviceId: "p1", neighborRouterId: "3.3.3.3", expectedState: "operational" }),
      check({ type: "ldp-binding", deviceId: "p1", fec: "4.4.4.4/32" }),
      check({ type: "mpls-lfib-entry", deviceId: "p1", fec: "4.4.4.4/32" }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "passed", "passed"]);
  });

  it("checks VRF/RT/VPNv4 state and real double-label customer connectivity", () => {
    const result = grade(SINGLE_CUSTOMER_L3VPN_DEMO, [
      check({ type: "vrf-exists", deviceId: "pe1", vrfId: "customer-a" }),
      check({ type: "vrf-interface", deviceId: "pe1", vrfId: "customer-a", interfaceId: "Gi0/1" }),
      check({ type: "route-target-export", deviceId: "pe1", vrfId: "customer-a", routeTarget: "65000:100" }),
      check({ type: "vpnv4-route", deviceId: "pe1", routeDistinguisher: "65000:100", network: "10.2.1.0", prefixLength: 24 }),
      check({ type: "vrf-route", deviceId: "pe1", vrfId: "customer-a", network: "10.2.1.0", prefixLength: 24, expectedSource: "bgp-vpn" }),
      check({ type: "l3vpn-connectivity", sourceDeviceId: "ce1", destinationIp: "10.2.1.2", expected: "success" }),
    ]);
    expect(result.score).toBe(100);
    expect(result.checks.every((entry) => entry.status === "passed")).toBe(true);
  });

  it("checks deterministic isolation for overlapping customer address space", () => {
    const result = grade(OVERLAPPING_CUSTOMER_L3VPN_DEMO, [
      check({ type: "overlapping-prefix-isolation", deviceId: "pe1", firstVrfId: "customer-a", secondVrfId: "customer-b", network: "10.0.0.0", prefixLength: 24 }),
      check({ type: "customer-isolation", deviceId: "pe1", sourceVrfId: "customer-a", destinationVrfId: "customer-b", network: "10.2.0.0", prefixLength: 24 }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed"]);
  });

  it("does not expose hidden RD, RT, labels or diagnostic expectations to students", () => {
    const result = grade(SINGLE_CUSTOMER_L3VPN_DEMO, [
      check({ type: "vpnv4-route", deviceId: "pe1", routeDistinguisher: "65000:100", network: "10.2.1.0", prefixLength: 24 }, "hidden"),
      check({ type: "route-target-import", deviceId: "pe1", vrfId: "customer-a", routeTarget: "65000:100" }, "hidden"),
    ], "student");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("65000:100");
    expect(serialized).not.toContain("routeTarget");
    expect(serialized).not.toContain("vpnLabel");
    expect(result.checks.every((entry) => entry.title === "Hidden check")).toBe(true);
  });
});

import type { GradingCheck, LabDocument, VerificationRequest } from "@sim/contracts";
import { verifySubmission } from "@sim/grading-core";
import { canonicalizeLabDocument } from "@sim/lab-format";
import {
  BGP_EVPN_STRETCH_DEMO,
  STATIC_VXLAN_STRETCH_DEMO,
} from "../../../apps/web/src/fixtures/vxlan-evpn-demo-labs";
import { describe, expect, it } from "vitest";

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
  document: LabDocument,
  checks: readonly GradingCheck[],
  resultView: "student" | "instructor" = "instructor",
) {
  const request: VerificationRequest = {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      // The verifier accepts structured topology and configuration only, and
      // rebuilds every overlay table itself.
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: "vxlan-evpn-spec", checks: [...checks] },
    resultView,
  };
  return verifySubmission(request);
}

/**
 * The MAC the deterministic topology gives each host's single interface.
 * Canonicalization assigns it, so the same document always yields the same
 * address in the browser and in the verifier.
 */
function hostMac(document: LabDocument, deviceId: string): string {
  const canonical = canonicalizeLabDocument(document);
  const node = canonical.topology.nodes.find((entry) => entry.id === deviceId)!;
  return node.interfaces[0]!.mac!;
}

describe("VXLAN and BGP EVPN grading", () => {
  it("checks static VTEP configuration, mapping, peer state and real overlay connectivity", () => {
    const result = grade(STATIC_VXLAN_STRETCH_DEMO, [
      check({ type: "nve-configured", configuration: { deviceId: "vtep1", expectedSourceInterfaceId: "Loopback0", expected: "operational" } }),
      check({ type: "vxlan-vni-mapping", configuration: { deviceId: "vtep1", vni: 10_010, vlanId: 10, expectedReplication: "static" } }),
      check({ type: "vxlan-peer-state", configuration: { deviceId: "vtep1", vni: 10_010, peerAddress: "10.255.0.2", expected: "reachable" } }),
      // Connectivity must have crossed a tunnel, not an invisible cable.
      check({ type: "vxlan-l2-connectivity", configuration: { sourceDeviceId: "pc-a", destinationIp: "192.168.10.20", expected: "success", requireEncapsulation: true } }),
      check({ type: "vxlan-remote-mac", configuration: { deviceId: "vtep1", vni: 10_010, macAddress: hostMac(STATIC_VXLAN_STRETCH_DEMO, "pc-b"), expectedRemoteVtep: "10.255.0.2", expectedSource: "data-plane", expected: "present" } }),
      // The underlay Router carries the outer IPv4/UDP and no tenant MAC.
      check({ type: "evpn-customer-isolation", configuration: { underlayDeviceId: "core" } }),
    ]);
    expect(result.checks.map((entry) => `${entry.id}:${entry.status}`)).toEqual([
      "check-nve-configured:passed",
      "check-vxlan-vni-mapping:passed",
      "check-vxlan-peer-state:passed",
      "check-vxlan-l2-connectivity:passed",
      "check-vxlan-remote-mac:passed",
      "check-evpn-customer-isolation:passed",
    ]);
    expect(result.score).toBe(100);
  });

  it("checks EVPN Type 2/3 routes, route targets and reflection through the spine", () => {
    const result = grade(BGP_EVPN_STRETCH_DEMO, [
      check({ type: "evpn-type3-route", configuration: { deviceId: "leaf1", vni: 20_020, originatingVtep: "10.255.0.2", routeDistinguisher: "65000:20020", expected: "present" } }),
      check({ type: "evpn-route-target", configuration: { deviceId: "leaf1", vni: 20_020, direction: "import", routeTarget: "65000:20020" } }),
      // The stamps land on the client that received the reflected route.
      check({ type: "evpn-route-reflected", configuration: { deviceId: "leaf1", routeType: 3, expectedOriginatorId: "10.255.0.2", expectedClusterId: "10.255.0.9" } }),
      check({ type: "vxlan-l2-connectivity", configuration: { sourceDeviceId: "host-a", destinationIp: "192.168.20.20", expected: "success", requireEncapsulation: true } }),
      // Type 2 arrives through the control plane, not from a decapsulated frame.
      check({ type: "evpn-type2-route", configuration: { deviceId: "leaf1", vni: 20_020, macAddress: hostMac(BGP_EVPN_STRETCH_DEMO, "host-b"), expected: "present" } }),
      check({ type: "vxlan-remote-mac", configuration: { deviceId: "leaf1", vni: 20_020, macAddress: hostMac(BGP_EVPN_STRETCH_DEMO, "host-b"), expectedSource: "bgp-evpn", expected: "present" } }),
    ]);
    expect(result.checks.filter((entry) => entry.status !== "passed")).toEqual([]);
    expect(result.score).toBe(100);
  });

  it("fails deterministically when the route target does not match", () => {
    // One leaf exports a route target the other never imports, so nothing is
    // programmed even though both sides advertise and the session is up.
    const mismatched = JSON.parse(JSON.stringify(BGP_EVPN_STRETCH_DEMO)) as LabDocument;
    const leaf2 = mismatched.configurations.leaf2!;
    if (leaf2.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    leaf2.evpn = {
      vnis: [{
        vni: 20_020,
        routeDistinguisher: "65000:20020",
        importRouteTargets: ["65000:29999"],
        exportRouteTargets: ["65000:29999"],
      }],
    };
    const result = grade(mismatched, [
      check({ type: "vxlan-peer-state", configuration: { deviceId: "leaf1", vni: 20_020, peerAddress: "10.255.0.2", expected: "absent" } }),
      check({ type: "vxlan-remote-mac", configuration: { deviceId: "leaf1", vni: 20_020, macAddress: hostMac(mismatched, "host-b"), expected: "absent" } }),
      // A VTEP must not import a VNI whose route target it does not hold.
      check({ type: "evpn-customer-isolation", configuration: { underlayDeviceId: "spine", vtepDeviceId: "leaf1", foreignVni: 20_020 } }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("does not expose hidden RD, route target or MAC expectations to students", () => {
    const mac = hostMac(BGP_EVPN_STRETCH_DEMO, "host-b");
    const result = grade(BGP_EVPN_STRETCH_DEMO, [
      check({ type: "evpn-type2-route", configuration: { deviceId: "leaf1", vni: 20_020, macAddress: mac, routeDistinguisher: "65000:20020", expected: "present" } }, "hidden"),
      check({ type: "evpn-route-target", configuration: { deviceId: "leaf1", vni: 20_020, direction: "export", routeTarget: "65000:20020" } }, "hidden"),
    ], "student");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("65000:20020");
    expect(serialized).not.toContain(mac);
    expect(serialized).not.toContain("routeTarget");
    expect(result.checks.every((entry) => entry.title === "Hidden check")).toBe(true);
  });
});

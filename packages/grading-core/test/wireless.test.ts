import { verifySubmission } from "@sim/grading-core";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  AP_FAILOVER_DEMO,
  HOME_WIRELESS_ROUTER_DEMO,
  OPEN_WIRELESS_LAN_DEMO,
  WPA2_WIRELESS_LAN_DEMO,
} from "../../../apps/web/src/fixtures/wireless-demo-labs";

function request(documentInput: typeof OPEN_WIRELESS_LAN_DEMO, checks: unknown[], resultView = "instructor") {
  const document = canonicalizeLabDocument(documentInput);
  return {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: {
        topology: document.topology,
        configurations: document.configurations,
      },
      clientRevision: "wireless-test",
      score: 100,
    },
    gradingSpec: {
      schemaVersion: 1,
      id: "wireless-grade",
      checks,
    },
    resultView,
    score: 100,
  };
}

const identity = {
  points: 1,
  visibility: "visible",
} as const;

describe("wireless grading", () => {
  it("grades association, SSID, client count, address and connectivity from rebuilt state", () => {
    const result = verifySubmission(request(OPEN_WIRELESS_LAN_DEMO, [
      { ...identity, id: "associated", title: "Associated", type: "wireless-associated", configuration: { stationDeviceId: "laptop-1", accessPointDeviceId: "ap-1" } },
      { ...identity, id: "ssid", title: "SSID", type: "wireless-ssid", configuration: { deviceId: "ap-1", expectedSsid: "LAB-OPEN" } },
      { ...identity, id: "security", title: "Security", type: "wireless-security", configuration: { deviceId: "ap-1", expectedMode: "open" } },
      { ...identity, id: "clients", title: "Clients", type: "wireless-client-count", configuration: { deviceId: "ap-1", minimumClients: 1, maximumClients: 1 } },
      { ...identity, id: "ipv4", title: "IPv4", type: "wireless-ipv4", configuration: { deviceId: "laptop-1", expectedSubnet: "192.168.10.0/24" } },
      { ...identity, id: "connectivity", title: "Connectivity", type: "wireless-connectivity", configuration: { sourceDeviceId: "laptop-1", destination: "192.168.10.1", expected: "success" } },
    ]));

    expect(result.score).toBe(100);
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
    expect(result.engine.processedEvents).toBeGreaterThan(0);
  });

  it("grades WPA2 mode and home-router NAT without exposing credential material", () => {
    const wpaDocument = canonicalizeLabDocument(WPA2_WIRELESS_LAN_DEMO);
    const verifier = wpaDocument.configurations["ap-1"];
    if (verifier?.kind !== "access-point" || verifier.accessPoint.security.mode !== "wpa2-personal") {
      throw new Error("fixture mismatch");
    }
    const fingerprint = verifier.accessPoint.security.credentialVerifier.hashBase64;
    const wpa = verifySubmission(request(WPA2_WIRELESS_LAN_DEMO, [{
      ...identity,
      visibility: "hidden",
      id: "wpa2",
      title: "WPA2 configured",
      type: "wireless-security",
      configuration: { deviceId: "ap-1", expectedMode: "wpa2-personal" },
    }], "student"));
    const nat = verifySubmission(request(HOME_WIRELESS_ROUTER_DEMO, [{
      ...identity,
      id: "nat",
      title: "PAT enabled",
      type: "wireless-router-nat",
      configuration: { deviceId: "wireless-router-1", expectedEnabled: true },
    }]));

    expect(wpa.checks[0]).toMatchObject({ title: "Hidden check", status: "passed" });
    expect(JSON.stringify(wpa)).not.toContain(fingerprint);
    expect(JSON.stringify(wpa)).not.toMatch(/credential|verifier|passphrase/iu);
    expect(nat.checks[0]?.status).toBe("passed");
    expect(nat.score).toBe(100);
  });

  it("executes a hidden bounded AP-failure action and grades deterministic roaming", () => {
    const result = verifySubmission(request(AP_FAILOVER_DEMO, [{
      ...identity,
      id: "roam",
      title: "Roams to backup",
      type: "wireless-roamed",
      configuration: {
        stationDeviceId: "laptop-1",
        expectedToAccessPointDeviceId: "ap-2",
        triggerAccessPointShutdownDeviceId: "ap-1",
      },
    }]));

    expect(result.checks[0]).toMatchObject({ status: "passed" });
    expect(result.checks[0]?.diagnostics).toMatchObject({ accessPointDeviceId: "ap-2" });
  });
});

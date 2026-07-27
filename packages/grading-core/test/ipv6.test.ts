import type { LabDocument } from "@sim/contracts";
import { verifySubmission } from "@sim/grading-core";
import { buildLabFromDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { submissionFrom } from "./fixtures";

function staticIpv6Lan(): LabDocument {
  return {
    schemaVersion: 1,
    id: "ipv6-static-lan",
    title: "IPv6 Static LAN",
    simulation: { seed: 10_505 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "pc2", kind: "pc", name: "PC2", interfaces: [{ id: "eth0" }] },
      ],
      links: [
        { id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
        { id: "l2", a: { node: "pc2", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/2" } },
      ],
    },
    configurations: {
      pc1: {
        kind: "pc",
        hostname: "PC1",
        interfaces: [],
        dhcpEnabled: false,
        ipv6: { mode: "static", address: "2001:db8:10::10", prefixLength: 64 },
      },
      sw1: {
        kind: "l2-switch",
        hostname: "SW1",
        vlans: [],
        interfaces: [
          { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 1, nativeVlan: 1 },
          { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 1, nativeVlan: 1 },
        ],
      },
      pc2: {
        kind: "pc",
        hostname: "PC2",
        interfaces: [],
        dhcpEnabled: false,
        ipv6: { mode: "static", address: "2001:db8:10::20", prefixLength: 64 },
      },
    },
  };
}

function request(document: LabDocument, resultView: "student" | "instructor" = "instructor") {
  return {
    submission: submissionFrom(document),
    resultView,
    gradingSpec: {
      schemaVersion: 1 as const,
      id: "ipv6-core",
      checks: [
        {
          id: "address",
          title: "PC1 IPv6 address",
          type: "ipv6-address" as const,
          points: 1,
          visibility: "visible" as const,
          configuration: { deviceId: "pc1", expectedAddress: "2001:db8:10::10", expectedPrefixLength: 64 },
        },
        {
          id: "connectivity",
          title: "PC1 reaches PC2",
          type: "ipv6-connectivity" as const,
          points: 2,
          visibility: "hidden" as const,
          configuration: { sourceDeviceId: "pc1", destination: "2001:db8:10::20", expected: "success" as const },
        },
        {
          id: "neighbor",
          title: "PC2 resolved by NDP",
          type: "ipv6-neighbor" as const,
          points: 1,
          visibility: "visible" as const,
          configuration: { deviceId: "pc1", neighborAddress: "2001:db8:10::20" },
        },
      ],
    },
  };
}

describe("IPv6 grading integration", () => {
  it("rebuilds a static LAN, runs NDP, and grades server-owned connectivity", () => {
    const result = verifySubmission(request(staticIpv6Lan()));
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["address", "passed"],
      ["connectivity", "passed"],
      ["neighbor", "passed"],
    ]);
    expect(result.score).toBe(100);
  });

  it("matches browser-engine behavior deterministically and redacts hidden expectations", () => {
    const document = staticIpv6Lan();
    const browser = buildLabFromDocument(document);
    const pc1 = browser.getPc("pc1")!;
    browser.engine.runUntilIdle();
    pc1.ping6("2001:db8:10::20", 1);
    browser.engine.runUntilIdle();
    expect(pc1.ipv6PingResults.at(-1)?.success).toBe(true);

    const first = verifySubmission(request(document, "student"));
    const second = verifySubmission(request(document, "student"));
    expect(second).toEqual(first);
    const hidden = first.checks.find((check) => check.id === "connectivity");
    expect(hidden).toEqual({
      id: "connectivity",
      title: "Hidden check",
      status: "passed",
      awardedPoints: 2,
      maximumPoints: 2,
      message: "Hidden check passed",
    });
    expect(JSON.stringify(hidden)).not.toContain("2001:db8:10::20");
  });
});

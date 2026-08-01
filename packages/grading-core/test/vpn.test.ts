import { createVpnPreSharedKeyVerifier } from "@sim/console-auth";
import type { LabDocument, PasswordVerifier } from "@sim/contracts";
import type { GradingSpec } from "@sim/contracts/grading";
import { verifySubmission } from "@sim/grading-core";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { beforeAll, describe, expect, it } from "vitest";

let MATCHING_KEY: PasswordVerifier;
let WRONG_KEY: PasswordVerifier;

beforeAll(async () => {
  MATCHING_KEY = await createVpnPreSharedKeyVerifier("simulatornet-site-vpn");
  WRONG_KEY = await createVpnPreSharedKeyVerifier("a-different-key-42");
});

/** LAN A — R1 — ISP — R2 — LAN B with a protected Tunnel0 on each router. */
function lab(options: { branchKey?: PasswordVerifier; protect?: boolean } = {}): LabDocument {
  const protect = options.protect ?? true;
  const vpn = (destination: string, overlay: string, key: PasswordVerifier | undefined, peerId: string) => ({
    tunnels: [{
      id: 0,
      shutdown: false,
      source: { type: "interface" as const, interfaceId: "Gi0/1" },
      destinationAddress: destination,
      mode: "gre-ipv4" as const,
      ipv4: { address: overlay, prefixLength: 30 },
      mtu: 1_400,
      ttl: 255,
      ...(protect ? { ipsecProfileId: "SITE-VPN" } : {}),
    }],
    proposals: protect
      ? [{ id: "IKE-PROP", encryption: "sim-aes256" as const, integrity: "sim-sha256" as const }]
      : [],
    ikePeers: protect
      ? [{
          id: peerId,
          address: destination,
          preSharedKeyVerifier: key,
          proposalId: "IKE-PROP",
          lifetimeSeconds: 3_600,
          credentialResetRequired: false,
        }]
      : [],
    ipsecProfiles: protect
      ? [{ id: "SITE-VPN", ikePeerId: peerId, proposalId: "IKE-PROP", lifetimeSeconds: 3_600 }]
      : [],
  });
  return canonicalizeLabDocument({
    schemaVersion: 1,
    id: "vpn-grading",
    title: "VPN grading",
    simulation: { seed: 909 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc-a", kind: "pc", name: "PC-A", interfaces: [{ id: "eth0" }] },
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        {
          id: "isp",
          kind: "cloud",
          name: "ISP",
          interfaces: [{ id: "Eth0/0" }, { id: "Eth0/1" }, { id: "Eth0/2" }, { id: "Eth0/3" }],
        },
        { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "pc-b", kind: "pc", name: "PC-B", interfaces: [{ id: "eth0" }] },
      ],
      links: [
        { id: "a", a: { node: "pc-a", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
        { id: "b", a: { node: "r1", iface: "Gi0/1" }, b: { node: "isp", iface: "Eth0/0" } },
        { id: "c", a: { node: "isp", iface: "Eth0/1" }, b: { node: "r2", iface: "Gi0/1" } },
        { id: "d", a: { node: "r2", iface: "Gi0/0" }, b: { node: "pc-b", iface: "eth0" } },
      ],
    },
    configurations: {
      "pc-a": { kind: "pc", ipv4: { address: "10.1.0.10", prefixLength: 24, defaultGateway: "10.1.0.1" } },
      "pc-b": { kind: "pc", ipv4: { address: "10.2.0.10", prefixLength: 24, defaultGateway: "10.2.0.1" } },
      isp: {
        kind: "cloud",
        interfaces: [
          { id: "Eth0/0", routed: true, ipv4: { address: "203.0.113.2", prefixLength: 30 } },
          { id: "Eth0/1", routed: true, ipv4: { address: "203.0.113.5", prefixLength: 30 } },
          { id: "Eth0/2" },
          { id: "Eth0/3" },
        ],
      },
      r1: {
        kind: "router",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "10.1.0.1", prefixLength: 24 } },
          { id: "Gi0/1", routed: true, ipv4: { address: "203.0.113.1", prefixLength: 30 } },
        ],
        staticRoutes: [
          { network: "203.0.113.4", prefixLength: 30, nextHop: "203.0.113.2" },
          { network: "10.2.0.0", prefixLength: 24, nextHop: "10.255.0.2" },
        ],
        vpn: vpn("203.0.113.6", "10.255.0.1", MATCHING_KEY, "BRANCH"),
      },
      r2: {
        kind: "router",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "10.2.0.1", prefixLength: 24 } },
          { id: "Gi0/1", routed: true, ipv4: { address: "203.0.113.6", prefixLength: 30 } },
        ],
        staticRoutes: [
          { network: "203.0.113.0", prefixLength: 30, nextHop: "203.0.113.5" },
          { network: "10.1.0.0", prefixLength: 24, nextHop: "10.255.0.1" },
        ],
        vpn: vpn("203.0.113.1", "10.255.0.2", options.branchKey ?? MATCHING_KEY, "HQ"),
      },
    },
  });
}

function verify(
  document: LabDocument,
  checks: GradingSpec["checks"],
  resultView: "student" | "instructor" = "instructor",
) {
  return verifySubmission({
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: "vpn", checks },
    resultView,
  });
}

function check(
  type: string,
  configuration: Record<string, unknown>,
  visibility: "visible" | "hidden" = "visible",
): GradingSpec["checks"][number] {
  return {
    id: `${type}-1`,
    title: type,
    points: 1,
    visibility,
    type,
    configuration,
  } as unknown as GradingSpec["checks"][number];
}

describe("site-to-site VPN grading checks", () => {
  it("grades tunnel configuration, operational state, routing and connectivity", () => {
    const result = verify(lab(), [
      check("gre-tunnel-configured", {
        deviceId: "r1",
        tunnelId: 0,
        expectedDestination: "203.0.113.6",
        expectedSourceInterface: "Gi0/1",
        expectedOverlayAddress: "10.255.0.1",
      }),
      check("gre-tunnel-operational", { deviceId: "r1", tunnelId: 0, expected: true }),
      check("vpn-route", { deviceId: "r1", network: "10.255.0.0", prefixLength: 30, tunnelId: 0 }),
      check("tunnel-connectivity", {
        sourceDeviceId: "pc-a",
        destination: "10.2.0.10",
        expected: "success",
        tunnelDeviceId: "r1",
      }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(
      ["passed", "passed", "passed", "passed"],
    );
    expect(result.score).toBe(100);
  });

  it("grades IKE configuration, state, profile binding and the SA pair", () => {
    const result = verify(lab(), [
      check("ike-peer-configured", {
        deviceId: "r1",
        peerId: "BRANCH",
        expectedAddress: "203.0.113.6",
        expectPreSharedKey: true,
        expectedProposalId: "IKE-PROP",
      }),
      check("ike-state", { deviceId: "r1", peerId: "BRANCH", expectedState: "ESTABLISHED" }),
      check("ipsec-profile", {
        deviceId: "r1",
        profileId: "SITE-VPN",
        expectedPeerId: "BRANCH",
        expectedProposalId: "IKE-PROP",
        boundTunnelId: 0,
      }),
      check("ipsec-sa-established", { deviceId: "r1", peerId: "BRANCH", expectBothDirections: true }),
      check("protected-packet-delivered", {
        sourceDeviceId: "pc-a",
        destination: "10.2.0.10",
        deviceId: "r1",
      }),
      check("esp-replay-rejected", { deviceId: "r2", peerId: "HQ" }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(
      ["passed", "passed", "passed", "passed", "passed", "passed"],
    );
  });

  it("fails IKE state and SA checks when the pre-shared keys do not match", async () => {
    const result = verify(lab({ branchKey: WRONG_KEY }), [
      check("ike-state", { deviceId: "r1", peerId: "BRANCH", expectedState: "ESTABLISHED" }),
      check("ipsec-sa-established", { deviceId: "r1", peerId: "BRANCH" }),
      check("gre-tunnel-operational", { deviceId: "r1", tunnelId: 0, expected: true }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["failed", "failed", "failed"]);
    expect(result.checks[0]!.diagnostics?.failureReason).toBe("authentication-failed");
    await expect(Promise.resolve(result.score)).resolves.toBe(0);
  });

  it("never exposes a key, a verifier or an SPI in a student result", () => {
    const result = verify(
      lab(),
      [
        check("ike-peer-configured", { deviceId: "r1", peerId: "BRANCH" }, "hidden"),
        check("ipsec-sa-established", { deviceId: "r1", peerId: "BRANCH" }, "hidden"),
      ],
      "student",
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MATCHING_KEY.hashBase64);
    expect(serialized).not.toContain(MATCHING_KEY.saltBase64);
    expect(serialized).not.toContain("simulatornet-site-vpn");
    // A hidden check keeps its diagnostics — including SPIs — server-side.
    expect(serialized).not.toContain("spis");
    for (const entry of result.checks) expect(entry.diagnostics).toBeUndefined();
  });

  it("grades a plain GRE tunnel without requiring any crypto configuration", () => {
    const result = verify(lab({ protect: false }), [
      check("gre-tunnel-operational", { deviceId: "r1", tunnelId: 0, expected: true }),
      check("tunnel-connectivity", {
        sourceDeviceId: "pc-a",
        destination: "10.2.0.10",
        tunnelDeviceId: "r1",
      }),
      check("ipsec-sa-established", { deviceId: "r1", peerId: "BRANCH" }),
    ]);
    expect(result.checks.map((entry) => entry.status)).toEqual(["passed", "passed", "failed"]);
  });
});

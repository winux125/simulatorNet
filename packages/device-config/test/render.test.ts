import type { DeviceConfig } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import {
  deviceConfigurationDigest,
  deviceConfigurationStatus,
  diffConfigurationText,
  renderDeviceConfiguration,
  renderStartupConfiguration,
  supportsDeviceConfigurationApply,
  supportsDeviceConfigurationText,
} from "../src/index";

const VERIFIER = {
  algorithm: "pbkdf2-sha256" as const,
  iterations: 1_000,
  saltBase64: "c2FsdHNhbHQ=",
  hashBase64: "aGFzaGhhc2g=",
};

function router(overrides: Partial<Extract<DeviceConfig, { kind: "router" }>> = {}): DeviceConfig {
  return {
    kind: "router",
    hostname: "R1",
    interfaces: [
      { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
      { id: "Gi0/1", routed: false, shutdown: true },
    ],
    subinterfaces: [],
    staticRoutes: [{ network: "172.16.0.0", prefixLength: 16, nextHop: "10.0.0.2" }],
    dhcpPools: [],
    acls: [],
    aclBindings: [],
    natPools: [],
    natRules: [],
    natInterfaceRoles: [],
    ...overrides,
  } as DeviceConfig;
}

describe("device configuration renderer", () => {
  it("renders a router deterministically from structured state", () => {
    const text = renderDeviceConfiguration(router());
    expect(text).toBe([
      "!",
      "hostname R1",
      "!",
      "interface Gi0/0",
      " ip address 10.0.0.1 255.255.255.0",
      "!",
      "interface Gi0/1",
      " shutdown",
      "!",
      "ip route 172.16.0.0 255.255.0.0 10.0.0.2",
      "!",
      "end",
      "",
    ].join("\n"));
    // Byte-identical on every render: a projection, never a snapshot.
    expect(renderDeviceConfiguration(router())).toBe(text);
  });

  it("orders sections and lists canonically regardless of input order", () => {
    const forward = renderDeviceConfiguration(router({
      staticRoutes: [
        { network: "10.9.0.0", prefixLength: 16, nextHop: "10.0.0.2" },
        { network: "10.8.0.0", prefixLength: 16, nextHop: "10.0.0.2" },
      ],
    }));
    const reversed = renderDeviceConfiguration(router({
      staticRoutes: [
        { network: "10.8.0.0", prefixLength: 16, nextHop: "10.0.0.2" },
        { network: "10.9.0.0", prefixLength: 16, nextHop: "10.0.0.2" },
      ],
    }));
    expect(forward).toBe(reversed);
    expect(forward.indexOf("10.8.0.0")).toBeLessThan(forward.indexOf("10.9.0.0"));
  });

  it("redacts every credential and never prints a verifier", () => {
    const text = renderDeviceConfiguration(router({
      consoleAccess: {
        mode: "local-user",
        users: [{ id: "u1", username: "admin", passwordVerifier: VERIFIER, privilegeLevel: 15, enabled: true }],
        enableSecretVerifier: VERIFIER,
        maximumAttempts: 3,
        credentialResetRequired: false,
      },
      vpn: {
        tunnels: [],
        proposals: [{ id: "PROP", encryption: "sim-aes256", integrity: "sim-sha256" }],
        ikePeers: [{
          id: "BRANCH",
          address: "203.0.113.6",
          preSharedKeyVerifier: VERIFIER,
          proposalId: "PROP",
          lifetimeSeconds: 3_600,
          credentialResetRequired: false,
        }],
        ipsecProfiles: [],
      },
    }));
    expect(text).toContain("enable secret <configured>");
    expect(text).toContain("username admin privilege 15 secret <configured>");
    expect(text).toContain(" pre-shared-key <configured>");
    expect(text).not.toContain(VERIFIER.hashBase64);
    expect(text).not.toContain(VERIFIER.saltBase64);
    expect(text).not.toContain("pbkdf2");
  });

  it("says so when the NVRAM is empty", () => {
    expect(renderStartupConfiguration(undefined)).toBe("% startup-config is not present\n");
    expect(renderStartupConfiguration(router())).toBe(renderDeviceConfiguration(router()));
  });

  it("gives a host an honest summary instead of a fake IOS config", () => {
    const text = renderDeviceConfiguration({
      kind: "pc",
      hostname: "PC1",
      interfaces: [],
      dhcpEnabled: true,
    });
    expect(supportsDeviceConfigurationText("pc")).toBe(false);
    expect(supportsDeviceConfigurationApply("pc")).toBe(false);
    expect(text).toContain("Desktop / IP Configuration");
    expect(text).not.toContain("hostname PC1");
  });

  it("uses SimulatorNet vocabulary for a device that is not a Cisco appliance", () => {
    expect(supportsDeviceConfigurationText("access-point")).toBe(true);
    expect(supportsDeviceConfigurationApply("access-point")).toBe(false);
    const text = renderDeviceConfiguration({
      kind: "access-point",
      hostname: "AP1",
      interfaces: [],
      radio: { enabled: true, band: "2.4ghz", supportedChannels: [6, 1, 11], radioDomainId: "lab" },
      accessPoint: {
        ssid: "Campus",
        broadcastSsid: true,
        band: "2.4ghz",
        channel: 6,
        enabled: true,
        radioDomainId: "lab",
        priority: 100,
        maximumClients: 32,
        clientIsolation: false,
        security: { mode: "wpa2-personal", credentialVerifier: VERIFIER },
      },
    });
    expect(text).toContain("! SimulatorNet access point configuration");
    expect(text).toContain(" supported-channels 1,6,11");
    expect(text).toContain(" security wpa2-personal passphrase <configured>");
    expect(text).not.toContain(VERIFIER.hashBase64);
  });
});

describe("configuration drift", () => {
  it("treats a lab with no startup snapshot as saved", () => {
    const status = deviceConfigurationStatus(router(), { state: "implicit" });
    expect(status.drift).toBe("saved");
    expect(status.startupDigest).toBe(status.runningDigest);
  });

  it("reports an erased NVRAM separately from a mismatch", () => {
    expect(deviceConfigurationStatus(router(), { state: "absent" }).drift).toBe("no-startup-configuration");
    expect(deviceConfigurationStatus(router(), { state: "saved", configuration: router() }).drift).toBe("saved");
    expect(deviceConfigurationStatus(
      router({ hostname: "R2" }),
      { state: "saved", configuration: router() },
    ).drift).toBe("modified");
  });

  it("compares structured snapshots, not property order", () => {
    const a = router();
    const reordered = JSON.parse(JSON.stringify({ ...a })) as DeviceConfig;
    expect(deviceConfigurationDigest(reordered)).toBe(deviceConfigurationDigest(a));
    expect(deviceConfigurationStatus(reordered, { state: "saved", configuration: a }).drift).toBe("saved");
  });
});

describe("configuration diff", () => {
  it("reports added and removed lines from rendered projections only", () => {
    const diff = diffConfigurationText(
      renderDeviceConfiguration(router()),
      renderDeviceConfiguration(router({ hostname: "R2" })),
    );
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.find((line) => line.kind === "removed")?.text).toBe("hostname R1");
    expect(diff.lines.find((line) => line.kind === "added")?.text).toBe("hostname R2");
  });
});

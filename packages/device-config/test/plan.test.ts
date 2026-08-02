import type { DeviceConfig } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import {
  applyDeviceConfigurationPlan,
  DEFAULT_DEVICE_CONFIGURATION_LIMITS,
  inspectDeviceConfigurationText,
  redactConfigurationLine,
  summarizeConfigurationCredentials,
  parseConfigurationCredentials,
} from "../src/index";

const VERIFIER = {
  algorithm: "pbkdf2-sha256" as const,
  iterations: 1_000,
  saltBase64: "c2FsdHNhbHQ=",
  hashBase64: "aGFzaGhhc2g=",
};

const CURRENT: DeviceConfig = {
  kind: "router",
  hostname: "R1",
  interfaces: [
    { id: "Gi0/0", routed: false, shutdown: false },
    { id: "Gi0/1", routed: false, shutdown: false },
  ],
  subinterfaces: [],
  staticRoutes: [],
  dhcpPools: [],
  acls: [],
  aclBindings: [],
  natPools: [],
  natRules: [],
  natInterfaceRoles: [],
  consoleAccess: {
    mode: "local-user",
    users: [{ id: "u1", username: "admin", passwordVerifier: VERIFIER, privilegeLevel: 15, enabled: true }],
    maximumAttempts: 3,
    credentialResetRequired: false,
  },
};

function inspect(text: string) {
  return inspectDeviceConfigurationText(text, {
    deviceId: "r1",
    deviceType: "router",
    interfaceIds: ["Gi0/0", "Gi0/1"],
    fallbackHostname: "R1",
  });
}

const SUPPORTED = [
  "hostname BRANCH",
  "!",
  "interface Gi0/0",
  " ip address 192.0.2.1 255.255.255.0",
  " no shutdown",
  "!",
].join("\n");

describe("configuration text plan", () => {
  it("previews supported lines with their source line numbers", () => {
    const plan = inspect(SUPPORTED);
    expect(plan.problems).toEqual([]);
    expect(plan.hostname).toBe("BRANCH");
    expect(plan.appliedCount).toBe(4);
    expect(plan.unsupportedCount).toBe(0);
    expect(plan.lines.map((line) => [line.number, line.outcome])).toEqual([
      [1, "applied"], [3, "applied"], [4, "applied"], [5, "applied"],
    ]);
  });

  it("reports an unsupported line rather than dropping it", () => {
    const plan = inspect(`${SUPPORTED}\nrouter bgp 65000\n`);
    expect(plan.unsupportedCount).toBe(1);
    const unsupported = plan.lines.find((line) => line.outcome === "unsupported");
    expect(unsupported).toMatchObject({ number: 7, text: "router bgp 65000" });
  });

  it("applies atomically and only after unsupported lines are acknowledged", () => {
    const plan = inspect(`${SUPPORTED}\nrouter bgp 65000\n`);
    const refused = applyDeviceConfigurationPlan(plan, { current: CURRENT });
    expect(refused.status).toBe("requires-confirmation");
    expect(refused.configuration).toBeUndefined();

    const applied = applyDeviceConfigurationPlan(plan, { current: CURRENT, acceptUnsupportedLines: true });
    expect(applied.status).toBe("applied");
    expect(applied.configuration?.hostname).toBe("BRANCH");
  });

  it("rejects a plan that recognised nothing", () => {
    const plan = inspect("router bgp 65000\nneighbor 10.0.0.1 remote-as 65001\n");
    expect(plan.problems[0]?.code).toBe("no-recognised-configuration");
    const result = applyDeviceConfigurationPlan(plan, { current: CURRENT });
    expect(result.status).toBe("rejected");
    expect(result.configuration).toBeUndefined();
  });

  it("keeps credentials and management settings the parser never reads", () => {
    const plan = inspect(SUPPORTED);
    const applied = applyDeviceConfigurationPlan(plan, { current: CURRENT, acceptUnsupportedLines: true });
    const configuration = applied.configuration as Extract<DeviceConfig, { kind: "router" }>;
    expect(configuration.consoleAccess?.users[0]?.username).toBe("admin");
  });

  it("refuses a configuration written for another device kind", () => {
    const plan = inspectDeviceConfigurationText(SUPPORTED, {
      deviceId: "sw1",
      deviceType: "l2-switch",
      interfaceIds: ["Gi0/0", "Gi0/1"],
      fallbackHostname: "SW1",
    });
    const result = applyDeviceConfigurationPlan(plan, { current: CURRENT });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("not a router");
  });

  it("refuses a device kind that has no configuration file", () => {
    const plan = inspectDeviceConfigurationText(SUPPORTED, {
      deviceId: "pc1",
      deviceType: "pc",
      interfaceIds: ["eth0"],
      fallbackHostname: "PC1",
    });
    expect(plan.problems[0]?.code).toBe("device-kind-unsupported");
    expect(plan.problems[0]?.message).toContain("Desktop / IP Configuration");
  });

  it("bounds the text it will even look at", () => {
    const oversized = "!\n".repeat(DEFAULT_DEVICE_CONFIGURATION_LIMITS.maximumTextLines + 1);
    expect(inspect(oversized).problems[0]?.code).toBe("too-many-lines");
    expect(inspect("   \n").problems[0]?.code).toBe("empty-configuration");
  });
});

describe("credentials in configuration text", () => {
  it("never echoes a pasted secret back into the report", () => {
    const plan = inspect([
      "hostname BRANCH",
      "enable secret SuperSecret1",
      "username admin privilege 15 secret AnotherSecret",
      "interface Gi0/0",
      " ip address 192.0.2.1 255.255.255.0",
    ].join("\n"));
    const rendered = JSON.stringify(plan);
    expect(rendered).not.toContain("SuperSecret1");
    expect(rendered).not.toContain("AnotherSecret");
    expect(plan.lines.some((line) => line.text === "enable secret <redacted>")).toBe(true);
    expect(plan.credentials).toEqual([
      { kind: "enable-secret" },
      { kind: "local-user", username: "admin", privilegeLevel: 15 },
    ]);
    expect(plan.warnings.some((warning) => warning.includes("stored as verifiers"))).toBe(true);
  });

  it("redacts every secret keyword shape", () => {
    expect(redactConfigurationLine(" password Cisco123")).toBe(" password <redacted>");
    expect(redactConfigurationLine("snmp-server community public ro")).toBe("snmp-server community <redacted>");
    expect(redactConfigurationLine(" key SharedKey")).toBe(" key <redacted>");
    expect(redactConfigurationLine(" pre-shared-key Secret")).toBe(" pre-shared-key <redacted>");
    expect(redactConfigurationLine("interface Gi0/0")).toBe("interface Gi0/0");
  });

  it("never accepts a vendor password hash as a credential", () => {
    const parsed = parseConfigurationCredentials("enable secret 5 $1$abc$defghi\n");
    expect(parsed.enableSecret).toBeUndefined();
    expect(parsed.vendorHashDetected).toBe(true);
    expect(summarizeConfigurationCredentials(parsed)).toEqual([{ kind: "vendor-hash" }]);
  });
});

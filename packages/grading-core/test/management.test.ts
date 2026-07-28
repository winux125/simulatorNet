import { describe, expect, it } from "vitest";
import type { GradingCheck, VerificationRequest } from "@sim/contracts/grading";
import { SNMP_OID } from "@sim/sim-core";
import { verifySubmission } from "../src";
import { CENTRALIZED_AAA_DEMO, SNMP_MANAGEMENT_DEMO, SSH_MANAGEMENT_DEMO } from "../../../apps/web/src/fixtures/management-demo-labs";
import type { LabDocument } from "@sim/contracts";

function request(document: LabDocument, checks: GradingCheck[]): VerificationRequest {
  return {
    submission: {
      labId: document.id,
      labVersion: 1,
      schemaVersion: 1,
      simulation: document.simulation,
      snapshot: { topology: document.topology, configurations: document.configurations },
    },
    gradingSpec: { schemaVersion: 1, id: document.id, checks },
    resultView: "student",
  } as VerificationRequest;
}

function check(overrides: Partial<GradingCheck> & Pick<GradingCheck, "type" | "configuration">): GradingCheck {
  return {
    id: "check",
    title: "Management check",
    points: 1,
    visibility: "visible",
    ...overrides,
  } as GradingCheck;
}

function run(document: LabDocument, checks: GradingCheck[]) {
  return verifySubmission(request(document, checks));
}

describe("management grading checks", () => {
  it.each([
    ["ssh enabled", "ssh", true, "passed"],
    ["telnet disabled", "telnet", false, "passed"],
    ["telnet wrongly expected enabled", "telnet", true, "failed"],
  ])("remote-service-enabled: %s", (_name, service, expected, status) => {
    const result = run(SSH_MANAGEMENT_DEMO, [check({
      type: "remote-service-enabled",
      configuration: { deviceId: "mgmt-r1", service, expected },
    })]);
    expect(result.checks[0]?.status).toBe(status);
  });

  it("vty-transport verifies the permitted transports and login mode", () => {
    const result = run(SSH_MANAGEMENT_DEMO, [
      check({ id: "ok", type: "vty-transport", configuration: { deviceId: "mgmt-r1", line: 0, expected: ["ssh"], loginMode: "local" } }),
      check({ id: "wrong", type: "vty-transport", configuration: { deviceId: "mgmt-r1", line: 0, expected: ["telnet", "ssh"] } }),
    ]);
    expect(result.checks.find((entry) => entry.id === "ok")?.status).toBe("passed");
    expect(result.checks.find((entry) => entry.id === "wrong")?.status).toBe("failed");
  });

  it("ssh-session-established logs in with the stored credential and reaches the CLI", () => {
    const result = run(SSH_MANAGEMENT_DEMO, [check({
      type: "ssh-session-established",
      configuration: {
        clientDeviceId: "admin-pc",
        targetDeviceId: "mgmt-sw1",
        targetAddress: "192.168.10.2",
        username: "admin",
        expected: "success",
      },
    })]);
    expect(result.checks[0]?.status).toBe("passed");
  });

  it("telnet-session-established fails when the device refuses Telnet", () => {
    const result = run(SSH_MANAGEMENT_DEMO, [check({
      type: "telnet-session-established",
      configuration: {
        clientDeviceId: "admin-pc",
        targetDeviceId: "mgmt-r1",
        targetAddress: "192.168.10.1",
        username: "admin",
        expected: "failure",
      },
    })]);
    expect(result.checks[0]?.status).toBe("passed");
  });

  it("aaa-method-list compares the configured methods in order", () => {
    const result = run(CENTRALIZED_AAA_DEMO, [
      check({
        id: "ok",
        type: "aaa-method-list",
        configuration: {
          deviceId: "aaa-r1",
          purpose: "authentication-login",
          listName: "default",
          expectedMethods: ["group radius", "local"],
        },
      }),
      check({
        id: "reordered",
        type: "aaa-method-list",
        configuration: {
          deviceId: "aaa-r1",
          purpose: "authentication-login",
          listName: "default",
          expectedMethods: ["local", "group radius"],
        },
      }),
    ]);
    expect(result.checks.find((entry) => entry.id === "ok")?.status).toBe("passed");
    // Order matters: the first conclusive result wins.
    expect(result.checks.find((entry) => entry.id === "reordered")?.status).toBe("failed");
  });

  it("radius-authentication confirms which method actually decided", () => {
    const result = run(CENTRALIZED_AAA_DEMO, [check({
      type: "radius-authentication",
      configuration: {
        clientDeviceId: "admin-pc",
        targetDeviceId: "aaa-r1",
        targetAddress: "192.168.20.1",
        username: "admin",
        expected: "success",
      },
    })]);
    expect(result.checks[0]?.status).toBe("passed");
  });

  it("command-authorized and command-denied reflect the TACACS+ policy", () => {
    const result = run(CENTRALIZED_AAA_DEMO, [
      check({
        id: "allowed",
        type: "command-authorized",
        configuration: {
          clientDeviceId: "admin-pc",
          targetDeviceId: "aaa-r1",
          targetAddress: "192.168.20.1",
          username: "admin",
          command: "show version",
        },
      }),
      check({
        id: "denied",
        type: "command-denied",
        configuration: {
          clientDeviceId: "admin-pc",
          targetDeviceId: "aaa-r1",
          targetAddress: "192.168.20.1",
          username: "admin",
          command: "configure terminal",
        },
      }),
    ]);
    expect(result.checks.find((entry) => entry.id === "allowed")?.status).toBe("passed");
    expect(result.checks.find((entry) => entry.id === "denied")?.status).toBe("passed");
  });

  it("snmp-agent-configured and snmp-value read the built-in MIB", () => {
    const result = run(SNMP_MANAGEMENT_DEMO, [
      check({
        id: "agent",
        type: "snmp-agent-configured",
        configuration: { deviceId: "snmp-r1", expectCommunity: true, expectTraps: true, location: "SimulatorNet teaching lab" },
      }),
      check({ id: "sysname", type: "snmp-value", configuration: { deviceId: "snmp-r1", oid: SNMP_OID.sysName, expectedValue: "R1" } }),
      check({ id: "ifnumber", type: "snmp-value", configuration: { deviceId: "snmp-sw1", oid: SNMP_OID.ifNumber, expectedValue: "3" } }),
    ]);
    for (const id of ["agent", "sysname", "ifnumber"]) {
      expect(result.checks.find((entry) => entry.id === id)?.status).toBe("passed");
    }
  });

  it("never reveals a credential, community or hidden expectation in a student result", () => {
    const result = run(CENTRALIZED_AAA_DEMO, [check({
      id: "hidden",
      visibility: "hidden",
      type: "radius-authentication",
      configuration: {
        clientDeviceId: "admin-pc",
        targetDeviceId: "aaa-r1",
        targetAddress: "192.168.20.1",
        username: "admin",
        expected: "success",
      },
    })]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SimulatorNetLab!");
    expect(serialized).not.toContain("SimulatorNetAaaKey!");
    expect(serialized).not.toContain("credentialFingerprint");
    // A hidden check reveals neither its title nor its expected values.
    expect(result.checks[0]?.title).toBe("Hidden check");
    expect(serialized).not.toContain("admin");
  });
});

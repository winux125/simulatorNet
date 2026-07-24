import { beforeAll, describe, expect, it } from "vitest";
import type { RouterDeviceConfig } from "@sim/contracts";
import { verifyPassword } from "@sim/console-auth";
import {
  applyImportedConsoleCredentials,
  executeLabImport,
  inspectLabImport,
  registerBuiltinImportAdapters,
} from "@sim/importers";

const encoder = new TextEncoder();

const AUTH_LAB = `name: authlab
topology:
  nodes:
    r1:
      kind: vr-csr
      startup-config: |
        hostname R1
        username admin privilege 15 secret cisco123
        enable secret enablepass
        interface GigabitEthernet1
         ip address 10.0.0.1 255.255.255.0
    r2:
      kind: vr-csr
      startup-config: |
        hostname R2
        enable secret 5 $1$abcd$deadbeefhashvaluexyz
  links:
    - endpoints: ["r1:GigabitEthernet1", "r2:GigabitEthernet1"]
`;

beforeAll(() => registerBuiltinImportAdapters());

describe("imported console credentials", () => {
  it("converts explicit plaintext credentials into verifiers and redacts the source", async () => {
    const plan = await inspectLabImport({ filename: "auth.clab.yml", bytes: encoder.encode(AUTH_LAB) });
    const result = await applyImportedConsoleCredentials(executeLabImport(plan));

    const r1 = result.document.configurations.r1 as RouterDeviceConfig;
    const access = r1.consoleAccess!;
    expect(access.mode).toBe("local-user");
    expect(access.users[0]?.username).toBe("admin");
    expect(access.users[0]?.privilegeLevel).toBe(15);
    expect(await verifyPassword("cisco123", access.users[0]!.passwordVerifier)).toBe(true);
    expect(await verifyPassword("enablepass", access.enableSecretVerifier!)).toBe(true);

    // Plaintext never survives in the report or the preserved artifact.
    expect(JSON.stringify(result.report)).not.toContain("cisco123");
    const artifact = result.sourceArtifacts.find((entry) => entry.nodeId === "r1")!;
    expect(artifact.text).not.toContain("cisco123");
    expect(artifact.text).not.toContain("enablepass");
    expect(artifact.text).toContain("<redacted>");
    expect(result.report.credentialsDetected).toBeGreaterThanOrEqual(2);
  });

  it("flags an unverifiable vendor hash as requiring a reset without inventing a password", async () => {
    const plan = await inspectLabImport({ filename: "auth.clab.yml", bytes: encoder.encode(AUTH_LAB) });
    const result = await applyImportedConsoleCredentials(executeLabImport(plan));
    const r2 = result.document.configurations.r2 as RouterDeviceConfig;
    expect(r2.consoleAccess?.credentialResetRequired).toBe(true);
    expect(r2.consoleAccess?.enableSecretVerifier).toBeUndefined();
    expect(r2.consoleAccess?.users).toHaveLength(0);
    expect(result.report.credentialsRequiringReset).toBeGreaterThanOrEqual(1);
  });
});

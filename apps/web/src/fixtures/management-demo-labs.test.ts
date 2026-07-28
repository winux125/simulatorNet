import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { createManagementCredentialVerifier, managementCredentialScope } from "@sim/console-auth";
import type { LabDocument } from "@sim/contracts";
import { createSimulationWorkerRuntime, type CliExecutionResult } from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import {
  CENTRALIZED_AAA_DEMO,
  MANAGEMENT_DEMO_CREDENTIALS,
  MANAGEMENT_DEMO_LABS,
  SNMP_MANAGEMENT_DEMO,
  SSH_MANAGEMENT_DEMO,
  TELNET_VS_SSH_DEMO,
} from "./management-demo-labs";

/** The demo credential, as the terminal would derive it before sending. */
const ADMIN_FINGERPRINT = "yacCYYSgVIetIvK0mlgRm6Qs2uYi8SqhPDPc9jCR5Wc=";

/**
 * Drive a host terminal through the *worker runtime*, which is the real product
 * path: `EXECUTE_CLI` carries the opaque credential fingerprint exactly as the
 * browser terminal sends it, and the main thread never touches the engine.
 */
function terminal(document: LabDocument, deviceId: string) {
  const runtime = createSimulationWorkerRuntime();
  const ready = runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "init", document });
  expect(ready.type).toBe("REQUEST_SUCCEEDED");
  let sequence = 0;
  const send = (input: string, credential?: string): CliExecutionResult => {
    const response = runtime.handleRequest({
      type: "EXECUTE_CLI",
      requestId: `cli-${++sequence}`,
      sessionId: `terminal:${deviceId}`,
      deviceId,
      input,
      credential,
    });
    if (response.type !== "REQUEST_SUCCEEDED") throw new Error(response.error.message);
    return response.payload as CliExecutionResult;
  };
  return { runtime, send };
}

describe("M10.7 management demo labs", () => {
  it("canonicalizes, builds, serializes, and rebuilds all four labs", () => {
    expect(MANAGEMENT_DEMO_LABS).toHaveLength(4);
    for (const entry of MANAGEMENT_DEMO_LABS) {
      const canonical = canonicalizeLabDocument(entry.document);
      const built = buildLabFromDocument(canonical);
      const serialized = serializeLabDocument(built, {
        id: canonical.id,
        title: canonical.title,
        description: canonical.description,
        instructions: canonical.instructions,
        expectedOutcome: canonical.expectedOutcome,
        diagram: canonical.diagram,
      });
      expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
      expect(() => buildLabFromDocument(parseLabDocument(stringifyLabDocument(serialized)))).not.toThrow();
    }
  });

  it("never persists a demo password, key or community in a lab document", () => {
    for (const entry of MANAGEMENT_DEMO_LABS) {
      // The instructions deliberately name the credential so a learner knows
      // what to type; the persisted configuration must never contain it.
      const configuration = JSON.stringify(entry.document.configurations);
      for (const secret of [
        MANAGEMENT_DEMO_CREDENTIALS.adminPassword,
        MANAGEMENT_DEMO_CREDENTIALS.operatorPassword,
        MANAGEMENT_DEMO_CREDENTIALS.linePassword,
        MANAGEMENT_DEMO_CREDENTIALS.aaaSharedKey,
        MANAGEMENT_DEMO_CREDENTIALS.snmpCommunity,
      ]) {
        expect(configuration).not.toContain(secret);
      }
    }
  });

  it("SSH management: reaches the L2 switch management SVI and refuses Telnet", () => {
    const { send } = terminal(SSH_MANAGEMENT_DEMO, "admin-pc");
    expect(send("ssh admin@192.168.10.2").output).toContain("cannot be established");
    send("yes");
    const login = send("", ADMIN_FINGERPRINT);
    expect(login.prompt).toBe("SW1#");
    expect(login.remote?.label).toBe("SSH 192.168.10.2");
    expect(send("show vlan brief").output).toContain("MGMT");

    expect(send("exit").output).toContain("Connection closed by foreign host.");
    const refused = send("telnet 192.168.10.1");
    expect(refused.output).toContain("%");
    expect(refused.prompt).toBe("C:\\>");
  });

  it("Telnet vs SSH: the ACL drops Telnet in the packet path but permits SSH", () => {
    const { send } = terminal(TELNET_VS_SSH_DEMO, "admin-pc");
    expect(send("telnet 10.0.0.1").output).toContain("%");

    expect(send("ssh admin@10.0.0.1").output).toContain("Fingerprint: SHA256:");
    send("yes");
    expect(send("", ADMIN_FINGERPRINT).prompt).toBe("R1#");
  });

  it("Centralized AAA: RADIUS accepts and TACACS+ denies a configuration command", () => {
    const { send } = terminal(CENTRALIZED_AAA_DEMO, "admin-pc");
    expect(send("telnet 192.168.20.1").output)
      .toContain("Warning: Telnet transmits credentials without encryption.");
    send(MANAGEMENT_DEMO_CREDENTIALS.adminUser);
    expect(send("", ADMIN_FINGERPRINT).prompt).toBe("R1#");

    expect(send("show version").output).not.toContain("% Authorization failed.");
    // Denied by TACACS+ command authorization, and never executed.
    expect(send("configure terminal").output).toContain("% Authorization failed.");
  });

  it("SNMP management: GET and WALK return live state and a linkDown trap arrives", () => {
    const { send } = terminal(SNMP_MANAGEMENT_DEMO, "nms");
    expect(send("snmpget R1 1.3.6.1.2.1.1.5.0").output).toContain("OctetString: R1");
    const walk = send("snmpwalk SW1 1.3.6.1.2.1.2.2.1.2").output;
    expect(walk).toContain("Gi0/1");
    expect(walk).toContain("Vlan30");

    const built = buildLabFromDocument(SNMP_MANAGEMENT_DEMO);
    built.engine.runUntilIdle();
    const router = built.getRouter("snmp-r1")!;
    router.snmp.resetOperationBudget();
    router.getInterface("Gi0/1")!.shutdown();
    built.engine.runUntilIdle();
    const traps = built.getServer("nms")!.services.networkManagement.runtimeSnapshot().traps;
    expect(traps.some((trap) => trap.trapType === "linkDown" && trap.sourceName === "R1")).toBe(true);
  });

  it("derives the demo credential fingerprint from the documented scope", async () => {
    const verifier = await createManagementCredentialVerifier(
      managementCredentialScope.user(MANAGEMENT_DEMO_CREDENTIALS.adminUser),
      MANAGEMENT_DEMO_CREDENTIALS.adminPassword,
    );
    expect(verifier.hashBase64).toBe(ADMIN_FINGERPRINT);
  });
});

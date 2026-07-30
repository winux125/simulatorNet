import { describe, expect, it } from "vitest";
import { createCliSession, type CliSession } from "@sim/cli-engine";
import { managementCredentialScope } from "@sim/console-auth";
import type { ConsoleAccessConfiguration } from "@sim/contracts";
import type { BuiltLab } from "@sim/lab-format";
import { L2Switch, Router } from "@sim/sim-core";
import {
  ADMIN_PASSWORD,
  fingerprintFor,
  LINE_PASSWORD,
  localAdmin,
  managementLab,
  remoteAccess,
  vtyLine,
} from "./helpers";

async function accessWith(
  overrides: Partial<ConsoleAccessConfiguration> = {},
): Promise<ConsoleAccessConfiguration> {
  return {
    mode: "local-user",
    users: [await localAdmin()],
    maximumAttempts: 3,
    credentialResetRequired: false,
    ...overrides,
  };
}

/** Drive PC1's CLI exactly as the terminal does, credential prompts included. */
function terminal(lab: BuiltLab, deviceId = "pc1"): { session: CliSession; run(line: string, secret?: string): string } {
  const device = lab.getDevice(deviceId)!;
  const session = createCliSession(device, lab.engine);
  session.useRemoteSessionOpener(lab.management);
  return {
    session,
    run: (line, secret) => session.execute(line, secret),
  };
}

describe("simulated Telnet and SSH remote CLI", () => {
  it("opens a Telnet session, logs in locally and runs a command on the router", async () => {
    const lab = managementLab({ access: await accessWith(), remote: await remoteAccess() });
    const pc = terminal(lab);

    const banner = pc.run("telnet 192.168.10.1");
    expect(banner).toContain("Warning: Telnet transmits credentials without encryption.");
    expect(pc.session.prompt()).toBe("Username:");

    expect(pc.run("admin")).toBe("");
    expect(pc.session.prompt()).toBe("Password:");
    expect(pc.session.expectsSecret()).toBe(true);
    expect(pc.session.credentialScope()).toBe(managementCredentialScope.user("admin"));

    pc.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));
    // privilege 15 lands straight in privileged EXEC, exactly like IOS
    expect(pc.session.prompt()).toBe("R1#");

    expect(pc.run("show ip interface brief")).toContain("192.168.10.1");
  });

  it("keeps the host session underneath: exit returns to the host prompt", async () => {
    const lab = managementLab({ access: await accessWith(), remote: await remoteAccess() });
    const pc = terminal(lab);
    pc.run("telnet 192.168.10.1");
    pc.run("admin");
    pc.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));
    expect(pc.session.prompt()).toBe("R1#");

    expect(pc.run("exit")).toContain("Connection closed by foreign host.");
    expect(pc.session.prompt()).toBe("C:\\>");
    // The local host CLI is intact and still answers its own commands.
    expect(pc.run("ipconfig")).toContain("192.168.10.20");
  });

  it("confirms an unknown SSH host key before asking for credentials", async () => {
    const lab = managementLab({ access: await accessWith(), remote: await remoteAccess() });
    const pc = terminal(lab);

    const prompt = pc.run("ssh admin@192.168.10.1");
    expect(prompt).toContain("The authenticity of host '192.168.10.1' cannot be established.");
    expect(prompt).toContain("Fingerprint: SHA256:");
    expect(pc.session.prompt()).toBe("Continue connecting (yes/no)?");

    expect(pc.run("yes")).toContain("Permanently added");
    expect(pc.session.prompt()).toBe("Password:");
    pc.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));
    expect(pc.session.prompt()).toBe("R1#");
  });

  it("remembers an accepted host key for the next session from the same client", async () => {
    const lab = managementLab({ access: await accessWith(), remote: await remoteAccess() });
    const first = terminal(lab);
    first.run("ssh admin@192.168.10.1");
    first.run("yes");
    first.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));
    first.run("exit");

    const second = terminal(lab);
    second.run("ssh admin@192.168.10.1");
    expect(second.session.prompt()).toBe("Password:");
  });

  it("rejects a wrong credential and never puts the secret in the trace", async () => {
    const lab = managementLab({ access: await accessWith(), remote: await remoteAccess() });
    lab.engine.enableTrace();
    const pc = terminal(lab);
    pc.run("telnet 192.168.10.1");
    pc.run("admin");
    const output = pc.run("", await fingerprintFor(managementCredentialScope.user("admin"), "wrong-password"));

    expect(output).toBe("% Login invalid\n\n");
    expect(pc.session.prompt()).toBe("Username:");
    const trace = JSON.stringify(lab.engine.traceLog);
    expect(trace).toContain("telnet-login-failed");
    expect(trace).not.toContain(ADMIN_PASSWORD);
    expect(trace).not.toContain("wrong-password");
  });

  it("drops the session after the configured number of failed logins", async () => {
    const lab = managementLab({ access: await accessWith(), remote: await remoteAccess() });
    const pc = terminal(lab);
    pc.run("telnet 192.168.10.1");
    const bad = await fingerprintFor(managementCredentialScope.user("admin"), "nope");
    pc.run("admin");
    pc.run("", bad);
    pc.run("admin");
    pc.run("", bad);
    pc.run("admin");
    const output = pc.run("", bad);

    expect(output).toContain("% Authentication failed.");
    expect(pc.session.prompt()).toBe("C:\\>");
  });

  it("authenticates a line password without asking for a username", async () => {
    const lineVerifier = await fingerprintFor(managementCredentialScope.line("vty"), LINE_PASSWORD);
    const lab = managementLab({
      access: await accessWith({ mode: "password-only", users: [] }),
      remote: await remoteAccess({
        vtyLines: [vtyLine({
          loginMode: "password",
          passwordVerifier: {
            algorithm: "pbkdf2-sha256",
            iterations: 120_000,
            saltBase64: "unused-for-comparison",
            hashBase64: lineVerifier,
          },
        })],
      }),
    });
    const pc = terminal(lab);
    pc.run("telnet 192.168.10.1");
    expect(pc.session.prompt()).toBe("Password:");
    pc.run("", lineVerifier);
    // A line password grants user EXEC only.
    expect(pc.session.prompt()).toBe("R1>");
  });

  it("refuses a transport the VTY lines do not permit", async () => {
    const lab = managementLab({
      access: await accessWith(),
      remote: await remoteAccess({ vtyLines: [vtyLine({ transports: ["ssh"] })] }),
    });
    const pc = terminal(lab);
    expect(pc.run("telnet 192.168.10.1")).toContain("% Connection refused by remote host.");
    expect(pc.session.prompt()).toBe("C:\\>");
  });

  it("reports exhausted VTY lines instead of opening an unbounded session", async () => {
    const lab = managementLab({
      access: await accessWith(),
      remote: await remoteAccess({ vtyLines: [vtyLine({ first: 0, last: 0 })] }),
    });
    const first = terminal(lab);
    first.run("telnet 192.168.10.1");
    first.run("admin");
    first.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));

    const second = terminal(lab);
    expect(second.run("telnet 192.168.10.1")).toContain("% All remote terminal lines are in use.");
  });

  it("reaches an L2 switch through its management SVI without enabling routing", async () => {
    const lab = managementLab({
      access: await accessWith(),
      remote: await remoteAccess(),
      withManagedSwitch: true,
    });
    const pc = terminal(lab);
    pc.run("telnet 192.168.10.2");
    pc.run("admin");
    pc.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));
    expect(pc.session.prompt()).toBe("SW1#");
    expect(pc.run("show vlan brief")).toContain("MGMT");

    const sw = lab.getDevice("sw1") as L2Switch;
    expect(sw).toBeInstanceOf(L2Switch);
    expect(sw.managementSviSummary()?.ip).toBe("192.168.10.2");
    // Still an L2 device: no routing plane is exposed on the switch itself.
    expect(sw instanceof Router).toBe(false);
  });

  it("closes remote sessions when the management interface loses its VLAN", async () => {
    const lab = managementLab({
      access: await accessWith(),
      remote: await remoteAccess(),
      withManagedSwitch: true,
    });
    const pc = terminal(lab);
    pc.run("telnet 192.168.10.2");
    pc.run("admin");
    pc.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));
    expect(lab.management.sessions()).toHaveLength(1);

    lab.management.closeForDevice("sw1", "management-interface-down");
    lab.engine.runUntilIdle();
    expect(lab.management.sessions()).toHaveLength(0);
  });

  it("keeps runtime session state out of the serialized document", async () => {
    const lab = managementLab({ access: await accessWith(), remote: await remoteAccess() });
    const pc = terminal(lab);
    pc.run("telnet 192.168.10.1");
    pc.run("admin");
    pc.run("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));

    const router = lab.getDevice("r1") as Router;
    const snapshot = router.remoteAccess.snapshot();
    expect(snapshot.vtyLines).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("sessionId");
    expect(JSON.stringify(snapshot)).not.toContain(ADMIN_PASSWORD);
  });
});

import { describe, expect, it } from "vitest";
import { createCliSession } from "@sim/cli-engine";
import { managementCredentialScope } from "@sim/console-auth";
import type { ConsoleAccessConfiguration } from "@sim/contracts";
import { L2Switch, Router } from "@sim/sim-core";
import { SSH_PORT, TELNET_PORT } from "@sim/contracts";
import { ADMIN_PASSWORD, fingerprintFor, localAdmin, managementLab, remoteAccess } from "./helpers";

async function access(): Promise<ConsoleAccessConfiguration> {
  return {
    mode: "local-user",
    users: [await localAdmin()],
    maximumAttempts: 3,
    credentialResetRequired: false,
  };
}

/**
 * Remote management must depend on the *network*, not on a shortcut into the
 * target device. These cases prove the traffic really traverses routing, ACLs
 * and interface state.
 */
describe("remote management reachability", () => {
  it("is blocked by an inbound ACL that denies Telnet but permits SSH", async () => {
    const lab = managementLab({ access: await access(), remote: await remoteAccess() });
    lab.engine.enableTrace();
    const router = lab.getDevice("r1") as Router;
    router.defineAcl({
      id: "MGMT",
      type: "extended",
      rules: [
        { sequence: 10, action: "deny", protocol: 6, source: { kind: "any" }, destination: { kind: "any" }, destinationPort: { kind: "eq", port: TELNET_PORT } },
        { sequence: 20, action: "permit", protocol: 6, source: { kind: "any" }, destination: { kind: "any" }, destinationPort: { kind: "eq", port: SSH_PORT } },
        { sequence: 30, action: "permit", protocol: "ip", source: { kind: "any" }, destination: { kind: "any" } },
      ],
    });
    router.applyAcl("Gi0/0", "in", "MGMT");

    const blocked = createCliSession(lab.getDevice("pc1")!, lab.engine);
    blocked.useRemoteSessionOpener(lab.management);
    const telnet = blocked.execute("telnet 192.168.10.1");
    expect(telnet).toContain("%");
    expect(blocked.prompt()).toBe("C:\\>");
    // The SYN is dropped by the ACL and TCP eventually gives up: the block is
    // genuinely in the packet path, not a shortcut inside the service.
    const trace = JSON.stringify(lab.engine.traceLog);
    expect(trace).toContain("acl-denied");
    expect(trace).toContain("tcp-timeout");

    const allowed = createCliSession(lab.getDevice("pc1")!, lab.engine);
    allowed.useRemoteSessionOpener(lab.management);
    allowed.execute("ssh admin@192.168.10.1");
    allowed.execute("yes");
    expect(allowed.prompt()).toBe("Password:");
    allowed.execute("", await fingerprintFor(managementCredentialScope.user("admin"), ADMIN_PASSWORD));
    expect(allowed.prompt()).toBe("R1#");
  });

  it("fails when the path to the management address is administratively down", async () => {
    const lab = managementLab({ access: await access(), remote: await remoteAccess() });
    (lab.getDevice("r1") as Router).getInterface("Gi0/0")!.shutdown();
    lab.engine.runUntilIdle();

    const session = createCliSession(lab.getDevice("pc1")!, lab.engine);
    session.useRemoteSessionOpener(lab.management);
    expect(session.execute("telnet 192.168.10.1")).toContain("%");
    expect(session.prompt()).toBe("C:\\>");
  });

  it("takes an L2 management SVI down with its VLAN and refuses new sessions", async () => {
    const lab = managementLab({
      access: await access(),
      remote: await remoteAccess(),
      withManagedSwitch: true,
    });
    const sw = lab.getDevice("sw1") as L2Switch;
    expect(sw.managementSviSummary()?.operUp).toBe(true);

    // Move the only member ports out of the management VLAN.
    sw.setAccess("Gi0/1", 20);
    sw.setAccess("Gi0/2", 20);
    lab.engine.runUntilIdle();
    expect(sw.managementSviSummary()?.operUp).toBe(false);

    const session = createCliSession(lab.getDevice("pc1")!, lab.engine);
    session.useRemoteSessionOpener(lab.management);
    expect(session.execute("telnet 192.168.10.2")).toContain("%");
  });

  it("resolves a managed device by hostname without any DNS server", async () => {
    const lab = managementLab({
      access: await access(),
      remote: await remoteAccess(),
      withManagedSwitch: true,
    });
    const session = createCliSession(lab.getDevice("pc1")!, lab.engine);
    session.useRemoteSessionOpener(lab.management);
    session.execute("telnet SW1");
    expect(session.prompt()).toBe("Username:");
  });

  it("never exposes a management plane on an unmanaged device", async () => {
    const lab = managementLab({ access: await access(), remote: await remoteAccess() });
    expect(lab.management.managedDeviceIds()).toEqual(["r1", "sw1"]);
    expect(lab.management.serviceOf("pc1")).toBeUndefined();
  });
});

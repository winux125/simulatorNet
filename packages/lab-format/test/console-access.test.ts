import type { HubDeviceConfig, LabDocument, RouterDeviceConfig } from "@sim/contracts";
import { createPasswordVerifier, verifyPassword } from "@sim/console-auth";
import { buildLabFromDocument, canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";

function labWith(consoleAccess: RouterDeviceConfig["consoleAccess"]): LabDocument {
  return {
    schemaVersion: 1,
    id: "auth-lab",
    title: "Auth Lab",
    simulation: { seed: 7 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
      ],
      links: [{ id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } }],
    },
    configurations: {
      pc1: { kind: "pc", hostname: "PC1", interfaces: [], ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" }, dhcpEnabled: false },
      r1: {
        kind: "router",
        hostname: "R1",
        interfaces: [{ id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } }],
        subinterfaces: [], staticRoutes: [], dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
        consoleAccess,
      },
    },
  };
}

describe("console access persistence and isolation", () => {
  it("preserves console access through canonicalize and export round trip", async () => {
    const consoleAccess = {
      mode: "local-user" as const,
      users: [{ id: "u1", username: "admin", passwordVerifier: await createPasswordVerifier("cisco123", 1_000), privilegeLevel: 15, enabled: true }],
      enableSecretVerifier: await createPasswordVerifier("enablepass", 1_000),
      maximumAttempts: 3,
      credentialResetRequired: false,
    };
    const canonical = canonicalizeLabDocument(labWith(consoleAccess));
    const access = (canonical.configurations.r1 as RouterDeviceConfig).consoleAccess!;
    expect(access.mode).toBe("local-user");
    expect(access.users[0]?.username).toBe("admin");
    expect(await verifyPassword("cisco123", access.users[0]!.passwordVerifier)).toBe(true);
    // Survives serialization to JSON and back.
    const reparsed = canonicalizeLabDocument(JSON.parse(stringifyLabDocument(canonical)) as LabDocument);
    expect((reparsed.configurations.r1 as RouterDeviceConfig).consoleAccess).toEqual(access);
  });

  it("never lets console auth affect the data plane or grading trace", async () => {
    const consoleAccess = {
      mode: "password-only" as const,
      users: [],
      consolePasswordVerifier: await createPasswordVerifier("linepass", 1_000),
      maximumAttempts: 3,
      credentialResetRequired: false,
    };
    const run = (document: LabDocument) => {
      const lab = buildLabFromDocument(document);
      lab.engine.enableTrace();
      lab.getPc("pc1")!.ping("10.0.0.1", 1);
      lab.engine.runUntilIdle();
      return { success: lab.getPc("pc1")!.pingResults.at(-1)?.success, trace: lab.engine.traceLog };
    };
    const withAuth = run(labWith(consoleAccess));
    const withoutAuth = run(labWith(undefined));
    expect(withAuth.success).toBe(true);
    // The engine ignores console access entirely: identical golden trace.
    expect(withAuth.trace).toEqual(withoutAuth.trace);
  });

  it("does not let a hub carry console authentication", () => {
    const document: LabDocument = {
      schemaVersion: 1, id: "hub-lab", title: "Hub", simulation: { seed: 1 },
      topology: { schemaVersion: 1, nodes: [{ id: "h1", kind: "hub", name: "H1", interfaces: [{ id: "Eth0/1" }] }], links: [] },
      configurations: { h1: { kind: "hub", hostname: "H1", interfaces: [], consoleAccess: { mode: "password-only", users: [], maximumAttempts: 3, credentialResetRequired: false } } as HubDeviceConfig & { consoleAccess: unknown } },
    };
    const canonical = canonicalizeLabDocument(document);
    expect("consoleAccess" in canonical.configurations.h1!).toBe(false);
  });
});

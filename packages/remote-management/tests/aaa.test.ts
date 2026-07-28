import { describe, expect, it } from "vitest";
import { createCliSession, type CliSession } from "@sim/cli-engine";
import { createManagementCredentialVerifier, managementCredentialScope } from "@sim/console-auth";
import type {
  AaaConfiguration,
  AaaMethod,
  ConsoleAccessConfiguration,
  LabDocumentDraft,
  RadiusServiceConfig,
  TacacsServiceConfig,
} from "@sim/contracts";
import { buildLabFromDocument, canonicalizeLabDocument, type BuiltLab } from "@sim/lab-format";
import { Server } from "@sim/sim-core";
import { fingerprintFor, localAdmin, remoteAccess, vtyLine } from "./helpers";

const PASSWORD = "lab-admin-secret";
const SHARED_KEY = "lab-shared-key";
const ADMIN_SCOPE = managementCredentialScope.user("admin");

async function aaaServerUser(username: string, password: string, privilegeLevel: number) {
  const verifier = await createManagementCredentialVerifier(managementCredentialScope.user(username), password);
  return {
    id: `srv-${username}`,
    username,
    credentialFingerprint: verifier.hashBase64,
    privilegeLevel,
    enabled: true,
  };
}

interface AaaLabOptions {
  readonly methods: readonly AaaMethod[];
  /** Omit the AAA server from the topology so it is genuinely unreachable. */
  readonly withAaaServer?: boolean;
  readonly radiusUsers?: RadiusServiceConfig["users"];
  readonly tacacs?: Partial<TacacsServiceConfig>;
  readonly commandMethods?: readonly AaaMethod[];
  readonly localUserPrivilege?: number;
}

/** PC1 --- SW1 --- R1 --- AAA1 (Server with RADIUS and TACACS+ services). */
async function aaaLab(options: AaaLabOptions): Promise<BuiltLab> {
  const sharedKey = await fingerprintFor(managementCredentialScope.sharedKey("AAA1"), SHARED_KEY);
  const access: ConsoleAccessConfiguration = {
    mode: "local-user",
    users: [await localAdmin("admin", PASSWORD, options.localUserPrivilege ?? 15)],
    maximumAttempts: 3,
    credentialResetRequired: false,
  };
  const aaa: AaaConfiguration = {
    enabled: true,
    authenticationLogin: [{ name: "default", methods: [...options.methods] }],
    authorizationExec: [],
    authorizationCommands: options.commandMethods
      ? [{ name: "default", privilegeLevel: 15, methods: [...options.commandMethods] }]
      : [],
    accountingExec: [{ name: "default", mode: "start-stop", methods: ["group radius"] }],
    accountingCommands: [{ name: "default", privilegeLevel: 15, mode: "start-stop", methods: ["group tacacs+"] }],
    servers: [
      {
        name: "AAA1",
        protocol: "radius",
        address: "192.168.50.10",
        sharedKeyFingerprint: sharedKey,
        timeoutSeconds: 2,
        retries: 0,
      },
      {
        name: "AAA1",
        protocol: "tacacs+",
        address: "192.168.50.10",
        sharedKeyFingerprint: sharedKey,
        timeoutSeconds: 2,
        retries: 0,
      },
    ],
  };

  const radius: RadiusServiceConfig = {
    type: "radius",
    id: "radius",
    enabled: true,
    port: 1812,
    accountingPort: 1813,
    users: options.radiusUsers ?? [await aaaServerUser("admin", PASSWORD, 15)],
    clients: [{ id: "r1", address: "192.168.50.1", name: "R1", sharedKeyFingerprint: sharedKey, enabled: true }],
    restrictToConfiguredClients: true,
  };
  const tacacs: TacacsServiceConfig = {
    type: "tacacs",
    id: "tacacs",
    enabled: true,
    port: 49,
    users: [await aaaServerUser("admin", PASSWORD, 15)],
    clients: [{ id: "r1", address: "192.168.50.1", name: "R1", sharedKeyFingerprint: sharedKey, enabled: true }],
    restrictToConfiguredClients: true,
    execAuthorizationDefault: "permit",
    commandRules: [],
    commandDefault: "permit",
    ...options.tacacs,
  };

  const draft: LabDocumentDraft = {
    schemaVersion: 1,
    id: "aaa-lab",
    title: "AAA lab",
    simulation: { seed: 11 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        ...(options.withAaaServer === false
          ? []
          : [{ id: "aaa1", kind: "server" as const, name: "AAA1", interfaces: [{ id: "eth0" }, { id: "eth1" }] }]),
      ],
      links: [
        { id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
        ...(options.withAaaServer === false
          ? []
          : [{ id: "l2", a: { node: "r1", iface: "Gi0/1" }, b: { node: "aaa1", iface: "eth0" } }]),
      ],
    },
    configurations: {
      pc1: {
        kind: "pc",
        hostname: "PC1",
        ipv4: { address: "10.0.0.20", prefixLength: 24, defaultGateway: "10.0.0.1" },
      },
      r1: {
        kind: "router",
        hostname: "R1",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
          { id: "Gi0/1", routed: true, ipv4: { address: "192.168.50.1", prefixLength: 24 } },
        ],
        consoleAccess: access,
        remoteAccess: await remoteAccess({ vtyLines: [vtyLine({ loginMode: "local" })] }),
        aaa,
      },
      ...(options.withAaaServer === false
        ? {}
        : {
            aaa1: {
              kind: "server" as const,
              hostname: "AAA1",
              interfaces: [
                { id: "eth0", ipv4: { address: "192.168.50.10", prefixLength: 24 } },
                { id: "eth1" },
              ],
              defaultGateway: "192.168.50.1",
              enabledServices: [radius, tacacs],
            },
          }),
    },
  };
  return buildLabFromDocument(canonicalizeLabDocument(draft));
}

function terminal(lab: BuiltLab): CliSession {
  const session = createCliSession(lab.getDevice("pc1")!, lab.engine);
  session.useRemoteSessionOpener(lab.management);
  return session;
}

async function login(lab: BuiltLab, password = PASSWORD): Promise<CliSession> {
  const session = terminal(lab);
  session.execute("telnet 10.0.0.1");
  session.execute("admin");
  session.execute("", await fingerprintFor(ADMIN_SCOPE, password));
  return session;
}

describe("AAA method lists", () => {
  it.each([
    ["group radius then local", ["group radius", "local"] as AaaMethod[]],
    ["group tacacs+ then local", ["group tacacs+", "local"] as AaaMethod[]],
    ["local only", ["local"] as AaaMethod[]],
  ])("accepts a valid credential through %s", async (_name, methods) => {
    const lab = await aaaLab({ methods });
    const session = await login(lab);
    expect(session.prompt()).toBe("R1#");
  });

  it.each([
    ["group radius", ["group radius", "local"] as AaaMethod[]],
    ["group tacacs+", ["group tacacs+", "local"] as AaaMethod[]],
  ])("does not fall back to local after an explicit %s reject", async (_name, methods) => {
    // The server is reachable and says no: the login must fail even though the
    // very same credential would satisfy the local database.
    const lab = await aaaLab({ methods, radiusUsers: [], tacacs: { users: [] } });
    const session = await login(lab);
    expect(session.prompt()).not.toBe("R1#");
  });

  it("falls back to local when the AAA server is unreachable", async () => {
    const lab = await aaaLab({ methods: ["group radius", "local"], withAaaServer: false });
    lab.engine.enableTrace();
    const session = await login(lab);
    expect(session.prompt()).toBe("R1#");
    expect(JSON.stringify(lab.engine.traceLog)).toContain("radius-timeout");
  });

  it("fails when every method is unavailable and none accepts", async () => {
    const lab = await aaaLab({ methods: ["group radius"], withAaaServer: false });
    const session = await login(lab);
    expect(session.prompt()).not.toBe("R1#");
  });

  it("rejects a wrong password without leaking it into the trace", async () => {
    const lab = await aaaLab({ methods: ["group radius", "local"] });
    lab.engine.enableTrace();
    const session = await login(lab, "not-the-password");
    expect(session.prompt()).not.toBe("R1#");
    const trace = JSON.stringify(lab.engine.traceLog);
    expect(trace).not.toContain(PASSWORD);
    expect(trace).not.toContain("not-the-password");
    expect(trace).not.toContain(SHARED_KEY);
  });
});

describe("TACACS+ command authorization", () => {
  it("permits a command that matches a permit rule", async () => {
    const lab = await aaaLab({
      methods: ["local"],
      commandMethods: ["group tacacs+"],
      tacacs: {
        commandRules: [
          { id: "r1", sequence: 10, match: "prefix", command: "show", action: "permit" },
        ],
        commandDefault: "deny",
      },
    });
    const session = await login(lab);
    expect(session.execute("show ip interface brief")).toContain("10.0.0.1");
  });

  it("denies a command that no rule permits and never runs it", async () => {
    const lab = await aaaLab({
      methods: ["local"],
      commandMethods: ["group tacacs+"],
      tacacs: {
        commandRules: [{ id: "r1", sequence: 10, match: "prefix", command: "show", action: "permit" }],
        commandDefault: "deny",
      },
    });
    const session = await login(lab);
    expect(session.execute("configure terminal")).toContain("% Authorization failed.");
    // Refused: the device never entered configuration mode.
    expect(session.execute("show ip interface brief")).toContain("10.0.0.1");
  });

  it("honours an explicit deny rule ahead of a broader permit", async () => {
    const lab = await aaaLab({
      methods: ["local"],
      commandMethods: ["group tacacs+"],
      tacacs: {
        commandRules: [
          { id: "deny-run", sequence: 10, match: "prefix", command: "show running-config", action: "deny" },
          { id: "allow-show", sequence: 20, match: "prefix", command: "show", action: "permit" },
        ],
        commandDefault: "deny",
      },
    });
    const session = await login(lab);
    expect(session.execute("show running-config")).toContain("% Authorization failed.");
    expect(session.execute("show version")).not.toContain("% Authorization failed.");
  });
});

describe("AAA accounting", () => {
  it("records session start and command events without storing secrets", async () => {
    const lab = await aaaLab({ methods: ["group radius", "local"] });
    const session = await login(lab);
    session.execute("show version");
    session.execute("exit");
    lab.engine.runUntilIdle();

    const server = lab.getDevice("aaa1") as Server;
    const runtime = server.serviceRuntimeSnapshot();
    const events = [...runtime.radius.accounting, ...runtime.tacacs.accounting];
    expect(events.some((entry) => entry.event === "start")).toBe(true);
    expect(events.some((entry) => entry.event === "stop")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(SHARED_KEY);
  });

  it("keeps accounting out of the serialized document", async () => {
    const lab = await aaaLab({ methods: ["group radius", "local"] });
    await login(lab);
    lab.engine.runUntilIdle();
    const server = lab.getDevice("aaa1") as Server;
    // The runtime has entries; the persisted configuration has none of them.
    expect(server.serviceRuntimeSnapshot().radius.accounting.length).toBeGreaterThan(0);
    const configured = JSON.stringify(server.services.configurations());
    expect(configured).not.toContain("sessionId");
    expect(configured).not.toContain("receivedAtNs");
    expect(configured).not.toContain(PASSWORD);
    expect(configured).not.toContain(SHARED_KEY);
  });
});

describe("AAA server access control", () => {
  it("rejects a request from an unconfigured client address", async () => {
    const lab = await aaaLab({
      methods: ["group radius"],
      radiusUsers: [await aaaServerUser("admin", PASSWORD, 15)],
    });
    const server = lab.getDevice("aaa1") as Server;
    const radius = server.services.configurations().find((entry) => entry.type === "radius")!;
    server.configureService({ ...radius, clients: [] });
    lab.engine.runUntilIdle();

    const session = await login(lab);
    expect(session.prompt()).not.toBe("R1#");
  });
});

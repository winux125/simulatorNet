import {
  createManagementCredentialVerifier,
  managementCredentialScope,
} from "@sim/console-auth";
import type {
  ConsoleAccessConfiguration,
  LabDocumentDraft,
  RemoteAccessConfiguration,
  VtyLineConfig,
} from "@sim/contracts";
import { buildLabFromDocument, canonicalizeLabDocument, type BuiltLab } from "@sim/lab-format";

export const ADMIN_PASSWORD = "lab-admin-secret";
export const LINE_PASSWORD = "lab-line-secret";

/** Credentials for a demo/lab user, stored only as opaque verifiers. */
export async function localAdmin(
  username = "admin",
  password = ADMIN_PASSWORD,
  privilegeLevel = 15,
): Promise<ConsoleAccessConfiguration["users"][number]> {
  const scope = managementCredentialScope.user(username);
  const verifier = await createManagementCredentialVerifier(scope, password);
  return {
    id: `user-${username}`,
    username,
    passwordVerifier: verifier,
    credentialFingerprint: verifier.hashBase64,
    privilegeLevel,
    enabled: true,
  };
}

export async function fingerprintFor(scope: string, secret: string): Promise<string> {
  return (await createManagementCredentialVerifier(scope, secret)).hashBase64;
}

export function vtyLine(overrides: Partial<VtyLineConfig> = {}): VtyLineConfig {
  return {
    first: 0,
    last: 4,
    loginMode: "local",
    transports: ["telnet", "ssh"],
    execTimeoutSeconds: 600,
    ...overrides,
  };
}

export async function remoteAccess(
  overrides: Partial<RemoteAccessConfiguration> = {},
): Promise<RemoteAccessConfiguration> {
  return {
    telnetEnabled: true,
    ssh: {
      enabled: true,
      version: 2,
      domainName: "lab.local",
      hostKeyFingerprint: "SHA256:0000000000000000000000000000000000000000",
      modulusBits: 2_048,
    },
    vtyLines: [vtyLine()],
    ...overrides,
  };
}

interface ManagementLabOptions {
  readonly access: ConsoleAccessConfiguration;
  readonly remote: RemoteAccessConfiguration;
  /** Extra L2 switch between PC and router, reached through a management SVI. */
  readonly withManagedSwitch?: boolean;
}

/**
 * PC1 --- SW1 --- R1
 *
 * PC1 192.168.10.20/24, SW1 management SVI 192.168.10.2/24 (VLAN 10),
 * R1 Gi0/0 192.168.10.1/24.
 */
export function managementLab(options: ManagementLabOptions): BuiltLab {
  const draft: LabDocumentDraft = {
    schemaVersion: 1,
    id: "management-lab",
    title: "Management lab",
    simulation: { seed: 7 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
        {
          id: "sw1",
          kind: "l2-switch",
          name: "SW1",
          interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
        },
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      ],
      links: [
        { id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
        { id: "l2", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "r1", iface: "Gi0/0" } },
      ],
    },
    configurations: {
      pc1: {
        kind: "pc",
        hostname: "PC1",
        ipv4: { address: "192.168.10.20", prefixLength: 24, defaultGateway: "192.168.10.1" },
      },
      sw1: {
        kind: "l2-switch",
        hostname: "SW1",
        vlans: [{ id: 10, name: "MGMT" }],
        interfaces: [
          { id: "Gi0/1", mode: "access", accessVlan: 10 },
          { id: "Gi0/2", mode: "access", accessVlan: 10 },
        ],
        managementSvi: options.withManagedSwitch
          ? { vlanId: 10, ipAddress: "192.168.10.2", prefixLength: 24, adminUp: true }
          : undefined,
        managementDefaultGateway: options.withManagedSwitch ? "192.168.10.1" : undefined,
        consoleAccess: options.withManagedSwitch ? options.access : undefined,
        remoteAccess: options.withManagedSwitch ? options.remote : undefined,
      },
      r1: {
        kind: "router",
        hostname: "R1",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "192.168.10.1", prefixLength: 24 } },
          { id: "Gi0/1" },
        ],
        consoleAccess: options.access,
        remoteAccess: options.remote,
      },
    },
  };
  return buildLabFromDocument(canonicalizeLabDocument(draft));
}

/** Run a terminal line on a host CLI session and return everything it printed. */
export interface TerminalDriver {
  send(line: string, credential?: string): string;
  prompt(): string;
  expectsSecret(): boolean;
  credentialScope(): string | undefined;
}

import type {
  ConsoleAccessConfiguration,
  LabDocument,
  PasswordVerifier,
  RemoteAccessConfiguration,
  SnmpAgentConfiguration,
  LabDocumentDraft,
} from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";

/**
 * M10.7 management demo labs: remote CLI, AAA and SNMP.
 *
 * These are teaching labs, so they ship with *documented educational*
 * credentials — never a production secret. Even here the passwords are stored
 * only as scope-bound verifiers, exactly as a learner's own configuration is:
 * the plaintext below appears in the instructions so a learner knows what to
 * type, and nowhere in any persisted structure.
 *
 * Setup instructions in each lab tell the learner which credential to use; the
 * simulated SSH host key is derived when the lab is built, never shipped.
 */

/** Documented educational credentials. Never reuse these anywhere real. */
export const MANAGEMENT_DEMO_CREDENTIALS = {
  adminUser: "admin",
  adminPassword: "SimulatorNetLab!",
  operatorUser: "operator",
  operatorPassword: "SimulatorNetOps!",
  linePassword: "SimulatorNetLine!",
  aaaSharedKey: "SimulatorNetAaaKey!",
  snmpCommunity: "SimulatorNetRead",
} as const;

const ADMIN_VERIFIER: PasswordVerifier = {
  algorithm: "pbkdf2-sha256",
  iterations: 120_000,
  saltBase64: "MGT/zIlzv1427bZ7O5BQGQ==",
  hashBase64: "yacCYYSgVIetIvK0mlgRm6Qs2uYi8SqhPDPc9jCR5Wc=",
};
const OPERATOR_VERIFIER: PasswordVerifier = {
  algorithm: "pbkdf2-sha256",
  iterations: 120_000,
  saltBase64: "N3AVx9J7JCqPIK5DDhT8hQ==",
  hashBase64: "yWt/GFhbySTyoixT4qfYlm0tifjaN73EGGEbv+enA44=",
};
/** Reserved for a line-password lab; kept beside the other demo verifiers. */
export const LINE_VERIFIER: PasswordVerifier = {
  algorithm: "pbkdf2-sha256",
  iterations: 120_000,
  saltBase64: "CsDiBUhVYj5kYBcaqkVG3Q==",
  hashBase64: "ZTGTGdVnmTfscOTZljXWkmuquxBAfqdWilVEnd54EGo=",
};
const AAA_KEY_FINGERPRINT = "WTUJfSseZvSC7HPCWZh6OE9HD0nErTvvmvJp8X6eIyQ=";

/** SNMP communities are scoped to the agent's device id, so each differs. */
const COMMUNITY = {
  "mgmt-r1": "vZKmvcPrzXTM++IB6+QpHPHP1QIBXSHPdikhOjNc7cg=",
  "mgmt-sw1": "ekbasMdV//F08c7PMMDRhwWBH84CpvIh4cF5IXhf+R0=",
  "mgmt-l3": "Bv2KlBWfuPndzNvoWn+FqxRT5tMeR9fFa5C3B9ewVIo=",
  "aaa-r1": "7WzkWUOSNDFrQhreSUt+AYomQB9BMuciIHJoyIIICCY=",
  "aaa-sw1": "wh/jXExUSwXC3l2s5xVs6gipBOF042iKt0Hy8kQdzZI=",
  "snmp-r1": "XPwynoAV1c7NQPzQUezFuV2vJEKr/WIh+MXzOKV9D74=",
  "snmp-sw1": "7BMHKHWGeFarPmoLxAdj4gJNu/ucxZmBt7RhllcqFPs=",
  "snmp-l3": "dFLokqdEf1GoBg5kJT4Ma9R3WD3XYae2FlYUg3NEQFg=",
} as const;

function localUsers(privileged = true): ConsoleAccessConfiguration {
  return {
    mode: "local-user",
    users: [
      {
        id: "admin",
        username: MANAGEMENT_DEMO_CREDENTIALS.adminUser,
        passwordVerifier: { ...ADMIN_VERIFIER },
        credentialFingerprint: ADMIN_VERIFIER.hashBase64,
        privilegeLevel: privileged ? 15 : 1,
        enabled: true,
      },
      {
        id: "operator",
        username: MANAGEMENT_DEMO_CREDENTIALS.operatorUser,
        passwordVerifier: { ...OPERATOR_VERIFIER },
        credentialFingerprint: OPERATOR_VERIFIER.hashBase64,
        privilegeLevel: 15,
        enabled: true,
      },
    ],
    maximumAttempts: 3,
    credentialResetRequired: false,
  };
}

function sshOnly(deviceId: string, authenticationList?: string): RemoteAccessConfiguration {
  return {
    // SSH-only management: Telnet is refused before any credential is asked.
    telnetEnabled: false,
    ssh: {
      enabled: true,
      version: 2,
      domainName: "lab.local",
      hostKeyFingerprint: hostKey(deviceId),
      modulusBits: 2_048,
    },
    vtyLines: [{
      first: 0,
      last: 4,
      loginMode: "local",
      transports: ["ssh"],
      execTimeoutSeconds: 600,
      authenticationListName: authenticationList,
    }],
  };
}

function telnetAndSsh(deviceId: string, authenticationList?: string): RemoteAccessConfiguration {
  return {
    telnetEnabled: true,
    ssh: {
      enabled: true,
      version: 2,
      domainName: "lab.local",
      hostKeyFingerprint: hostKey(deviceId),
      modulusBits: 2_048,
    },
    vtyLines: [{
      first: 0,
      last: 4,
      loginMode: "local",
      transports: ["telnet", "ssh"],
      execTimeoutSeconds: 600,
      authenticationListName: authenticationList,
    }],
  };
}

/**
 * The same deterministic derivation `crypto key generate rsa` performs. It is a
 * device identity string, never key material.
 */
function hostKey(deviceId: string): string {
  let hash = 2_166_136_261;
  for (const char of `${deviceId}|lab.local|2048`) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
  const bytes: string[] = [];
  let state = hash;
  for (let index = 0; index < 16; index++) {
    state = Math.imul(state ^ (index + 0x9e37_79b9), 16_777_619) >>> 0;
    bytes.push(((state >>> 16) & 0xff).toString(16).padStart(2, "0"));
  }
  return `SHA256:${bytes.join("")}`;
}

function agent(deviceId: keyof typeof COMMUNITY, trapTarget?: string): SnmpAgentConfiguration {
  return {
    enabled: true,
    communities: [{ id: "read-only", fingerprint: COMMUNITY[deviceId], access: "read-only", enabled: true }],
    location: "SimulatorNet teaching lab",
    contact: "netops@lab.local",
    trapsEnabled: trapTarget !== undefined,
    trapDestinations: trapTarget === undefined
      ? []
      : [{ id: "nms", address: trapTarget, port: 162, version: "2c", enabled: true }],
    enabledTrapTypes: [],
  };
}

// --- 1. SSH management --------------------------------------------------------

const SSH_MANAGEMENT_DEMO_DRAFT: LabDocumentDraft = {
  schemaVersion: 1,
  id: "demo-ssh-management",
  title: "SSH Management",
  description: "Objective: manage a Router, an L2 Switch and an L3 Switch over simulated SSH only.",
  instructions: [
    "Addressing: ADMIN-PC 192.168.10.50/24, SW1 management SVI 192.168.10.2/24 (VLAN 10),",
    "R1 Gi0/0 192.168.10.1/24, L3SW Vlan10 192.168.10.3/24.",
    "",
    "Credentials (educational only, stored as verifiers): user 'admin' password 'SimulatorNetLab!'.",
    "Set your own with the Management > Remote Access panel before submitting a graded lab.",
    "",
    "Required configuration: local users, ip domain-name, crypto key generate rsa, ip ssh version 2,",
    "line vty 0 4 with 'login local' and 'transport input ssh'. Telnet is deliberately disabled.",
    "",
    "Try: ssh admin@192.168.10.2 from ADMIN-PC, accept the host key, then run 'show vlan brief'.",
    "Expected outcome: SSH succeeds on all three devices; 'telnet 192.168.10.1' is refused.",
    "Troubleshooting hint: an L2 switch answers only on its management VLAN — check that an",
    "active access port still carries VLAN 10, or the SVI goes operationally down.",
  ].join("\n"),
  expectedOutcome: "SSH management works on Router, L2 Switch and L3 Switch; Telnet is refused.",
  simulation: { seed: 10_701 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "admin-pc", kind: "pc", name: "ADMIN-PC", position: { x: 80, y: 220 }, interfaces: [{ id: "eth0" }] },
      {
        id: "mgmt-sw1",
        kind: "l2-switch",
        name: "SW1",
        position: { x: 380, y: 220 },
        interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
      },
      { id: "mgmt-r1", kind: "router", name: "R1", position: { x: 700, y: 110 }, interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      {
        id: "mgmt-l3",
        kind: "l3-switch",
        name: "L3SW",
        position: { x: 700, y: 340 },
        interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
      },
    ],
    links: [
      { id: "pc-sw", a: { node: "admin-pc", iface: "eth0" }, b: { node: "mgmt-sw1", iface: "Gi0/1" } },
      { id: "sw-r1", a: { node: "mgmt-sw1", iface: "Gi0/2" }, b: { node: "mgmt-r1", iface: "Gi0/0" } },
      { id: "sw-l3", a: { node: "mgmt-sw1", iface: "Gi0/3" }, b: { node: "mgmt-l3", iface: "Gi0/1" } },
    ],
  },
  configurations: {
    "admin-pc": {
      kind: "pc",
      hostname: "ADMIN-PC",
      interfaces: [],
      ipv4: { address: "192.168.10.50", prefixLength: 24, defaultGateway: "192.168.10.1" },
      dhcpEnabled: false,
    },
    "mgmt-sw1": {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [{ id: 10, name: "MGMT" }],
      interfaces: [
        { id: "Gi0/1", mode: "access", accessVlan: 10 },
        { id: "Gi0/2", mode: "access", accessVlan: 10 },
        { id: "Gi0/3", mode: "access", accessVlan: 10 },
      ],
      managementSvi: { vlanId: 10, ipAddress: "192.168.10.2", prefixLength: 24, adminUp: true, description: "Management" },
      managementDefaultGateway: "192.168.10.1",
      consoleAccess: localUsers(),
      remoteAccess: sshOnly("mgmt-sw1"),
    },
    "mgmt-r1": {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", routed: true, ipv4: { address: "192.168.10.1", prefixLength: 24 } },
        { id: "Gi0/1" },
      ],
      consoleAccess: localUsers(),
      remoteAccess: sshOnly("mgmt-r1"),
    },
    "mgmt-l3": {
      kind: "l3-switch",
      hostname: "L3SW",
      vlans: [{ id: 10, name: "MGMT" }],
      interfaces: [
        { id: "Gi0/1", mode: "access", accessVlan: 10 },
        { id: "Gi0/2", mode: "access", accessVlan: 10 },
      ],
      svis: [{ vlanId: 10, ipAddress: "192.168.10.3", prefixLength: 24, adminUp: true }],
      ipRoutingEnabled: false,
      consoleAccess: localUsers(),
      remoteAccess: sshOnly("mgmt-l3"),
    },
  },
};

// --- 2. Telnet vs SSH ---------------------------------------------------------

const TELNET_VS_SSH_DEMO_DRAFT: LabDocumentDraft = {
  schemaVersion: 1,
  id: "demo-telnet-vs-ssh",
  title: "Telnet vs SSH",
  description: "Objective: compare plaintext Telnet with simulated SSH, then block Telnet with an ACL.",
  instructions: [
    "Addressing: ADMIN-PC 10.0.0.50/24, R1 Gi0/0 10.0.0.1/24.",
    "",
    "Credentials (educational only): user 'admin' password 'SimulatorNetLab!'.",
    "",
    "Both transports are permitted on line vty 0 4, but ACL MGMT on Gi0/0 denies TCP 23 and",
    "permits TCP 22. Open Packet Trace and use the Telnet and SSH protocol filters.",
    "",
    "Try: 'telnet 10.0.0.1' — the SYN is dropped by the ACL and TCP eventually times out.",
    "Then 'ssh admin@10.0.0.1' — the session opens after you accept the host key.",
    "Expected outcome: Telnet is denied in the packet path; SSH succeeds.",
    "Troubleshooting hint: simulated SSH is not encryption. It exists so you can practise the",
    "management workflow; the warning Telnet prints is the real teaching point.",
  ].join("\n"),
  expectedOutcome: "The ACL denies Telnet in Packet Trace while SSH still reaches the CLI.",
  simulation: { seed: 10_702 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "admin-pc", kind: "pc", name: "ADMIN-PC", position: { x: 120, y: 220 }, interfaces: [{ id: "eth0" }] },
      { id: "mgmt-r1", kind: "router", name: "R1", position: { x: 520, y: 220 }, interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
    ],
    links: [
      { id: "pc-r1", a: { node: "admin-pc", iface: "eth0" }, b: { node: "mgmt-r1", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    "admin-pc": {
      kind: "pc",
      hostname: "ADMIN-PC",
      interfaces: [],
      ipv4: { address: "10.0.0.50", prefixLength: 24, defaultGateway: "10.0.0.1" },
      dhcpEnabled: false,
    },
    "mgmt-r1": {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Gi0/1" },
      ],
      acls: [{
        id: "MGMT",
        type: "extended",
        rules: [
          { sequence: 10, action: "deny", protocol: 6, source: { kind: "any" }, destination: { kind: "any" }, destinationPort: { kind: "eq", port: 23 } },
          { sequence: 20, action: "permit", protocol: 6, source: { kind: "any" }, destination: { kind: "any" }, destinationPort: { kind: "eq", port: 22 } },
          { sequence: 30, action: "permit", protocol: "ip", source: { kind: "any" }, destination: { kind: "any" } },
        ],
      }],
      aclBindings: [{ interfaceName: "Gi0/0", direction: "in", aclId: "MGMT" }],
      consoleAccess: localUsers(),
      remoteAccess: telnetAndSsh("mgmt-r1"),
    },
  },
};

// --- 3. Centralized AAA -------------------------------------------------------

const CENTRALIZED_AAA_DEMO_DRAFT: LabDocumentDraft = {
  schemaVersion: 1,
  id: "demo-centralized-aaa",
  title: "Centralized AAA",
  description: "Objective: authenticate through RADIUS, authorize commands through TACACS+, and fall back to local when the server is unavailable.",
  instructions: [
    "Addressing: ADMIN-PC 192.168.20.50/24, R1 Gi0/0 192.168.20.1/24, R1 Gi0/1 192.168.50.1/24,",
    "AAA1 192.168.50.10/24, SW1 management SVI 192.168.20.2/24 (VLAN 20).",
    "",
    "Credentials (educational only): user 'admin' password 'SimulatorNetLab!' on both the AAA",
    "server and the local database; shared key 'SimulatorNetAaaKey!' between R1 and AAA1.",
    "",
    "Method lists: authentication login default = group radius, local.",
    "Command authorization for privilege 15 = group tacacs+, and TACACS+ permits 'show' while",
    "denying 'configure'.",
    "",
    "Try: telnet 192.168.20.1 and log in as admin, then run 'show version' and 'configure terminal'.",
    "Then shut down R1 Gi0/1 and log in again: RADIUS times out and the local database accepts you.",
    "Expected outcome: RADIUS accepts, TACACS+ denies 'configure terminal', and local fallback",
    "works only while the server is unreachable — never after an explicit reject.",
    "Troubleshooting hint: a reachable server that rejects is conclusive. If local fallback",
    "happens when you did not expect it, the server was unreachable, not disagreeing.",
  ].join("\n"),
  expectedOutcome: "RADIUS authentication, TACACS+ command authorization, and local fallback only on server outage.",
  simulation: { seed: 10_703 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "admin-pc", kind: "pc", name: "ADMIN-PC", position: { x: 80, y: 240 }, interfaces: [{ id: "eth0" }] },
      {
        id: "aaa-sw1",
        kind: "l2-switch",
        name: "SW1",
        position: { x: 340, y: 240 },
        interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
      },
      { id: "aaa-r1", kind: "router", name: "R1", position: { x: 620, y: 240 }, interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      { id: "aaa1", kind: "server", name: "AAA1", position: { x: 900, y: 240 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
    ],
    links: [
      { id: "pc-sw", a: { node: "admin-pc", iface: "eth0" }, b: { node: "aaa-sw1", iface: "Gi0/1" } },
      { id: "sw-r1", a: { node: "aaa-sw1", iface: "Gi0/2" }, b: { node: "aaa-r1", iface: "Gi0/0" } },
      { id: "r1-aaa", a: { node: "aaa-r1", iface: "Gi0/1" }, b: { node: "aaa1", iface: "eth0" } },
    ],
  },
  configurations: {
    "admin-pc": {
      kind: "pc",
      hostname: "ADMIN-PC",
      interfaces: [],
      ipv4: { address: "192.168.20.50", prefixLength: 24, defaultGateway: "192.168.20.1" },
      dhcpEnabled: false,
    },
    "aaa-sw1": {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [{ id: 20, name: "MGMT" }],
      interfaces: [
        { id: "Gi0/1", mode: "access", accessVlan: 20 },
        { id: "Gi0/2", mode: "access", accessVlan: 20 },
      ],
      managementSvi: { vlanId: 20, ipAddress: "192.168.20.2", prefixLength: 24, adminUp: true },
      managementDefaultGateway: "192.168.20.1",
      consoleAccess: localUsers(),
      remoteAccess: telnetAndSsh("aaa-sw1"),
    },
    "aaa-r1": {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", routed: true, ipv4: { address: "192.168.20.1", prefixLength: 24 } },
        { id: "Gi0/1", routed: true, ipv4: { address: "192.168.50.1", prefixLength: 24 } },
      ],
      consoleAccess: localUsers(),
      remoteAccess: telnetAndSsh("aaa-r1"),
      aaa: {
        enabled: true,
        authenticationLogin: [{ name: "default", methods: ["group radius", "local"] }],
        authorizationExec: [],
        authorizationCommands: [{ name: "default", privilegeLevel: 15, methods: ["group tacacs+"] }],
        accountingExec: [{ name: "default", mode: "start-stop", methods: ["group radius"] }],
        accountingCommands: [{ name: "default", privilegeLevel: 15, mode: "start-stop", methods: ["group tacacs+"] }],
        servers: [
          {
            name: "AAA1",
            protocol: "radius",
            address: "192.168.50.10",
            authenticationPort: 1812,
            accountingPort: 1813,
            sharedKeyFingerprint: AAA_KEY_FINGERPRINT,
            timeoutSeconds: 3,
            retries: 1,
          },
          {
            name: "AAA1",
            protocol: "tacacs+",
            address: "192.168.50.10",
            sharedKeyFingerprint: AAA_KEY_FINGERPRINT,
            timeoutSeconds: 3,
            retries: 1,
          },
        ],
      },
    },
    aaa1: {
      kind: "server",
      hostname: "AAA1",
      interfaces: [
        { id: "eth0", ipv4: { address: "192.168.50.10", prefixLength: 24 } },
        { id: "eth1" },
      ],
      defaultGateway: "192.168.50.1",
      enabledServices: [
        {
          type: "radius",
          id: "radius",
          enabled: true,
          port: 1812,
          accountingPort: 1813,
          restrictToConfiguredClients: true,
          users: [{
            id: "admin",
            username: MANAGEMENT_DEMO_CREDENTIALS.adminUser,
            credentialFingerprint: ADMIN_VERIFIER.hashBase64,
            privilegeLevel: 15,
            role: "network-admin",
            enabled: true,
          }],
          clients: [{
            id: "r1",
            address: "192.168.50.1",
            name: "R1",
            sharedKeyFingerprint: AAA_KEY_FINGERPRINT,
            enabled: true,
          }],
        },
        {
          type: "tacacs",
          id: "tacacs",
          enabled: true,
          port: 49,
          restrictToConfiguredClients: true,
          execAuthorizationDefault: "permit",
          commandDefault: "deny",
          users: [{
            id: "admin",
            username: MANAGEMENT_DEMO_CREDENTIALS.adminUser,
            credentialFingerprint: ADMIN_VERIFIER.hashBase64,
            privilegeLevel: 15,
            enabled: true,
          }],
          clients: [{
            id: "r1",
            address: "192.168.50.1",
            name: "R1",
            sharedKeyFingerprint: AAA_KEY_FINGERPRINT,
            enabled: true,
          }],
          commandRules: [
            { id: "permit-show", sequence: 10, match: "prefix", command: "show", action: "permit" },
            { id: "permit-exit", sequence: 20, match: "prefix", command: "exit", action: "permit" },
            { id: "deny-config", sequence: 30, match: "prefix", command: "configure", action: "deny" },
          ],
        },
      ],
    },
  },
};

// --- 4. SNMP network management ----------------------------------------------

const SNMP_MANAGEMENT_DEMO_DRAFT: LabDocumentDraft = {
  schemaVersion: 1,
  id: "demo-snmp-management",
  title: "SNMP Network Management",
  description: "Objective: poll several devices from an NMS with SNMP GET and WALK, then observe a link-down trap.",
  instructions: [
    "Addressing: NMS 192.168.50.10/24, R1 Gi0/0 192.168.50.1/24 and Gi0/1 192.168.60.1/24,",
    "SW1 management SVI 192.168.60.2/24 (VLAN 30), L3SW Vlan30 192.168.60.3/24.",
    "",
    "Credentials (educational only): read-only community 'SimulatorNetRead'.",
    "After you save a community the panel shows only 'Community configured' — the value itself",
    "is never displayed again, exactly like a password.",
    "",
    "Try from the NMS terminal:",
    "  snmpget R1 1.3.6.1.2.1.1.5.0        (sysName)",
    "  snmpwalk SW1 1.3.6.1.2.1.2.2.1.2    (the interface table)",
    "Then shut down R1 Gi0/1 and run 'sim show snmp traps' to see the linkDown trap arrive.",
    "",
    "Expected outcome: GET and WALK return real simulator state; a linkDown trap reaches the NMS.",
    "Troubleshooting hint: SNMP values come from the built-in educational MIB. It reports only",
    "what the engine models — there is no CPU or memory object, because a protocol simulator",
    "has no honest value for one.",
  ].join("\n"),
  expectedOutcome: "SNMP GET/WALK return live interface and system state, and a linkDown trap is received.",
  simulation: { seed: 10_704 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "nms", kind: "server", name: "NMS", position: { x: 90, y: 230 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
      { id: "snmp-r1", kind: "router", name: "R1", position: { x: 400, y: 230 }, interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      {
        id: "snmp-sw1",
        kind: "l2-switch",
        name: "SW1",
        position: { x: 700, y: 120 },
        interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
      },
      {
        id: "snmp-l3",
        kind: "l3-switch",
        name: "L3SW",
        position: { x: 700, y: 350 },
        interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
      },
    ],
    links: [
      { id: "nms-r1", a: { node: "nms", iface: "eth0" }, b: { node: "snmp-r1", iface: "Gi0/0" } },
      { id: "r1-sw1", a: { node: "snmp-r1", iface: "Gi0/1" }, b: { node: "snmp-sw1", iface: "Gi0/1" } },
      { id: "sw1-l3", a: { node: "snmp-sw1", iface: "Gi0/2" }, b: { node: "snmp-l3", iface: "Gi0/1" } },
    ],
  },
  configurations: {
    nms: {
      kind: "server",
      hostname: "NMS",
      interfaces: [
        { id: "eth0", ipv4: { address: "192.168.50.10", prefixLength: 24 } },
        { id: "eth1" },
      ],
      defaultGateway: "192.168.50.1",
      enabledServices: [{
        type: "network-management",
        id: "nms",
        enabled: true,
        port: 162,
        restrictTrapsToTargets: false,
        targets: [
          { id: "r1", name: "R1", address: "192.168.50.1", port: 161, version: "2c", communityFingerprint: COMMUNITY["snmp-r1"], enabled: true },
          { id: "sw1", name: "SW1", address: "192.168.60.2", port: 161, version: "2c", communityFingerprint: COMMUNITY["snmp-sw1"], enabled: true },
          { id: "l3sw", name: "L3SW", address: "192.168.60.3", port: 161, version: "2c", communityFingerprint: COMMUNITY["snmp-l3"], enabled: true },
        ],
      }],
    },
    "snmp-r1": {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", routed: true, ipv4: { address: "192.168.50.1", prefixLength: 24 } },
        { id: "Gi0/1", routed: true, ipv4: { address: "192.168.60.1", prefixLength: 24 } },
      ],
      snmp: agent("snmp-r1", "192.168.50.10"),
    },
    "snmp-sw1": {
      kind: "l2-switch",
      hostname: "SW1",
      vlans: [{ id: 30, name: "MGMT" }],
      interfaces: [
        { id: "Gi0/1", mode: "access", accessVlan: 30 },
        { id: "Gi0/2", mode: "access", accessVlan: 30 },
      ],
      managementSvi: { vlanId: 30, ipAddress: "192.168.60.2", prefixLength: 24, adminUp: true },
      managementDefaultGateway: "192.168.60.1",
      snmp: agent("snmp-sw1", "192.168.50.10"),
    },
    "snmp-l3": {
      kind: "l3-switch",
      hostname: "L3SW",
      vlans: [{ id: 30, name: "MGMT" }],
      interfaces: [
        { id: "Gi0/1", mode: "access", accessVlan: 30 },
        { id: "Gi0/2", mode: "access", accessVlan: 30 },
      ],
      svis: [{ vlanId: 30, ipAddress: "192.168.60.3", prefixLength: 24, adminUp: true }],
      ipRoutingEnabled: false,
      staticRoutes: [{ network: "0.0.0.0", prefixLength: 0, nextHop: "192.168.60.1" }],
      snmp: agent("snmp-l3", "192.168.50.10"),
    },
  },
};

/**
 * Canonicalized once at module load: the drafts above omit schema defaults so
 * they stay readable, and canonicalization fills them in exactly as a saved lab
 * would — the same document the worker and the verifier then rebuild.
 */
export const SSH_MANAGEMENT_DEMO: LabDocument = canonicalizeLabDocument(SSH_MANAGEMENT_DEMO_DRAFT);
export const TELNET_VS_SSH_DEMO: LabDocument = canonicalizeLabDocument(TELNET_VS_SSH_DEMO_DRAFT);
export const CENTRALIZED_AAA_DEMO: LabDocument = canonicalizeLabDocument(CENTRALIZED_AAA_DEMO_DRAFT);
export const SNMP_MANAGEMENT_DEMO: LabDocument = canonicalizeLabDocument(SNMP_MANAGEMENT_DEMO_DRAFT);

export const MANAGEMENT_DEMO_LABS = [
  { id: "demo-ssh-management", title: SSH_MANAGEMENT_DEMO.title, document: SSH_MANAGEMENT_DEMO },
  { id: "demo-telnet-vs-ssh", title: TELNET_VS_SSH_DEMO.title, document: TELNET_VS_SSH_DEMO },
  { id: "demo-centralized-aaa", title: CENTRALIZED_AAA_DEMO.title, document: CENTRALIZED_AAA_DEMO },
  { id: "demo-snmp-management", title: SNMP_MANAGEMENT_DEMO.title, document: SNMP_MANAGEMENT_DEMO },
] as const;

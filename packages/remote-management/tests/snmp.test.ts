import { describe, expect, it } from "vitest";
import { createCliSession, type CliSession } from "@sim/cli-engine";
import { createManagementCredentialVerifier, managementCredentialScope } from "@sim/console-auth";
import type { LabDocumentDraft, NetworkManagementServiceConfig, SnmpAgentConfiguration } from "@sim/contracts";
import { SNMP_LIMITS } from "@sim/contracts";
import { buildLabFromDocument, canonicalizeLabDocument, type BuiltLab } from "@sim/lab-format";
import { L2Switch, Router, Server, SNMP_OID } from "@sim/sim-core";

const COMMUNITY = "lab-read-only";
const WRONG_COMMUNITY = "not-the-community";

async function communityFingerprint(deviceId: string, value: string): Promise<string> {
  return (await createManagementCredentialVerifier(managementCredentialScope.community(deviceId), value)).hashBase64;
}

/** NMS --- R1 --- SW1, with SNMP agents on both network devices. */
async function snmpLab(options: { trapsEnabled?: boolean } = {}): Promise<BuiltLab> {
  const routerCommunity = await communityFingerprint("r1", COMMUNITY);
  const switchCommunity = await communityFingerprint("sw1", COMMUNITY);
  const agent = (fingerprint: string): SnmpAgentConfiguration => ({
    enabled: true,
    communities: [{ id: "public", fingerprint, access: "read-only", enabled: true }],
    location: "Lab rack 1",
    contact: "netops@lab.local",
    trapsEnabled: options.trapsEnabled ?? false,
    trapDestinations: options.trapsEnabled
      ? [{ id: "nms", address: "192.168.50.10", port: 162, version: "2c", enabled: true }]
      : [],
    enabledTrapTypes: [],
  });
  const nms: NetworkManagementServiceConfig = {
    type: "network-management",
    id: "nms",
    enabled: true,
    port: 162,
    targets: [
      { id: "r1", name: "R1", address: "192.168.50.1", port: 161, version: "2c", communityFingerprint: routerCommunity, enabled: true },
      { id: "sw1", name: "SW1", address: "192.168.60.2", port: 161, version: "2c", communityFingerprint: switchCommunity, enabled: true },
      { id: "bad", name: "BAD", address: "192.168.50.1", port: 161, version: "2c", communityFingerprint: await communityFingerprint("r1", WRONG_COMMUNITY), enabled: true },
    ],
    restrictTrapsToTargets: false,
  };

  const draft: LabDocumentDraft = {
    schemaVersion: 1,
    id: "snmp-lab",
    title: "SNMP lab",
    simulation: { seed: 23 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "nms1", kind: "server", name: "NMS", interfaces: [{ id: "eth0" }, { id: "eth1" }] },
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
      ],
      links: [
        { id: "l1", a: { node: "nms1", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
        { id: "l2", a: { node: "r1", iface: "Gi0/1" }, b: { node: "sw1", iface: "Gi0/1" } },
      ],
    },
    configurations: {
      nms1: {
        kind: "server",
        hostname: "NMS",
        interfaces: [{ id: "eth0", ipv4: { address: "192.168.50.10", prefixLength: 24 } }, { id: "eth1" }],
        defaultGateway: "192.168.50.1",
        enabledServices: [nms],
      },
      r1: {
        kind: "router",
        hostname: "R1",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "192.168.50.1", prefixLength: 24 } },
          { id: "Gi0/1", routed: true, ipv4: { address: "192.168.60.1", prefixLength: 24 } },
        ],
        snmp: agent(routerCommunity),
      },
      sw1: {
        kind: "l2-switch",
        hostname: "SW1",
        vlans: [{ id: 10, name: "MGMT" }],
        interfaces: [
          { id: "Gi0/1", mode: "access", accessVlan: 10 },
          { id: "Gi0/2", mode: "access", accessVlan: 10 },
        ],
        managementSvi: { vlanId: 10, ipAddress: "192.168.60.2", prefixLength: 24, adminUp: true },
        managementDefaultGateway: "192.168.60.1",
        snmp: agent(switchCommunity),
      },
    },
  };
  const lab = buildLabFromDocument(canonicalizeLabDocument(draft));
  lab.engine.runUntilIdle();
  return lab;
}

function nmsTerminal(lab: BuiltLab): CliSession {
  return createCliSession(lab.getDevice("nms1")!, lab.engine);
}

describe("SNMPv2c agent and NMS", () => {
  it("answers a GET with real simulator state", async () => {
    const lab = await snmpLab();
    const cli = nmsTerminal(lab);
    const sysName = cli.execute(`snmpget R1 ${SNMP_OID.sysName}`);
    expect(sysName).toContain("R1");
    expect(cli.execute(`snmpget R1 ${SNMP_OID.sysLocation}`)).toContain("Lab rack 1");
    expect(cli.execute(`snmpget R1 ${SNMP_OID.ifNumber}`)).toContain("Integer: 2");
  });

  it("reports sysUpTime from virtual time, never a wall clock", async () => {
    const lab = await snmpLab();
    const cli = nmsTerminal(lab);
    const first = cli.execute(`snmpget R1 ${SNMP_OID.sysUpTime}`);
    lab.engine.advanceTo(lab.engine.now() + 5_000_000_000);
    const second = cli.execute(`snmpget R1 ${SNMP_OID.sysUpTime}`);
    const ticks = (text: string) => Number(/TimeTicks: (\d+)/u.exec(text)?.[1] ?? -1);
    expect(ticks(second)).toBeGreaterThan(ticks(first));
  });

  it("walks the interface table of an L2 switch through its management SVI", async () => {
    const lab = await snmpLab();
    const cli = nmsTerminal(lab);
    const walk = cli.execute(`snmpwalk SW1 ${SNMP_OID.ifDescr}`);
    expect(walk).toContain("Gi0/1");
    expect(walk).toContain("Gi0/2");
    expect(walk).toContain("Vlan10");
    // A WALK stops at its own subtree and never runs away.
    expect(walk.split("\n").length).toBeLessThanOrEqual(SNMP_LIMITS.maximumWalkLength);
  });

  it("rejects an invalid community and never reveals the configured one", async () => {
    const lab = await snmpLab();
    lab.engine.enableTrace();
    const cli = nmsTerminal(lab);
    expect(cli.execute(`snmpget BAD ${SNMP_OID.sysName}`)).toContain("invalid community");
    const trace = JSON.stringify(lab.engine.traceLog);
    expect(trace).toContain("snmp-authentication-failure");
    expect(trace).not.toContain(COMMUNITY);
    expect(trace).not.toContain(WRONG_COMMUNITY);
  });

  it("delivers a linkDown trap to the NMS when a monitored link fails", async () => {
    const lab = await snmpLab({ trapsEnabled: true });
    const router = lab.getDevice("r1") as Router;
    router.snmp.resetOperationBudget();
    router.getInterface("Gi0/1")!.shutdown();
    lab.engine.runUntilIdle();

    const server = lab.getDevice("nms1") as Server;
    const traps = server.services.networkManagement.runtimeSnapshot().traps;
    expect(traps.some((trap) => trap.trapType === "linkDown" && trap.sourceName === "R1")).toBe(true);
    expect(JSON.stringify(traps)).not.toContain(COMMUNITY);
  });

  it("keeps traps and poll results out of the serialized configuration", async () => {
    const lab = await snmpLab({ trapsEnabled: true });
    const cli = nmsTerminal(lab);
    cli.execute(`snmpget R1 ${SNMP_OID.sysName}`);
    const router = lab.getDevice("r1") as Router;
    const snapshot = JSON.stringify(router.snmp.snapshot());
    expect(snapshot).not.toContain("varBinds");
    expect(snapshot).not.toContain(COMMUNITY);
    // Only the fingerprint is persisted, never the community string itself.
    expect(router.snmp.snapshot().communities[0]?.fingerprint).toBeDefined();
  });

  it("does not answer SNMP on a device whose agent is disabled", async () => {
    const lab = await snmpLab();
    const sw = lab.getDevice("sw1") as L2Switch;
    sw.snmp.configure({
      enabled: false,
      communities: [],
      trapsEnabled: false,
      trapDestinations: [],
      enabledTrapTypes: [],
    });
    lab.engine.runUntilIdle();
    const cli = nmsTerminal(lab);
    expect(cli.execute(`snmpget SW1 ${SNMP_OID.sysName}`)).toContain("timeout");
  });
});

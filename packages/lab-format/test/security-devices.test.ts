import {
  Firewall,
  IspCloud,
  TrafficGenerator,
} from "@sim/sim-core";
import type { LabDocument } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const document: LabDocument = {
  schemaVersion: 1,
  id: "security-devices",
  title: "Security devices",
  simulation: { seed: 601 },
  topology: {
    schemaVersion: 1,
    nodes: [
      {
        id: "fw",
        kind: "firewall",
        name: "FW1",
        interfaces: [{ id: "Eth0/0" }, { id: "Eth0/1" }, { id: "Eth0/2" }, { id: "Eth0/3" }],
      },
      {
        id: "isp",
        kind: "cloud",
        name: "ISP1",
        interfaces: [{ id: "Eth0/0" }, { id: "Eth0/1" }, { id: "Eth0/2" }, { id: "Eth0/3" }],
      },
      {
        id: "tg",
        kind: "traffic-generator",
        name: "TG1",
        interfaces: [{ id: "eth0" }],
      },
    ],
    links: [],
  },
  configurations: {
    fw: {
      kind: "firewall",
      hostname: "FW1",
      interfaces: [
        { id: "Eth0/0", routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Eth0/1", routed: true, ipv4: { address: "203.0.113.1", prefixLength: 24 } },
        { id: "Eth0/2" },
        { id: "Eth0/3" },
      ],
      acls: [{
        id: "INSIDE",
        type: "standard",
        rules: [{ sequence: 10, action: "permit", source: { kind: "network", address: "10.0.0.0", wildcard: "0.0.0.255" } }],
      }],
      aclBindings: [{ interfaceName: "Eth0/0", direction: "in", aclId: "INSIDE" }],
      natPools: [],
      natRules: [{ id: "WEB-STATIC", sequence: 10, kind: "static", insideLocal: "10.0.0.10", insideGlobal: "203.0.113.10" }],
      natInterfaceRoles: [
        { interfaceName: "Eth0/0", role: "inside" },
        { interfaceName: "Eth0/1", role: "outside" },
      ],
      zones: [
        { interfaceName: "Eth0/0", zone: "inside" },
        { interfaceName: "Eth0/1", zone: "outside" },
      ],
      firewallPolicies: [{
        id: "inside-out",
        sequence: 10,
        sourceZone: "inside",
        destinationZone: "outside",
        action: "permit",
        protocol: "ip",
      }],
      defaultPolicy: "deny",
    },
    isp: {
      kind: "cloud",
      hostname: "ISP1",
      interfaces: [
        { id: "Eth0/0", routed: true, ipv4: { address: "203.0.113.2", prefixLength: 24 } },
        { id: "Eth0/1", routed: true, ipv4: { address: "198.51.100.1", prefixLength: 24 } },
        { id: "Eth0/2" },
        { id: "Eth0/3" },
      ],
      impairments: [{
        interfaceName: "Eth0/1",
        additionalLatencyNs: 1_000,
        packetLossRate: 0.1,
        note: "Deterministic provider impairment",
      }],
    },
    tg: {
      kind: "traffic-generator",
      hostname: "TG1",
      ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" },
      flows: [{
        id: "ping",
        protocol: "icmp",
        destination: "10.0.0.1",
        count: 1,
        intervalNs: 0,
      }],
    },
  },
};

describe("M10.3 security/infrastructure devices", () => {
  it("parses, canonicalizes, builds, and serializes all three new types", () => {
    const canonical = canonicalizeLabDocument(parseLabDocument(document));
    const built = buildLabFromDocument(canonical);
    expect(built.getFirewall("fw")).toBeInstanceOf(Firewall);
    expect(built.getCloud("isp")).toBeInstanceOf(IspCloud);
    expect(built.getTrafficGenerator("tg")).toBeInstanceOf(TrafficGenerator);
    expect(built.getTrafficGenerator("tg")?.ip).toBe("10.0.0.10");
    const serialized = serializeLabDocument(built, {
      id: canonical.id,
      title: canonical.title,
    });
    expect(canonicalizeLabDocument(serialized)).toEqual(canonical);
  });

  it("persists structured security/tool configuration but excludes transient runtime", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(document));
    built.getTrafficGenerator("tg")?.startFlow("ping");
    built.engine.runUntilIdle();
    expect(built.getTrafficGenerator("tg")?.flowResults()).not.toHaveLength(0);

    const serialized = serializeLabDocument(built, { id: "security-devices", title: "Security devices" });
    expect(serialized.configurations.fw).toMatchObject({
      kind: "firewall",
      acls: [{ id: "INSIDE" }],
      natRules: [{ id: "WEB-STATIC" }],
      firewallPolicies: [{ id: "inside-out" }],
    });
    expect(serialized.configurations.isp).toMatchObject({
      kind: "cloud",
      impairments: [{ interfaceName: "Eth0/1", packetLossRate: 0.1 }],
    });
    expect(serialized.configurations.tg).toMatchObject({
      kind: "traffic-generator",
      flows: [{ id: "ping" }],
    });
    const json = JSON.stringify(serialized);
    expect(json).not.toMatch(/aclCounters|natTranslations|connectionTable|trafficResults|packet-loss-decision/i);
  });
});

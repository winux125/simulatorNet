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
    },
    tg: {
      kind: "traffic-generator",
      hostname: "TG1",
      ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" },
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

  it("never serializes runtime sessions, impairments, flow results, or packet-loss decisions", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(document));
    built.getFirewall("fw")?.definePolicy({
      id: "inside-out",
      sequence: 10,
      sourceZone: "inside",
      destinationZone: "outside",
      action: "permit",
      protocol: "ip",
    });
    built.getCloud("isp")?.configureImpairment({
      interfaceName: "Eth0/1",
      additionalLatencyNs: 1_000,
      packetLossRate: 0.1,
    });
    built.getTrafficGenerator("tg")?.configureFlow({
      id: "ping",
      protocol: "icmp",
      destination: "10.0.0.1",
      count: 1,
      intervalNs: 0,
    });
    const json = JSON.stringify(serializeLabDocument(built, { id: "security-devices", title: "Security devices" }));
    expect(json).not.toMatch(/inside-out|packetLossRate|traffic-flow|flowId|connectionTable|packet-loss/i);
  });
});

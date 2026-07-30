import type { LabDocument } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  serializeLabDocument,
} from "@sim/lab-format";
import { DEFAULT_LINK_CAPACITY_BPS, DEFAULT_LINK_QUEUE_LIMIT_PACKETS, Router } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

const QOS_LAB: LabDocument = {
  schemaVersion: 1,
  id: "qos-round-trip",
  title: "QoS round trip",
  simulation: { seed: 5 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc", kind: "pc", name: "PC", interfaces: [{ id: "eth0" }] },
      { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      { id: "srv", kind: "server", name: "SRV", interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "a", a: { node: "pc", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
      {
        id: "b",
        a: { node: "r1", iface: "Gi0/1" },
        b: { node: "srv", iface: "eth0" },
        capacityBps: 2_000_000,
        propagationDelayNs: 250_000,
        queueLimitPackets: 32,
      },
    ],
  },
  configurations: {
    pc: { kind: "pc", ipv4: { address: "10.0.0.10", prefixLength: 24, defaultGateway: "10.0.0.1" } },
    r1: {
      kind: "router",
      interfaces: [
        { id: "Gi0/0", routed: true, ipv4: { address: "10.0.0.1", prefixLength: 24 } },
        { id: "Gi0/1", routed: true, ipv4: { address: "10.0.1.1", prefixLength: 24 } },
      ],
      qos: {
        classMaps: [{
          id: "REALTIME",
          matchType: "match-any",
          matches: [{ kind: "dscp", values: [46] }, { kind: "protocol", protocol: "udp" }],
        }],
        policyMaps: [{
          id: "WAN-EDGE",
          classes: [
            { className: "REALTIME", priority: { percent: 20 }, marking: { dscp: 46 } },
            {
              className: "class-default",
              bandwidthPercent: 50,
              police: { rateBps: 1_000_000, burstBytes: 32_000, exceedAction: "drop" },
              shape: { averageRateBps: 2_000_000 },
            },
          ],
        }],
        servicePolicies: [{ interfaceName: "Gi0/1", direction: "output", policyMapId: "WAN-EDGE" }],
      },
    },
    srv: {
      kind: "server",
      interfaces: [{ id: "eth0", ipv4: { address: "10.0.1.10", prefixLength: 24 } }],
      defaultGateway: "10.0.1.1",
    },
  },
} as unknown as LabDocument;

function roundTrip(document: LabDocument): LabDocument {
  const canonical = canonicalizeLabDocument(document);
  const built = buildLabFromDocument(canonical);
  return serializeLabDocument(built, { id: canonical.id, title: canonical.title });
}

describe("QoS persistence", () => {
  it("round-trips class maps, policy maps and service policies", () => {
    const canonical = canonicalizeLabDocument(QOS_LAB);
    const serialized = roundTrip(QOS_LAB);
    expect(serialized.configurations.r1).toEqual(canonical.configurations.r1);
    expect(roundTrip(serialized)).toEqual(serialized);
  });

  it("round-trips link capacity, propagation delay and queue limit", () => {
    const serialized = roundTrip(QOS_LAB);
    const link = serialized.topology.links.find((entry) => entry.id === "b")!;
    expect(link.capacityBps).toBe(2_000_000);
    expect(link.propagationDelayNs).toBe(250_000);
    expect(link.queueLimitPackets).toBe(32);
  });

  it("opens a schema-v1 lab without a qos block using documented defaults", () => {
    const legacy: LabDocument = {
      ...QOS_LAB,
      topology: {
        ...QOS_LAB.topology,
        links: QOS_LAB.topology.links.map((link) => ({ id: link.id, a: link.a, b: link.b })),
      },
      configurations: {
        ...QOS_LAB.configurations,
        r1: { ...QOS_LAB.configurations.r1, qos: undefined } as LabDocument["configurations"][string],
      },
    };
    const built = buildLabFromDocument(canonicalizeLabDocument(legacy));
    const link = built.engine.findLink("r1", "Gi0/1")!;
    expect(link.capacityBps).toBe(DEFAULT_LINK_CAPACITY_BPS);
    expect(link.queueLimitPackets).toBe(DEFAULT_LINK_QUEUE_LIMIT_PACKETS);
    const serialized = serializeLabDocument(built, { id: legacy.id, title: legacy.title });
    expect((serialized.configurations.r1 as { qos?: unknown }).qos).toBeUndefined();
  });

  it("never serializes queued packets, tokens, counters or measured delays", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(QOS_LAB));
    const pc = built.getPc("pc")!;
    for (let index = 0; index < 12; index++) {
      pc.sendUdp({
        destinationAddress: "10.0.1.10",
        destinationPort: 5060,
        payload: { kind: "udp-application", protocol: "voice", data: "x", payloadBytes: 1_200 },
      });
    }
    built.engine.runUntilIdle();
    const router = built.getRouter("r1") as Router;
    expect(router.qosCounters().length).toBeGreaterThan(0);
    const serialized = JSON.stringify(serializeLabDocument(built, { id: "qos-round-trip", title: "QoS round trip" }));
    for (const forbidden of ["matchedPackets", "droppedPackets", "depthPackets", "tokens", "maximumWaitingTimeNs"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

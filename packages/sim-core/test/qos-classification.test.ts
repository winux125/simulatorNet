import { IpProtocol } from "@sim/contracts";
import {
  DSCP_NAMES,
  Ipv6NextHeader,
  QOS_CLASS_DEFAULT,
  QOS_RESOURCE_LIMITS,
  QosPolicyEngine,
  QosPolicyError,
  Pc,
  Router,
  Server,
  createSimulationEngine,
  dscpName,
  dscpOf,
  macFromIndex,
  parseDscp,
  precedenceOfDscp,
  type Ipv4Packet,
  type Ipv6Packet,
  type QosClassMap,
  type QosPacketSubject,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function ipv4(options: {
  src?: string;
  dst?: string;
  protocol?: 1 | 6 | 17;
  srcPort?: number;
  dstPort?: number;
  dscp?: number;
} = {}): Ipv4Packet {
  const protocol = options.protocol ?? IpProtocol.UDP;
  const transport = protocol === IpProtocol.ICMP
    ? { kind: "icmp" as const, type: 8 as const, code: 0, identifier: 1, sequence: 1 }
    : protocol === IpProtocol.TCP
      ? { kind: "tcp" as const, srcPort: options.srcPort ?? 1234, dstPort: options.dstPort ?? 80, sequence: 1, acknowledgment: 0 }
      : {
          kind: "udp" as const,
          srcPort: options.srcPort ?? 1234,
          dstPort: options.dstPort ?? 5060,
          payload: { kind: "udp-application" as const, protocol: "test", data: "x", payloadBytes: 200 },
        };
  return {
    kind: "ipv4",
    src: options.src ?? "10.0.0.10",
    dst: options.dst ?? "10.0.1.10",
    protocol,
    dscp: options.dscp,
    ttl: 64,
    payload: transport,
  };
}

function ipv6(options: { src?: string; dst?: string; trafficClass?: number; dstPort?: number } = {}): Ipv6Packet {
  return {
    kind: "ipv6",
    src: options.src ?? "2001:db8:1::10",
    dst: options.dst ?? "2001:db8:2::10",
    nextHeader: Ipv6NextHeader.UDP,
    trafficClass: options.trafficClass,
    hopLimit: 64,
    payload: {
      kind: "udp",
      srcPort: 1234,
      dstPort: options.dstPort ?? 5060,
      payload: { kind: "udp-application", protocol: "test", data: "x", payloadBytes: 200 },
    },
  };
}

function subject(packet: Ipv4Packet | Ipv6Packet, cos?: number): QosPacketSubject {
  return { packet, wireSizeBytes: 250, cos };
}

function engineWith(classMaps: QosClassMap[]): QosPolicyEngine {
  const qos = new QosPolicyEngine();
  for (const map of classMaps) qos.defineClassMap(map);
  qos.definePolicyMap({
    id: "EDGE",
    classes: [
      ...classMaps.map((map) => ({ className: map.id })),
      { className: QOS_CLASS_DEFAULT },
    ],
  });
  qos.attach({ interfaceName: "Gi0/0", direction: "output", policyMapId: "EDGE" });
  return qos;
}

describe("DSCP and CoS markings", () => {
  it.each([
    ["ef", 46],
    ["EF", 46],
    ["af31", 26],
    ["cs5", 40],
    ["cs0", 0],
    ["default", 0],
    ["0", 0],
    ["63", 63],
  ])("parses %s as %i", (token, expected) => {
    expect(parseDscp(token)).toBe(expected);
  });

  it.each([["64"], ["-1"], ["af99"], ["voice"], [""]])("rejects %s", (token) => {
    expect(() => parseDscp(token)).toThrow();
  });

  it.each([[46, "ef"], [26, "af31"], [0, "default"], [40, "cs5"], [45, "45"]])(
    "names DSCP %i as %s",
    (value, expected) => {
      expect(dscpName(value)).toBe(expected);
    },
  );

  it.each([[46, 5], [26, 3], [0, 0], [56, 7]])("derives IP precedence %i from DSCP", (dscp, precedence) => {
    expect(precedenceOfDscp(dscp)).toBe(precedence);
  });

  it("exposes every symbolic name the CLI documents", () => {
    expect(Object.keys(DSCP_NAMES)).toContain("af43");
    expect(Object.keys(DSCP_NAMES)).toHaveLength(22);
  });
});

describe("class-map matching", () => {
  const table: Array<[string, QosClassMap, Ipv4Packet | Ipv6Packet, boolean]> = [
    [
      "match dscp ef on IPv4",
      { id: "VOICE", matchType: "match-any", matches: [{ kind: "dscp", values: [46] }] },
      ipv4({ dscp: 46 }),
      true,
    ],
    [
      "match dscp ef on IPv6 traffic class",
      { id: "VOICE", matchType: "match-any", matches: [{ kind: "dscp", values: [46] }] },
      ipv6({ trafficClass: 46 }),
      true,
    ],
    [
      "unmarked packet is not EF",
      { id: "VOICE", matchType: "match-any", matches: [{ kind: "dscp", values: [46] }] },
      ipv4(),
      false,
    ],
    [
      "match precedence",
      { id: "P5", matchType: "match-any", matches: [{ kind: "precedence", values: [5] }] },
      ipv4({ dscp: 40 }),
      true,
    ],
    [
      "match protocol udp",
      { id: "UDP", matchType: "match-any", matches: [{ kind: "protocol", protocol: "udp" }] },
      ipv4({ protocol: IpProtocol.UDP }),
      true,
    ],
    [
      "match protocol udp rejects tcp",
      { id: "UDP", matchType: "match-any", matches: [{ kind: "protocol", protocol: "udp" }] },
      ipv4({ protocol: IpProtocol.TCP }),
      false,
    ],
    [
      "match destination port",
      { id: "WEB", matchType: "match-any", matches: [{ kind: "destination-port", port: { kind: "eq", port: 80 } }] },
      ipv4({ protocol: IpProtocol.TCP, dstPort: 80 }),
      true,
    ],
    [
      "match source port range",
      { id: "RTP", matchType: "match-any", matches: [{ kind: "source-port", port: { kind: "range", start: 1000, end: 2000 } }] },
      ipv4({ srcPort: 1500 }),
      true,
    ],
    [
      "match source prefix on IPv4",
      {
        id: "GUEST",
        matchType: "match-any",
        matches: [{ kind: "source-prefix", ipv4: { kind: "network", address: "10.0.0.0", wildcard: "0.0.0.255" } }],
      },
      ipv4({ src: "10.0.0.42" }),
      true,
    ],
    [
      "match source prefix on IPv6",
      {
        id: "GUEST6",
        matchType: "match-any",
        matches: [{ kind: "source-prefix", ipv6: { kind: "prefix", address: "2001:db8:1::", prefixLength: 64 } }],
      },
      ipv6({ src: "2001:db8:1::99" }),
      true,
    ],
    [
      "match-all needs every rule",
      {
        id: "STRICT",
        matchType: "match-all",
        matches: [{ kind: "protocol", protocol: "udp" }, { kind: "dscp", values: [46] }],
      },
      ipv4({ protocol: IpProtocol.UDP }),
      false,
    ],
    [
      "match-all succeeds when every rule holds",
      {
        id: "STRICT",
        matchType: "match-all",
        matches: [{ kind: "protocol", protocol: "udp" }, { kind: "dscp", values: [46] }],
      },
      ipv4({ protocol: IpProtocol.UDP, dscp: 46 }),
      true,
    ],
    [
      "match-any needs only one rule",
      {
        id: "LOOSE",
        matchType: "match-any",
        matches: [{ kind: "protocol", protocol: "tcp" }, { kind: "dscp", values: [46] }],
      },
      ipv4({ protocol: IpProtocol.UDP, dscp: 46 }),
      true,
    ],
  ];

  it.each(table)("%s", (_label, classMap, packet, expected) => {
    const qos = engineWith([classMap]);
    const result = qos.classify("Gi0/0", "output", subject(packet), { nowNs: 0 });
    expect(result?.className === classMap.id).toBe(expected);
    if (!expected) expect(result?.matched).toBe(false);
  });

  it("matches an IPv4 ACL through the shared selector callback", () => {
    const qos = engineWith([{ id: "WEB", matchType: "match-any", matches: [{ kind: "access-group", aclId: "101" }] }]);
    const permit = qos.classify("Gi0/0", "output", subject(ipv4()), {
      nowNs: 0,
      aclPermits: (aclId) => aclId === "101",
    });
    const deny = qos.classify("Gi0/0", "output", subject(ipv4()), {
      nowNs: 0,
      aclPermits: () => false,
    });
    expect(permit?.className).toBe("WEB");
    expect(deny?.className).toBe(QOS_CLASS_DEFAULT);
  });

  it("matches an IPv6 ACL only for IPv6 packets", () => {
    const qos = engineWith([{ id: "V6", matchType: "match-any", matches: [{ kind: "ipv6-access-group", aclId: "V6-IN" }] }]);
    const context = { nowNs: 0, ipv6AclPermits: () => true };
    expect(qos.classify("Gi0/0", "output", subject(ipv6()), context)?.className).toBe("V6");
    expect(qos.classify("Gi0/0", "output", subject(ipv4()), context)?.className).toBe(QOS_CLASS_DEFAULT);
  });

  it("matches an 802.1p CoS only when the frame carries a tag", () => {
    const qos = engineWith([{ id: "TAGGED", matchType: "match-any", matches: [{ kind: "cos", values: [5] }] }]);
    expect(qos.classify("Gi0/0", "output", subject(ipv4(), 5), { nowNs: 0 })?.className).toBe("TAGGED");
    expect(qos.classify("Gi0/0", "output", subject(ipv4()), { nowNs: 0 })?.className).toBe(QOS_CLASS_DEFAULT);
  });

  it("matches a Traffic Generator flow id as internal test metadata", () => {
    const qos = engineWith([{ id: "TEST", matchType: "match-any", matches: [{ kind: "traffic-flow", flowId: "VOICE" }] }]);
    expect(qos.classify("Gi0/0", "output", subject(ipv4()), { nowNs: 0, flowId: "VOICE" })?.className).toBe("TEST");
    expect(qos.classify("Gi0/0", "output", subject(ipv4()), { nowNs: 0, flowId: "BULK" })?.className).toBe(QOS_CLASS_DEFAULT);
  });

  it("returns undefined when no service policy is attached", () => {
    const qos = new QosPolicyEngine();
    expect(qos.classify("Gi0/0", "output", subject(ipv4()), { nowNs: 0 })).toBeUndefined();
  });

  it("evaluates policy classes in their configured order", () => {
    const qos = new QosPolicyEngine();
    qos.defineClassMap({ id: "ANY-UDP", matchType: "match-any", matches: [{ kind: "protocol", protocol: "udp" }] });
    qos.defineClassMap({ id: "VOICE", matchType: "match-any", matches: [{ kind: "dscp", values: [46] }] });
    qos.definePolicyMap({
      id: "ORDERED",
      classes: [{ className: "VOICE" }, { className: "ANY-UDP" }, { className: QOS_CLASS_DEFAULT }],
    });
    qos.attach({ interfaceName: "Gi0/0", direction: "output", policyMapId: "ORDERED" });
    expect(qos.classify("Gi0/0", "output", subject(ipv4({ dscp: 46 })), { nowNs: 0 })?.className).toBe("VOICE");
  });
});

describe("marking actions", () => {
  const qos = new QosPolicyEngine();

  it.each([
    ["set dscp ef", { dscp: 46 }, 0, 46],
    ["set dscp default", { dscp: 0 }, 46, 0],
    ["set precedence 5 keeps the low bits", { precedence: 5 }, 2, 42],
    ["no marking leaves the packet alone", undefined, 26, 26],
  ])("%s", (_label, marking, before, after) => {
    const outcome = qos.applyMarking(subject(ipv4({ dscp: before })), marking);
    expect(dscpOf(outcome.packet)).toBe(after);
    expect(outcome.dscpBefore).toBe(before);
    expect(outcome.dscpAfter).toBe(after);
  });

  it("marks the IPv6 traffic class, not an IPv4 field", () => {
    const outcome = qos.applyMarking(subject(ipv6({ trafficClass: 0 })), { dscp: 34 });
    expect((outcome.packet as Ipv6Packet).trafficClass).toBe(34);
  });

  it("returns a new packet instead of mutating the original", () => {
    const original = ipv4({ dscp: 0 });
    const outcome = qos.applyMarking(subject(original), { dscp: 46 });
    expect(original.dscp).toBe(0);
    expect(outcome.packet).not.toBe(original);
  });

  it("carries a CoS change without touching DSCP", () => {
    const outcome = qos.applyMarking(subject(ipv4({ dscp: 46 }), 0), { cos: 5 });
    expect(outcome.cosAfter).toBe(5);
    expect(outcome.dscpAfter).toBe(46);
    expect(outcome.changed).toBe(true);
  });

  it.each([
    ["DSCP above 63", { dscp: 64 }],
    ["negative DSCP", { dscp: -1 }],
    ["precedence above 7", { precedence: 8 }],
    ["CoS above 7", { cos: 8 }],
  ])("rejects %s", (_label, marking) => {
    expect(() => qos.applyMarking(subject(ipv4()), marking)).toThrow();
  });
});

describe("QoS configuration limits and problems", () => {
  it("rejects a class map named class-default", () => {
    const qos = new QosPolicyEngine();
    expect(() => qos.defineClassMap({ id: QOS_CLASS_DEFAULT, matchType: "match-any", matches: [] }))
      .toThrow(QosPolicyError);
  });

  it("enforces the match-rule limit", () => {
    const qos = new QosPolicyEngine();
    const matches = Array.from(
      { length: QOS_RESOURCE_LIMITS.maximumMatchRulesPerClass + 1 },
      () => ({ kind: "any" as const }),
    );
    expect(() => qos.defineClassMap({ id: "TOO-MANY", matchType: "match-any", matches })).toThrow(QosPolicyError);
  });

  it("rejects a class that is both priority and bandwidth", () => {
    const qos = new QosPolicyEngine();
    qos.defineClassMap({ id: "A", matchType: "match-any", matches: [{ kind: "any" }] });
    expect(() => qos.definePolicyMap({
      id: "BAD",
      classes: [{ className: "A", priority: { percent: 10 }, bandwidthPercent: 20 }],
    })).toThrow(QosPolicyError);
  });

  it("reports a policy that references a missing class map", () => {
    const qos = new QosPolicyEngine();
    qos.definePolicyMap({ id: "P", classes: [{ className: "MISSING", bandwidthPercent: 10 }] });
    qos.attach({ interfaceName: "Gi0/0", direction: "output", policyMapId: "P" });
    expect(qos.problems().map((problem) => problem.code)).toContain("policy-missing-class-map");
  });

  it("reports a policy that allocates more than the interface has", () => {
    const qos = new QosPolicyEngine();
    qos.defineClassMap({ id: "A", matchType: "match-any", matches: [{ kind: "any" }] });
    qos.defineClassMap({ id: "B", matchType: "match-any", matches: [{ kind: "any" }] });
    qos.definePolicyMap({
      id: "P",
      classes: [{ className: "A", bandwidthPercent: 70 }, { className: "B", bandwidthPercent: 60 }],
    });
    expect(qos.problems().map((problem) => problem.code)).toContain("policy-bandwidth-exceeded");
  });

  it("reports a scheduling policy attached inbound", () => {
    const qos = new QosPolicyEngine();
    qos.defineClassMap({ id: "A", matchType: "match-any", matches: [{ kind: "any" }] });
    qos.definePolicyMap({ id: "P", classes: [{ className: "A", bandwidthPercent: 40 }] });
    qos.attach({ interfaceName: "Gi0/0", direction: "input", policyMapId: "P" });
    expect(qos.problems().map((problem) => problem.code)).toContain("service-policy-type-mismatch");
  });

  it("keeps class-map and policy-map output in canonical order", () => {
    const qos = new QosPolicyEngine();
    for (const id of ["ZULU", "ALPHA", "MIKE"]) {
      qos.defineClassMap({ id, matchType: "match-any", matches: [{ kind: "any" }] });
    }
    expect(qos.classMapConfigurations().map((map) => map.id)).toEqual(["ALPHA", "MIKE", "ZULU"]);
  });
});

describe("router QoS pipeline", () => {
  function lab() {
    const engine = createSimulationEngine({ seed: 4_242 });
    const pc = engine.add(new Pc("pc", "PC"));
    const router = engine.add(new Router("r1", "R1"));
    const server = engine.add(new Server("srv", "SRV"));
    pc.addInterface("eth0", macFromIndex(1));
    router.addInterface("Gi0/0", macFromIndex(2));
    router.addInterface("Gi0/1", macFromIndex(3));
    server.addInterface("eth0", macFromIndex(4));
    pc.configure({ ip: "10.0.0.10", mask: 24, gateway: "10.0.0.1" });
    router.getOrCreateInterface("Gi0/0");
    router.getOrCreateInterface("Gi0/1");
    router.setInterfaceIp("Gi0/0", "10.0.0.1", 24);
    router.setInterfaceIp("Gi0/1", "10.0.1.1", 24);
    server.configure({ ip: "10.0.1.10", mask: 24, gateway: "10.0.1.1" });
    engine.connect("pc", "eth0", "r1", "Gi0/0");
    engine.connect("r1", "Gi0/1", "srv", "eth0");
    engine.enableTrace();
    return { engine, pc, router, server };
  }

  it("marks forwarded traffic on egress and records class counters", () => {
    const { engine, pc, router } = lab();
    router.defineQosClassMap({ id: "ICMP", matchType: "match-any", matches: [{ kind: "protocol", protocol: "icmp" }] });
    router.defineQosPolicyMap({
      id: "WAN-EDGE",
      classes: [{ className: "ICMP", marking: { dscp: 46 } }, { className: QOS_CLASS_DEFAULT }],
    });
    router.applyServicePolicy("Gi0/1", "output", "WAN-EDGE");
    pc.ping("10.0.1.10", 1);
    engine.runUntilIdle();

    const marked = engine.traceLog.filter((entry) => entry.type === "qos-marked");
    expect(marked.length).toBeGreaterThan(0);
    expect(marked[0]!.detail).toMatchObject({ dscpBefore: 0, dscpAfter: 46, class: "ICMP", direction: "output" });
    const counters = router.qosCounters();
    expect(counters.find((row) => row.className === "ICMP")?.matchedPackets).toBeGreaterThan(0);
    expect(counters.find((row) => row.className === "ICMP")?.markedPackets).toBeGreaterThan(0);
  });

  it("classifies inbound before the ACL and routing pipeline", () => {
    const { engine, pc, router } = lab();
    router.defineQosClassMap({ id: "ANY", matchType: "match-any", matches: [{ kind: "any" }] });
    router.defineQosPolicyMap({ id: "IN", classes: [{ className: "ANY", marking: { dscp: 26 } }] });
    router.applyServicePolicy("Gi0/0", "input", "IN");
    router.defineAcl({
      id: "AF31-ONLY",
      type: "extended",
      rules: [{ sequence: 10, action: "permit", protocol: "ip", source: { kind: "any" }, destination: { kind: "any" } }],
    });
    router.applyAcl("Gi0/0", "in", "AF31-ONLY");
    pc.ping("10.0.1.10", 1);
    engine.runUntilIdle();

    const order = engine.traceLog
      .filter((entry) => entry.device === "r1" && (entry.type === "qos-marked" || entry.type === "acl-evaluated"))
      .map((entry) => entry.type);
    expect(order[0]).toBe("qos-marked");
    expect(order).toContain("acl-evaluated");
  });

  it("falls through to class-default and traces it", () => {
    const { engine, pc, router } = lab();
    router.defineQosClassMap({ id: "TCP", matchType: "match-any", matches: [{ kind: "protocol", protocol: "tcp" }] });
    router.defineQosPolicyMap({
      id: "EDGE",
      classes: [{ className: "TCP", marking: { dscp: 34 } }, { className: QOS_CLASS_DEFAULT, marking: { dscp: 8 } }],
    });
    router.applyServicePolicy("Gi0/1", "output", "EDGE");
    pc.ping("10.0.1.10", 1);
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) => entry.type === "qos-class-default")).toBe(true);
    expect(router.qosCounters().some((row) => row.className === QOS_CLASS_DEFAULT && row.matchedPackets > 0)).toBe(true);
  });

  it("produces an identical trace for identical input", () => {
    const run = () => {
      const { engine, pc, router } = lab();
      router.defineQosClassMap({ id: "ICMP", matchType: "match-any", matches: [{ kind: "protocol", protocol: "icmp" }] });
      router.defineQosPolicyMap({
        id: "WAN-EDGE",
        classes: [{ className: "ICMP", marking: { dscp: 46 } }, { className: QOS_CLASS_DEFAULT }],
      });
      router.applyServicePolicy("Gi0/1", "output", "WAN-EDGE");
      pc.ping("10.0.1.10", 1);
      engine.runUntilIdle();
      return engine.traceLog;
    };
    expect(run()).toEqual(run());
  });
});

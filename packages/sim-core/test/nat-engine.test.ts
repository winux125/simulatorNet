import { IcmpType, IpProtocol } from "@sim/contracts";
import {
  NAT_RESOURCE_LIMITS,
  NatEngine,
  NatError,
  type Ipv4Packet,
  type NatEngineLimits,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function icmp(src = "10.0.0.10", dst = "203.0.113.10", identifier = 7): Ipv4Packet {
  return {
    kind: "ipv4",
    src,
    dst,
    protocol: IpProtocol.ICMP,
    ttl: 64,
    payload: { kind: "icmp", type: IcmpType.EchoRequest, code: 0, identifier, sequence: 1 },
  };
}

function tcp(srcPort = 50_000, dstPort = 443): Ipv4Packet {
  return {
    kind: "ipv4",
    src: "10.0.0.10",
    dst: "203.0.113.10",
    protocol: IpProtocol.TCP,
    ttl: 64,
    payload: {
      kind: "tcp",
      srcPort,
      dstPort,
      sequence: 1,
      acknowledgment: 0,
      syn: true,
    },
  };
}

function udp(srcPort = 50_001, dstPort = 53): Ipv4Packet {
  return {
    kind: "ipv4",
    src: "10.0.0.10",
    dst: "203.0.113.10",
    protocol: IpProtocol.UDP,
    ttl: 64,
    payload: {
      kind: "udp",
      srcPort,
      dstPort,
      payload: { kind: "udp-application", protocol: "test", data: null },
    },
  };
}

function context(nowNs = 0, aclPermits?: (aclId: string, packet: Ipv4Packet) => boolean) {
  return {
    nowNs,
    outsideInterfaceAddress: "203.0.113.1",
    aclPermits,
  };
}

function smallLimits(overrides: Partial<NatEngineLimits>): NatEngineLimits {
  return { ...NAT_RESOURCE_LIMITS, ...overrides };
}

describe("NatEngine", () => {
  it("translates static one-to-one traffic outbound and unsolicited return inbound", () => {
    const nat = new NatEngine();
    nat.defineRule({
      id: "static-web",
      sequence: 10,
      kind: "static",
      insideLocal: "10.0.0.10",
      insideGlobal: "203.0.113.100",
    });
    const outbound = nat.translateOutbound(tcp(), context());
    expect(outbound.packet).toMatchObject({ src: "203.0.113.100", dst: "203.0.113.10" });
    expect(outbound.translation).toMatchObject({ kind: "static", expiresAtNs: undefined });

    const inbound = nat.translateInbound({
      ...tcp(443, 50_000),
      src: "203.0.113.10",
      dst: "203.0.113.100",
    }, context());
    expect(inbound.packet).toMatchObject({ src: "203.0.113.10", dst: "10.0.0.10" });
  });

  it("allocates dynamic pool addresses deterministically and reports exhaustion", () => {
    const nat = new NatEngine();
    nat.definePool({ id: "public", startAddress: "203.0.113.100", endAddress: "203.0.113.101" });
    nat.defineRule({
      id: "dynamic",
      sequence: 10,
      kind: "dynamic",
      source: { kind: "any" },
      poolId: "public",
    });
    expect(nat.translateOutbound(icmp("10.0.0.10"), context()).packet.src).toBe("203.0.113.100");
    expect(nat.translateOutbound(icmp("10.0.0.11"), context()).packet.src).toBe("203.0.113.101");
    expect(nat.translateOutbound(icmp("10.0.0.10"), context()).packet.src).toBe("203.0.113.100");
    expect(nat.translateInbound(
      icmp("203.0.113.10", "203.0.113.100"),
      context(),
    ).packet.dst).toBe("10.0.0.10");
    expect(() => nat.translateOutbound(icmp("10.0.0.12"), context()))
      .toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_POOL_EXHAUSTED" }));
  });

  it("PAT translates TCP, UDP and ICMP with stable collision-safe ports", () => {
    const nat = new NatEngine();
    nat.defineRule({
      id: "overload",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    const tcpResult = nat.translateOutbound(tcp(), context());
    const udpResult = nat.translateOutbound(udp(), context());
    const icmpResult = nat.translateOutbound(icmp(), context());

    expect(tcpResult.packet.payload).toMatchObject({ kind: "tcp", srcPort: 49_152 });
    expect(udpResult.packet.payload).toMatchObject({ kind: "udp", srcPort: 49_152 });
    expect(icmpResult.packet.payload).toMatchObject({ kind: "icmp", identifier: 49_152 });
    expect(nat.translateOutbound(tcp(), context()).packet).toEqual(tcpResult.packet);

    const secondClient = nat.translateOutbound({
      ...tcp(),
      src: "10.0.0.11",
    }, context());
    expect(secondClient.packet.payload).toMatchObject({ kind: "tcp", srcPort: 49_153 });
  });

  it("restores PAT destination address and transport tokens on return traffic", () => {
    const nat = new NatEngine();
    nat.defineRule({
      id: "overload",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    const outbound = nat.translateOutbound(tcp(50_000, 443), context());
    const translatedPort = outbound.translation!.insideGlobalToken!;
    const inbound = nat.translateInbound({
      ...tcp(443, translatedPort),
      src: "203.0.113.10",
      dst: "203.0.113.1",
    }, context());
    expect(inbound.packet).toMatchObject({ dst: "10.0.0.10" });
    expect(inbound.packet.payload).toMatchObject({ kind: "tcp", dstPort: 50_000 });

    const udpOutbound = nat.translateOutbound(udp(50_001, 53), context());
    const translatedUdpPort = udpOutbound.translation!.insideGlobalToken!;
    const udpInbound = nat.translateInbound({
      ...udp(53, translatedUdpPort),
      src: "203.0.113.10",
      dst: "203.0.113.1",
    }, context());
    expect(udpInbound.packet).toMatchObject({ dst: "10.0.0.10" });
    expect(udpInbound.packet.payload).toMatchObject({ kind: "udp", dstPort: 50_001 });

    const icmpOutbound = nat.translateOutbound(icmp("10.0.0.10", "203.0.113.20", 42), context());
    const translatedId = icmpOutbound.translation!.insideGlobalToken!;
    const icmpInbound = nat.translateInbound({
      kind: "ipv4",
      src: "203.0.113.20",
      dst: "203.0.113.1",
      protocol: IpProtocol.ICMP,
      ttl: 64,
      payload: {
        kind: "icmp",
        type: IcmpType.EchoReply,
        code: 0,
        identifier: translatedId,
        sequence: 1,
      },
    }, context());
    expect(icmpInbound.packet).toMatchObject({ dst: "10.0.0.10" });
    expect(icmpInbound.packet.payload).toMatchObject({ identifier: 42 });
  });

  it("denies unsolicited inbound dynamic/PAT traffic with a typed error", () => {
    const nat = new NatEngine();
    nat.definePool({ id: "public", startAddress: "203.0.113.100", endAddress: "203.0.113.100" });
    nat.defineRule({
      id: "dynamic",
      sequence: 10,
      kind: "dynamic",
      source: { kind: "any" },
      poolId: "public",
    });
    expect(() => nat.translateInbound(icmp("203.0.113.10", "203.0.113.100"), context()))
      .toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_NO_TRANSLATION" }));

    const pat = new NatEngine();
    pat.defineRule({
      id: "pat",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    expect(() => pat.translateInbound({
      ...tcp(443, 49_152),
      src: "203.0.113.10",
      dst: "203.0.113.1",
    }, context())).toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_NO_TRANSLATION" }));
  });

  it("expires translations by virtual time and reuses released tokens", () => {
    const nat = new NatEngine(smallLimits({
      patPortStart: 49_152,
      patPortEnd: 49_152,
      tcpTimeoutNs: 100,
    }));
    nat.defineRule({
      id: "pat",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    nat.translateOutbound(tcp(), context(0));
    expect(() => nat.translateOutbound({ ...tcp(), src: "10.0.0.11" }, context(99)))
      .toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_PORT_EXHAUSTED" }));
    expect(nat.translationTable(100)).toEqual([]);
    expect(nat.translateOutbound({ ...tcp(), src: "10.0.0.11" }, context(100)).packet.payload)
      .toMatchObject({ srcPort: 49_152 });
  });

  it("uses an ACL selector without trusting packet-provided policy results", () => {
    const nat = new NatEngine();
    nat.defineRule({
      id: "selected",
      sequence: 10,
      kind: "pat",
      source: { kind: "acl", aclId: "nat-sources" },
      outsideAddress: "interface",
    });
    const selected = nat.translateOutbound(
      icmp("10.0.0.10"),
      context(0, (aclId, packet) => aclId === "nat-sources" && packet.src === "10.0.0.10"),
    );
    expect(selected.packet.src).toBe("203.0.113.1");
    const bypassed = nat.translateOutbound(
      icmp("10.0.0.11"),
      context(0, (_aclId, packet) => packet.src === "10.0.0.10"),
    );
    expect(bypassed.packet.src).toBe("10.0.0.11");
  });

  it("enforces bounded rules, pools, pool sizes, translations and port ranges", () => {
    expect(() => new NatEngine(smallLimits({ patPortStart: 60_000, patPortEnd: 59_999 })))
      .toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_INVALID_CONFIGURATION" }));

    const poolLimited = new NatEngine(smallLimits({ maximumPoolsPerDevice: 1 }));
    poolLimited.definePool({ id: "one", startAddress: "203.0.113.1", endAddress: "203.0.113.1" });
    expect(() => poolLimited.definePool({ id: "two", startAddress: "203.0.113.2", endAddress: "203.0.113.2" }))
      .toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_LIMIT_EXCEEDED" }));

    const ruleLimited = new NatEngine(smallLimits({ maximumRulesPerDevice: 1 }));
    ruleLimited.defineRule({
      id: "one",
      sequence: 10,
      kind: "static",
      insideLocal: "10.0.0.1",
      insideGlobal: "203.0.113.1",
    });
    expect(() => ruleLimited.defineRule({
      id: "two",
      sequence: 20,
      kind: "static",
      insideLocal: "10.0.0.2",
      insideGlobal: "203.0.113.2",
    })).toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_LIMIT_EXCEEDED" }));

    const translationLimited = new NatEngine(smallLimits({ maximumRuntimeTranslations: 1 }));
    translationLimited.defineRule({
      id: "pat",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    translationLimited.translateOutbound(tcp(), context());
    expect(() => translationLimited.translateOutbound({ ...tcp(), src: "10.0.0.11" }, context()))
      .toThrowError(expect.objectContaining<Partial<NatError>>({ code: "NAT_LIMIT_EXCEEDED" }));
  });

  it("produces identical translations and tables for identical input", () => {
    const run = () => {
      const nat = new NatEngine();
      nat.defineRule({
        id: "pat",
        sequence: 10,
        kind: "pat",
        source: { kind: "any" },
        outsideAddress: "interface",
      });
      nat.translateOutbound(tcp(), context(10));
      nat.translateOutbound(udp(), context(20));
      nat.translateOutbound(icmp(), context(30));
      return nat.translationTable(30);
    };
    expect(run()).toEqual(run());
  });
});

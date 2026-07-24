import { IcmpType, IpProtocol } from "@sim/contracts";
import {
  ACL_RESOURCE_LIMITS,
  AclRuleBudget,
  PacketPolicyEngine,
  PacketPolicyError,
  type ExtendedAclRule,
  type Ipv4Acl,
  type Ipv4Packet,
  type StandardAclRule,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

const any = { kind: "any" } as const;

function icmp(src = "10.0.0.10", dst = "10.0.1.10"): Ipv4Packet {
  return {
    kind: "ipv4",
    src,
    dst,
    protocol: IpProtocol.ICMP,
    ttl: 64,
    payload: {
      kind: "icmp",
      type: IcmpType.EchoRequest,
      code: 0,
      identifier: 1,
      sequence: 1,
    },
  };
}

function udp(srcPort: number, dstPort: number): Ipv4Packet {
  return {
    kind: "ipv4",
    src: "10.0.0.10",
    dst: "10.0.1.10",
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

function tcp(srcPort: number, dstPort: number): Ipv4Packet {
  return {
    kind: "ipv4",
    src: "10.0.0.10",
    dst: "10.0.1.10",
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

function standard(id: string, rules: StandardAclRule[]): Ipv4Acl {
  return { id, type: "standard", rules };
}

function extended(id: string, rules: ExtendedAclRule[]): Ipv4Acl {
  return { id, type: "extended", rules };
}

describe("PacketPolicyEngine", () => {
  it("evaluates standard ACLs in sequence order with host/any and implicit deny", () => {
    const policy = new PacketPolicyEngine();
    policy.defineAcl(standard("standard-10", [
      { sequence: 30, action: "permit", source: any },
      { sequence: 10, action: "deny", source: { kind: "host", address: "10.0.0.99" } },
      { sequence: 20, action: "permit", source: { kind: "host", address: "10.0.0.10" } },
    ]));
    policy.bind({ aclId: "standard-10", interfaceName: "Gi0/0", direction: "in" });

    expect(policy.evaluate("Gi0/0", "in", icmp("10.0.0.99"))).toMatchObject({
      action: "deny",
      sequence: 10,
      implicit: false,
    });
    expect(policy.evaluate("Gi0/0", "in", icmp("10.0.0.10"))).toMatchObject({
      action: "permit",
      sequence: 20,
    });
    expect(policy.evaluate("Gi0/0", "out", icmp())).toBeUndefined();

    policy.defineAcl(standard("implicit", [
      { sequence: 10, action: "permit", source: { kind: "host", address: "192.0.2.1" } },
    ]));
    policy.bind({ aclId: "implicit", interfaceName: "Gi0/1", direction: "out" });
    expect(policy.evaluate("Gi0/1", "out", icmp())).toEqual({
      aclId: "implicit",
      interfaceName: "Gi0/1",
      direction: "out",
      action: "deny",
      sequence: undefined,
      implicit: true,
    });
  });

  it("supports arbitrary non-contiguous Cisco wildcard masks", () => {
    const policy = new PacketPolicyEngine();
    policy.defineAcl(standard("wildcard", [{
      sequence: 10,
      action: "permit",
      source: { kind: "network", address: "10.0.20.0", wildcard: "0.255.0.255" },
    }]));
    policy.bind({ aclId: "wildcard", interfaceName: "Gi0/0", direction: "in" });

    expect(policy.evaluate("Gi0/0", "in", icmp("10.77.20.199"))?.action).toBe("permit");
    expect(policy.evaluate("Gi0/0", "in", icmp("10.77.21.199"))).toMatchObject({
      action: "deny",
      implicit: true,
    });
  });

  it("matches extended TCP and UDP eq/range ports and ICMP protocol", () => {
    const policy = new PacketPolicyEngine();
    policy.defineAcl(extended("extended-100", [
      {
        sequence: 10,
        action: "permit",
        protocol: IpProtocol.TCP,
        source: any,
        destination: { kind: "host", address: "10.0.1.10" },
        sourcePort: { kind: "range", start: 49_152, end: 65_535 },
        destinationPort: { kind: "eq", port: 443 },
      },
      {
        sequence: 20,
        action: "permit",
        protocol: IpProtocol.UDP,
        source: any,
        destination: any,
        destinationPort: { kind: "range", start: 53, end: 69 },
      },
      {
        sequence: 30,
        action: "permit",
        protocol: IpProtocol.ICMP,
        source: any,
        destination: any,
      },
    ]));
    policy.bind({ aclId: "extended-100", interfaceName: "outside", direction: "out" });

    expect(policy.evaluate("outside", "out", tcp(50_000, 443))).toMatchObject({ sequence: 10, action: "permit" });
    expect(policy.evaluate("outside", "out", tcp(50_000, 80))).toMatchObject({ implicit: true, action: "deny" });
    expect(policy.evaluate("outside", "out", udp(50_000, 53))).toMatchObject({ sequence: 20 });
    expect(policy.evaluate("outside", "out", udp(50_000, 70))).toMatchObject({ implicit: true });
    expect(policy.evaluate("outside", "out", icmp())).toMatchObject({ sequence: 30 });
  });

  it("uses first match and keeps deterministic runtime-only counters", () => {
    const policy = new PacketPolicyEngine();
    policy.defineAcl(standard("ordered", [
      { sequence: 20, action: "permit", source: any },
      { sequence: 10, action: "deny", source: any },
    ]));
    policy.bind({ aclId: "ordered", interfaceName: "Gi0/0", direction: "in" });
    policy.evaluate("Gi0/0", "in", icmp());
    policy.evaluate("Gi0/0", "in", icmp());

    expect(policy.counterSummaries()).toEqual([{
      aclId: "ordered",
      sequence: 10,
      action: "deny",
      matches: 2,
    }]);
    expect(policy.aclConfigurations()).toEqual([standard("ordered", [
      { sequence: 10, action: "deny", source: any },
      { sequence: 20, action: "permit", source: any },
    ])]);
    policy.resetCounters();
    expect(policy.counterSummaries()).toEqual([]);
  });

  it("enforces per-ACL, per-device, and shared per-lab resource limits", () => {
    const tooManyRules = Array.from(
      { length: ACL_RESOURCE_LIMITS.maximumRulesPerAcl + 1 },
      (_, sequence) => ({ sequence, action: "permit" as const, source: any }),
    );
    expect(() => new PacketPolicyEngine().defineAcl(standard("oversized", tooManyRules)))
      .toThrowError(expect.objectContaining<Partial<PacketPolicyError>>({ code: "ACL_RULE_LIMIT_EXCEEDED" }));

    const devicePolicy = new PacketPolicyEngine();
    for (let index = 0; index < ACL_RESOURCE_LIMITS.maximumAclsPerDevice; index++) {
      devicePolicy.defineAcl(standard(`acl-${index}`, []));
    }
    expect(() => devicePolicy.defineAcl(standard("one-too-many", [])))
      .toThrowError(expect.objectContaining<Partial<PacketPolicyError>>({ code: "ACL_LIMIT_EXCEEDED" }));

    const shared = new AclRuleBudget(2);
    const first = new PacketPolicyEngine(shared);
    const second = new PacketPolicyEngine(shared);
    first.defineAcl(standard("first", [
      { sequence: 10, action: "permit", source: any },
      { sequence: 20, action: "deny", source: any },
    ]));
    expect(() => second.defineAcl(standard("second", [
      { sequence: 10, action: "permit", source: any },
    ]))).toThrowError(expect.objectContaining<Partial<PacketPolicyError>>({
      code: "ACL_LAB_RULE_LIMIT_EXCEEDED",
    }));
    expect(shared.usedRules).toBe(2);
  });

  it("rejects malformed protocols, ports, sequences, and missing ACL bindings", () => {
    const policy = new PacketPolicyEngine();
    expect(() => policy.defineAcl(extended("bad-port", [{
      sequence: 10,
      action: "permit",
      protocol: IpProtocol.ICMP,
      source: any,
      destination: any,
      destinationPort: { kind: "eq", port: 80 },
    }]))).toThrowError(expect.objectContaining<Partial<PacketPolicyError>>({
      code: "ACL_INVALID_CONFIGURATION",
    }));
    expect(() => policy.defineAcl(standard("duplicates", [
      { sequence: 10, action: "permit", source: any },
      { sequence: 10, action: "deny", source: any },
    ]))).toThrowError(expect.objectContaining<Partial<PacketPolicyError>>({
      code: "ACL_INVALID_CONFIGURATION",
    }));
    expect(() => policy.bind({ aclId: "missing", interfaceName: "Gi0/0", direction: "in" }))
      .toThrowError(expect.objectContaining<Partial<PacketPolicyError>>({ code: "ACL_NOT_FOUND" }));
  });
});

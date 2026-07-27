import {
  Ipv6NextHeader,
  PacketPolicyEngine,
  Pc,
  Router,
  Server,
  createSimulationEngine,
  macFromIndex,
  type Ipv6Acl,
  type Ipv6Packet,
} from "@sim/sim-core";
import type { ServerServiceConfig } from "@sim/contracts";
import { describe, expect, it } from "vitest";

const packet = (
  nextHeader: Ipv6Packet["nextHeader"],
  src = "2001:db8:10::10",
  dst = "2001:db8:20::10",
  sourcePort = 49_152,
  destinationPort = 80,
): Ipv6Packet => ({
  kind: "ipv6",
  src,
  dst,
  nextHeader,
  hopLimit: 64,
  payload: nextHeader === Ipv6NextHeader.TCP
    ? {
        kind: "tcp",
        srcPort: sourcePort,
        dstPort: destinationPort,
        sequence: 1,
        acknowledgement: 0,
        flags: { syn: true },
      }
    : nextHeader === Ipv6NextHeader.UDP
      ? {
          kind: "udp",
          srcPort: sourcePort,
          dstPort: destinationPort,
          payload: { kind: "udp-application", protocol: "test", data: "value" },
        }
      : {
          kind: "icmpv6",
          type: 128,
          code: 0,
          identifier: 1,
          sequence: 1,
        },
});

const WEB6: Ipv6Acl = {
  id: "WEB6",
  type: "ipv6",
  rules: [
    {
      sequence: 20,
      action: "deny",
      protocol: "ipv6",
      source: { kind: "any" },
      destination: { kind: "any" },
    },
    {
      sequence: 10,
      action: "permit",
      protocol: Ipv6NextHeader.TCP,
      source: { kind: "prefix", address: "2001:db8:10::", prefixLength: 64 },
      destination: { kind: "host", address: "2001:db8:20::10" },
      destinationPort: { kind: "eq", port: 80 },
    },
  ],
};

describe("shared IPv6 packet policy", () => {
  it.each([
    ["matching HTTP", packet(Ipv6NextHeader.TCP), "permit", 10, false],
    ["wrong TCP port", packet(Ipv6NextHeader.TCP, undefined, undefined, 49_152, 443), "deny", 20, false],
    ["UDP traffic", packet(Ipv6NextHeader.UDP), "deny", 20, false],
    ["source outside prefix", packet(Ipv6NextHeader.TCP, "2001:db8:30::10"), "deny", 20, false],
  ] as const)("applies ordered prefix and port rules to %s", (_title, candidate, action, sequence, implicit) => {
    const policy = new PacketPolicyEngine();
    policy.defineIpv6Acl(WEB6);
    policy.bindIpv6({ interfaceName: "Gi0/0", direction: "in", aclId: "WEB6" });
    expect(policy.evaluateIpv6("Gi0/0", "in", candidate)).toMatchObject({ action, sequence, implicit });
  });

  it("uses implicit deny and transient counters without changing configuration", () => {
    const policy = new PacketPolicyEngine();
    policy.defineIpv6Acl({ id: "EMPTY6", type: "ipv6", rules: [] });
    policy.bindIpv6({ interfaceName: "Gi0/0", direction: "out", aclId: "EMPTY6" });
    expect(policy.evaluateIpv6("Gi0/0", "out", packet(Ipv6NextHeader.ICMPv6))).toMatchObject({
      action: "deny",
      implicit: true,
    });
    expect(policy.counterSummaries()).toEqual([
      { aclId: "EMPTY6", sequence: undefined, action: "deny", matches: 1 },
    ]);
    policy.resetCounters();
    expect(policy.ipv6AclConfigurations()).toEqual([{ id: "EMPTY6", type: "ipv6", rules: [] }]);
  });

  it.each([
    [{ kind: "prefix", address: "2001:db8::", prefixLength: 129 }, /prefix length/],
    [{ kind: "host", address: "not-ipv6" }, /Invalid IPv6/],
  ] as const)("rejects invalid IPv6 matcher %j", (source, message) => {
    const policy = new PacketPolicyEngine();
    expect(() => policy.defineIpv6Acl({
      id: "BAD6",
      type: "ipv6",
      rules: [{
        sequence: 10,
        action: "permit",
        protocol: "ipv6",
        source,
        destination: { kind: "any" },
      }],
    })).toThrow(message);
  });

  it("permits HTTP, required ICMPv6 control traffic, and denies other routed traffic", () => {
    const engine = createSimulationEngine({ seed: 540 });
    engine.enableTrace();
    const router = engine.add(new Router("r1", "R1"));
    const client = engine.add(new Pc("pc1", "PC1"));
    const server = engine.add(new Server("server1", "SRV1"));
    router.addInterface("Gi0/0", macFromIndex(100));
    router.addInterface("Gi0/1", macFromIndex(101));
    router.getOrCreateInterface("Gi0/0");
    router.getOrCreateInterface("Gi0/1");
    router.setInterfaceIpv6("Gi0/0", "2001:db8:10::1", 64);
    router.setInterfaceIpv6("Gi0/1", "2001:db8:20::1", 64);
    router.setIpv6ForwardingEnabled(true);
    client.addInterface("eth0", macFromIndex(1));
    server.addInterface("eth0", macFromIndex(2));
    client.configureIpv6Static("2001:db8:10::10", 64, "2001:db8:10::1");
    server.configureIpv6Static("2001:db8:20::10", 64, "2001:db8:20::1");
    engine.connect(client.id, "eth0", router.id, "Gi0/0");
    engine.connect(server.id, "eth0", router.id, "Gi0/1");
    const http: ServerServiceConfig = {
      id: "http6",
      type: "http",
      enabled: true,
      port: 80,
      resources: [{ path: "/", contentType: "text/plain", body: "allowed" }],
    };
    server.configureServices([http]);
    router.defineIpv6Acl({
      id: "WEB6",
      type: "ipv6",
      rules: [
        {
          sequence: 5,
          action: "permit",
          protocol: Ipv6NextHeader.ICMPv6,
          source: { kind: "any" },
          destination: { kind: "any" },
        },
        {
          sequence: 10,
          action: "permit",
          protocol: Ipv6NextHeader.TCP,
          source: { kind: "prefix", address: "2001:db8:10::", prefixLength: 64 },
          destination: { kind: "host", address: "2001:db8:20::10" },
          destinationPort: { kind: "eq", port: 80 },
        },
        {
          sequence: 20,
          action: "deny",
          protocol: "ipv6",
          source: { kind: "any" },
          destination: { kind: "any" },
        },
      ],
    });
    router.applyIpv6Acl("Gi0/1", "out", "WEB6");
    engine.runUntilIdle();

    client.applications.httpGet("http://[2001:db8:20::10]/");
    engine.runUntilIdle();
    expect(client.applications.httpResults.at(-1)).toMatchObject({ statusCode: 200, body: "allowed" });

    client.sendUdp({
      destinationAddress: "2001:db8:20::10",
      destinationPort: 9999,
      payload: { kind: "udp-application", protocol: "test", data: "blocked" },
    });
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) =>
      entry.type === "ipv6-acl-denied"
      && entry.detail?.nextHeader === Ipv6NextHeader.UDP)).toBe(true);
  });

  it("does not secretly bypass a rule that blocks critical NDP", () => {
    const engine = createSimulationEngine({ seed: 541 });
    const router = engine.add(new Router("r1", "R1"));
    const pc = engine.add(new Pc("pc1", "PC1"));
    router.addInterface("Gi0/0", macFromIndex(100));
    router.getOrCreateInterface("Gi0/0");
    router.setInterfaceIpv6("Gi0/0", "2001:db8:10::1", 64);
    pc.addInterface("eth0", macFromIndex(1));
    pc.configureIpv6Static("2001:db8:10::10", 64);
    engine.connect(pc.id, "eth0", router.id, "Gi0/0");
    router.defineIpv6Acl({
      id: "BLOCK6",
      type: "ipv6",
      rules: [{
        sequence: 10,
        action: "deny",
        protocol: "ipv6",
        source: { kind: "any" },
        destination: { kind: "any" },
      }],
    });
    router.applyIpv6Acl("Gi0/0", "in", "BLOCK6");
    engine.runUntilIdle();
    pc.ping6("2001:db8:10::1", 1);
    engine.runUntilIdle();

    expect(pc.ipv6PingResults.at(-1)).toMatchObject({ success: false });
    expect(router.ipv6Problems).toEqual([
      expect.stringMatching(/blocked required ICMPv6 control traffic.*NDP or SLAAC may fail/),
    ]);
  });
});

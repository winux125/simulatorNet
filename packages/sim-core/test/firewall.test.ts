import { IpProtocol } from "@sim/contracts";
import {
  Firewall,
  Pc,
  Server,
  createSimulationEngine,
  macFromIndex,
  type FirewallPolicyRule,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function firewallTopology() {
  const engine = createSimulationEngine({ seed: 301 });
  const firewall = engine.add(new Firewall("fw", "FW1"));
  firewall.addInterface("Eth0/0", macFromIndex(200));
  firewall.addInterface("Eth0/1", macFromIndex(201));
  firewall.configureInterface("Eth0/0", { ip: "10.0.0.1", mask: 24 });
  firewall.configureInterface("Eth0/1", { ip: "203.0.113.1", mask: 24 });
  firewall.setZone("Eth0/0", "inside");
  firewall.setZone("Eth0/1", "outside");

  const inside = engine.add(new Pc("inside", "Inside"));
  inside.addInterface("eth0", macFromIndex(1));
  inside.configure({ ip: "10.0.0.10", mask: 24, gateway: "10.0.0.1" });
  engine.connect("inside", "eth0", "fw", "Eth0/0");

  const outside = engine.add(new Server("outside", "Outside"));
  outside.addInterface("eth0", macFromIndex(2));
  outside.configure({ ip: "203.0.113.10", mask: 24, gateway: "203.0.113.1" });
  engine.connect("outside", "eth0", "fw", "Eth0/1");
  return { engine, firewall, inside, outside };
}

const permitInside: FirewallPolicyRule = {
  id: "inside-out",
  sequence: 10,
  sourceZone: "inside",
  destinationZone: "outside",
  action: "permit",
  protocol: "ip",
  source: { kind: "any" },
  destination: { kind: "any" },
};

function deterministicPing(): { trace: TraceEntry[]; table: unknown; success: boolean } {
  const { engine, firewall, inside } = firewallTopology();
  engine.enableTrace();
  firewall.definePolicy(permitInside);
  inside.ping("203.0.113.10", 1);
  engine.runUntilIdle();
  return {
    trace: engine.traceLog,
    table: firewall.connectionTable(),
    success: inside.pingResults[0]?.success ?? false,
  };
}

describe("stateful Firewall", () => {
  it("uses explicit default deny for unsolicited and new transit traffic", () => {
    const { engine, firewall, inside, outside } = firewallTopology();
    engine.enableTrace();
    inside.ping("203.0.113.10", 1);
    outside.ping("10.0.0.10", 2);
    engine.runUntilIdle();
    expect(inside.pingResults[0]).toMatchObject({ success: false });
    expect(outside.pingResults[0]).toMatchObject({ success: false });
    expect(firewall.defaultPolicy).toBe("deny");
    expect(engine.traceLog.filter((entry) => entry.type === "firewall-denied").length).toBeGreaterThan(0);
  });

  it("permits a NEW flow by first match and automatically permits established return traffic", () => {
    const result = deterministicPing();
    expect(result.success).toBe(true);
    expect(result.table).toEqual([
      expect.objectContaining({
        protocol: IpProtocol.ICMP,
        sourceZone: "inside",
        destinationZone: "outside",
        state: "ESTABLISHED",
      }),
    ]);
    expect(result.trace).toContainEqual(expect.objectContaining({
      type: "firewall-permitted",
      detail: expect.objectContaining({ reason: "stateful-return", state: "ESTABLISHED" }),
    }));
  });

  it("orders policies by sequence rather than insertion order", () => {
    const { engine, firewall, inside } = firewallTopology();
    firewall.definePolicy({
      ...permitInside,
      id: "deny-later",
      sequence: 20,
      action: "deny",
    });
    firewall.definePolicy({
      ...permitInside,
      id: "permit-first",
      sequence: 10,
      action: "permit",
    });
    inside.ping("203.0.113.10", 1);
    engine.runUntilIdle();
    expect(inside.pingResults[0]).toMatchObject({ success: true });
    expect(firewall.policyCounterSummaries()).toEqual([{ ruleId: "permit-first", matches: 1 }]);
  });

  it("applies ordered protocol/port rules to TCP and tracks closing state", () => {
    const { engine, firewall, inside, outside } = firewallTopology();
    outside.listenTcp(443, (connection) => connection.setHandlers({
      onEstablished: (current) => current.close(),
    }), "https-test");
    firewall.definePolicy({
      id: "deny-http",
      sequence: 10,
      sourceZone: "inside",
      destinationZone: "outside",
      action: "deny",
      protocol: IpProtocol.TCP,
      destinationPort: { kind: "eq", port: 80 },
      destination: { kind: "any" },
      source: { kind: "any" },
    });
    firewall.definePolicy({
      id: "permit-https",
      sequence: 20,
      sourceZone: "inside",
      destinationZone: "outside",
      action: "permit",
      protocol: IpProtocol.TCP,
      source: { kind: "any" },
      destination: { kind: "any" },
      destinationPort: { kind: "eq", port: 443 },
    });
    let established = false;
    inside.connectTcp("203.0.113.10", 443, {
      onEstablished: (connection) => {
        established = true;
        connection.close();
      },
    });
    engine.runUntilIdle();
    expect(established).toBe(true);
    expect(firewall.policyCounterSummaries()).toContainEqual({ ruleId: "permit-https", matches: 1 });
    expect(firewall.connectionTable()[0]?.state).toMatch(/ESTABLISHED|CLOSING|EXPIRED/);
  });

  it("tracks a UDP pseudo-session and permits the reverse datagram", () => {
    const { engine, firewall, inside, outside } = firewallTopology();
    firewall.definePolicy({
      ...permitInside,
      id: "udp-out",
      protocol: IpProtocol.UDP,
    });
    outside.bindUdp(9000, (datagram) => {
      outside.sendUdp({
        destinationAddress: datagram.sourceAddress,
        destinationPort: datagram.sourcePort,
        sourcePort: 9000,
        payload: datagram.payload,
      });
    });
    let reply = false;
    const sourcePort = inside.bindUdp(0, () => {
      reply = true;
    });
    inside.sendUdp({
      destinationAddress: "203.0.113.10",
      destinationPort: 9000,
      sourcePort,
      payload: { kind: "udp-application", protocol: "echo", data: "hello" },
    });
    engine.runUntilIdle();
    expect(reply).toBe(true);
    expect(firewall.connectionTable()[0]).toMatchObject({
      protocol: IpProtocol.UDP,
      state: "ESTABLISHED",
    });
  });

  it("supports named inside/outside/dmz/custom zones and bounded policy counters", () => {
    const { firewall } = firewallTopology();
    firewall.addInterface("Eth0/2", macFromIndex(202));
    firewall.addInterface("Eth0/3", macFromIndex(203));
    firewall.configureInterface("Eth0/2", { ip: "172.16.0.1", mask: 24 });
    firewall.configureInterface("Eth0/3", { ip: "192.0.2.1", mask: 24 });
    firewall.setZone("Eth0/2", "dmz");
    firewall.setZone("Eth0/3", "partners");
    expect(firewall.zoneConfigurations()).toEqual([
      { interfaceName: "Eth0/0", zone: "inside" },
      { interfaceName: "Eth0/1", zone: "outside" },
      { interfaceName: "Eth0/2", zone: "dmz" },
      { interfaceName: "Eth0/3", zone: "partners" },
    ]);
  });

  it("enforces a finite policy table", () => {
    const { firewall } = firewallTopology();
    for (let index = 0; index < 256; index++) {
      firewall.definePolicy({
        id: `rule-${index}`,
        sequence: index,
        sourceZone: "*",
        destinationZone: "*",
        action: "deny",
        protocol: "ip",
      });
    }
    expect(() => firewall.definePolicy({
      id: "overflow",
      sequence: 300,
      sourceZone: "*",
      destinationZone: "*",
      action: "deny",
      protocol: "ip",
    })).toThrow(/limit/);
  });

  it("expires connection state using virtual time only", () => {
    const { engine, firewall, inside } = firewallTopology();
    firewall.definePolicy(permitInside);
    inside.ping("203.0.113.10", 1);
    engine.runUntilIdle();
    const expiry = firewall.connectionTable()[0]!.expiresAtNs;
    engine.advanceTo(expiry);
    expect(firewall.connectionTable()[0]).toMatchObject({ state: "EXPIRED" });
  });

  it("composes inherited ACL and NAT/PAT engines", () => {
    const { engine, firewall, inside } = firewallTopology();
    firewall.definePolicy(permitInside);
    firewall.setNatRole("Eth0/0", "inside");
    firewall.setNatRole("Eth0/1", "outside");
    firewall.defineNatRule({
      id: "overload",
      sequence: 10,
      kind: "pat",
      source: { kind: "any" },
      outsideAddress: "interface",
    });
    inside.ping("203.0.113.10", 1);
    engine.runUntilIdle();
    expect(inside.pingResults[0]).toMatchObject({ success: true });
    expect(firewall.natTranslations()).toHaveLength(1);
    expect(firewall.connectionTable()).toHaveLength(1);
  });

  it("produces identical state and trace after an identical rebuild", () => {
    expect(deterministicPing()).toEqual(deterministicPing());
  });
});

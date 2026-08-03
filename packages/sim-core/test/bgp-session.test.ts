import { describe, expect, it } from "vitest";
import {
  BGP_TCP_PORT,
  ControlProtocolConfigurationError,
  Router,
  createSimulationEngine,
  isBgpMessage,
  macFromIndex,
} from "@sim/sim-core";

function connectedPair(remoteAsOnR1 = 65_002, localAsOnR2 = 65_002) {
  const engine = createSimulationEngine({ seed: 10_10 });
  engine.enableTrace();
  const r1 = engine.add(new Router("r1", "R1"));
  const r2 = engine.add(new Router("r2", "R2"));
  r1.addInterface("Gi0/0", macFromIndex(1));
  r2.addInterface("Gi0/0", macFromIndex(2));
  r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 30 });
  r2.configureInterface("Gi0/0", { ip: "10.0.12.2", mask: 30 });
  engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
  r1.bgp.configure({
    localAs: 65_001,
    routerId: "1.1.1.1",
    keepaliveSeconds: 10,
    holdTimeSeconds: 30,
    neighbors: [{ address: "10.0.12.2", remoteAs: remoteAsOnR1 }],
  });
  r2.bgp.configure({
    localAs: localAsOnR2,
    routerId: "2.2.2.2",
    keepaliveSeconds: 20,
    holdTimeSeconds: 60,
    neighbors: [{ address: "10.0.12.1", remoteAs: 65_001 }],
  });
  return { engine, r1, r2 };
}

describe("BGP session transport and FSM", () => {
  it("establishes eBGP through simulated TCP port 179", () => {
    const { engine, r1, r2 } = connectedPair();
    engine.runUntilIdle();

    expect(r1.bgp.summaries()[0]).toMatchObject({
      address: "10.0.12.2",
      state: "established",
      localAddress: "10.0.12.1",
      negotiatedHoldTimeSeconds: 30,
    });
    expect(r2.bgp.summaries()[0]?.state).toBe("established");
    expect(r1.management.tcp.inspect().some((socket) => socket.remotePort === BGP_TCP_PORT)).toBe(true);
  });

  it("emits deterministic FSM and message trace events", () => {
    const { engine } = connectedPair();
    engine.runUntilIdle();

    const r1States = engine.traceLog
      .filter((entry) => entry.device === "r1" && entry.type === "bgp-state-changed")
      .map((entry) => entry.detail?.state);
    expect(r1States).toEqual(["connect", "open-sent", "open-confirm", "established"]);
    expect(engine.traceLog.some((entry) => entry.type === "bgp-session-established")).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "tcp-connection-established")).toBe(true);
  });

  it("rejects a peer whose OPEN advertises the wrong AS", () => {
    const { engine, r1 } = connectedPair(65_002, 65_003);
    engine.runUntilIdle();

    expect(r1.bgp.summaries()[0]).toMatchObject({ state: "idle", lastError: "Remote AS does not match neighbor configuration" });
    expect(engine.traceLog.some((entry) => entry.type === "bgp-notification")).toBe(true);
  });

  it("stays Active when the neighbor has no route", () => {
    const engine = createSimulationEngine({ seed: 4 });
    const router = engine.add(new Router("r1", "R1"));
    router.addInterface("Gi0/0", macFromIndex(1));
    router.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    router.bgp.configure({ localAs: 1, neighbors: [{ address: "192.0.2.1", remoteAs: 2 }] });

    expect(router.bgp.summaries()[0]).toMatchObject({
      state: "active",
      lastError: "neighbor is not reachable through the IPv4 routing table",
    });
  });

  it("fails to establish when an interface ACL blocks simulated TCP 179", () => {
    const { engine, r1, r2 } = connectedPair();
    r2.defineAcl({
      id: "block-bgp",
      type: "extended",
      rules: [
        {
          sequence: 10,
          action: "deny",
          protocol: 6,
          source: { kind: "any" },
          destination: { kind: "any" },
          destinationPort: { kind: "eq", port: BGP_TCP_PORT },
        },
        { sequence: 20, action: "permit", protocol: "ip", source: { kind: "any" }, destination: { kind: "any" } },
      ],
    });
    r2.applyAcl("Gi0/0", "in", "block-bgp");
    engine.runUntilIdle();

    expect(r1.bgp.summaries()[0]?.state).not.toBe("established");
    expect(engine.traceLog.some((entry) => entry.type === "acl-denied"
      && entry.detail?.interface === "Gi0/0"
      && entry.detail?.sequence === 10)).toBe(true);
  });

  it("uses one-hop eBGP and bounded multihop TTL configuration", () => {
    const { r1 } = connectedPair();
    expect(r1.bgp.outboundTtl("10.0.12.2")).toBe(1);
    r1.bgp.configure({
      localAs: 65_001,
      neighbors: [{ address: "10.0.12.2", remoteAs: 65_002, ebgpMultihop: 7 }],
    });
    expect(r1.bgp.outboundTtl("10.0.12.2")).toBe(7);
  });

  it("does not leave an unbounded periodic event stream", () => {
    const { engine, r1 } = connectedPair();
    expect(() => engine.runUntilIdle()).not.toThrow();
    expect(engine.pendingEventCount()).toBe(0);

    engine.advanceTo(engine.now() + 31_000_000_000);
    expect(r1.bgp.summaries()[0]).toMatchObject({
      state: "idle",
      lastError: "BGP hold timer expired after 30 seconds",
    });
    expect(engine.traceLog.some((entry) => entry.type === "bgp-hold-expired")).toBe(true);
    expect(() => engine.runUntilIdle()).not.toThrow();
    expect(engine.pendingEventCount()).toBe(0);
  });
});

describe("BGP configuration and structured messages", () => {
  it.each([
    [0, "localAs"],
    [4_294_967_296, "localAs"],
  ])("rejects invalid ASN %s", (localAs, field) => {
    const engine = createSimulationEngine({ seed: 1 });
    const router = engine.add(new Router("r1", "R1"));
    expect(() => router.bgp.configure({ localAs })).toThrowError(ControlProtocolConfigurationError);
    try {
      router.bgp.configure({ localAs });
    } catch (error) {
      expect((error as ControlProtocolConfigurationError).field).toBe(field);
    }
  });

  it("recognizes only the bounded structured BGP message envelope", () => {
    expect(isBgpMessage({ kind: "bgp-keepalive" })).toBe(true);
    expect(isBgpMessage({ kind: "wireless-beacon" })).toBe(false);
    expect(isBgpMessage(null)).toBe(false);
  });
});

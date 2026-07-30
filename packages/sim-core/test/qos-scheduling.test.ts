import {
  NS_PER_MS,
  Pc,
  QOS_CLASS_DEFAULT,
  Router,
  Server,
  TokenBucket,
  createSimulationEngine,
  defaultBurstBytes,
  macFromIndex,
  type QosPolicyMap,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

/** PC and a Traffic-Generator-like host behind one slow WAN link. */
function lab(options: { wanCapacityBps?: number; queueLimitPackets?: number } = {}) {
  const engine = createSimulationEngine({ seed: 9_001, linkDelayNs: 0 });
  const voice = engine.add(new Pc("voice", "VOICE"));
  const bulk = engine.add(new Pc("bulk", "BULK"));
  const router = engine.add(new Router("r1", "R1"));
  const server = engine.add(new Server("srv", "SRV"));
  voice.addInterface("eth0", macFromIndex(1));
  bulk.addInterface("eth0", macFromIndex(2));
  router.addInterface("Gi0/0", macFromIndex(3));
  router.addInterface("Gi0/1", macFromIndex(4));
  router.addInterface("Gi0/2", macFromIndex(5));
  server.addInterface("eth0", macFromIndex(6));
  voice.configure({ ip: "10.0.0.10", mask: 24, gateway: "10.0.0.1" });
  bulk.configure({ ip: "10.0.1.10", mask: 24, gateway: "10.0.1.1" });
  server.configure({ ip: "10.0.2.10", mask: 24, gateway: "10.0.2.1" });
  for (const name of ["Gi0/0", "Gi0/1", "Gi0/2"]) router.getOrCreateInterface(name);
  router.setInterfaceIp("Gi0/0", "10.0.0.1", 24);
  router.setInterfaceIp("Gi0/1", "10.0.1.1", 24);
  router.setInterfaceIp("Gi0/2", "10.0.2.1", 24);
  engine.connect("voice", "eth0", "r1", "Gi0/0", { propagationDelayNs: 0 });
  engine.connect("bulk", "eth0", "r1", "Gi0/1", { propagationDelayNs: 0 });
  engine.connect("r1", "Gi0/2", "srv", "eth0", {
    propagationDelayNs: 0,
    capacityBps: options.wanCapacityBps ?? 1_000_000,
    queueLimitPackets: options.queueLimitPackets ?? 64,
  });
  // Arrival order is read from a real listener, not from a queue counter, so a
  // test observes exactly what the far end received and in which order.
  const arrivals: string[] = [];
  const collect = (datagram: { payload: { kind: string } }) => {
    const payload = datagram.payload;
    if (payload.kind === "udp-application") arrivals.push((payload as { protocol: string }).protocol);
  };
  for (const port of [5060, 9000]) server.transport.udp.bind(port, collect, "qos-probe");
  engine.enableTrace();
  return { engine, voice, bulk, router, server, arrivals };
}

function udp(host: Pc, destination: string, port: number, bytes: number, flowMarker: string): void {
  host.sendUdp({
    destinationAddress: destination,
    destinationPort: port,
    payload: { kind: "udp-application", protocol: flowMarker, data: "x", payloadBytes: bytes },
  });
}

const VOICE_VS_BULK: QosPolicyMap = {
  id: "WAN-EDGE",
  classes: [
    { className: "REALTIME", priority: { percent: 40 }, marking: { dscp: 46 } },
    { className: QOS_CLASS_DEFAULT, bandwidthPercent: 50 },
  ],
};

describe("token bucket", () => {
  it("starts full and refills only from virtual time", () => {
    const bucket = new TokenBucket({ rateBps: 8_000, burstBytes: 1_000 }, 0);
    expect(bucket.consume(1_000, 0)).toBe(true);
    expect(bucket.consume(1, 0)).toBe(false);
    // 8 kbps = 1000 bytes per second.
    expect(bucket.consume(500, 500 * NS_PER_MS)).toBe(true);
  });

  it("never exceeds its burst however long it idles", () => {
    const bucket = new TokenBucket({ rateBps: 8_000, burstBytes: 1_000 }, 0);
    expect(bucket.availableBytes(60_000_000_000)).toBe(1_000);
  });

  it("reports a strictly future ready time when it is short", () => {
    const bucket = new TokenBucket({ rateBps: 8_000, burstBytes: 100 }, 0);
    bucket.consume(100, 0);
    expect(bucket.readyAtNs(100, 0)).toBeGreaterThan(0);
  });

  it("derives a bounded default burst from the rate", () => {
    expect(defaultBurstBytes(8_000)).toBe(1_500);
    expect(defaultBurstBytes(100_000_000_000)).toBe(1_048_576);
    expect(defaultBurstBytes(32_000_000)).toBe(1_000_000);
  });
});

describe("strict priority scheduling", () => {
  it("serves priority traffic before bulk traffic queued first", () => {
    const { engine, voice, bulk, router, arrivals } = lab({ wanCapacityBps: 1_000_000 });
    router.defineQosClassMap({
      id: "REALTIME",
      matchType: "match-any",
      matches: [{ kind: "destination-port", port: { kind: "eq", port: 5060 } }],
    });
    router.defineQosPolicyMap(VOICE_VS_BULK);
    router.applyServicePolicy("Gi0/2", "output", "WAN-EDGE");

    // Fill the WAN queue with bulk first, then send voice.
    for (let index = 0; index < 6; index++) udp(bulk, "10.0.2.10", 9000, 1_400, `bulk${index}`);
    engine.advanceTo(engine.now() + 1);
    for (let index = 0; index < 3; index++) udp(voice, "10.0.2.10", 5060, 160, `voice${index}`);
    engine.runUntilIdle();

    const markers = arrivals.filter((marker) => marker.length > 0);
    const firstVoice = markers.findIndex((marker) => marker.startsWith("voice"));
    const lastBulk = markers.map((marker) => marker.startsWith("bulk")).lastIndexOf(true);
    expect(firstVoice).toBeGreaterThanOrEqual(0);
    expect(firstVoice).toBeLessThan(lastBulk);
    expect(engine.traceLog.some((entry) => entry.type === "qos-priority-served")).toBe(true);
  });

  it("polices priority traffic above its allowance instead of starving other queues", () => {
    const { engine, voice, router, arrivals } = lab({ wanCapacityBps: 1_000_000 });
    router.defineQosClassMap({
      id: "REALTIME",
      matchType: "match-any",
      matches: [{ kind: "destination-port", port: { kind: "eq", port: 5060 } }],
    });
    router.defineQosPolicyMap({
      id: "TIGHT",
      classes: [
        { className: "REALTIME", priority: { rateBps: 8_000 } },
        { className: QOS_CLASS_DEFAULT },
      ],
    });
    router.applyServicePolicy("Gi0/2", "output", "TIGHT");
    for (let index = 0; index < 40; index++) udp(voice, "10.0.2.10", 5060, 1_400, `voice${index}`);
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) => entry.type === "qos-police-dropped")).toBe(true);
    const wan = router.getInterface("Gi0/2")!;
    expect(wan.egress.snapshot().dropsByReason["policer-exceed"]).toBeGreaterThan(0);
  });
});

describe("weighted scheduling", () => {
  it("keeps ordering inside one class and stays deterministic between classes", () => {
    const run = () => {
      const { engine, voice, bulk, router, arrivals } = lab({ wanCapacityBps: 1_000_000 });
      router.defineQosClassMap({
        id: "GOLD",
        matchType: "match-any",
        matches: [{ kind: "source-prefix", ipv4: { kind: "network", address: "10.0.0.0", wildcard: "0.0.0.255" } }],
      });
      router.defineQosPolicyMap({
        id: "WEIGHTED",
        classes: [
          { className: "GOLD", bandwidthPercent: 70 },
          { className: QOS_CLASS_DEFAULT, bandwidthPercent: 30 },
        ],
      });
      router.applyServicePolicy("Gi0/2", "output", "WEIGHTED");
      for (let index = 0; index < 5; index++) {
        udp(voice, "10.0.2.10", 9000, 1_400, `gold${index}`);
        udp(bulk, "10.0.2.10", 9000, 1_400, `best${index}`);
      }
      engine.runUntilIdle();
      return arrivals.filter((marker) => marker.length > 0);
    };
    const first = run();
    expect(first).toEqual(run());
    expect(first.filter((marker) => marker.startsWith("gold")))
      .toEqual(["gold0", "gold1", "gold2", "gold3", "gold4"]);
    expect(first.filter((marker) => marker.startsWith("best")))
      .toEqual(["best0", "best1", "best2", "best3", "best4"]);
    expect(first.filter((marker) => marker.startsWith("gold")).length).toBe(5);
  });

  it("is work-conserving when the other class is empty", () => {
    const { engine, voice, router, arrivals } = lab({ wanCapacityBps: 1_000_000 });
    router.defineQosClassMap({
      id: "GOLD",
      matchType: "match-any",
      matches: [{ kind: "source-prefix", ipv4: { kind: "network", address: "10.0.0.0", wildcard: "0.0.0.255" } }],
    });
    router.defineQosPolicyMap({
      id: "WEIGHTED",
      classes: [
        { className: "GOLD", bandwidthPercent: 10 },
        { className: QOS_CLASS_DEFAULT, bandwidthPercent: 90 },
      ],
    });
    router.applyServicePolicy("Gi0/2", "output", "WEIGHTED");
    for (let index = 0; index < 4; index++) udp(voice, "10.0.2.10", 9000, 1_400, `gold${index}`);
    engine.runUntilIdle();
    // A 10% class still drains fully when nothing competes with it.
    expect(arrivals.filter((marker) => marker.startsWith("gold"))).toHaveLength(4);
  });
});

describe("policing", () => {
  it("transmits conforming traffic and drops the excess", () => {
    const { engine, voice, router, arrivals } = lab({ wanCapacityBps: 100_000_000 });
    router.defineQosClassMap({ id: "GUEST", matchType: "match-any", matches: [{ kind: "any" }] });
    router.defineQosPolicyMap({
      id: "GUEST-POLICE",
      classes: [{
        className: "GUEST",
        police: { rateBps: 64_000, burstBytes: 3_000, exceedAction: "drop" },
      }],
    });
    router.applyServicePolicy("Gi0/0", "input", "GUEST-POLICE");
    for (let index = 0; index < 12; index++) udp(voice, "10.0.2.10", 9000, 1_400, `g${index}`);
    engine.runUntilIdle();

    const conform = engine.traceLog.filter((entry) => entry.type === "qos-police-conform").length;
    const dropped = engine.traceLog.filter((entry) => entry.type === "qos-police-dropped").length;
    expect(conform).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
    expect(conform + dropped).toBe(12);
    expect(arrivals.filter((marker) => marker.startsWith("g"))).toHaveLength(conform);
    expect(router.qosCounters().find((row) => row.className === "GUEST")?.droppedPackets).toBe(dropped);
  });

  it("marks exceeding traffic down instead of dropping it when asked to", () => {
    const { engine, voice, router, arrivals } = lab({ wanCapacityBps: 100_000_000 });
    router.defineQosClassMap({ id: "GUEST", matchType: "match-any", matches: [{ kind: "any" }] });
    router.defineQosPolicyMap({
      id: "GUEST-REMARK",
      classes: [{
        className: "GUEST",
        marking: { dscp: 26 },
        police: { rateBps: 64_000, burstBytes: 3_000, exceedAction: "set-dscp-transmit", exceedDscp: 8 },
      }],
    });
    router.applyServicePolicy("Gi0/0", "input", "GUEST-REMARK");
    for (let index = 0; index < 10; index++) udp(voice, "10.0.2.10", 9000, 1_400, `g${index}`);
    engine.runUntilIdle();
    const marks = engine.traceLog
      .filter((entry) => entry.type === "qos-marked")
      .map((entry) => entry.detail?.dscpAfter);
    expect(marks).toContain(26);
    expect(marks).toContain(8);
    expect(engine.traceLog.some((entry) => entry.type === "qos-police-dropped")).toBe(false);
  });

  it("never delays a packet it lets through", () => {
    const { engine, voice, router, arrivals } = lab({ wanCapacityBps: 100_000_000 });
    router.defineQosClassMap({ id: "ANY", matchType: "match-any", matches: [{ kind: "any" }] });
    router.defineQosPolicyMap({
      id: "P",
      classes: [{ className: "ANY", police: { rateBps: 10_000_000, burstBytes: 100_000, exceedAction: "drop" } }],
    });
    router.applyServicePolicy("Gi0/0", "input", "P");
    udp(voice, "10.0.2.10", 9000, 200, "one");
    engine.runUntilIdle();
    expect(engine.traceLog.some((entry) => entry.type === "qos-shape-delayed")).toBe(false);
  });
});

describe("shaping", () => {
  it("delays traffic but does not drop it while the queue has room", () => {
    const { engine, bulk, router, arrivals } = lab({ wanCapacityBps: 100_000_000, queueLimitPackets: 256 });
    router.defineQosPolicyMap({
      id: "WAN-SHAPE",
      classes: [{ className: QOS_CLASS_DEFAULT, shape: { averageRateBps: 512_000, burstBytes: 2_000 } }],
    });
    router.applyServicePolicy("Gi0/2", "output", "WAN-SHAPE");
    for (let index = 0; index < 8; index++) udp(bulk, "10.0.2.10", 9000, 1_400, `s${index}`);
    engine.runUntilIdle();

    expect(engine.traceLog.some((entry) => entry.type === "qos-shape-delayed")).toBe(true);
    expect(engine.traceLog.some((entry) => entry.type === "qos-shape-released")).toBe(true);
    const markers = arrivals.filter((marker) => marker.startsWith("s"));
    expect(markers).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    const wan = router.getInterface("Gi0/2")!;
    expect(wan.egress.snapshot().droppedPackets).toBe(0);
    expect(wan.egress.snapshot().maximumWaitingTimeNs).toBeGreaterThan(0);
  });

  it("completes a bounded flow instead of hanging", () => {
    const { engine, bulk, router, arrivals } = lab({ wanCapacityBps: 100_000_000 });
    router.defineQosPolicyMap({
      id: "WAN-SHAPE",
      classes: [{ className: QOS_CLASS_DEFAULT, shape: { averageRateBps: 256_000, burstBytes: 1_500 } }],
    });
    router.applyServicePolicy("Gi0/2", "output", "WAN-SHAPE");
    for (let index = 0; index < 5; index++) udp(bulk, "10.0.2.10", 9000, 1_400, `s${index}`);
    const processed = engine.runUntilIdle();
    expect(processed).toBeGreaterThan(0);
    expect(engine.pendingEventCount()).toBe(0);
    expect(arrivals.filter((marker) => marker.startsWith("s"))).toHaveLength(5);
  });
});

describe("queue drops", () => {
  it("separates tail drop from policer drop in the interface counters", () => {
    const { engine, bulk, router, arrivals } = lab({ wanCapacityBps: 64_000, queueLimitPackets: 2 });
    router.defineQosPolicyMap({ id: "PLAIN", classes: [{ className: QOS_CLASS_DEFAULT }] });
    router.applyServicePolicy("Gi0/2", "output", "PLAIN");
    for (let index = 0; index < 10; index++) udp(bulk, "10.0.2.10", 9000, 1_400, `s${index}`);
    engine.runUntilIdle();
    const snapshot = router.getInterface("Gi0/2")!.egress.snapshot();
    expect(snapshot.dropsByReason["tail-drop"]).toBeGreaterThan(0);
    expect(snapshot.dropsByReason["policer-exceed"]).toBeUndefined();
    expect(engine.traceLog.some((entry) => entry.type === "qos-queue-dropped")).toBe(true);
  });

  it("exposes per-class queue depth and counters", () => {
    const { engine, voice, bulk, router, arrivals } = lab({ wanCapacityBps: 1_000_000 });
    router.defineQosClassMap({
      id: "GOLD",
      matchType: "match-any",
      matches: [{ kind: "source-prefix", ipv4: { kind: "network", address: "10.0.0.0", wildcard: "0.0.0.255" } }],
    });
    router.defineQosPolicyMap({
      id: "WEIGHTED",
      classes: [{ className: "GOLD", bandwidthPercent: 60 }, { className: QOS_CLASS_DEFAULT, bandwidthPercent: 40 }],
    });
    router.applyServicePolicy("Gi0/2", "output", "WEIGHTED");
    for (let index = 0; index < 3; index++) {
      udp(voice, "10.0.2.10", 9000, 1_400, `gold${index}`);
      udp(bulk, "10.0.2.10", 9000, 1_400, `best${index}`);
    }
    engine.runUntilIdle();
    const classes = router.getInterface("Gi0/2")!.egress.snapshot().classes;
    expect(classes.map((entry) => entry.className)).toEqual(["GOLD", QOS_CLASS_DEFAULT]);
    expect(classes.every((entry) => entry.dequeuedPackets > 0)).toBe(true);
    expect(classes.every((entry) => entry.depthPackets === 0)).toBe(true);
  });
});

describe("Step execution visibility", () => {
  it("exposes every QoS stage in the trace of a single operation", () => {
    const { engine, voice, router, arrivals } = lab({ wanCapacityBps: 1_000_000 });
    router.defineQosClassMap({
      id: "REALTIME",
      matchType: "match-any",
      matches: [{ kind: "destination-port", port: { kind: "eq", port: 5060 } }],
    });
    router.defineQosPolicyMap({
      id: "STAGES",
      classes: [
        {
          className: "REALTIME",
          priority: { percent: 30 },
          marking: { dscp: 46 },
          police: { rateBps: 8_000_000, burstBytes: 100_000, exceedAction: "drop" },
        },
        { className: QOS_CLASS_DEFAULT, shape: { averageRateBps: 512_000, burstBytes: 1_500 } },
      ],
    });
    router.applyServicePolicy("Gi0/2", "output", "STAGES");
    udp(voice, "10.0.2.10", 5060, 200, "voice");
    engine.runUntilIdle();
    const types = new Set(engine.traceLog.map((entry) => entry.type));
    for (const expected of [
      "qos-classified",
      "qos-marked",
      "qos-policy-applied",
      "qos-police-conform",
      "packet-enqueued",
      "qos-queue-selected",
      "qos-priority-served",
      "packet-serialization-started",
      "packet-serialization-completed",
      "packet-dequeued",
    ]) {
      expect(types.has(expected), `missing trace ${expected}`).toBe(true);
    }
  });
});

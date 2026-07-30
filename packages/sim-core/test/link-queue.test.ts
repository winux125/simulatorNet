import { EtherType } from "@sim/contracts";
import {
  DEFAULT_LINK_CAPACITY_BPS,
  DEFAULT_LINK_QUEUE_LIMIT_PACKETS,
  Device,
  LINK_PERFORMANCE_LIMITS,
  LinkPerformanceError,
  NS_PER_MS,
  WIRE_SIZE_MODEL,
  createSimulationEngine,
  estimatePacketWireSizeBytes,
  macFromIndex,
  normalizeLinkPerformance,
  serializationDelayNs,
  type EthernetFrame,
  type EthernetInterface,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

class Probe extends Device {
  readonly deviceType = "pc" as const;
  readonly received: Array<{ frame: EthernetFrame; atNs: number }> = [];

  override onReceive(frame: EthernetFrame, _ingress: EthernetInterface): void {
    this.received.push({ frame, atNs: this.engine.now() });
  }
}

function udpFrame(payloadBytes: number, marker: string): EthernetFrame {
  return {
    src: macFromIndex(1),
    dst: macFromIndex(2),
    etherType: EtherType.IPv4,
    payload: {
      kind: "ipv4",
      src: "10.0.0.1",
      dst: "10.0.0.2",
      protocol: 17,
      ttl: 64,
      payload: {
        kind: "udp",
        srcPort: 4000,
        dstPort: 5000,
        payload: { kind: "udp-application", protocol: marker, data: marker, payloadBytes },
      },
    },
  };
}

function setup(performance?: { capacityBps?: number; propagationDelayNs?: number; queueLimitPackets?: number }) {
  const engine = createSimulationEngine({ seed: 7 });
  const left = engine.add(new Probe("left", "Left"));
  const right = engine.add(new Probe("right", "Right"));
  left.addInterface("eth0", macFromIndex(1));
  right.addInterface("eth0", macFromIndex(2));
  const link = engine.connect("left", "eth0", "right", "eth0", {
    propagationDelayNs: 0,
    ...performance,
  });
  engine.enableTrace();
  return { engine, left, right, link, out: left.getInterface("eth0")! };
}

describe("deterministic wire-size estimate", () => {
  it.each([
    ["explicit UDP payload", 500, 500 + WIRE_SIZE_MODEL.udpHeaderBytes + WIRE_SIZE_MODEL.ipv4HeaderBytes + 18],
    ["small UDP payload padded to the minimum frame", 1, WIRE_SIZE_MODEL.minimumFrameBytes],
  ])("%s", (_label, payloadBytes, expected) => {
    expect(estimatePacketWireSizeBytes(udpFrame(payloadBytes, "x"))).toBe(expected);
  });

  it("adds one 802.1Q tag for a tagged frame", () => {
    const untagged = udpFrame(500, "x");
    const tagged: EthernetFrame = { ...untagged, vlan: 10 };
    expect(estimatePacketWireSizeBytes(tagged) - estimatePacketWireSizeBytes(untagged))
      .toBe(WIRE_SIZE_MODEL.vlanTagBytes);
  });

  it("never reports a size outside the bounded model", () => {
    const huge = udpFrame(10 * WIRE_SIZE_MODEL.maximumFrameBytes, "x");
    expect(estimatePacketWireSizeBytes(huge)).toBe(WIRE_SIZE_MODEL.maximumFrameBytes);
  });
});

describe("serialization delay", () => {
  it.each([
    [1_500, 100_000_000, 120_000],
    [64, 10_000_000, 51_200],
    [1_500, 1_000_000_000, 12_000],
  ])("clocks %i bytes at %i bps in %i ns", (bytes, capacityBps, expected) => {
    expect(serializationDelayNs(bytes, capacityBps)).toBe(expected);
  });

  it("never returns zero, a negative value, or NaN", () => {
    expect(serializationDelayNs(0, DEFAULT_LINK_CAPACITY_BPS))
      .toBe(LINK_PERFORMANCE_LIMITS.minimumSerializationNs);
    expect(serializationDelayNs(1, LINK_PERFORMANCE_LIMITS.maximumCapacityBps))
      .toBeGreaterThanOrEqual(LINK_PERFORMANCE_LIMITS.minimumSerializationNs);
    expect(Number.isFinite(serializationDelayNs(WIRE_SIZE_MODEL.maximumFrameBytes, 1_000))).toBe(true);
  });
});

describe("link performance configuration", () => {
  it("defaults to a documented 100 Mbps, 256-packet cable", () => {
    const normalized = normalizeLinkPerformance(undefined);
    expect(normalized.capacityBps).toBe(DEFAULT_LINK_CAPACITY_BPS);
    expect(normalized.queueLimitPackets).toBe(DEFAULT_LINK_QUEUE_LIMIT_PACKETS);
  });

  it.each([
    ["capacity below the minimum", { capacityBps: 1 }],
    ["capacity above the maximum", { capacityBps: LINK_PERFORMANCE_LIMITS.maximumCapacityBps + 1 }],
    ["fractional capacity", { capacityBps: 1_000.5 }],
    ["negative propagation delay", { propagationDelayNs: -1 }],
    ["queue limit of zero", { queueLimitPackets: 0 }],
    ["queue limit above the maximum", { queueLimitPackets: LINK_PERFORMANCE_LIMITS.maximumQueueLimitPackets + 1 }],
  ])("rejects %s", (_label, input) => {
    expect(() => normalizeLinkPerformance(input)).toThrow(LinkPerformanceError);
  });
});

describe("egress queue", () => {
  it("delays delivery by serialization plus propagation", () => {
    const { engine, right, out } = setup({ capacityBps: 10_000_000, propagationDelayNs: NS_PER_MS });
    const frame = udpFrame(1_000, "a");
    const expectedSerialization = serializationDelayNs(estimatePacketWireSizeBytes(frame), 10_000_000);
    out.transmit(frame);
    engine.runUntilIdle();
    expect(right.received).toHaveLength(1);
    expect(right.received[0]!.atNs).toBe(expectedSerialization + NS_PER_MS);
  });

  it("serializes queued packets one at a time and preserves FIFO order", () => {
    const { engine, right, out } = setup({ capacityBps: 1_000_000 });
    for (const marker of ["a", "b", "c"]) out.transmit(udpFrame(1_000, marker));
    engine.runUntilIdle();
    const markers = right.received.map((entry) =>
      (entry.frame.payload as { payload: { payload: { protocol: string } } }).payload.payload.protocol);
    expect(markers).toEqual(["a", "b", "c"]);
    const arrivals = right.received.map((entry) => entry.atNs);
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThan(0);
    expect(arrivals[2]! - arrivals[1]!).toBe(arrivals[1]! - arrivals[0]!);
  });

  it("tail-drops beyond the configured queue limit and counts the drop", () => {
    const { engine, right, out } = setup({ capacityBps: 1_000_000, queueLimitPackets: 2 });
    for (let index = 0; index < 6; index++) out.transmit(udpFrame(1_000, `p${index}`));
    engine.runUntilIdle();
    // One packet is already serializing, two more fit in the queue.
    expect(right.received).toHaveLength(3);
    const snapshot = out.egress.snapshot();
    expect(snapshot.droppedPackets).toBe(3);
    expect(snapshot.dropsByReason["tail-drop"]).toBe(3);
    expect(engine.traceLog.filter((entry) => entry.type === "packet-tail-dropped")).toHaveLength(3);
  });

  it("emits the queue trace vocabulary without payload bodies", () => {
    const { engine, out } = setup({ capacityBps: 1_000_000 });
    out.transmit(udpFrame(1_000, "a"));
    engine.runUntilIdle();
    const types = engine.traceLog.map((entry) => entry.type);
    expect(types).toContain("packet-enqueued");
    expect(types).toContain("packet-dequeued");
    expect(types).toContain("packet-serialization-started");
    expect(types).toContain("packet-serialization-completed");
    for (const entry of engine.traceLog) {
      expect(JSON.stringify(entry.detail ?? {})).not.toContain("payload");
    }
  });

  it("keeps the two directions of a full-duplex link independent", () => {
    const { engine, left, right, out } = setup({ capacityBps: 1_000_000 });
    const back = right.getInterface("eth0")!;
    for (let index = 0; index < 4; index++) out.transmit(udpFrame(1_400, `fwd${index}`));
    back.transmit({ ...udpFrame(64, "rev"), src: macFromIndex(2), dst: macFromIndex(1) });
    engine.runUntilIdle();
    expect(left.received).toHaveLength(1);
    expect(right.received).toHaveLength(4);
    // The single reverse packet is not held behind the four forward packets.
    expect(left.received[0]!.atNs).toBeLessThan(right.received[3]!.atNs);
  });

  it("drops queued packets when the interface is shut down", () => {
    const { engine, right, out } = setup({ capacityBps: 1_000_000 });
    for (let index = 0; index < 5; index++) out.transmit(udpFrame(1_400, `p${index}`));
    expect(out.egress.depthPackets).toBeGreaterThan(0);
    out.shutdown();
    engine.runUntilIdle();
    expect(out.egress.depthPackets).toBe(0);
    expect(right.received).toHaveLength(0);
    expect(out.egress.snapshot().dropsByReason["interface-down"]).toBeGreaterThan(0);
    expect(engine.traceLog.some((entry) => entry.type === "queue-cleared")).toBe(true);
  });

  it("drops queued packets when the link is removed", () => {
    const { engine, link, right, out } = setup({ capacityBps: 1_000_000 });
    for (let index = 0; index < 5; index++) out.transmit(udpFrame(1_400, `p${index}`));
    engine.disconnect(link);
    engine.runUntilIdle();
    expect(right.received).toHaveLength(0);
    expect(out.egress.snapshot().dropsByReason["link-removed"]).toBeGreaterThan(0);
  });

  it("applies a live capacity change to the next packet only", () => {
    const { engine, link, right, out } = setup({ capacityBps: 1_000_000 });
    out.transmit(udpFrame(1_000, "slow"));
    link.configurePerformance({ capacityBps: 100_000_000 });
    out.transmit(udpFrame(1_000, "fast"));
    engine.runUntilIdle();
    const [first, second] = right.received;
    const slowSerialization = serializationDelayNs(estimatePacketWireSizeBytes(udpFrame(1_000, "slow")), 1_000_000);
    const fastSerialization = serializationDelayNs(estimatePacketWireSizeBytes(udpFrame(1_000, "fast")), 100_000_000);
    expect(first!.atNs).toBe(slowSerialization);
    expect(second!.atNs - first!.atNs).toBe(fastSerialization);
  });

  it("produces an identical queue trace for identical input", () => {
    const run = () => {
      const { engine, out } = setup({ capacityBps: 1_000_000, queueLimitPackets: 3 });
      for (let index = 0; index < 8; index++) out.transmit(udpFrame(1_000, `p${index}`));
      engine.runUntilIdle();
      return engine.traceLog;
    };
    expect(run()).toEqual(run());
  });
});

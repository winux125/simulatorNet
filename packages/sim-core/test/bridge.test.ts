import {
  Device,
  EthernetBridge,
  NS_PER_MS,
  createSimulationEngine,
  macFromIndex,
  type EthernetFrame,
  type EthernetInterface,
} from "@sim/sim-core";
import { EtherType } from "@sim/contracts";
import { describe, expect, it } from "vitest";

class Probe extends Device {
  readonly deviceType = "pc" as const;
  readonly frames: EthernetFrame[] = [];
  override onReceive(frame: EthernetFrame, _ingress: EthernetInterface): void { this.frames.push(frame); }
}

function testFrame(src: string, dst: string): EthernetFrame {
  return {
    src,
    dst,
    etherType: EtherType.ARP,
    payload: { kind: "arp", op: 1, senderMac: src, senderIp: "10.0.0.1", targetMac: dst, targetIp: "10.0.0.2" },
  };
}

// Aging times are expressed well above the link serialization delay a frame now
// pays, so these tests still measure MAC aging rather than queue timing.
function setup(agingTimeNs = 100 * NS_PER_MS) {
  const engine = createSimulationEngine({ seed: 20, linkDelayNs: 1 });
  const bridge = engine.add(new EthernetBridge("br", "Bridge", agingTimeNs));
  const left = engine.add(new Probe("left", "Left"));
  const right = engine.add(new Probe("right", "Right"));
  left.addInterface("eth0", macFromIndex(1));
  right.addInterface("eth0", macFromIndex(2));
  bridge.addInterface("Eth0/1", macFromIndex(101));
  bridge.addInterface("Eth0/2", macFromIndex(102));
  engine.connect("left", "eth0", "br", "Eth0/1");
  engine.connect("right", "eth0", "br", "Eth0/2");
  return { engine, bridge, left, right };
}

describe("learning bridge", () => {
  it("learns source MACs, floods unknown/broadcast, and forwards known unicast", () => {
    const { engine, bridge, left, right } = setup();
    engine.enableTrace();
    left.getInterface("eth0")!.transmit(testFrame(left.getInterface("eth0")!.mac, "02:00:00:00:00:99"));
    engine.runUntilIdle();
    expect(right.frames).toHaveLength(1);
    expect(bridge.macAddressTable()).toEqual([expect.objectContaining({ port: "Eth0/1" })]);

    right.getInterface("eth0")!.transmit(testFrame(right.getInterface("eth0")!.mac, left.getInterface("eth0")!.mac));
    engine.runUntilIdle();
    expect(left.frames).toHaveLength(1);
    expect(engine.traceLog.some((entry) => entry.type === "bridge-forward")).toBe(true);
  });

  it("filters a known destination learned on the ingress side", () => {
    const { engine, bridge, left, right } = setup();
    engine.enableTrace();
    const leftMac = left.getInterface("eth0")!.mac;
    left.getInterface("eth0")!.transmit(testFrame(leftMac, "ff:ff:ff:ff:ff:ff"));
    engine.runUntilIdle();
    right.frames.length = 0;
    left.getInterface("eth0")!.transmit(testFrame("02:00:00:00:00:77", leftMac));
    engine.runUntilIdle();
    expect(right.frames).toHaveLength(0);
    expect(engine.traceLog.some((entry) => entry.type === "bridge-filter")).toBe(true);
  });

  it("ages learned entries exclusively through virtual time", () => {
    const { engine, bridge, left } = setup(50 * NS_PER_MS);
    left.getInterface("eth0")!.transmit(testFrame(left.getInterface("eth0")!.mac, "ff:ff:ff:ff:ff:ff"));
    engine.runUntilIdle();
    expect(bridge.macAddressTable()).toHaveLength(1);
    engine.advanceTo(engine.now() + 50 * NS_PER_MS);
    expect(bridge.macAddressTable()).toHaveLength(0);
  });

  it("produces an identical golden trace for identical input", () => {
    const run = () => {
      const { engine, left } = setup();
      engine.enableTrace();
      left.getInterface("eth0")!.transmit(testFrame(left.getInterface("eth0")!.mac, "ff:ff:ff:ff:ff:ff"));
      engine.runUntilIdle();
      return engine.traceLog;
    };
    expect(run()).toEqual(run());
  });
});

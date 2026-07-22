import {
  Device,
  FrameTraversalLimitError,
  Hub,
  Pc,
  createSimulationEngine,
  macFromIndex,
  type EthernetFrame,
  type EthernetInterface,
} from "@sim/sim-core";
import { EtherType } from "@sim/contracts";
import { describe, expect, it } from "vitest";

class Probe extends Device {
  readonly deviceType = "pc" as const;
  readonly received: Array<{ frame: EthernetFrame; ingress: string }> = [];
  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    this.received.push({ frame, ingress: ingress.name });
  }
}

function frame(dst = "02:00:00:00:00:99"): EthernetFrame {
  return {
    src: "02:00:00:00:00:01",
    dst,
    etherType: EtherType.ARP,
    payload: {
      kind: "arp",
      op: 1,
      senderMac: "02:00:00:00:00:01",
      senderIp: "192.168.1.1",
      targetMac: "00:00:00:00:00:00",
      targetIp: "192.168.1.2",
    },
  };
}

function hubWithProbes() {
  const engine = createSimulationEngine({ seed: 10 });
  const hub = engine.add(new Hub("hub", "Hub"));
  const probes = [1, 2, 3].map((index) => {
    const probe = engine.add(new Probe(`p${index}`, `P${index}`));
    probe.addInterface("eth0", macFromIndex(index));
    hub.addInterface(`Eth0/${index}`, macFromIndex(100 + index));
    engine.connect(probe.id, "eth0", hub.id, `Eth0/${index}`);
    return probe;
  });
  return { engine, hub, probes };
}

describe("Ethernet hub", () => {
  it("repeats broadcast and unicast unchanged to every other active port", () => {
    for (const destination of ["ff:ff:ff:ff:ff:ff", "02:00:00:00:00:99"]) {
      const { engine, hub, probes } = hubWithProbes();
      engine.enableTrace();
      const sent = frame(destination);
      probes[0]!.getInterface("eth0")!.transmit(sent);
      engine.runUntilIdle();
      expect(probes[0]!.received).toHaveLength(0);
      expect(probes[1]!.received[0]!.frame).toMatchObject(sent);
      expect(probes[2]!.received[0]!.frame).toMatchObject(sent);
      expect(hub.repeatedFrameCount).toBe(2);
      expect(engine.traceLog.filter((entry) => entry.type === "hub-frame-repeated")).toHaveLength(2);
      expect("macTable" in hub).toBe(false);
    }
  });

  it("skips shutdown egress ports and reports the drop reason", () => {
    const { engine, hub, probes } = hubWithProbes();
    engine.enableTrace();
    hub.getInterface("Eth0/3")!.shutdown();
    probes[0]!.getInterface("eth0")!.transmit(frame());
    engine.runUntilIdle();
    expect(probes[1]!.received).toHaveLength(1);
    expect(probes[2]!.received).toHaveLength(0);
    expect(engine.traceLog).toContainEqual(expect.objectContaining({
      type: "hub-frame-dropped",
      detail: expect.objectContaining({ reason: "egress-interface-down" }),
    }));
  });

  it("allows two PCs to complete ARP and ping through a repeater", () => {
    const engine = createSimulationEngine({ seed: 11 });
    const hub = engine.add(new Hub("hub", "Hub"));
    const pc1 = engine.add(new Pc("pc1", "PC1"));
    const pc2 = engine.add(new Pc("pc2", "PC2"));
    for (const [index, pc] of [pc1, pc2].entries()) {
      pc.addInterface("eth0", macFromIndex(index + 1));
      pc.configure({ ip: `192.168.1.${index + 10}`, mask: 24 });
      hub.addInterface(`Eth0/${index + 1}`, macFromIndex(index + 101));
      engine.connect(pc.id, "eth0", hub.id, `Eth0/${index + 1}`);
    }
    pc1.ping("192.168.1.11", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults).toEqual([expect.objectContaining({ sequence: 1, success: true })]);
  });

  it("terminates a physical hub loop with a typed traversal-limit error", () => {
    const engine = createSimulationEngine({ seed: 12, linkDelayNs: 1 });
    const hubs = ["a", "b", "c"].map((id) => engine.add(new Hub(id, id.toUpperCase())));
    for (const hub of hubs) {
      for (let index = 1; index <= 3; index++) hub.addInterface(`Eth0/${index}`, macFromIndex(200 + hub.id.charCodeAt(0) + index));
    }
    engine.connect("a", "Eth0/1", "b", "Eth0/1");
    engine.connect("b", "Eth0/2", "c", "Eth0/1");
    engine.connect("c", "Eth0/2", "a", "Eth0/2");
    const source = engine.add(new Probe("source", "Source"));
    source.addInterface("eth0", macFromIndex(1));
    engine.connect("source", "eth0", "a", "Eth0/3");
    source.getInterface("eth0")!.transmit(frame("ff:ff:ff:ff:ff:ff"));
    expect(() => engine.runUntilIdle(10_000)).toThrow(FrameTraversalLimitError);
    expect(engine.pendingEventCount()).toBeLessThan(10_000);
  });
});

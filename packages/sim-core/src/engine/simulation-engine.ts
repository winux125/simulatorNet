import type { Device } from "../devices/device";
import { Link } from "../net/link";
import type { LinkPerformanceConfiguration, LinkPerformanceInput } from "../net/link-performance";
import { AclRuleBudget } from "../policy/packet-policy-engine";
import { ControlProtocolBudget } from "../protocols/limits";
import { QosOperationBudget } from "../qos/limits";
import { VpnTunnelBudget } from "../vpn/limits";
import { DEFAULT_LINK_DELAY_NS } from "./constants";
import { EventQueue } from "./event-queue";
import { SeededRandom } from "./seeded-random";
import { VirtualClock } from "./virtual-clock";
import { WirelessMedium } from "../wireless/wireless-medium";
import { isWirelessInterface } from "../net/wireless-interface";

/** A structured record of something the engine did, for golden/determinism tests. */
export interface TraceEntry {
  readonly time: number;
  readonly type: string;
  readonly device: string;
  readonly detail?: Record<string, unknown>;
}

export interface EngineOptions {
  seed: number;
  /** Override the default per-link propagation delay. */
  linkDelayNs?: number;
}

/**
 * The deterministic discrete-event simulation engine. Owns simulated time, the
 * event queue, the seeded PRNG, and the set of devices and links. Given the
 * same topology, configuration, seed and inputs it always produces the same
 * result — the property the server verifier relies on.
 */
export class SimulationEngine {
  readonly rng: SeededRandom;
  readonly defaultLinkDelayNs: number;
  readonly devices = new Map<string, Device>();
  readonly links: Link[] = [];
  readonly traceLog: TraceEntry[] = [];
  /** Shared 2,048-rule ACL budget across every routed device in this lab. */
  readonly aclRuleBudget = new AclRuleBudget();
  /** Shared per-operation event budget for STP, EtherChannel, discovery, OSPF. */
  readonly controlProtocolBudget = new ControlProtocolBudget();
  /** Shared per-operation QoS classification/marking/queue-event budget. */
  readonly qosBudget = new QosOperationBudget();
  /** Shared bound on how many logical tunnel interfaces one lab may describe. */
  readonly vpnTunnelBudget = new VpnTunnelBudget();
  /** Lab-scoped radio medium; it never derives reachability from canvas coordinates. */
  readonly wireless: WirelessMedium;

  private readonly clock = new VirtualClock();
  private readonly queue = new EventQueue();
  private tracing = false;
  private traceLimit = Number.POSITIVE_INFINITY;

  constructor(options: EngineOptions) {
    this.rng = new SeededRandom(options.seed);
    this.defaultLinkDelayNs = options.linkDelayNs ?? DEFAULT_LINK_DELAY_NS;
    this.wireless = new WirelessMedium(this);
  }

  now(): number {
    return this.clock.now();
  }

  add<T extends Device>(device: T): T {
    if (this.devices.has(device.id)) {
      throw new Error(`Device ${device.id} already added`);
    }
    device.engine = this;
    device.onAddedToEngine();
    this.devices.set(device.id, device);
    return device;
  }

  getDevice(id: string): Device | undefined {
    return this.devices.get(id);
  }

  /**
   * Cable two interfaces together. `performance` may be a plain propagation
   * delay in nanoseconds (the pre-M10.8 form) or a structured link performance
   * description with capacity and queue depth.
   */
  connect(
    aDevice: string,
    aIface: string,
    bDevice: string,
    bIface: string,
    performance?: number | LinkPerformanceInput,
  ): Link {
    const a = this.requireInterface(aDevice, aIface);
    const b = this.requireInterface(bDevice, bIface);
    if (isWirelessInterface(a) || isWirelessInterface(b)) {
      throw new Error("Wireless interfaces associate through WirelessMedium and cannot be cabled.");
    }
    if (a.link || b.link) throw new Error("Interface already connected");
    const supplied: LinkPerformanceInput = typeof performance === "number"
      ? { propagationDelayNs: performance }
      : performance ?? {};
    const link = new Link(a, b, {
      ...supplied,
      propagationDelayNs: supplied.propagationDelayNs ?? this.defaultLinkDelayNs,
    });
    a.link = link;
    b.link = link;
    this.links.push(link);
    // Cabling changes both ports' operational state, which arms control protocols.
    a.notifyStateChanged();
    return link;
  }

  /** Find the cable joining two ports, if any. */
  findLink(deviceId: string, interfaceName: string): Link | undefined {
    return this.links.find((link) =>
      (link.a.device.id === deviceId && link.a.name === interfaceName)
      || (link.b.device.id === deviceId && link.b.name === interfaceName));
  }

  /**
   * Change a cable's capacity, propagation delay or queue depth while the lab
   * runs. Packets already serializing keep their original timing; the next
   * packet uses the new configuration.
   */
  configureLinkPerformance(
    deviceId: string,
    interfaceName: string,
    performance: LinkPerformanceInput,
  ): LinkPerformanceConfiguration {
    const link = this.findLink(deviceId, interfaceName);
    if (!link) throw new Error(`No link is attached to ${deviceId}/${interfaceName}`);
    return link.configurePerformance(performance);
  }

  /**
   * Remove a cable. Both directions release whatever they still hold: queued
   * packets are dropped with an explicit reason, never delivered afterwards.
   */
  disconnect(link: Link): void {
    const index = this.links.indexOf(link);
    if (index >= 0) this.links.splice(index, 1);
    link.a.flushEgress("link-removed");
    link.b.flushEgress("link-removed");
    link.a.link = undefined;
    link.b.link = undefined;
    link.a.notifyStateChanged();
    link.b.notifyStateChanged();
  }

  /** Drop every packet still waiting on any interface, for Stop Lab / rebuild. */
  clearEgressQueues(): number {
    let dropped = 0;
    for (const device of this.devices.values()) {
      for (const iface of device.interfaces.values()) dropped += iface.flushEgress("runtime-cleared");
    }
    return dropped;
  }

  scheduleIn(delayNs: number, run: () => void): void {
    if (delayNs < 0) throw new Error("scheduleIn: delay must be non-negative");
    this.queue.push(this.clock.now() + delayNs, run);
  }

  scheduleAt(timeNs: number, run: () => void): void {
    this.queue.push(timeNs, run);
  }

  enableTrace(maxEntries = Number.POSITIVE_INFINITY): void {
    this.tracing = true;
    this.traceLimit = Math.max(0, maxEntries);
  }

  trace(entry: TraceEntry): void {
    if (this.tracing && this.traceLog.length < this.traceLimit) this.traceLog.push(entry);
  }

  /** Scheduled virtual time of the next event, for bounded headless runners. */
  nextEventTime(): number | undefined {
    return this.queue.peekTime();
  }

  /** Number of pending deterministic events, exposed for diagnostics only. */
  pendingEventCount(): number {
    return this.queue.size;
  }

  /** Process exactly one event, returning false when the queue is empty. */
  runNextEvent(): boolean {
    const event = this.queue.pop();
    if (!event) return false;
    this.clock.set(event.time);
    event.run();
    return true;
  }

  /** Process all pending events in deterministic order until the queue drains. */
  runUntilIdle(maxEvents = 1_000_000): number {
    let processed = 0;
    for (;;) {
      const event = this.queue.pop();
      if (!event) break;
      if (processed >= maxEvents) {
        throw new Error("runUntilIdle exceeded maxEvents — possible infinite loop");
      }
      this.clock.set(event.time);
      event.run();
      processed++;
    }
    return processed;
  }

  /** Process events with time <= timeNs, then park the clock at timeNs. */
  advanceTo(timeNs: number, maxEvents = 1_000_000): number {
    let processed = 0;
    for (;;) {
      const next = this.queue.peekTime();
      if (next === undefined || next > timeNs) break;
      if (processed >= maxEvents) {
        throw new Error("advanceTo exceeded maxEvents — possible infinite loop");
      }
      const event = this.queue.pop()!;
      this.clock.set(event.time);
      event.run();
      processed++;
    }
    this.clock.set(timeNs);
    return processed;
  }

  private requireInterface(deviceId: string, ifaceName: string) {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Unknown device: ${deviceId}`);
    const iface = device.getInterface(ifaceName);
    if (!iface) throw new Error(`Unknown interface: ${deviceId}/${ifaceName}`);
    return iface;
  }
}

export function createSimulationEngine(options: EngineOptions): SimulationEngine {
  return new SimulationEngine(options);
}

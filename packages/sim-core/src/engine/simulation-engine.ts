import type { Device } from "../devices/device";
import { Link } from "../net/link";
import { AclRuleBudget } from "../policy/packet-policy-engine";
import { ControlProtocolBudget } from "../protocols/limits";
import { DEFAULT_LINK_DELAY_NS } from "./constants";
import { EventQueue } from "./event-queue";
import { SeededRandom } from "./seeded-random";
import { VirtualClock } from "./virtual-clock";
import { WirelessMedium } from "../wireless/wireless-medium";

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

  /** Cable two interfaces together. */
  connect(aDevice: string, aIface: string, bDevice: string, bIface: string, delayNs?: number): Link {
    const a = this.requireInterface(aDevice, aIface);
    const b = this.requireInterface(bDevice, bIface);
    if (a.link || b.link) throw new Error("Interface already connected");
    const link = new Link(a, b, delayNs ?? this.defaultLinkDelayNs);
    a.link = link;
    b.link = link;
    this.links.push(link);
    // Cabling changes both ports' operational state, which arms control protocols.
    a.notifyStateChanged();
    return link;
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

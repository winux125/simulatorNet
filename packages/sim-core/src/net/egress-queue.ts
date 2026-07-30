import type { EthernetFrame } from "../packets/ethernet";
import { LINK_PERFORMANCE_LIMITS } from "./link-performance";

/** Why a packet left an egress queue without being transmitted. */
export type QueueDropReason =
  | "tail-drop"
  | "queue-limit"
  | "interface-down"
  | "link-removed"
  | "runtime-cleared"
  | "resource-limit"
  | "policer-exceed"
  | "shaper-limit";

export const QUEUE_DROP_REASONS: readonly QueueDropReason[] = [
  "tail-drop",
  "queue-limit",
  "interface-down",
  "link-removed",
  "runtime-cleared",
  "resource-limit",
  "policer-exceed",
  "shaper-limit",
];

/** One packet waiting for its turn on the wire. Runtime only; never serialized. */
export interface QueuedPacket {
  readonly frame: EthernetFrame;
  readonly wireSizeBytes: number;
  readonly enqueuedAtNs: number;
  /** Monotonic per-interface arrival order; the FIFO tie-break inside a class. */
  readonly sequence: number;
  readonly className: string;
}

export interface EgressQueueClassSnapshot {
  readonly className: string;
  readonly depthPackets: number;
  readonly depthBytes: number;
  readonly limitPackets: number;
  readonly enqueuedPackets: number;
  readonly enqueuedBytes: number;
  readonly dequeuedPackets: number;
  readonly dequeuedBytes: number;
  readonly droppedPackets: number;
}

export interface EgressQueueSnapshot {
  readonly depthPackets: number;
  readonly depthBytes: number;
  readonly enqueuedPackets: number;
  readonly enqueuedBytes: number;
  readonly dequeuedPackets: number;
  readonly dequeuedBytes: number;
  readonly droppedPackets: number;
  readonly dropsByReason: Readonly<Record<string, number>>;
  readonly totalWaitingTimeNs: number;
  readonly maximumWaitingTimeNs: number;
  readonly classes: readonly EgressQueueClassSnapshot[];
}

/** The default class every packet uses until an output policy says otherwise. */
export const CLASS_DEFAULT = "class-default";

interface ClassQueue {
  readonly className: string;
  limitPackets: number;
  readonly packets: QueuedPacket[];
  depthBytes: number;
  enqueuedPackets: number;
  enqueuedBytes: number;
  dequeuedPackets: number;
  dequeuedBytes: number;
  droppedPackets: number;
}

/**
 * The deterministic output queue of one direction of one link.
 *
 * Until an output QoS policy is attached it holds exactly one FIFO class, so an
 * unconfigured lab behaves like a plain tail-drop interface. Runtime state lives
 * here and nowhere else: it is cleared on rebuild and never enters a
 * `LabDocument`, a submission, or a grading result.
 */
export class InterfaceEgressQueue {
  private readonly queues = new Map<string, ClassQueue>();
  private order: string[] = [CLASS_DEFAULT];
  private sequenceCounter = 0;
  private totalDropped = 0;
  private readonly dropsByReason = new Map<QueueDropReason, number>();
  private totalWaitingTimeNs = 0;
  private maximumWaitingTimeNs = 0;

  constructor(private defaultLimitPackets: number) {
    this.queues.set(CLASS_DEFAULT, createClassQueue(CLASS_DEFAULT, defaultLimitPackets));
  }

  get depthPackets(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.packets.length;
    return total;
  }

  get depthBytes(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.depthBytes;
    return total;
  }

  get isEmpty(): boolean {
    return this.depthPackets === 0;
  }

  /** Class names in scheduling order; always ends with `class-default`. */
  classNames(): readonly string[] {
    return [...this.order];
  }

  /** Replace the class set an output policy installed. Queued packets are kept. */
  configureClasses(classes: readonly { className: string; limitPackets?: number }[]): void {
    const requested = classes
      .map((entry) => entry.className)
      .filter((name) => name !== CLASS_DEFAULT);
    if (requested.length + 1 > LINK_PERFORMANCE_LIMITS.maximumQueuesPerInterface) {
      throw new Error(
        `Egress queue limit exceeded (${LINK_PERFORMANCE_LIMITS.maximumQueuesPerInterface} queues per interface).`,
      );
    }
    const next = [...requested, CLASS_DEFAULT];
    for (const entry of classes) {
      const limit = entry.limitPackets ?? this.defaultLimitPackets;
      const existing = this.queues.get(entry.className);
      if (existing) existing.limitPackets = limit;
      else this.queues.set(entry.className, createClassQueue(entry.className, limit));
    }
    if (!this.queues.has(CLASS_DEFAULT)) {
      this.queues.set(CLASS_DEFAULT, createClassQueue(CLASS_DEFAULT, this.defaultLimitPackets));
    }
    // Classes the new policy no longer defines release their packets explicitly.
    for (const name of [...this.queues.keys()]) {
      if (next.includes(name)) continue;
      this.queues.delete(name);
    }
    this.order = next;
  }

  /** Drop every configured class and go back to one FIFO. */
  resetClasses(): void {
    const retained = this.queues.get(CLASS_DEFAULT)
      ?? createClassQueue(CLASS_DEFAULT, this.defaultLimitPackets);
    this.queues.clear();
    this.queues.set(CLASS_DEFAULT, retained);
    this.order = [CLASS_DEFAULT];
  }

  setDefaultLimitPackets(limitPackets: number): void {
    this.defaultLimitPackets = limitPackets;
    const fallback = this.queues.get(CLASS_DEFAULT);
    if (fallback) fallback.limitPackets = limitPackets;
  }

  limitPacketsOf(className: string): number {
    return this.queues.get(className)?.limitPackets ?? this.defaultLimitPackets;
  }

  depthPacketsOf(className: string): number {
    return this.queues.get(className)?.packets.length ?? 0;
  }

  /**
   * Append a packet to its class. Returns the queued record, or `undefined` when
   * the class is already at its tail-drop limit or the interface byte ceiling is
   * reached.
   */
  enqueue(
    frame: EthernetFrame,
    wireSizeBytes: number,
    nowNs: number,
    className = CLASS_DEFAULT,
  ): QueuedPacket | undefined {
    const queue = this.queues.get(className) ?? this.queues.get(CLASS_DEFAULT)!;
    if (queue.packets.length >= queue.limitPackets) {
      this.recordDrop("tail-drop", queue);
      return undefined;
    }
    if (this.depthBytes + wireSizeBytes > LINK_PERFORMANCE_LIMITS.maximumQueuedBytesPerInterface) {
      this.recordDrop("resource-limit", queue);
      return undefined;
    }
    const queued: QueuedPacket = {
      frame,
      wireSizeBytes,
      enqueuedAtNs: nowNs,
      sequence: this.sequenceCounter++,
      className: queue.className,
    };
    queue.packets.push(queued);
    queue.depthBytes += wireSizeBytes;
    queue.enqueuedPackets++;
    queue.enqueuedBytes += wireSizeBytes;
    return queued;
  }

  /** Remove the head of one class, recording its virtual waiting time. */
  dequeueFrom(className: string, nowNs: number): QueuedPacket | undefined {
    const queue = this.queues.get(className);
    const packet = queue?.packets.shift();
    if (!queue || !packet) return undefined;
    queue.depthBytes -= packet.wireSizeBytes;
    queue.dequeuedPackets++;
    queue.dequeuedBytes += packet.wireSizeBytes;
    const waited = Math.max(0, nowNs - packet.enqueuedAtNs);
    this.totalWaitingTimeNs += waited;
    this.maximumWaitingTimeNs = Math.max(this.maximumWaitingTimeNs, waited);
    return packet;
  }

  /** Head of a class without removing it, for a scheduler's admission test. */
  peek(className: string): QueuedPacket | undefined {
    return this.queues.get(className)?.packets[0];
  }

  /** Simple FIFO order across the whole interface, used when no policy applies. */
  dequeueFifo(nowNs: number): QueuedPacket | undefined {
    let bestClass: string | undefined;
    let bestSequence = Number.POSITIVE_INFINITY;
    for (const name of this.order) {
      const head = this.queues.get(name)?.packets[0];
      if (head && head.sequence < bestSequence) {
        bestSequence = head.sequence;
        bestClass = name;
      }
    }
    return bestClass === undefined ? undefined : this.dequeueFrom(bestClass, nowNs);
  }

  /** Account a drop that happened outside the queue (policer, shaper, teardown). */
  recordExternalDrop(reason: QueueDropReason, className = CLASS_DEFAULT): void {
    this.recordDrop(reason, this.queues.get(className));
  }

  /**
   * Release everything still waiting. Queued packets are dropped, never
   * delivered late: an interface that goes down or a link that is removed must
   * not resurrect traffic after the topology changed.
   */
  clear(reason: QueueDropReason): QueuedPacket[] {
    const released: QueuedPacket[] = [];
    for (const queue of this.queues.values()) {
      for (const packet of queue.packets) {
        released.push(packet);
        this.recordDrop(reason, queue);
      }
      queue.packets.length = 0;
      queue.depthBytes = 0;
    }
    return released.sort((a, b) => a.sequence - b.sequence);
  }

  resetRuntime(): void {
    this.clear("runtime-cleared");
    this.sequenceCounter = 0;
    this.totalDropped = 0;
    this.dropsByReason.clear();
    this.totalWaitingTimeNs = 0;
    this.maximumWaitingTimeNs = 0;
    for (const queue of this.queues.values()) {
      queue.enqueuedPackets = 0;
      queue.enqueuedBytes = 0;
      queue.dequeuedPackets = 0;
      queue.dequeuedBytes = 0;
      queue.droppedPackets = 0;
    }
  }

  snapshot(): EgressQueueSnapshot {
    const dropsByReason: Record<string, number> = {};
    for (const reason of QUEUE_DROP_REASONS) {
      const count = this.dropsByReason.get(reason);
      if (count) dropsByReason[reason] = count;
    }
    let enqueuedPackets = 0;
    let enqueuedBytes = 0;
    let dequeuedPackets = 0;
    let dequeuedBytes = 0;
    const classes: EgressQueueClassSnapshot[] = this.order.map((name) => {
      const queue = this.queues.get(name)!;
      enqueuedPackets += queue.enqueuedPackets;
      enqueuedBytes += queue.enqueuedBytes;
      dequeuedPackets += queue.dequeuedPackets;
      dequeuedBytes += queue.dequeuedBytes;
      return {
        className: queue.className,
        depthPackets: queue.packets.length,
        depthBytes: queue.depthBytes,
        limitPackets: queue.limitPackets,
        enqueuedPackets: queue.enqueuedPackets,
        enqueuedBytes: queue.enqueuedBytes,
        dequeuedPackets: queue.dequeuedPackets,
        dequeuedBytes: queue.dequeuedBytes,
        droppedPackets: queue.droppedPackets,
      };
    });
    return {
      depthPackets: this.depthPackets,
      depthBytes: this.depthBytes,
      enqueuedPackets,
      enqueuedBytes,
      dequeuedPackets,
      dequeuedBytes,
      droppedPackets: this.totalDropped,
      dropsByReason,
      totalWaitingTimeNs: this.totalWaitingTimeNs,
      maximumWaitingTimeNs: this.maximumWaitingTimeNs,
      classes,
    };
  }

  private recordDrop(reason: QueueDropReason, queue: ClassQueue | undefined): void {
    this.totalDropped++;
    this.dropsByReason.set(reason, (this.dropsByReason.get(reason) ?? 0) + 1);
    if (queue) queue.droppedPackets++;
  }
}

function createClassQueue(className: string, limitPackets: number): ClassQueue {
  return {
    className,
    limitPackets,
    packets: [],
    depthBytes: 0,
    enqueuedPackets: 0,
    enqueuedBytes: 0,
    dequeuedPackets: 0,
    dequeuedBytes: 0,
    droppedPackets: 0,
  };
}

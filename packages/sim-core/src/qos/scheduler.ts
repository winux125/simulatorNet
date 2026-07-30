import type { InterfaceEgressQueue, QueuedPacket } from "../net/egress-queue";
import { CLASS_DEFAULT } from "../net/egress-queue";
import { WIRE_SIZE_MODEL } from "../net/packet-size";
import { QOS_RESOURCE_LIMITS } from "./limits";
import { defaultBurstBytes, TokenBucket } from "./token-bucket";

/**
 * Deficit round robin quantum scale.
 *
 * A class configured with `bandwidth percent N` receives `N%` of this scale as
 * its per-round quantum, floored at one maximum-size frame so a visit always
 * makes progress. That floor is why very small percentages converge to an equal
 * share rather than to starvation — an educational simplification, documented
 * in `docs/qos-simulation.md`.
 */
export const DRR_QUANTUM_SCALE_BYTES = 10 * WIRE_SIZE_MODEL.maximumFrameBytes;

export type EgressClassKind = "priority" | "bandwidth" | "default";

export interface EgressClassProfile {
  readonly className: string;
  readonly kind: EgressClassKind;
  /** Strict-priority allowance in bits per second; the built-in LLQ policer. */
  readonly priorityRateBps?: number;
  /** `bandwidth percent`; 0 means "share what is left equally". */
  readonly bandwidthPercent?: number;
  readonly shapeRateBps?: number;
  readonly shapeBurstBytes?: number;
  readonly queueLimitPackets?: number;
}

export interface EgressQueueProfile {
  readonly policyMapId: string;
  readonly interfaceName: string;
  readonly classes: readonly EgressClassProfile[];
}

export type SchedulerDecision =
  | { readonly kind: "send"; readonly packet: QueuedPacket; readonly reason: "priority" | "weighted" }
  | { readonly kind: "defer"; readonly className: string; readonly readyAtNs: number }
  | { readonly kind: "idle" };

/**
 * The deterministic egress scheduler of one interface.
 *
 * The model is fixed and documented: strict priority for `priority` classes,
 * then **deficit round robin** across the remaining classes. Class order comes
 * from the policy map, never from packet insertion order, so two engines always
 * choose the same packet. It is work-conserving except where a shaper
 * deliberately holds a class back.
 */
export class EgressScheduler {
  private profile: EgressQueueProfile | undefined;
  private readonly deficits = new Map<string, number>();
  private readonly quanta = new Map<string, number>();
  private readonly priorityBuckets = new Map<string, TokenBucket>();
  private readonly shapers = new Map<string, TokenBucket>();
  private cursor = 0;

  get activeProfile(): EgressQueueProfile | undefined {
    return this.profile;
  }

  /** Install (or clear) the queue structure an output policy map describes. */
  configure(profile: EgressQueueProfile | undefined, capacityBps: number, nowNs: number): void {
    this.profile = profile;
    this.deficits.clear();
    this.quanta.clear();
    this.priorityBuckets.clear();
    this.shapers.clear();
    this.cursor = 0;
    if (!profile) return;
    const weighted = profile.classes.filter((entry) => entry.kind !== "priority");
    const unweighted = weighted.filter((entry) => (entry.bandwidthPercent ?? 0) <= 0).length;
    const allocated = weighted.reduce((total, entry) => total + (entry.bandwidthPercent ?? 0), 0);
    const remaining = Math.max(0, QOS_RESOURCE_LIMITS.maximumBandwidthPercentTotal - allocated);
    const share = unweighted > 0 ? Math.max(1, Math.floor(remaining / unweighted)) : 0;
    for (const entry of profile.classes) {
      this.deficits.set(entry.className, 0);
      const percent = (entry.bandwidthPercent ?? 0) > 0 ? entry.bandwidthPercent! : share;
      this.quanta.set(
        entry.className,
        Math.max(
          WIRE_SIZE_MODEL.maximumFrameBytes,
          Math.round((DRR_QUANTUM_SCALE_BYTES * percent) / 100),
        ),
      );
      if (entry.kind === "priority") {
        const rateBps = entry.priorityRateBps ?? capacityBps;
        this.priorityBuckets.set(
          entry.className,
          new TokenBucket({ rateBps, burstBytes: defaultBurstBytes(rateBps) }, nowNs),
        );
      }
      if (entry.shapeRateBps !== undefined) {
        this.shapers.set(
          entry.className,
          new TokenBucket(
            {
              rateBps: entry.shapeRateBps,
              burstBytes: entry.shapeBurstBytes ?? defaultBurstBytes(entry.shapeRateBps),
            },
            nowNs,
          ),
        );
      }
    }
  }

  reset(nowNs = 0): void {
    for (const key of this.deficits.keys()) this.deficits.set(key, 0);
    for (const bucket of this.priorityBuckets.values()) bucket.reset(nowNs);
    for (const bucket of this.shapers.values()) bucket.reset(nowNs);
    this.cursor = 0;
  }

  classNames(): readonly string[] {
    return this.profile?.classes.map((entry) => entry.className) ?? [];
  }

  /**
   * The built-in priority policer. A class configured with `priority` may only
   * enqueue what its allowance covers; excess is dropped rather than allowed to
   * starve every other queue.
   */
  admits(className: string, bytes: number, nowNs: number): boolean {
    const bucket = this.priorityBuckets.get(className);
    if (!bucket) return true;
    return bucket.consume(bytes, nowNs);
  }

  /** Choose the next packet, or explain why nothing can leave yet. */
  select(queue: InterfaceEgressQueue, nowNs: number): SchedulerDecision {
    const profile = this.profile;
    if (!profile) {
      const packet = queue.dequeueFifo(nowNs);
      return packet ? { kind: "send", packet, reason: "weighted" } : { kind: "idle" };
    }
    let earliestDefer: { className: string; readyAtNs: number } | undefined;

    // 1. Strict priority, in policy order.
    for (const entry of profile.classes) {
      if (entry.kind !== "priority") continue;
      const head = queue.peek(entry.className);
      if (!head) continue;
      const shaped = this.shaperVerdict(entry.className, head, nowNs);
      if (shaped) {
        earliestDefer = earlier(earliestDefer, shaped);
        continue;
      }
      const packet = queue.dequeueFrom(entry.className, nowNs);
      if (packet) return { kind: "send", packet, reason: "priority" };
    }

    // 2. Deficit round robin over the remaining classes, from a stable cursor.
    const weighted = profile.classes.filter((entry) => entry.kind !== "priority");
    if (weighted.length === 0) {
      return earliestDefer ? { kind: "defer", ...earliestDefer } : { kind: "idle" };
    }
    for (let visit = 0; visit < weighted.length; visit++) {
      const entry = weighted[(this.cursor + visit) % weighted.length]!;
      const head = queue.peek(entry.className);
      if (!head) {
        this.deficits.set(entry.className, 0);
        continue;
      }
      const shaped = this.shaperVerdict(entry.className, head, nowNs);
      if (shaped) {
        earliestDefer = earlier(earliestDefer, shaped);
        continue;
      }
      const quantum = this.quanta.get(entry.className) ?? WIRE_SIZE_MODEL.maximumFrameBytes;
      let deficit = this.deficits.get(entry.className) ?? 0;
      if (deficit < head.wireSizeBytes) deficit += quantum;
      if (deficit < head.wireSizeBytes) {
        // The quantum floor is one maximum frame, so this cannot loop forever.
        this.deficits.set(entry.className, deficit);
        continue;
      }
      this.deficits.set(entry.className, deficit - head.wireSizeBytes);
      const packet = queue.dequeueFrom(entry.className, nowNs);
      if (!packet) continue;
      // Advance the cursor only when a class is finished with its deficit, so a
      // burst inside one class stays in order and the rotation stays fair.
      if ((this.deficits.get(entry.className) ?? 0) < (queue.peek(entry.className)?.wireSizeBytes ?? 0)) {
        this.cursor = (this.cursor + visit + 1) % weighted.length;
      } else {
        this.cursor = (this.cursor + visit) % weighted.length;
      }
      return { kind: "send", packet, reason: "weighted" };
    }
    return earliestDefer ? { kind: "defer", ...earliestDefer } : { kind: "idle" };
  }

  /** Charge a shaper for a packet the scheduler just released. */
  chargeShaper(className: string, bytes: number, nowNs: number): void {
    this.shapers.get(className)?.consume(bytes, nowNs);
  }

  hasShaper(className: string): boolean {
    return this.shapers.has(className);
  }

  private shaperVerdict(
    className: string,
    head: QueuedPacket,
    nowNs: number,
  ): { className: string; readyAtNs: number } | undefined {
    const shaper = this.shapers.get(className);
    if (!shaper) return undefined;
    if (shaper.availableBytes(nowNs) >= head.wireSizeBytes) return undefined;
    return { className, readyAtNs: shaper.readyAtNs(head.wireSizeBytes, nowNs) };
  }
}

function earlier(
  current: { className: string; readyAtNs: number } | undefined,
  candidate: { className: string; readyAtNs: number },
): { className: string; readyAtNs: number } {
  if (!current) return candidate;
  if (candidate.readyAtNs < current.readyAtNs) return candidate;
  if (candidate.readyAtNs === current.readyAtNs && candidate.className < current.className) return candidate;
  return current;
}

export { CLASS_DEFAULT };

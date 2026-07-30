import {
  DEFAULT_LINK_CAPACITY_BPS,
  DEFAULT_LINK_QUEUE_LIMIT_PACKETS,
} from "@sim/contracts";
import { DEFAULT_LINK_DELAY_NS, NS_PER_S } from "../engine/constants";

/**
 * Deterministic link performance limits. Every bound is finite so a lab can
 * never schedule an unbounded number of queue events or an unbounded delay.
 */
export const LINK_PERFORMANCE_LIMITS = Object.freeze({
  /** 1 kbps: slow enough to teach congestion, fast enough to stay bounded. */
  minimumCapacityBps: 1_000,
  /** 100 Gbps. */
  maximumCapacityBps: 100_000_000_000,
  maximumPropagationDelayNs: 60 * NS_PER_S,
  minimumQueueLimitPackets: 1,
  maximumQueueLimitPackets: 4_096,
  /** Hard ceiling on bytes a single interface may hold, whatever the class mix. */
  maximumQueuedBytesPerInterface: 8 * 1_024 * 1_024,
  /** Distinct egress queues one interface may own (class-default plus classes). */
  maximumQueuesPerInterface: 8,
  /** Serialization never takes zero virtual time, so a drain always progresses. */
  minimumSerializationNs: 1,
});

/** Re-exported so engine code has one import for every link-performance value. */
export { DEFAULT_LINK_CAPACITY_BPS, DEFAULT_LINK_QUEUE_LIMIT_PACKETS };

/**
 * The structured, serializable performance description of one physical link.
 * It is configuration, not runtime: queued packets, tokens and counters are
 * never part of it.
 */
export interface LinkPerformanceConfiguration {
  readonly capacityBps: number;
  readonly propagationDelayNs: number;
  readonly queueLimitPackets: number;
}

export type LinkPerformanceInput = Partial<LinkPerformanceConfiguration>;

export const DEFAULT_LINK_PERFORMANCE: LinkPerformanceConfiguration = Object.freeze({
  capacityBps: DEFAULT_LINK_CAPACITY_BPS,
  propagationDelayNs: DEFAULT_LINK_DELAY_NS,
  queueLimitPackets: DEFAULT_LINK_QUEUE_LIMIT_PACKETS,
});

export type LinkPerformanceErrorCode = "LINK_PERFORMANCE_INVALID_CONFIGURATION";

export class LinkPerformanceError extends Error {
  override readonly name = "LinkPerformanceError";

  constructor(
    readonly code: LinkPerformanceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function requireRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LinkPerformanceError(
      "LINK_PERFORMANCE_INVALID_CONFIGURATION",
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

/** Fill defaults and reject anything the deterministic model cannot represent. */
export function normalizeLinkPerformance(
  input: LinkPerformanceInput | undefined,
  base: LinkPerformanceConfiguration = DEFAULT_LINK_PERFORMANCE,
): LinkPerformanceConfiguration {
  const capacityBps = input?.capacityBps ?? base.capacityBps;
  const propagationDelayNs = input?.propagationDelayNs ?? base.propagationDelayNs;
  const queueLimitPackets = input?.queueLimitPackets ?? base.queueLimitPackets;
  return {
    capacityBps: requireRange(
      capacityBps,
      LINK_PERFORMANCE_LIMITS.minimumCapacityBps,
      LINK_PERFORMANCE_LIMITS.maximumCapacityBps,
      "Link capacity (bps)",
    ),
    propagationDelayNs: requireRange(
      propagationDelayNs,
      0,
      LINK_PERFORMANCE_LIMITS.maximumPropagationDelayNs,
      "Link propagation delay (ns)",
    ),
    queueLimitPackets: requireRange(
      queueLimitPackets,
      LINK_PERFORMANCE_LIMITS.minimumQueueLimitPackets,
      LINK_PERFORMANCE_LIMITS.maximumQueueLimitPackets,
      "Link queue limit (packets)",
    ),
  };
}

/**
 * How long `bytes` take to clock onto a link of `capacityBps`, in whole virtual
 * nanoseconds. Always at least one nanosecond so a bounded drain can never spin
 * at a single instant, and always finite so the event queue stays bounded.
 */
export function serializationDelayNs(bytes: number, capacityBps: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return LINK_PERFORMANCE_LIMITS.minimumSerializationNs;
  const capacity = Math.min(
    Math.max(capacityBps, LINK_PERFORMANCE_LIMITS.minimumCapacityBps),
    LINK_PERFORMANCE_LIMITS.maximumCapacityBps,
  );
  const nanoseconds = Math.ceil((bytes * 8 * NS_PER_S) / capacity);
  if (!Number.isSafeInteger(nanoseconds)) return LINK_PERFORMANCE_LIMITS.maximumPropagationDelayNs;
  return Math.max(nanoseconds, LINK_PERFORMANCE_LIMITS.minimumSerializationNs);
}

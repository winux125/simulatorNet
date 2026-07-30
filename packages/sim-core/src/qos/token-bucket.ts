import { NS_PER_S } from "../engine/constants";

export interface TokenBucketConfiguration {
  readonly rateBps: number;
  readonly burstBytes: number;
}

/**
 * A reusable deterministic token bucket.
 *
 * Tokens accrue from `VirtualClock` time only — there is no wall-clock timer, no
 * sampling and no measurement. Given the same configuration and the same
 * sequence of virtual timestamps it always reaches the same level, so a policer
 * or shaper behaves identically in the browser worker and in the verifier.
 */
export class TokenBucket {
  private levelBytes: number;
  private lastRefillNs: number;
  private configuration: TokenBucketConfiguration;

  constructor(configuration: TokenBucketConfiguration, startNs = 0) {
    this.configuration = { ...configuration };
    this.levelBytes = configuration.burstBytes;
    this.lastRefillNs = startNs;
  }

  get rateBps(): number {
    return this.configuration.rateBps;
  }

  get burstBytes(): number {
    return this.configuration.burstBytes;
  }

  /** Re-size the bucket, keeping whatever credit still fits. */
  configure(configuration: TokenBucketConfiguration, nowNs: number): void {
    this.refill(nowNs);
    this.configuration = { ...configuration };
    this.levelBytes = Math.min(this.levelBytes, configuration.burstBytes);
  }

  availableBytes(nowNs: number): number {
    this.refill(nowNs);
    return this.levelBytes;
  }

  /** Spend `bytes` when the bucket holds them; otherwise leave it untouched. */
  consume(bytes: number, nowNs: number): boolean {
    this.refill(nowNs);
    if (this.levelBytes < bytes) return false;
    this.levelBytes -= bytes;
    return true;
  }

  /**
   * The earliest virtual time at which `bytes` will be available. Always at
   * least one nanosecond in the future when the bucket is short, so a shaper
   * can never reschedule itself at the same instant forever.
   */
  readyAtNs(bytes: number, nowNs: number): number {
    this.refill(nowNs);
    if (this.levelBytes >= bytes) return nowNs;
    const needed = Math.min(bytes, this.configuration.burstBytes) - this.levelBytes;
    const waitNs = Math.ceil((needed * 8 * NS_PER_S) / this.configuration.rateBps);
    return nowNs + Math.max(1, Number.isFinite(waitNs) ? waitNs : 1);
  }

  reset(nowNs = 0): void {
    this.levelBytes = this.configuration.burstBytes;
    this.lastRefillNs = nowNs;
  }

  private refill(nowNs: number): void {
    if (nowNs <= this.lastRefillNs) return;
    const elapsedNs = nowNs - this.lastRefillNs;
    const added = (elapsedNs * this.configuration.rateBps) / (8 * NS_PER_S);
    this.levelBytes = Math.min(this.configuration.burstBytes, this.levelBytes + added);
    this.lastRefillNs = nowNs;
  }
}

/**
 * A burst that lets a rate work sensibly at educational packet sizes: a quarter
 * second of the configured rate, clamped to a bounded range.
 */
export function defaultBurstBytes(rateBps: number, minimumBytes = 1_500, maximumBytes = 1_048_576): number {
  const quarterSecond = Math.round(rateBps / 8 / 4);
  return Math.min(Math.max(quarterSecond, minimumBytes), maximumBytes);
}

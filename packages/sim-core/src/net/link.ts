import type { EthernetInterface } from "./interface";
import {
  DEFAULT_LINK_PERFORMANCE,
  normalizeLinkPerformance,
  type LinkPerformanceConfiguration,
  type LinkPerformanceInput,
} from "./link-performance";

/**
 * A point-to-point cable joining two interfaces.
 *
 * Its performance is structured configuration — finite capacity, propagation
 * delay and per-direction queue depth — so both ends serialize packets through
 * the same deterministic model. Each direction owns its own egress queue on the
 * transmitting interface, so a full-duplex link never lets one direction block
 * the other.
 */
export class Link {
  private performanceConfiguration: LinkPerformanceConfiguration;

  constructor(
    readonly a: EthernetInterface,
    readonly b: EthernetInterface,
    performance: LinkPerformanceInput | undefined = undefined,
  ) {
    this.performanceConfiguration = normalizeLinkPerformance(performance);
    this.applyQueueLimit();
  }

  get performance(): LinkPerformanceConfiguration {
    return this.performanceConfiguration;
  }

  get capacityBps(): number {
    return this.performanceConfiguration.capacityBps;
  }

  get propagationDelayNs(): number {
    return this.performanceConfiguration.propagationDelayNs;
  }

  get queueLimitPackets(): number {
    return this.performanceConfiguration.queueLimitPackets;
  }

  /**
   * Change link performance while the lab runs. A packet that is already
   * serializing keeps the delay it started with; the next packet uses the new
   * value. Nothing already queued is discarded.
   */
  configurePerformance(performance: LinkPerformanceInput): LinkPerformanceConfiguration {
    this.performanceConfiguration = normalizeLinkPerformance(performance, this.performanceConfiguration);
    this.applyQueueLimit();
    return this.performanceConfiguration;
  }

  private applyQueueLimit(): void {
    this.a.egress.setDefaultLimitPackets(this.performanceConfiguration.queueLimitPackets);
    this.b.egress.setDefaultLimitPackets(this.performanceConfiguration.queueLimitPackets);
  }
}

export { DEFAULT_LINK_PERFORMANCE };

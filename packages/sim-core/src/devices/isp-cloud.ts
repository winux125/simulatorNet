import type { Ipv4Packet } from "../packets/ipv4";
import type { L3Interface } from "./router";
import { Router } from "./router";

export const CLOUD_RESOURCE_LIMITS = Object.freeze({
  minimumInterfaces: 2,
  maximumInterfaces: 8,
  maximumAdditionalLatencyNs: 60_000_000_000,
});

export interface CloudImpairment {
  readonly interfaceName: string;
  readonly additionalLatencyNs: number;
  /** Probability in [0, 1]. Decisions use only the engine SeededRandom. */
  readonly packetLossRate: number;
  readonly note?: string;
}

/** Simulated routed provider. It never opens a real socket or accesses the Internet. */
export class IspCloud extends Router {
  override readonly deviceType = "cloud" as const;
  private readonly impairments = new Map<string, CloudImpairment>();

  override onAddedToEngine(): void {
    super.onAddedToEngine();
    if (this.interfaces.size > 0) this.validateInterfaceCount();
  }

  configureImpairment(configuration: CloudImpairment): void {
    if (!this.interfaces.has(configuration.interfaceName)) {
      throw new CloudConfigurationError(`Cloud ${this.id} has no interface ${configuration.interfaceName}.`);
    }
    if (!Number.isSafeInteger(configuration.additionalLatencyNs)
      || configuration.additionalLatencyNs < 0
      || configuration.additionalLatencyNs > CLOUD_RESOURCE_LIMITS.maximumAdditionalLatencyNs) {
      throw new CloudConfigurationError("Cloud additional latency is outside the supported range.");
    }
    if (!Number.isFinite(configuration.packetLossRate)
      || configuration.packetLossRate < 0
      || configuration.packetLossRate > 1) {
      throw new CloudConfigurationError("Cloud packet loss rate must be between 0 and 1.");
    }
    this.impairments.set(configuration.interfaceName, { ...configuration });
  }

  impairmentConfigurations(): CloudImpairment[] {
    return [...this.impairments.values()]
      .sort((a, b) => a.interfaceName.localeCompare(b.interfaceName))
      .map((configuration) => ({ ...configuration }));
  }

  validateInterfaceCount(): void {
    if (this.interfaces.size < CLOUD_RESOURCE_LIMITS.minimumInterfaces
      || this.interfaces.size > CLOUD_RESOURCE_LIMITS.maximumInterfaces) {
      throw new CloudConfigurationError(
        `Cloud requires ${CLOUD_RESOURCE_LIMITS.minimumInterfaces}-${CLOUD_RESOURCE_LIMITS.maximumInterfaces} Ethernet interfaces.`,
      );
    }
  }

  protected override permitForward(
    packet: Ipv4Packet,
    ingress: L3Interface,
    egress: L3Interface,
  ): boolean {
    const impairment = this.impairments.get(egress.name);
    if (!impairment || impairment.packetLossRate === 0) return true;
    const sample = this.engine.rng.nextFloat();
    if (sample >= impairment.packetLossRate) return true;
    this.engine.trace({
      time: this.engine.now(),
      type: "cloud-packet-dropped",
      device: this.id,
      detail: {
        ingress: ingress.name,
        egress: egress.name,
        source: packet.src,
        destination: packet.dst,
        lossRate: impairment.packetLossRate,
        sample,
      },
    });
    return false;
  }

  protected override forwardingDelayNs(
    _packet: Ipv4Packet,
    _ingress: L3Interface,
    egress: L3Interface,
  ): number {
    const latency = this.impairments.get(egress.name)?.additionalLatencyNs ?? 0;
    if (latency > 0) {
      this.engine.trace({
        time: this.engine.now(),
        type: "cloud-packet-delayed",
        device: this.id,
        detail: { egress: egress.name, additionalLatencyNs: latency },
      });
    }
    return latency;
  }
}

export class CloudConfigurationError extends Error {
  override readonly name = "CloudConfigurationError";
  readonly code = "CLOUD_INVALID_CONFIGURATION";
}

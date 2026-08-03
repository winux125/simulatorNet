export const DEFAULT_MPLS_LIMITS = Object.freeze({
  maximumLabelsPerRouter: 4_096,
  maximumLabelStackDepth: 4,
  maximumLfibEntriesPerLab: 16_384,
  maximumForwardingEventsPerOperation: 100_000,
});

export type MplsLimits = typeof DEFAULT_MPLS_LIMITS;

export class MplsLimitError extends Error {
  readonly code = "mpls-resource-limit";

  constructor(
    readonly limit: keyof MplsLimits,
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(`MPLS resource limit '${limit}' exceeded: ${actual} > ${maximum}`);
    this.name = "MplsLimitError";
  }
}

export class MplsConfigurationError extends Error {
  readonly code = "mpls-configuration";

  constructor(message: string) {
    super(message);
    this.name = "MplsConfigurationError";
  }
}

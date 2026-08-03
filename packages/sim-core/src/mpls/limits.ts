export const DEFAULT_MPLS_LIMITS = Object.freeze({
  maximumLabelsPerRouter: 4_096,
  maximumLabelStackDepth: 4,
  maximumLfibEntriesPerLab: 16_384,
  maximumForwardingEventsPerOperation: 100_000,
});

/**
 * The educational core MTU an MPLS-enabled link is assumed to carry. A label
 * stack eats into it, so a payload that already fills the link is dropped and
 * reported — never fragmented. It is a teaching value, not a hardware claim.
 */
export const MPLS_CORE_MTU_BYTES = 1_500;

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

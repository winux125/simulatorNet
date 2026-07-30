/**
 * Centralized, finite QoS resource limits. Every configuration and every
 * per-operation budget is bounded, so a lab can never make the deterministic
 * engine allocate or schedule without end.
 */
export const QOS_RESOURCE_LIMITS = Object.freeze({
  maximumClassMapsPerDevice: 32,
  maximumPolicyMapsPerDevice: 16,
  maximumClassesPerPolicy: 8,
  maximumMatchRulesPerClass: 8,
  maximumServicePolicyBindingsPerDevice: 64,
  /** Total scheduling percentage a policy map may allocate. */
  maximumBandwidthPercentTotal: 100,
  /** Ceiling on the share one priority class may reserve. */
  maximumPriorityPercent: 80,
  minimumPolicerRateBps: 8_000,
  maximumPolicerRateBps: 100_000_000_000,
  minimumPolicerBurstBytes: 64,
  maximumPolicerBurstBytes: 16 * 1_024 * 1_024,
  minimumShaperRateBps: 8_000,
  maximumShaperRateBps: 100_000_000_000,
  /** Packets a shaper may hold back before it starts tail-dropping. */
  maximumShapedPackets: 512,
  /** Classification/marking/policing evaluations one bounded operation may run. */
  maximumPolicyEvaluationsPerOperation: 200_000,
  /** Queue-lifecycle events one bounded operation may schedule. */
  maximumQueueEventsPerOperation: 200_000,
});

export type QosLimits = typeof QOS_RESOURCE_LIMITS;

export type QosBudgetKind = "policy-evaluations" | "queue-events";

export class QosBudgetExceededError extends Error {
  override readonly name = "QosBudgetExceededError";
  readonly code = "QOS_BUDGET_EXCEEDED";

  constructor(readonly budget: QosBudgetKind, readonly maximum: number) {
    super(`QoS ${budget} budget exceeded (${maximum} per operation).`);
  }
}

/**
 * Shared per-operation budget for every QoS engine in one lab. It holds no
 * device references, so the browser worker and the headless verifier enforce
 * exactly the same bound.
 */
export class QosOperationBudget {
  private evaluations = 0;
  private queueEvents = 0;

  constructor(
    private readonly maximumEvaluations = QOS_RESOURCE_LIMITS.maximumPolicyEvaluationsPerOperation,
    private readonly maximumQueueEvents = QOS_RESOURCE_LIMITS.maximumQueueEventsPerOperation,
  ) {}

  get usedEvaluations(): number {
    return this.evaluations;
  }

  get usedQueueEvents(): number {
    return this.queueEvents;
  }

  consumeEvaluation(): void {
    if (++this.evaluations > this.maximumEvaluations) {
      throw new QosBudgetExceededError("policy-evaluations", this.maximumEvaluations);
    }
  }

  consumeQueueEvent(): void {
    if (++this.queueEvents > this.maximumQueueEvents) {
      throw new QosBudgetExceededError("queue-events", this.maximumQueueEvents);
    }
  }

  reset(): void {
    this.evaluations = 0;
    this.queueEvents = 0;
  }
}

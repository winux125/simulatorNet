import type { SimulationEngine } from "../engine/simulation-engine";

export interface ProtocolActivityOptions {
  /** Diagnostic name, used in traces and errors. */
  readonly name: string;
  /** Period between two ticks, in virtual nanoseconds. */
  readonly intervalNs: number;
  /**
   * How many further periods the protocol keeps running after its last state
   * change. Three periods is enough for a converged protocol to re-advertise
   * and for the peer to agree before both sides go quiescent.
   */
  readonly quiescenceRounds: number;
  /** Hard bound on ticks between engine resets, so a broken lab still halts. */
  readonly maximumTicks: number;
}

/**
 * The bounded protocol activity window.
 *
 * A control protocol must never schedule an endless stream of hello events:
 * `runUntilIdle()` would never return, so Auto execution and headless grading
 * could not complete. Instead every periodic protocol runs inside an activity
 * window. It ticks while it has work and goes quiescent `quiescenceRounds`
 * periods after the last state change. Any stimulus — a link transition, a
 * configuration change, or a received PDU that actually changes state — calls
 * `arm()` and re-opens the window.
 *
 * Steady-state PDUs that change nothing deliberately do **not** re-arm the
 * window, otherwise two neighbours would keep each other awake for ever.
 */
export class ProtocolActivity {
  private remainingRounds = 0;
  private scheduled = false;
  private ticksUsed = 0;
  private lastTickNs: number | undefined;

  constructor(
    private readonly getEngine: () => SimulationEngine | undefined,
    private readonly options: ProtocolActivityOptions,
    private readonly onTick: () => void,
  ) {}

  /** True while periodic work and absence-of-message timers are running. */
  get active(): boolean {
    return this.remainingRounds > 0;
  }

  get tickCount(): number {
    return this.ticksUsed;
  }

  get lastTickAtNs(): number | undefined {
    return this.lastTickNs;
  }

  /** Re-open the activity window; schedules an immediate tick when idle. */
  arm(): void {
    this.remainingRounds = this.options.quiescenceRounds;
    this.schedule(0);
  }

  /** Close the window without running anything further (device stop/reset). */
  quiesce(): void {
    this.remainingRounds = 0;
  }

  /** Forget the tick budget, e.g. when the runtime is explicitly reset. */
  resetBudget(): void {
    this.ticksUsed = 0;
  }

  private schedule(delayNs: number): void {
    const engine = this.getEngine();
    if (!engine || this.scheduled) return;
    if (this.ticksUsed >= this.options.maximumTicks) return;
    this.scheduled = true;
    engine.scheduleIn(delayNs, () => {
      this.scheduled = false;
      if (this.remainingRounds <= 0) return;
      this.remainingRounds--;
      this.ticksUsed++;
      this.lastTickNs = engine.now();
      this.onTick();
      if (this.remainingRounds > 0) this.schedule(this.options.intervalNs);
    });
  }
}

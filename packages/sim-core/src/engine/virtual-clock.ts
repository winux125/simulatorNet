/**
 * Simulated time in nanoseconds. The clock only ever moves forward, driven by
 * the event queue. It never reads the wall clock, so runs are reproducible.
 */
export class VirtualClock {
  private t = 0;

  now(): number {
    return this.t;
  }

  set(timeNs: number): void {
    if (timeNs < this.t) {
      throw new Error(`VirtualClock cannot move backwards (${this.t} -> ${timeNs})`);
    }
    this.t = timeNs;
  }
}

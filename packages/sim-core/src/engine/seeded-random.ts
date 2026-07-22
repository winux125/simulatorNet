/**
 * Deterministic PRNG (mulberry32). Fast, tiny, and reproducible across
 * platforms — the same seed always yields the same sequence, which is what
 * lets the browser and the server verifier agree on a run.
 *
 * Never use Math.random() anywhere in the engine; use an instance of this.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next unsigned 32-bit integer. */
  nextU32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in [0, 1). */
  nextFloat(): number {
    return this.nextU32() / 0x1_0000_0000;
  }

  /** Integer in the inclusive range [min, max]. */
  nextInt(min: number, max: number): number {
    if (max < min) throw new Error(`nextInt: max (${max}) < min (${min})`);
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /** A copy positioned at the current state, advancing independently. */
  clone(): SeededRandom {
    const copy = new SeededRandom(0);
    copy.state = this.state;
    return copy;
  }
}

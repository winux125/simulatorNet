import { describe, expect, it } from "vitest";
import { SeededRandom } from "@sim/sim-core";

describe("SeededRandom (mulberry32)", () => {
  it("produces identical sequences for the same seed", () => {
    const a = new SeededRandom(12345);
    const b = new SeededRandom(12345);
    const seqA = Array.from({ length: 8 }, () => a.nextU32());
    const seqB = Array.from({ length: 8 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    expect(a.nextU32()).not.toEqual(b.nextU32());
  });

  it("nextFloat stays within [0, 1)", () => {
    const r = new SeededRandom(99);
    for (let i = 0; i < 1000; i++) {
      const f = r.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it("nextInt stays within the inclusive range", () => {
    const r = new SeededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const n = r.nextInt(10, 20);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(20);
    }
  });

  it("clone continues the same sequence independently", () => {
    const r = new SeededRandom(555);
    r.nextU32();
    const c = r.clone();
    expect(c.nextU32()).toEqual(r.nextU32());
  });
});

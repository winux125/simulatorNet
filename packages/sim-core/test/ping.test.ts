import { describe, expect, it } from "vitest";
import { normalizeMac, type TraceEntry } from "@sim/sim-core";
import { buildStarLan } from "./helpers";

describe("end-to-end ICMP ping (PC <-> switch <-> PC)", () => {
  it("succeeds with a positive RTT and populates both ARP caches", () => {
    const { engine, pcs } = buildStarLan(2);
    const [pc1, pc2] = pcs;
    pc1!.ping("192.168.1.11", 1);
    engine.runUntilIdle();

    expect(pc1!.pingResults).toHaveLength(1);
    const result = pc1!.pingResults[0]!;
    expect(result).toMatchObject({ sequence: 1, success: true });
    expect(result.rttNs).toBeGreaterThan(0);

    expect(pc1!.arpTable.get("192.168.1.11")).toBe(normalizeMac(pc2!.primary.mac));
    expect(pc2!.arpTable.get("192.168.1.10")).toBe(normalizeMac(pc1!.primary.mac));
  });

  it("times out (fails) when the destination host does not exist", () => {
    const { engine, pcs } = buildStarLan(2);
    const [pc1] = pcs;
    pc1!.ping("192.168.1.99", 1); // nobody owns .99
    engine.runUntilIdle();

    expect(pc1!.pingResults).toEqual([{ sequence: 1, success: false }]);
  });

  it("is deterministic: identical seed and input yield an identical event trace", () => {
    const run = (): TraceEntry[] => {
      const { engine, pcs } = buildStarLan(2, 4242);
      engine.enableTrace();
      pcs[0]!.ping("192.168.1.11", 7);
      engine.runUntilIdle();
      return engine.traceLog;
    };
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    // Sanity: the trace actually captured the full request/reply exchange.
    expect(first.some((e) => e.type === "ping-success")).toBe(true);
  });
});

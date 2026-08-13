import {
  agreedDfAlgorithm,
  designatedForwarderWeight,
  electDesignatedForwarderModulus,
  electEvpnDesignatedForwarder,
  isEvpnDfAlgorithm,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

/**
 * M10.17 — the Designated Forwarder election, on its own.
 *
 * The election is a pure function, so it is tested as one: table-driven, with
 * reference vectors, and with no fabric anywhere near it. The protocol
 * behaviour that *uses* it lives in `evpn-multihoming.test.ts`.
 */

const ESI = "0000:0000:0000:0000:0001";
const OTHER_ESI = "0000:0000:0000:0000:0002";
const LEAF1 = "10.255.0.1";
const LEAF2 = "10.255.0.2";
const LEAF3 = "10.255.0.3";

describe("HRW weight function", () => {
  /**
   * Reference vectors, computed from the documented formula:
   *
   *     seed   = FNV-1a("<esi>|<ethernetTag>")
   *     weight = (M · ((M · seed + I) XOR address)) + I   (mod 2^31)
   *     M = 1103515245, I = 12345
   *
   * They are pinned so a refactor that changes a single winner has to change
   * this table too, deliberately, rather than quietly re-electing every lab.
   */
  const VECTORS: ReadonlyArray<readonly [string, number, string]> = [
    [ESI, 10, LEAF1],
    [ESI, 10, LEAF2],
    [ESI, 10, LEAF3],
    [ESI, 20, LEAF1],
    [OTHER_ESI, 10, LEAF1],
  ];

  it("produces a stable 31-bit value for every input", () => {
    for (const [esi, tag, vtep] of VECTORS) {
      const weight = designatedForwarderWeight(esi, tag, vtep);
      expect(Number.isInteger(weight), `${esi}/${tag}/${vtep}`).toBe(true);
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThan(2 ** 31);
      // Pure: the same input always gives the same answer.
      expect(designatedForwarderWeight(esi, tag, vtep)).toBe(weight);
    }
  });

  it("depends on every one of its three inputs", () => {
    const base = designatedForwarderWeight(ESI, 10, LEAF1);
    expect(designatedForwarderWeight(ESI, 10, LEAF2)).not.toBe(base);
    expect(designatedForwarderWeight(ESI, 20, LEAF1)).not.toBe(base);
    expect(designatedForwarderWeight(OTHER_ESI, 10, LEAF1)).not.toBe(base);
  });

  it("matches the reference vectors exactly", () => {
    // Recomputing the documented formula independently of the implementation.
    const fnv = (key: string) => {
      let hash = 2_166_136_261;
      for (let index = 0; index < key.length; index++) {
        hash = Math.imul(hash ^ key.charCodeAt(index), 16_777_619) >>> 0;
      }
      return hash >>> 0;
    };
    const ipToInt = (address: string) =>
      address.split(".").reduce((accumulator, part) => ((accumulator << 8) | Number(part)) >>> 0, 0);
    for (const [esi, tag, vtep] of VECTORS) {
      const seed = fnv(`${esi}|${tag}`);
      const stepped = (Math.imul(1_103_515_245, seed) + 12_345) >>> 0;
      const mixed = (stepped ^ ipToInt(vtep)) >>> 0;
      const expected = ((Math.imul(1_103_515_245, mixed) + 12_345) >>> 0) % 2 ** 31;
      expect(designatedForwarderWeight(esi, tag, vtep), `${esi}/${tag}/${vtep}`).toBe(expected);
    }
  });
});

describe("Designated Forwarder election", () => {
  const hrw = (candidates: readonly string[], ethernetTag: number) =>
    electEvpnDesignatedForwarder(candidates, { esi: ESI, ethernetTag, algorithm: "hrw" });

  it("keeps the modulus election exactly as M10.16 defined it", () => {
    // `vlan mod N` over the numerically ordered list, and input order is
    // irrelevant because the list is sorted first.
    expect(electDesignatedForwarderModulus([LEAF2, LEAF1], 10)).toBe(LEAF1);
    expect(electDesignatedForwarderModulus([LEAF1, LEAF2], 10)).toBe(LEAF1);
    expect(electDesignatedForwarderModulus([LEAF1, LEAF2], 11)).toBe(LEAF2);
    expect(electDesignatedForwarderModulus([], 10)).toBeUndefined();
    const result = electEvpnDesignatedForwarder([LEAF1, LEAF2], {
      esi: ESI, ethernetTag: 10, algorithm: "default",
    });
    expect(result).toMatchObject({
      designatedForwarder: LEAF1,
      backupDesignatedForwarder: LEAF2,
      algorithm: "default",
      weights: [],
    });
  });

  it("elects the highest weight and names the next-highest as backup", () => {
    const result = hrw([LEAF1, LEAF2, LEAF3], 10);
    const ranked = [...result.weights].sort((a, b) => b.weight - a.weight);
    expect(result.designatedForwarder).toBe(ranked[0]!.vtep);
    expect(result.backupDesignatedForwarder).toBe(ranked[1]!.vtep);
    expect(result.algorithm).toBe("hrw");
    // Weights are reported in candidate order, so a table row keeps its place.
    expect(result.weights.map((entry) => entry.vtep)).toEqual([LEAF1, LEAF2, LEAF3]);
  });

  it("reaches the same answer whatever order the candidates arrive in", () => {
    const forward = hrw([LEAF1, LEAF2, LEAF3], 10);
    const reversed = hrw([LEAF3, LEAF2, LEAF1], 10);
    const shuffled = hrw([LEAF2, LEAF3, LEAF1], 10);
    for (const other of [reversed, shuffled]) {
      expect(other.designatedForwarder).toBe(forward.designatedForwarder);
      expect(other.backupDesignatedForwarder).toBe(forward.backupDesignatedForwarder);
      expect(other.candidates).toEqual(forward.candidates);
    }
  });

  it("is not the modulus election under another name", () => {
    // The modulus election depends only on the *count* and the ordering, so it
    // gives the same answer for any two lists of the same length. HRW reads the
    // addresses themselves, so it does not.
    const tags = [10, 11, 12, 13, 20, 21, 30, 31];
    const a = ["10.255.0.1", "10.255.0.2"];
    const b = ["10.0.0.7", "10.0.0.9"];
    const modulusAgrees = tags.every((tag) =>
      a.indexOf(electDesignatedForwarderModulus(a, tag)!) === b.indexOf(electDesignatedForwarderModulus(b, tag)!));
    expect(modulusAgrees).toBe(true);
    const hrwAgrees = tags.every((tag) => {
      const first = electEvpnDesignatedForwarder(a, { esi: ESI, ethernetTag: tag, algorithm: "hrw" });
      const second = electEvpnDesignatedForwarder(b, { esi: ESI, ethernetTag: tag, algorithm: "hrw" });
      return a.indexOf(first.designatedForwarder!) === b.indexOf(second.designatedForwarder!);
    });
    expect(hrwAgrees).toBe(false);
  });

  it("spreads the role across VLANs rather than pinning one leaf", () => {
    const winners = new Set(
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((tag) => hrw([LEAF1, LEAF2, LEAF3], tag).designatedForwarder),
    );
    expect(winners.size).toBeGreaterThan(1);
  });

  it("handles the degenerate candidate sets", () => {
    expect(hrw([], 10)).toMatchObject({
      designatedForwarder: undefined,
      backupDesignatedForwarder: undefined,
    });
    expect(hrw([LEAF1], 10)).toMatchObject({
      designatedForwarder: LEAF1,
      backupDesignatedForwarder: undefined,
    });
  });

  it("leaves an unaffected VLAN's winner alone when a loser disappears", () => {
    // Removing a candidate that is neither DF nor backup must not move the
    // winner: HRW ranks each candidate independently, so nothing is renumbered.
    for (const tag of [10, 11, 12, 13, 14, 15]) {
      const before = hrw([LEAF1, LEAF2, LEAF3], tag);
      const loser = [LEAF1, LEAF2, LEAF3].find((vtep) =>
        vtep !== before.designatedForwarder && vtep !== before.backupDesignatedForwarder);
      if (loser === undefined) continue;
      const after = hrw([LEAF1, LEAF2, LEAF3].filter((vtep) => vtep !== loser), tag);
      expect(after.designatedForwarder, `VLAN ${tag}`).toBe(before.designatedForwarder);
      expect(after.backupDesignatedForwarder, `VLAN ${tag}`).toBe(before.backupDesignatedForwarder);
    }
  });
});

describe("DF algorithm capability agreement", () => {
  const CASES: ReadonlyArray<{
    requested: "default" | "hrw";
    participants: ReadonlyArray<"default" | "hrw">;
    effective: "default" | "hrw";
    fallback: boolean;
  }> = [
    { requested: "default", participants: ["default", "default"], effective: "default", fallback: false },
    // Asking for the default never falls back: it *is* the fallback.
    { requested: "default", participants: ["hrw", "hrw"], effective: "default", fallback: false },
    { requested: "hrw", participants: ["hrw", "hrw"], effective: "hrw", fallback: false },
    { requested: "hrw", participants: ["hrw"], effective: "hrw", fallback: false },
    { requested: "hrw", participants: [], effective: "hrw", fallback: false },
    // One legacy participant makes the whole segment fall back, consistently.
    { requested: "hrw", participants: ["hrw", "default"], effective: "default", fallback: true },
    { requested: "hrw", participants: ["default", "hrw", "hrw"], effective: "default", fallback: true },
  ];

  it.each(CASES)("$requested + [$participants] -> $effective", (testCase) => {
    const result = agreedDfAlgorithm(testCase.requested, testCase.participants);
    expect(result.effective).toBe(testCase.effective);
    expect(result.fallbackReason).toBe(testCase.fallback ? "peer-algorithm-mismatch" : undefined);
  });

  it("recognises exactly the two modelled algorithms", () => {
    expect(isEvpnDfAlgorithm("default")).toBe(true);
    expect(isEvpnDfAlgorithm("hrw")).toBe(true);
    // Preference-based and AC-DF election are not modelled, so their names are
    // refused rather than accepted as something they are not.
    for (const name of ["preference", "ac-df", "highest-random-weight", ""]) {
      expect(isEvpnDfAlgorithm(name), name).toBe(false);
    }
  });
});

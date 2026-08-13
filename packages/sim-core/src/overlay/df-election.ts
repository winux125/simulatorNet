import { hashFlowKey } from "../util/hash";
import { ipToInt, type Ipv4 } from "../util/ipv4";
import type { Esi } from "./ethernet-segment";

/**
 * How a segment's participants agree on the Designated Forwarder.
 *
 * `default` is the modulus election of RFC 7432 §8.5, which every leaf has run
 * since M10.16. `hrw` is the highest-random-weight election: each candidate
 * computes a weight per `<ESI, Ethernet Tag>` and the highest wins.
 *
 * An absent value means `default`, so a lab written before M10.17 keeps exactly
 * the winner it always had — nothing is silently reinterpreted as HRW.
 */
export type EvpnDfAlgorithm = "default" | "hrw";

export function isEvpnDfAlgorithm(value: string): value is EvpnDfAlgorithm {
  return value === "default" || value === "hrw";
}

/** Why an election that asked for HRW did not run it. */
export type EvpnDfFallbackReason =
  /** At least one operational participant advertises `default` only. */
  | "peer-algorithm-mismatch";

/** One candidate's HRW weight, for inspection and for the election itself. */
export interface EvpnDfCandidateWeight {
  readonly vtep: Ipv4;
  /** A 31-bit unsigned value; higher wins. */
  readonly weight: number;
}

export interface EvpnDfElectionResult {
  /** Ordered candidates the election ran over, canonically by address. */
  readonly candidates: readonly Ipv4[];
  readonly designatedForwarder: Ipv4 | undefined;
  /**
   * The next-best candidate: the one that becomes DF if the winner withdraws.
   *
   * It is computed by the same function as the winner, so a failure does not
   * need a second, differently written election to agree with the first.
   */
  readonly backupDesignatedForwarder: Ipv4 | undefined;
  readonly algorithm: EvpnDfAlgorithm;
  /** Empty for the modulus election, which computes no weight at all. */
  readonly weights: readonly EvpnDfCandidateWeight[];
}

const TWO_POW_31 = 2_147_483_648;
/** The multiplier and increment of the classic linear congruential generator. */
const LCG_MULTIPLIER = 1_103_515_245;
const LCG_INCREMENT = 12_345;

function compareAddresses(left: Ipv4, right: Ipv4): number {
  return ipToInt(left) - ipToInt(right);
}

/**
 * The documented default election of RFC 7432 §8.5.
 *
 * Order the candidate addresses numerically, then pick `vlan mod N`. Input order
 * never matters, because the list is sorted first — which is what lets every
 * participant reach the same answer without telling anyone what it decided.
 */
export function electDesignatedForwarderModulus(
  candidates: readonly Ipv4[],
  vlanId: number,
): Ipv4 | undefined {
  if (candidates.length === 0) return undefined;
  const ordered = [...candidates].sort(compareAddresses);
  return ordered[((vlanId % ordered.length) + ordered.length) % ordered.length];
}

/**
 * One candidate's highest-random-weight value for one `<ESI, Ethernet Tag>`.
 *
 * This is the RFC 8584 shape: a linear congruential step over a seed derived
 * from the segment and the tag, mixed with the candidate's own address, taken
 * modulo 2^31.
 *
 *     seed   = FNV-1a("<esi>|<ethernetTag>")
 *     weight = (M · ((M · seed + I) XOR address)) + I   (mod 2^31)
 *     M = 1103515245, I = 12345
 *
 * The address is genuinely part of the result, which is what makes this *not* a
 * modulus election under another name: two candidate sets of the same size and
 * the same order can produce different winners, and adding a third candidate
 * does not renumber the other two. Every operation is 32-bit integer
 * arithmetic, so the browser worker and the verifier compute bit-identical
 * values with no floating point anywhere.
 */
export function designatedForwarderWeight(esi: Esi, ethernetTag: number, vtep: Ipv4): number {
  const seed = hashFlowKey(`${esi}|${ethernetTag}`);
  const stepped = (Math.imul(LCG_MULTIPLIER, seed) + LCG_INCREMENT) >>> 0;
  const mixed = (stepped ^ (ipToInt(vtep) >>> 0)) >>> 0;
  const weight = (Math.imul(LCG_MULTIPLIER, mixed) + LCG_INCREMENT) >>> 0;
  return weight % TWO_POW_31;
}

/**
 * The one election every participant runs.
 *
 * Whichever algorithm is in force, the answer is a pure function of the ESI, the
 * Ethernet Tag and the canonically ordered candidate set — so all of them reach
 * an identical result independently, and neither `Math.random` nor `Map`
 * insertion order nor wall-clock time can reach it.
 *
 * A tie in HRW is broken by the higher address, so two candidates that happen to
 * hash alike still resolve the same way everywhere.
 */
export function electEvpnDesignatedForwarder(
  candidates: readonly Ipv4[],
  input: { esi: Esi; ethernetTag: number; algorithm: EvpnDfAlgorithm },
): EvpnDfElectionResult {
  const ordered = [...candidates].sort(compareAddresses);
  if (input.algorithm !== "hrw") {
    const designatedForwarder = electDesignatedForwarderModulus(ordered, input.ethernetTag);
    // The modulus election's natural runner-up is the next candidate in the
    // ring: the one `vlan mod N` would pick if the winner were not there.
    const backup = ordered.length < 2
      ? undefined
      : electDesignatedForwarderModulus(
        ordered.filter((vtep) => vtep !== designatedForwarder),
        input.ethernetTag,
      );
    return {
      candidates: ordered,
      designatedForwarder,
      backupDesignatedForwarder: backup,
      algorithm: "default",
      weights: [],
    };
  }
  const weights = ordered.map((vtep): EvpnDfCandidateWeight => ({
    vtep,
    weight: designatedForwarderWeight(input.esi, input.ethernetTag, vtep),
  }));
  const ranked = [...weights].sort((a, b) => b.weight - a.weight || compareAddresses(b.vtep, a.vtep));
  return {
    candidates: ordered,
    designatedForwarder: ranked[0]?.vtep,
    backupDesignatedForwarder: ranked[1]?.vtep,
    algorithm: "hrw",
    // Reported in the canonical candidate order, never in ranked order, so a
    // table row keeps its place as weights change.
    weights,
  };
}

/**
 * The algorithm a segment actually runs, given what its participants support.
 *
 * HRW is used only when **every** operational participant agrees on it. One
 * legacy or default-only leaf makes the whole segment fall back, because two
 * leaves running different elections for the same `<ESI, VLAN>` could each
 * believe it is the Designated Forwarder — which is precisely the split the
 * election exists to prevent. The fallback is therefore consistent by
 * construction rather than by convention.
 */
export function agreedDfAlgorithm(
  requested: EvpnDfAlgorithm,
  participantAlgorithms: readonly EvpnDfAlgorithm[],
): { effective: EvpnDfAlgorithm; fallbackReason: EvpnDfFallbackReason | undefined } {
  if (requested !== "hrw") return { effective: "default", fallbackReason: undefined };
  const dissenting = participantAlgorithms.some((algorithm) => algorithm !== "hrw");
  return dissenting
    ? { effective: "default", fallbackReason: "peer-algorithm-mismatch" }
    : { effective: "hrw", fallbackReason: undefined };
}

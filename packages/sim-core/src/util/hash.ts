/**
 * The one deterministic, seed-free hash the engine uses to turn a structured
 * flow key into a stable index.
 *
 * It exists so that "which member of a bundle" and "which VTEP of an All-Active
 * Ethernet Segment" are answered by the *same* function: both are a pure
 * function of the fields the engine actually models, never `Math.random`, never
 * `Map` insertion order and never wall-clock time. The same input therefore
 * yields the same choice in the browser worker and in the verifier.
 */

/** FNV-1a, 32-bit. Small, stable and dependency-free. */
export function hashFlowKey(key: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Pick one entry of an already canonically ordered list for one flow.
 *
 * The list must be sorted by the caller, because the choice has to depend on
 * the *set* of paths and never on the order they happened to arrive in. Adding
 * or removing one entry re-indexes the modulus, so reassignment is bounded and
 * deterministic rather than a full reshuffle driven by anything external.
 */
export function selectByFlowKey<T>(ordered: readonly T[], flowKey: string): T | undefined {
  if (ordered.length === 0) return undefined;
  return ordered[hashFlowKey(flowKey) % ordered.length];
}

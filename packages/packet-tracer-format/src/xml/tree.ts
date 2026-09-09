/**
 * The minimal shape this package needs from a parsed XML tree.
 *
 * `@sim/importers` owns the one hardened XML parser in the repository and its
 * `XmlElement` satisfies this structurally, so the adapter injects an already
 * parsed tree and no second parser exists. This mirrors how `cli-engine`
 * depends on small structural interfaces the runtime injects rather than on the
 * runtime itself.
 *
 * Traversal here is deliberately *tolerant*: Packet Tracer moves wrapper
 * elements between releases, so lookups search for known semantic names instead
 * of walking an absolute path, and unknown siblings are ignored rather than
 * treated as errors.
 */
export interface XmlLike {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlLike[];
  readonly text: string;
}

const upper = (name: string): string => {
  const colon = name.lastIndexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toUpperCase();
};

/** Direct children with the given local name. */
export function childrenNamed(node: XmlLike, name: string): XmlLike[] {
  const target = upper(name);
  return node.children.filter((child) => upper(child.name) === target);
}

/** First direct child with the given local name. */
export function childNamed(node: XmlLike, name: string): XmlLike | undefined {
  const target = upper(name);
  return node.children.find((child) => upper(child.name) === target);
}

/**
 * First direct child matching any of the given names, in the order given, so a
 * renamed-but-equivalent element can be accepted without reordering the tree.
 */
export function childNamedAny(node: XmlLike, ...names: readonly string[]): XmlLike | undefined {
  for (const name of names) {
    const found = childNamed(node, name);
    if (found) return found;
  }
  return undefined;
}

/** Trimmed text of the first direct child with the given name. */
export function childText(node: XmlLike, name: string): string | undefined {
  const value = childNamed(node, name)?.text.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Depth-first descendants with the given local name, not descending into a
 * match. Bounded by `limit` so a hostile document cannot make traversal
 * quadratic; the caller reports when the bound truncated the result.
 */
export function descendantsNamed(node: XmlLike, name: string, limit = 100_000): XmlLike[] {
  const target = upper(name);
  const found: XmlLike[] = [];
  const stack: XmlLike[] = [node];
  while (stack.length > 0 && found.length < limit) {
    const current = stack.pop()!;
    if (current !== node && upper(current.name) === target) {
      found.push(current);
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index--) {
      stack.push(current.children[index]!);
    }
  }
  return found;
}

/** First descendant with the given local name. */
export function descendantNamed(node: XmlLike, name: string): XmlLike | undefined {
  return descendantsNamed(node, name, 1)[0];
}

/**
 * Text of every direct child with the given name, in document order. Packet
 * Tracer uses repeated same-named siblings for ordered pairs — a `<CABLE>` has
 * two `<PORT>` children whose *order* is the only thing distinguishing the two
 * endpoints — so position must be preserved, never collapsed into a map.
 */
export function orderedChildTexts(node: XmlLike, name: string): string[] {
  return childrenNamed(node, name).map((child) => child.text.trim());
}

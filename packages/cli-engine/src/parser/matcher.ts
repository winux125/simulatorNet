/**
 * A tiny pattern matcher over token arrays. The command set is small and fixed,
 * so instead of a general grammar each command declares a literal pattern with
 * typed holes:
 *
 *   "switchport access vlan {id}"   -> { id: "10" }
 *   "description {text...}"         -> { text: "uplink to core" }
 *
 * Literals match case-insensitively (Cisco keywords are case-insensitive).
 * `{name}` captures exactly one token; `{name...}` captures the rest of the line.
 * Command abbreviation and `?` help are intentionally out of scope for now.
 */
export type Params = Record<string, string>;

export function matchPattern(pattern: string, tokens: string[]): Params | null {
  const parts = pattern.split(" ");
  const params: Params = {};
  let i = 0;

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!;
    const rest = part.startsWith("{") && part.endsWith("...}");
    const single = part.startsWith("{") && part.endsWith("}") && !rest;

    if (rest) {
      const name = part.slice(1, -4);
      if (i >= tokens.length) return null; // needs at least one token
      params[name] = tokens.slice(i).join(" ");
      i = tokens.length;
      return p === parts.length - 1 ? params : null;
    }
    if (single) {
      const name = part.slice(1, -1);
      if (i >= tokens.length) return null;
      params[name] = tokens[i]!;
      i++;
      continue;
    }
    // literal keyword
    if (i >= tokens.length) return null;
    if (tokens[i]!.toLowerCase() !== part.toLowerCase()) return null;
    i++;
  }

  return i === tokens.length ? params : null; // no leftover tokens
}

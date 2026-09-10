import type { CommandSpec } from "../types";

/** Walk only the current node: later arguments can never disambiguate a keyword. */
export function resolveTokens(commands: CommandSpec[], input: string[]) {
  let candidates = commands.map((spec) => ({ spec, parts: spec.pattern.split(" "), index: 0, rest: false }));
  const tokens: string[] = [];
  for (const [index, token] of input.entries()) {
    const typed = token.toLowerCase();
    const literals = [...new Set(candidates.flatMap((c) => {
      const part = c.parts[c.index];
      return !c.rest && part && !part.startsWith("{") && part.toLowerCase().startsWith(typed) ? [part] : [];
    }))];
    const exact = literals.find((part) => part.toLowerCase() === typed);
    if (!exact && literals.length > 1) return { tokens, candidates, error: "ambiguous" as const, index };
    const literal = exact ?? literals[0];
    const next = candidates.filter((c) => {
      const part = c.parts[c.index];
      return literal ? !c.rest && part === literal : c.rest || part?.startsWith("{");
    });
    if (next.length === 0) return { tokens, candidates, error: "invalid" as const, index };
    tokens.push(literal ?? token);
    candidates = next.map((c) => {
      const rest = c.rest || c.parts[c.index]?.endsWith("...}") === true;
      return { ...c, rest, index: rest ? c.index : c.index + 1 };
    });
  }
  return { tokens, candidates, error: undefined, index: input.length };
}

export function nextTokens(result: ReturnType<typeof resolveTokens>): string[] {
  return [...new Set(result.candidates.flatMap((c) => {
    if (c.rest) return ["<cr>", c.parts[c.index]!];
    return [c.parts[c.index] ?? "<cr>"];
  }))];
}

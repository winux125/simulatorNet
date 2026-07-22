/**
 * The lexer. A CLI line is whitespace-separated tokens; there are no quotes or
 * operators in the supported command set, so tokenizing is a simple split.
 * `description <text>` keeps its trailing words as separate tokens — the parser
 * rejoins them.
 */
export function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter((t) => t.length > 0);
}

/** Comparison key only: lookup must still return an existing domain interface ID. */
export function normalizeInterfaceName(name: string): string {
  const compact = name.toLowerCase().replace(/\s+/gu, "");
  const aliases: ReadonlyArray<readonly [RegExp, string]> = [
    [/^(?:gigabitethernet|gigabit|gig|ge|gi|g)(?=\d)/u, "gi"],
    [/^(?:tengigabitethernet|tengige|te)(?=\d)/u, "te"],
    [/^(?:fastethernet|fast|fa|fe|f)(?=\d)/u, "fa"],
    [/^(?:ethernet|eth|et|e)(?=\d)/u, "eth"],
    [/^(?:serial|ser|se|s)(?=\d)/u, "se"],
    [/^(?:loopback|loop|lo)(?=\d)/u, "lo"],
    [/^(?:management|mgmt|ma)(?=\d)/u, "ma"],
    [/^(?:vlan|vl)(?=\d)/u, "vlan"],
    [/^(?:port-channel|po)(?=\d)/u, "port-channel"],
    [/^(?:tunnel|tu)(?=\d)/u, "tunnel"],
  ];
  for (const [pattern, canonical] of aliases) {
    if (pattern.test(compact)) return compact.replace(pattern, canonical);
  }
  return compact;
}

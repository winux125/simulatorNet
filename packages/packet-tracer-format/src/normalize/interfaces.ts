/**
 * Interface-name normalization.
 *
 * Packet Tracer writes full names ("FastEthernet0/1"); SimulatorNet's device
 * profiles use the abbreviated form ("Fa0/1") and hosts use "eth0". Translating
 * between them is pure string work over a known vocabulary, so it lives here
 * with the rest of the Packet Tracer vocabulary rather than in the importer.
 *
 * Resolution is deliberately strict about the last step. A name that cannot be
 * matched to a real interface on the target device returns undefined so the
 * caller can leave the endpoint unresolved and ask the user. Attaching a cable
 * to the nearest free port instead would silently rewire the lab.
 */

/** Full Packet Tracer media prefixes and their SimulatorNet abbreviations. */
const MEDIA_PREFIXES: readonly (readonly [RegExp, string])[] = [
  [/^tengigabitethernet/iu, "Te"],
  [/^gigabitethernet/iu, "Gi"],
  [/^fastethernet/iu, "Fa"],
  [/^ethernet/iu, "Eth"],
  [/^serial/iu, "Se"],
  [/^loopback/iu, "Lo"],
  [/^vlan/iu, "Vlan"],
  [/^tunnel/iu, "Tunnel"],
  [/^port-?channel/iu, "Po"],
  [/^wireless/iu, "Wlan"],
  // Already-abbreviated forms pass through unchanged.
  [/^te(?=\d)/iu, "Te"],
  [/^gi(?=\d)/iu, "Gi"],
  [/^fa(?=\d)/iu, "Fa"],
  [/^eth(?=\d)/iu, "Eth"],
  [/^se(?=\d)/iu, "Se"],
  [/^lo(?=\d)/iu, "Lo"],
  [/^po(?=\d)/iu, "Po"],
];

export interface ParsedInterfaceName {
  /** Abbreviated media prefix, e.g. "Fa", "Gi". */
  readonly prefix: string;
  /** Slot/port suffix exactly as written, e.g. "0/1" or "0". */
  readonly suffix: string;
  /** The abbreviated whole, e.g. "Fa0/1". */
  readonly abbreviated: string;
}

/**
 * Split a Packet Tracer interface name into its media prefix and suffix.
 * Returns undefined for a name whose media this vocabulary does not know,
 * which the caller reports rather than guessing at.
 */
export function parsePacketTracerInterfaceName(name: string): ParsedInterfaceName | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return undefined;
  for (const [pattern, prefix] of MEDIA_PREFIXES) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const suffix = trimmed.slice(match[0].length).trim();
    if (!/^\d+(?:\/\d+)*$/u.test(suffix)) continue;
    return { prefix, suffix, abbreviated: `${prefix}${suffix}` };
  }
  return undefined;
}

/** True when the interface is a host-style port rather than a slotted one. */
const isHostStyle = (templates: readonly string[]): boolean =>
  templates.some((id) => /^(?:eth|wlan)\d+$/iu.test(id));

/**
 * Ethernet media prefixes, in the order a substitution should prefer them.
 *
 * A Packet Tracer 2811 has `FastEthernet0/0` where a SimulatorNet router has
 * `GigabitEthernet0/0` — the same physical position on the same medium, at a
 * speed this simulator does not model separately. Everything outside this set
 * — Serial, Loopback, Vlan, Tunnel, Port-channel — is a different medium
 * entirely and is never substituted for another.
 */
const ETHERNET_PREFIXES: readonly string[] = ["Te", "Gi", "Fa", "Eth"];

const isEthernetPrefix = (prefix: string): boolean =>
  ETHERNET_PREFIXES.some((candidate) => candidate.toLowerCase() === prefix.toLowerCase());

/** How an interface name was matched, so the caller can report a substitution. */
export type InterfaceMatchKind =
  | "exact"
  | "abbreviated"
  | "same-shape"
  /** Same slot and port on the same medium, at a different Ethernet speed. */
  | "ethernet-speed"
  /** Host port chosen by ordinal, safe only because a host has no slots. */
  | "positional";

export interface ResolvedInterface {
  readonly id: string;
  readonly match: InterfaceMatchKind;
}

/**
 * Resolve a Packet Tracer interface name onto one of `templates`, which are the
 * target device's real interface ids.
 *
 * Priority, highest first:
 *   1. exact match (case-insensitive) against a template;
 *   2. the abbreviated form of the Packet Tracer name;
 *   3. same media prefix and same slot suffix;
 *   4. same slot suffix on another Ethernet speed;
 *   5. for host-style targets ("eth0"), positional mapping by port ordinal.
 *
 * Anything else is unresolved. Note what step 4 is *not*: it never takes a
 * different position, and it never crosses a medium. `FastEthernet0/0` resolves
 * to `GigabitEthernet0/0` and to nothing else, so a lab cannot be rewired by
 * it — only relabelled. `Serial0/0/0` stays unresolved, because SimulatorNet
 * has no serial interface to put it on.
 */
export function resolvePacketTracerInterface(
  packetTracerName: string,
  templates: readonly string[],
  /** Ordinal of this interface among the source device's cabled ports. */
  ordinal = 0,
): ResolvedInterface | undefined {
  const trimmed = packetTracerName.trim();
  const lowered = trimmed.toLowerCase();

  const exact = templates.find((id) => id.toLowerCase() === lowered);
  if (exact !== undefined) return { id: exact, match: "exact" };

  const parsed = parsePacketTracerInterfaceName(trimmed);
  if (parsed) {
    const abbreviated = templates.find((id) => id.toLowerCase() === parsed.abbreviated.toLowerCase());
    if (abbreviated !== undefined) return { id: abbreviated, match: "abbreviated" };

    const shapes = templates
      .map((id) => ({ id, parsed: parsePacketTracerInterfaceName(id) }))
      .filter((entry): entry is { id: string; parsed: ParsedInterfaceName } => entry.parsed !== undefined
        && entry.parsed.suffix === parsed.suffix);

    // Same media, same slot numbering — covers "Ethernet0/1" against "Eth0/1".
    const sameShape = shapes.find((entry) =>
      entry.parsed.prefix.toLowerCase() === parsed.prefix.toLowerCase());
    if (sameShape !== undefined) return { id: sameShape.id, match: "same-shape" };

    // Same position, different Ethernet speed. Ordered so the choice is stable
    // rather than dependent on how the profile happened to list its ports.
    //
    // Only a slotted name qualifies. An unslotted "FastEthernet0" is a host
    // port, and its "0" is an ordinal rather than a slot — matching it against
    // "eth0" would be a coincidence of digits, not the same position. Those
    // belong to the positional rule below, which is written for them.
    if (isEthernetPrefix(parsed.prefix) && parsed.suffix.includes("/")) {
      for (const prefix of ETHERNET_PREFIXES) {
        const candidate = shapes.find((entry) =>
          entry.parsed.prefix.toLowerCase() === prefix.toLowerCase());
        if (candidate !== undefined) return { id: candidate.id, match: "ethernet-speed" };
      }
    }
  }

  // A host has one or two unslotted ports and Packet Tracer calls the first one
  // "FastEthernet0". Positional mapping is safe here precisely because the
  // target has no slots to get wrong.
  if (isHostStyle(templates)) {
    const ethernet = templates.filter((id) => /^eth\d+$/iu.test(id));
    const wireless = templates.filter((id) => /^wlan\d+$/iu.test(id));
    const wantsWireless = /^wireless|^wlan/iu.test(trimmed);
    const pool = wantsWireless && wireless.length > 0 ? wireless : ethernet;
    const chosen = pool[Math.min(ordinal, pool.length - 1)];
    if (chosen !== undefined) return { id: chosen, match: "positional" };
  }

  return undefined;
}

/** The resolved id alone, for a caller that does not report the match kind. */
export function resolveInterfaceOnDevice(
  packetTracerName: string,
  templates: readonly string[],
  ordinal = 0,
): string | undefined {
  return resolvePacketTracerInterface(packetTracerName, templates, ordinal)?.id;
}

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
 * Resolve a Packet Tracer interface name onto one of `templates`, which are the
 * target device's real interface ids.
 *
 * Priority, highest first:
 *   1. exact match (case-insensitive) against a template;
 *   2. the abbreviated form of the Packet Tracer name;
 *   3. same media prefix and same slot suffix;
 *   4. for host-style targets ("eth0"), positional mapping by port ordinal.
 *
 * Anything else is unresolved.
 */
export function resolveInterfaceOnDevice(
  packetTracerName: string,
  templates: readonly string[],
  /** Ordinal of this interface among the source device's cabled ports. */
  ordinal = 0,
): string | undefined {
  const trimmed = packetTracerName.trim();
  const lowered = trimmed.toLowerCase();

  const exact = templates.find((id) => id.toLowerCase() === lowered);
  if (exact !== undefined) return exact;

  const parsed = parsePacketTracerInterfaceName(trimmed);
  if (parsed) {
    const abbreviated = templates.find((id) => id.toLowerCase() === parsed.abbreviated.toLowerCase());
    if (abbreviated !== undefined) return abbreviated;

    // Same media, same slot numbering — covers "Ethernet0/1" against "Eth0/1".
    const sameShape = templates.find((id) => {
      const template = parsePacketTracerInterfaceName(id);
      return template !== undefined
        && template.prefix.toLowerCase() === parsed.prefix.toLowerCase()
        && template.suffix === parsed.suffix;
    });
    if (sameShape !== undefined) return sameShape;
  }

  // A host has one or two unslotted ports and Packet Tracer calls the first one
  // "FastEthernet0". Positional mapping is safe here precisely because the
  // target has no slots to get wrong.
  if (isHostStyle(templates)) {
    const ethernet = templates.filter((id) => /^eth\d+$/iu.test(id));
    const wireless = templates.filter((id) => /^wlan\d+$/iu.test(id));
    const wantsWireless = /^wireless|^wlan/iu.test(trimmed);
    const pool = wantsWireless && wireless.length > 0 ? wireless : ethernet;
    if (pool.length > 0) return pool[Math.min(ordinal, pool.length - 1)];
  }

  return undefined;
}

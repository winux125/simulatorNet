/**
 * Cisco IOS-like startup-config subset applier. It reads a small, well-defined
 * set of commands (hostname, interface addressing/shutdown/description, static
 * routes, VLANs, switchport access) into structured data and returns every line
 * it did NOT understand untouched. Nothing is executed or replayed through an
 * interactive terminal; unknown source config is never silently dropped.
 */

export interface ImportedInterfaceConfig {
  id: string;
  ipv4?: { address: string; prefixLength: number };
  shutdown: boolean;
  description?: string;
  switchportMode?: "access" | "trunk";
  accessVlan?: number;
}

export interface ImportedDeviceConfiguration {
  hostname?: string;
  interfaces: ImportedInterfaceConfig[];
  staticRoutes: Array<{ network: string; prefixLength: number; nextHop: string }>;
  vlans: Array<{ id: number; name: string }>;
  appliedLines: string[];
  unparsedLines: string[];
}

function isIpv4(value: string | undefined): value is string {
  if (!value) return false;
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/** Convert a dotted subnet mask to a prefix length, or undefined if not a mask. */
export function maskToPrefix(mask: string | undefined): number | undefined {
  if (!mask) return undefined;
  const octets = mask.split(".");
  if (octets.length !== 4) return undefined;
  let bits = 0;
  let seenZero = false;
  for (const octet of octets) {
    const value = Number(octet);
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
    for (let bit = 7; bit >= 0; bit--) {
      if ((value >> bit) & 1) { if (seenZero) return undefined; bits++; } else seenZero = true;
    }
  }
  return bits;
}

const PREFIX_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:gigabitethernet|gigabit|gig|ge|gi)/u, "gi"],
  [/^(?:tengigabitethernet|tengige|te)/u, "te"],
  [/^(?:fastethernet|fast|fa|fe)/u, "fa"],
  [/^(?:ethernet|eth|et|e)/u, "eth"],
  [/^(?:serial|ser|se|s)/u, "se"],
  [/^(?:loopback|loop|lo)/u, "lo"],
  [/^(?:management|mgmt|ma)/u, "ma"],
  [/^(?:vlan|vl)/u, "vlan"],
];

/** Normalise an interface name so abbreviations and casing compare equal. */
export function normalizeInterfaceName(name: string): string {
  const compact = name.toLowerCase().replace(/\s+/gu, "");
  for (const [pattern, canonical] of PREFIX_ALIASES) {
    const match = pattern.exec(compact);
    if (match && match[0].length > 0) return canonical + compact.slice(match[0].length);
  }
  return compact;
}

export function parseIosConfig(text: string, interfaceNames: readonly string[]): ImportedDeviceConfiguration {
  const resolve = new Map<string, string>();
  for (const name of interfaceNames) resolve.set(normalizeInterfaceName(name), name);
  const interfaces = new Map<string, ImportedInterfaceConfig>();
  const ensureInterface = (id: string): ImportedInterfaceConfig => {
    const existing = interfaces.get(id);
    if (existing) return existing;
    const created: ImportedInterfaceConfig = { id, shutdown: false };
    interfaces.set(id, created);
    return created;
  };

  const result: ImportedDeviceConfiguration = {
    interfaces: [], staticRoutes: [], vlans: [], appliedLines: [], unparsedLines: [],
  };
  const vlanNames = new Map<number, string>();
  let current: ImportedInterfaceConfig | undefined;
  let currentVlan: number | undefined;
  const applied = (line: string): void => { result.appliedLines.push(line.trim()); };
  const unparsed = (line: string): void => { result.unparsedLines.push(line.trim()); };

  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.replace(/\s+$/u, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed === "!" || trimmed === "end") { current = undefined; currentVlan = undefined; continue; }
    const tokens = trimmed.split(/\s+/u);
    const head = tokens[0]!.toLowerCase();
    const isIndented = raw.startsWith(" ") || raw.startsWith("\t");

    if (head === "hostname" && tokens[1]) { result.hostname = tokens[1]; applied(line); current = undefined; continue; }
    if (head === "interface") {
      const actual = resolve.get(normalizeInterfaceName(tokens.slice(1).join("")));
      currentVlan = undefined;
      if (actual) { current = ensureInterface(actual); applied(line); } else { current = undefined; unparsed(line); }
      continue;
    }
    if (head === "ip" && tokens[1]?.toLowerCase() === "route" && isIpv4(tokens[2]) && isIpv4(tokens[4])) {
      const prefix = maskToPrefix(tokens[3]);
      if (prefix !== undefined) { result.staticRoutes.push({ network: tokens[2], prefixLength: prefix, nextHop: tokens[4] }); applied(line); }
      else unparsed(line);
      current = undefined;
      continue;
    }
    if (head === "vlan" && /^\d+$/u.test(tokens[1] ?? "")) { currentVlan = Number(tokens[1]); current = undefined; applied(line); continue; }
    if (head === "name" && currentVlan !== undefined && tokens[1]) { vlanNames.set(currentVlan, tokens.slice(1).join(" ")); applied(line); continue; }

    if (current && isIndented) {
      if (head === "ip" && tokens[1]?.toLowerCase() === "address" && isIpv4(tokens[2])) {
        const prefix = maskToPrefix(tokens[3]);
        if (prefix !== undefined) { current.ipv4 = { address: tokens[2], prefixLength: prefix }; applied(line); continue; }
      }
      if (head === "shutdown") { current.shutdown = true; applied(line); continue; }
      if (head === "no" && tokens[1]?.toLowerCase() === "shutdown") { current.shutdown = false; applied(line); continue; }
      if (head === "description" && tokens.length > 1) { current.description = tokens.slice(1).join(" "); applied(line); continue; }
      if (head === "switchport" && tokens[1]?.toLowerCase() === "mode" && (tokens[2] === "access" || tokens[2] === "trunk")) {
        current.switchportMode = tokens[2]; applied(line); continue;
      }
      if (head === "switchport" && tokens[1]?.toLowerCase() === "access" && tokens[2]?.toLowerCase() === "vlan" && /^\d+$/u.test(tokens[3] ?? "")) {
        current.accessVlan = Number(tokens[3]); applied(line); continue;
      }
    }
    unparsed(line);
  }

  result.interfaces = [...interfaces.values()];
  result.vlans = [...vlanNames.entries()].map(([id, name]) => ({ id, name }));
  return result;
}

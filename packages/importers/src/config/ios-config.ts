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
  /** `spanning-tree portfast` / `spanning-tree bpduguard enable`. */
  portFast?: boolean;
  bpduGuard?: boolean;
  spanningTreeCost?: number;
  spanningTreePriority?: number;
  /** `channel-group <id> mode <mode>`. */
  channelGroup?: { id: number; mode: "on" | "active" | "passive" | "desirable" | "auto" };
  /** `no cdp enable`, `no lldp transmit`, `no lldp receive`. */
  cdpEnabled?: boolean;
  lldpTransmit?: boolean;
  lldpReceive?: boolean;
  /** `ip ospf <process> area 0` and friends. */
  ospf?: {
    enabled?: boolean;
    cost?: number;
    priority?: number;
    networkType?: "broadcast" | "point-to-point";
    helloIntervalSeconds?: number;
    deadIntervalSeconds?: number;
  };
}

/** `interface Loopback<n>` recognised from an imported startup-config. */
export interface ImportedLoopbackConfig {
  id: number;
  description?: string;
  shutdown: boolean;
  ipv4?: { address: string; prefixLength: number };
}

export interface ImportedOspfConfig {
  processId: number;
  routerId?: string;
  networks: Array<{ network: string; wildcard: string; area: number }>;
  passiveInterfaces: string[];
}

export interface ImportedDeviceConfiguration {
  hostname?: string;
  interfaces: ImportedInterfaceConfig[];
  loopbacks: ImportedLoopbackConfig[];
  staticRoutes: Array<{ network: string; prefixLength: number; nextHop: string }>;
  vlans: Array<{ id: number; name: string }>;
  /** `spanning-tree mode pvst|rapid-pvst`; absent means the default (disabled). */
  spanningTreeMode?: "stp" | "rstp";
  spanningTreeVlanPriorities: Array<{ vlanId: number; priority: number }>;
  cdpEnabled?: boolean;
  lldpEnabled?: boolean;
  ospf?: ImportedOspfConfig;
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
    interfaces: [],
    loopbacks: [],
    staticRoutes: [],
    vlans: [],
    spanningTreeVlanPriorities: [],
    appliedLines: [],
    unparsedLines: [],
  };
  const vlanNames = new Map<number, string>();
  const loopbacks = new Map<number, ImportedLoopbackConfig>();
  let current: ImportedInterfaceConfig | undefined;
  let currentLoopback: ImportedLoopbackConfig | undefined;
  let currentVlan: number | undefined;
  let inOspf = false;
  const applied = (line: string): void => { result.appliedLines.push(line.trim()); };
  const unparsed = (line: string): void => { result.unparsedLines.push(line.trim()); };

  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.replace(/\s+$/u, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed === "!" || trimmed === "end") {
      current = undefined;
      currentLoopback = undefined;
      currentVlan = undefined;
      inOspf = false;
      continue;
    }
    const tokens = trimmed.split(/\s+/u);
    const head = tokens[0]!.toLowerCase();
    const isIndented = raw.startsWith(" ") || raw.startsWith("\t");

    if (head === "hostname" && tokens[1]) { result.hostname = tokens[1]; applied(line); current = undefined; continue; }
    if (head === "interface") {
      const spec = tokens.slice(1).join("");
      currentVlan = undefined;
      inOspf = false;
      const loopbackMatch = /^lo(?:opback)?(\d+)$/u.exec(normalizeInterfaceName(spec));
      if (loopbackMatch) {
        const id = Number(loopbackMatch[1]);
        currentLoopback = loopbacks.get(id) ?? { id, shutdown: false };
        loopbacks.set(id, currentLoopback);
        current = undefined;
        applied(line);
        continue;
      }
      currentLoopback = undefined;
      const actual = resolve.get(normalizeInterfaceName(spec));
      if (actual) { current = ensureInterface(actual); applied(line); } else { current = undefined; unparsed(line); }
      continue;
    }

    // --- global control-protocol commands ---------------------------------
    if (head === "spanning-tree" && tokens[1]?.toLowerCase() === "mode") {
      const mode = tokens[2]?.toLowerCase();
      if (mode === "pvst") { result.spanningTreeMode = "stp"; applied(line); continue; }
      if (mode === "rapid-pvst") { result.spanningTreeMode = "rstp"; applied(line); continue; }
      // MST and MST regions are explicitly out of scope for this release.
      unparsed(line);
      continue;
    }
    if (head === "spanning-tree" && tokens[1]?.toLowerCase() === "vlan"
      && /^\d+$/u.test(tokens[2] ?? "") && tokens[3]?.toLowerCase() === "priority"
      && /^\d+$/u.test(tokens[4] ?? "")) {
      const priority = Number(tokens[4]);
      if (priority % 4096 === 0 && priority <= 61_440) {
        result.spanningTreeVlanPriorities.push({ vlanId: Number(tokens[2]), priority });
        applied(line);
      } else unparsed(line);
      continue;
    }
    if (head === "cdp" && tokens[1]?.toLowerCase() === "run" && !isIndented) {
      result.cdpEnabled = true; applied(line); continue;
    }
    if (head === "no" && tokens[1]?.toLowerCase() === "cdp" && tokens[2]?.toLowerCase() === "run" && !isIndented) {
      result.cdpEnabled = false; applied(line); continue;
    }
    if (head === "lldp" && tokens[1]?.toLowerCase() === "run" && !isIndented) {
      result.lldpEnabled = true; applied(line); continue;
    }
    if (head === "no" && tokens[1]?.toLowerCase() === "lldp" && tokens[2]?.toLowerCase() === "run" && !isIndented) {
      result.lldpEnabled = false; applied(line); continue;
    }
    if (head === "router" && tokens[1]?.toLowerCase() === "ospf" && /^\d+$/u.test(tokens[2] ?? "")) {
      result.ospf = { processId: Number(tokens[2]), networks: [], passiveInterfaces: [] };
      inOspf = true;
      current = undefined;
      currentLoopback = undefined;
      applied(line);
      continue;
    }
    // Other routing protocols stay unparsed and are reported honestly.
    if (head === "router") { inOspf = false; current = undefined; unparsed(line); continue; }

    if (inOspf && result.ospf && isIndented) {
      if (head === "router-id" && isIpv4(tokens[1])) { result.ospf.routerId = tokens[1]; applied(line); continue; }
      if (head === "network" && isIpv4(tokens[1]) && isIpv4(tokens[2])
        && tokens[3]?.toLowerCase() === "area" && /^\d+$/u.test(tokens[4] ?? "")) {
        const area = Number(tokens[4]);
        // Only the backbone area is supported; anything else is reported.
        if (area === 0) {
          result.ospf.networks.push({ network: tokens[1], wildcard: tokens[2], area });
          applied(line);
        } else unparsed(line);
        continue;
      }
      if (head === "passive-interface" && tokens[1]) {
        const actual = resolve.get(normalizeInterfaceName(tokens[1]))
          ?? (/^lo(?:opback)?\d+$/u.test(normalizeInterfaceName(tokens[1]))
            ? `Loopback${/(\d+)$/u.exec(tokens[1])?.[1]}`
            : undefined);
        if (actual) { result.ospf.passiveInterfaces.push(actual); applied(line); } else unparsed(line);
        continue;
      }
    }

    if (currentLoopback && isIndented) {
      if (head === "ip" && tokens[1]?.toLowerCase() === "address" && isIpv4(tokens[2])) {
        const prefix = maskToPrefix(tokens[3]);
        if (prefix !== undefined) { currentLoopback.ipv4 = { address: tokens[2], prefixLength: prefix }; applied(line); continue; }
      }
      if (head === "description" && tokens.length > 1) {
        currentLoopback.description = tokens.slice(1).join(" "); applied(line); continue;
      }
      if (head === "shutdown") { currentLoopback.shutdown = true; applied(line); continue; }
      if (head === "no" && tokens[1]?.toLowerCase() === "shutdown") { currentLoopback.shutdown = false; applied(line); continue; }
      unparsed(line);
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
      // --- interface control-protocol commands ----------------------------
      if (head === "spanning-tree" && tokens[1]?.toLowerCase() === "portfast") {
        current.portFast = true; applied(line); continue;
      }
      if (head === "no" && tokens[1]?.toLowerCase() === "spanning-tree" && tokens[2]?.toLowerCase() === "portfast") {
        current.portFast = false; applied(line); continue;
      }
      if (head === "spanning-tree" && tokens[1]?.toLowerCase() === "bpduguard") {
        const state = tokens[2]?.toLowerCase();
        if (state === "enable" || state === "disable") { current.bpduGuard = state === "enable"; applied(line); continue; }
      }
      if (head === "spanning-tree" && tokens[1]?.toLowerCase() === "cost" && /^\d+$/u.test(tokens[2] ?? "")) {
        current.spanningTreeCost = Number(tokens[2]); applied(line); continue;
      }
      if (head === "spanning-tree" && tokens[1]?.toLowerCase() === "port-priority" && /^\d+$/u.test(tokens[2] ?? "")) {
        const priority = Number(tokens[2]);
        if (priority % 16 === 0 && priority <= 240) { current.spanningTreePriority = priority; applied(line); continue; }
      }
      if (head === "channel-group" && /^\d+$/u.test(tokens[1] ?? "") && tokens[2]?.toLowerCase() === "mode") {
        const mode = tokens[3]?.toLowerCase();
        if (mode === "on" || mode === "active" || mode === "passive" || mode === "desirable" || mode === "auto") {
          current.channelGroup = { id: Number(tokens[1]), mode };
          applied(line);
          continue;
        }
      }
      if (head === "cdp" && tokens[1]?.toLowerCase() === "enable") { current.cdpEnabled = true; applied(line); continue; }
      if (head === "no" && tokens[1]?.toLowerCase() === "cdp" && tokens[2]?.toLowerCase() === "enable") {
        current.cdpEnabled = false; applied(line); continue;
      }
      if (head === "lldp" && (tokens[1]?.toLowerCase() === "transmit" || tokens[1]?.toLowerCase() === "receive")) {
        if (tokens[1].toLowerCase() === "transmit") current.lldpTransmit = true;
        else current.lldpReceive = true;
        applied(line);
        continue;
      }
      if (head === "no" && tokens[1]?.toLowerCase() === "lldp"
        && (tokens[2]?.toLowerCase() === "transmit" || tokens[2]?.toLowerCase() === "receive")) {
        if (tokens[2].toLowerCase() === "transmit") current.lldpTransmit = false;
        else current.lldpReceive = false;
        applied(line);
        continue;
      }
      if (head === "ip" && tokens[1]?.toLowerCase() === "ospf") {
        const ospf = current.ospf ?? {};
        const keyword = tokens[2]?.toLowerCase();
        if (/^\d+$/u.test(tokens[2] ?? "") && tokens[3]?.toLowerCase() === "area" && tokens[4] === "0") {
          ospf.enabled = true;
          current.ospf = ospf;
          applied(line);
          continue;
        }
        if (keyword === "cost" && /^\d+$/u.test(tokens[3] ?? "")) {
          ospf.cost = Number(tokens[3]); current.ospf = ospf; applied(line); continue;
        }
        if (keyword === "priority" && /^\d+$/u.test(tokens[3] ?? "")) {
          ospf.priority = Number(tokens[3]); current.ospf = ospf; applied(line); continue;
        }
        if (keyword === "network" && (tokens[3] === "point-to-point" || tokens[3] === "broadcast")) {
          ospf.networkType = tokens[3]; current.ospf = ospf; applied(line); continue;
        }
        if (keyword === "hello-interval" && /^\d+$/u.test(tokens[3] ?? "")) {
          ospf.helloIntervalSeconds = Number(tokens[3]); current.ospf = ospf; applied(line); continue;
        }
        if (keyword === "dead-interval" && /^\d+$/u.test(tokens[3] ?? "")) {
          ospf.deadIntervalSeconds = Number(tokens[3]); current.ospf = ospf; applied(line); continue;
        }
      }
    }
    unparsed(line);
  }

  result.interfaces = [...interfaces.values()];
  result.loopbacks = [...loopbacks.values()].sort((a, b) => a.id - b.id);
  result.vlans = [...vlanNames.entries()].map(([id, name]) => ({ id, name }));
  return result;
}

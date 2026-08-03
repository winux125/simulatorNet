/**
 * Cisco IOS-like startup-config subset applier. It reads a small, well-defined
 * set of commands (hostname, interface addressing/shutdown/description, static
 * routes, VLANs, switchport access) into structured data and returns every line
 * it did NOT understand untouched. Nothing is executed or replayed through an
 * interactive terminal; unknown source config is never silently dropped.
 */
import {
  Ipv6CidrSchema,
  Ipv6Schema,
  MAXIMUM_TUNNEL_MTU,
  MAXIMUM_VPN_LIFETIME_SECONDS,
  MINIMUM_TUNNEL_MTU,
  MINIMUM_VPN_LIFETIME_SECONDS,
  type Ipv6AclConfig,
  type BgpProcessConfig,
  type LdpConfig,
  type PrefixListConfig,
  type RouteMapConfig,
  type RouteMapSequenceConfig,
  type VrfConfig,
  type Ospfv3ProcessConfig,
  type QosClassMapConfig,
  type QosConfiguration,
  type QosMatchRuleConfig,
  type QosPolicyClassConfig,
  type QosPolicyMapConfig,
  parseDscpToken,
} from "@sim/contracts";
import { isCredentialLine, redactConfigurationLine } from "./credentials";

export interface ImportedInterfaceConfig {
  id: string;
  ipv4?: { address: string; prefixLength: number };
  ipv6?: Array<{ address: string; prefixLength: number }>;
  shutdown: boolean;
  description?: string;
  mplsEnabled?: boolean;
  vrfId?: string;
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
  ospfv3?: {
    enabled?: boolean;
    cost?: number;
  };
  ipv6TrafficFilters?: Array<{ aclId: string; direction: "in" | "out" }>;
  /** `service-policy input|output <policy-map>`. */
  servicePolicies?: Array<{ direction: "input" | "output"; policyMapId: string }>;
}

/** `interface Loopback<n>` recognised from an imported startup-config. */
export interface ImportedLoopbackConfig {
  id: number;
  description?: string;
  shutdown: boolean;
  ipv4?: { address: string; prefixLength: number };
  ipv6?: Array<{ address: string; prefixLength: number }>;
}

/**
 * `interface Tunnel<n>` recognised from an imported startup-config.
 *
 * Only the GRE-over-IPv4 subset SimulatorNet actually simulates is mapped.
 * Crypto maps, IKEv1, certificate trustpoints, transport mode and NAT traversal
 * are never invented: they stay in `unparsedLines` and are reported honestly.
 */
export interface ImportedTunnelConfig {
  id: number;
  description?: string;
  shutdown: boolean;
  ipv4?: { address: string; prefixLength: number };
  ipv6?: Array<{ address: string; prefixLength: number }>;
  sourceInterface?: string;
  sourceAddress?: string;
  destinationAddress?: string;
  mode?: "gre-ipv4";
  mtu?: number;
  ttl?: number;
  ipsecProfileId?: string;
}

export interface ImportedIkeProposalConfig {
  id: string;
  encryption?: "sim-aes128" | "sim-aes256";
  integrity?: "sim-sha256";
}

export interface ImportedIkePeerConfig {
  id: string;
  address?: string;
  localIdentity?: string;
  remoteIdentity?: string;
  proposalId?: string;
  lifetimeSeconds?: number;
  /**
   * True when the source declared a pre-shared key. A vendor key or hash is
   * never decrypted, never re-derived and never preserved: the peer is imported
   * without a key and the learner must set one before the tunnel can protect.
   */
  credentialResetRequired: boolean;
}

export interface ImportedIpsecProfileConfig {
  id: string;
  ikePeerId?: string;
  proposalId?: string;
  lifetimeSeconds?: number;
}

export interface ImportedVpnConfiguration {
  tunnels: ImportedTunnelConfig[];
  proposals: ImportedIkeProposalConfig[];
  ikePeers: ImportedIkePeerConfig[];
  ipsecProfiles: ImportedIpsecProfileConfig[];
}

export interface ImportedOspfConfig {
  processId: number;
  routerId?: string;
  networks: Array<{ network: string; wildcard: string; area: number }>;
  passiveInterfaces: string[];
}

/** One source line and what the parser did with it. */
export interface ConfigLineOutcome {
  /** 1-based line number in the source text. */
  readonly number: number;
  /** The line as written, already redacted when it declares a credential. */
  readonly text: string;
  readonly outcome: "applied" | "unsupported";
  /** True when the line declares a password, key, community or passphrase. */
  readonly credential: boolean;
}

export interface ImportedDeviceConfiguration {
  hostname?: string;
  interfaces: ImportedInterfaceConfig[];
  loopbacks: ImportedLoopbackConfig[];
  staticRoutes: Array<{ network: string; prefixLength: number; nextHop: string }>;
  ipv6UnicastRoutingEnabled?: boolean;
  ipv6StaticRoutes: Array<{ network: string; prefixLength: number; nextHop: string }>;
  ipv6Acls: Ipv6AclConfig[];
  ipv6AclBindings: Array<{ interfaceName: string; direction: "in" | "out"; aclId: string }>;
  vlans: Array<{ id: number; name: string }>;
  /** `bridge aging-time <seconds>`, understood by the Ethernet bridge. */
  bridgeAgingTimeSeconds?: number;
  /** `spanning-tree mode pvst|rapid-pvst`; absent means the default (disabled). */
  spanningTreeMode?: "stp" | "rstp";
  spanningTreeVlanPriorities: Array<{ vlanId: number; priority: number }>;
  cdpEnabled?: boolean;
  lldpEnabled?: boolean;
  ospf?: ImportedOspfConfig;
  ospfv3?: Ospfv3ProcessConfig;
  bgp?: BgpProcessConfig;
  ldp?: LdpConfig;
  vrfs: VrfConfig[];
  prefixLists: PrefixListConfig[];
  routeMaps: RouteMapConfig[];
  /**
   * The recognised MQC subset: class-map, match, policy-map, class, set dscp,
   * priority/bandwidth percent, police, shape average. Anything else stays in
   * `unparsedLines` and is reported honestly by the import report.
   */
  qos: QosConfiguration;
  /**
   * The recognised site-to-site VPN subset: Tunnel interfaces, tunnel
   * source/destination/mode/mtu/ttl, tunnel protection, and the simplified
   * IKEv2 proposal/peer and IPsec profile blocks.
   */
  vpn: ImportedVpnConfiguration;
  appliedLines: string[];
  unparsedLines: string[];
  /**
   * Every non-blank source line with its 1-based number, so a preview can point
   * at the exact line a learner has to fix. Redacted, so a report can never
   * echo a pasted password back onto the screen.
   */
  lines: ConfigLineOutcome[];
}

function ipv6Cidr(value: string | undefined): { address: string; prefixLength: number } | undefined {
  const parsed = Ipv6CidrSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const slash = parsed.data.lastIndexOf("/");
  return { address: parsed.data.slice(0, slash), prefixLength: Number(parsed.data.slice(slash + 1)) };
}

function ipv6Matcher(tokens: string[], start: number) {
  const token = tokens[start]?.toLowerCase();
  if (token === "any") return { matcher: { kind: "any" as const }, consumed: 1 };
  if (token === "host" && Ipv6Schema.safeParse(tokens[start + 1]).success) {
    return { matcher: { kind: "host" as const, address: tokens[start + 1]! }, consumed: 2 };
  }
  const prefix = ipv6Cidr(tokens[start]);
  if (!prefix) return undefined;
  return {
    matcher: { kind: "prefix" as const, address: prefix.address, prefixLength: prefix.prefixLength },
    consumed: 1,
  };
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

/** The `match` forms the importer understands; everything else stays unparsed. */
function parseQosMatch(tokens: string[]): QosMatchRuleConfig | undefined {
  const keyword = tokens[1]?.toLowerCase();
  if (keyword === "any") return { kind: "any" };
  if (keyword === "dscp" && tokens[2]) {
    const dscp = parseDscpToken(tokens[2]);
    return dscp === undefined ? undefined : { kind: "dscp", values: [dscp] };
  }
  if (keyword === "precedence" && /^[0-7]$/u.test(tokens[2] ?? "")) {
    return { kind: "precedence", values: [Number(tokens[2])] };
  }
  if (keyword === "cos" && /^[0-7]$/u.test(tokens[2] ?? "")) {
    return { kind: "cos", values: [Number(tokens[2])] };
  }
  if (keyword === "protocol") {
    const protocol = tokens[2]?.toLowerCase();
    if (protocol === "icmp" || protocol === "tcp" || protocol === "udp") return { kind: "protocol", protocol };
    return undefined;
  }
  if (keyword === "access-group") {
    const aclId = tokens[2]?.toLowerCase() === "name" ? tokens[3] : tokens[2];
    return aclId ? { kind: "access-group", aclId } : undefined;
  }
  return undefined;
}

/** Bounded positive integer, or undefined when the token is not one. */
function boundedNumber(token: string | undefined, minimum: number, maximum: number): number | undefined {
  if (token === undefined) return undefined;
  const value = Number(token);
  if (!Number.isInteger(value) || value < minimum || value > maximum) return undefined;
  return value;
}

/**
 * The `interface Tunnel<n>` body the importer understands. Only GRE over IPv4
 * is mapped; `tunnel mode ipsec ipv4`, mGRE, NHRP and anything else fall
 * through to `unparsedLines`.
 */
function applyTunnelLine(
  tunnel: ImportedTunnelConfig,
  tokens: string[],
  head: string,
  resolveSource: (name: string) => string | undefined,
): boolean {
  if (head === "description" && tokens.length > 1) {
    tunnel.description = tokens.slice(1).join(" ");
    return true;
  }
  if (head === "shutdown") { tunnel.shutdown = true; return true; }
  if (head === "no" && tokens[1]?.toLowerCase() === "shutdown") { tunnel.shutdown = false; return true; }
  if (head === "ip" && tokens[1]?.toLowerCase() === "address" && isIpv4(tokens[2])) {
    const prefix = maskToPrefix(tokens[3]);
    if (prefix === undefined) return false;
    tunnel.ipv4 = { address: tokens[2], prefixLength: prefix };
    return true;
  }
  if (head === "ipv6" && tokens[1]?.toLowerCase() === "address") {
    const address = ipv6Cidr(tokens[2]);
    if (!address) return false;
    tunnel.ipv6 = [...(tunnel.ipv6 ?? []), address];
    return true;
  }
  if (head !== "tunnel") return false;
  const keyword = tokens[1]?.toLowerCase();
  if (keyword === "source" && tokens[2]) {
    if (isIpv4(tokens[2])) { tunnel.sourceAddress = tokens[2]; return true; }
    // Resolve the abbreviation to the interface the device actually has, so a
    // `tunnel source GigabitEthernet0/1` matches a mapped `Gi0/1`.
    const typed = tokens.slice(2).join("");
    const actual = resolveSource(typed);
    if (!actual) return false;
    tunnel.sourceInterface = actual;
    return true;
  }
  if (keyword === "destination" && isIpv4(tokens[2])) {
    tunnel.destinationAddress = tokens[2];
    return true;
  }
  if (keyword === "mode") {
    const mode = tokens.slice(2).map((token) => token.toLowerCase()).join(" ");
    // Only plain GRE over IPv4 is simulated; every other mode is unparsed.
    if (mode === "gre ip" || mode === "gre ipv4") { tunnel.mode = "gre-ipv4"; return true; }
    return false;
  }
  if (keyword === "mtu") {
    const mtu = boundedNumber(tokens[2], MINIMUM_TUNNEL_MTU, MAXIMUM_TUNNEL_MTU);
    if (mtu === undefined) return false;
    tunnel.mtu = mtu;
    return true;
  }
  if (keyword === "ttl") {
    const ttl = boundedNumber(tokens[2], 1, 255);
    if (ttl === undefined) return false;
    tunnel.ttl = ttl;
    return true;
  }
  if (keyword === "protection"
    && tokens[2]?.toLowerCase() === "ipsec"
    && tokens[3]?.toLowerCase() === "profile"
    && tokens[4]) {
    tunnel.ipsecProfileId = tokens[4];
    return true;
  }
  return false;
}

/**
 * The IKEv2 proposal body. A real transform name is never silently accepted:
 * SimulatorNet only has simulated `sim-` transforms, so `aes-cbc-256` maps to
 * the nearest simulated strength and anything unrecognised stays unparsed.
 */
function applyProposalLine(proposal: ImportedIkeProposalConfig, tokens: string[], head: string): boolean {
  const value = tokens[1]?.toLowerCase();
  if (head === "encryption" && value) {
    if (value.includes("128")) { proposal.encryption = "sim-aes128"; return true; }
    if (value.includes("256") || value.includes("aes")) { proposal.encryption = "sim-aes256"; return true; }
    return false;
  }
  if (head === "integrity" && value) {
    if (value.includes("sha256") || value.includes("sha-256")) { proposal.integrity = "sim-sha256"; return true; }
    return false;
  }
  return false;
}

/**
 * The IKEv2 peer body. A vendor pre-shared key — plaintext, `key 6` encrypted
 * or a password hash — is never decrypted and never preserved. The peer is
 * imported without a key and flagged so the learner sets one explicitly.
 */
function applyPeerLine(peer: ImportedIkePeerConfig, tokens: string[], head: string): boolean {
  if (head === "address" && isIpv4(tokens[1])) { peer.address = tokens[1]; return true; }
  if (head === "proposal" && tokens[1]) { peer.proposalId = tokens[1]; return true; }
  if (head === "lifetime") {
    const seconds = boundedNumber(tokens[1], MINIMUM_VPN_LIFETIME_SECONDS, MAXIMUM_VPN_LIFETIME_SECONDS);
    if (seconds === undefined) return false;
    peer.lifetimeSeconds = seconds;
    return true;
  }
  if (head === "identity" && tokens[2]) {
    const side = tokens[1]?.toLowerCase();
    if (side === "local") { peer.localIdentity = tokens.slice(2).join(" "); return true; }
    if (side === "remote") { peer.remoteIdentity = tokens.slice(2).join(" "); return true; }
    return false;
  }
  if (head === "pre-shared-key") {
    // Recognised, but the key itself is dropped: importing a credential a
    // learner cannot verify would be worse than requiring an explicit reset.
    peer.credentialResetRequired = true;
    return true;
  }
  return false;
}

/** The IPsec profile body: peer, proposal and lifetime. */
function applyProfileLine(profile: ImportedIpsecProfileConfig, tokens: string[], head: string): boolean {
  if (head === "set" && tokens[2]) {
    const keyword = tokens[1]?.toLowerCase();
    if (keyword === "ikev2-peer") { profile.ikePeerId = tokens[2]; return true; }
    if (keyword === "proposal" || keyword === "ikev2-proposal") { profile.proposalId = tokens[2]; return true; }
    return false;
  }
  if (head === "lifetime") {
    const seconds = boundedNumber(tokens[1], MINIMUM_VPN_LIFETIME_SECONDS, MAXIMUM_VPN_LIFETIME_SECONDS);
    if (seconds === undefined) return false;
    profile.lifetimeSeconds = seconds;
    return true;
  }
  return false;
}

/** The policy-map class actions the importer understands. */
function applyQosClassLine(entry: QosPolicyClassConfig, tokens: string[]): boolean {
  const head = tokens[0]?.toLowerCase();
  if (head === "set" && tokens[1]?.toLowerCase() === "dscp" && tokens[2]) {
    const dscp = parseDscpToken(tokens[2]);
    if (dscp === undefined) return false;
    entry.marking = { ...entry.marking, dscp };
    return true;
  }
  if (head === "set" && tokens[1]?.toLowerCase() === "precedence" && /^[0-7]$/u.test(tokens[2] ?? "")) {
    entry.marking = { ...entry.marking, precedence: Number(tokens[2]) };
    return true;
  }
  if (head === "set" && tokens[1]?.toLowerCase() === "cos" && /^[0-7]$/u.test(tokens[2] ?? "")) {
    entry.marking = { ...entry.marking, cos: Number(tokens[2]) };
    return true;
  }
  if (head === "priority" && tokens[1]?.toLowerCase() === "percent" && isPercent(tokens[2])) {
    entry.priority = { percent: Number(tokens[2]) };
    return true;
  }
  if (head === "bandwidth" && tokens[1]?.toLowerCase() === "percent" && isPercent(tokens[2])) {
    entry.bandwidthPercent = Number(tokens[2]);
    return true;
  }
  if (head === "shape" && tokens[1]?.toLowerCase() === "average" && /^\d+$/u.test(tokens[2] ?? "")) {
    entry.shape = { averageRateBps: Number(tokens[2]) };
    return true;
  }
  if (head === "police" && /^\d+$/u.test(tokens[1] ?? "") && /^\d+$/u.test(tokens[2] ?? "")) {
    // `police <bps> <burst> [conform-action transmit] [exceed-action drop]`.
    const exceedIndex = tokens.findIndex((token) => token.toLowerCase() === "exceed-action");
    const exceed = exceedIndex >= 0 ? tokens[exceedIndex + 1]?.toLowerCase() : "drop";
    if (exceed !== undefined && exceed !== "drop" && exceed !== "set-dscp-transmit") return false;
    if (exceed === "set-dscp-transmit") {
      const exceedDscp = parseDscpToken(tokens[exceedIndex + 2] ?? "");
      if (exceedDscp === undefined) return false;
      entry.police = {
        rateBps: Number(tokens[1]),
        burstBytes: Number(tokens[2]),
        exceedAction: "set-dscp-transmit",
        exceedDscp,
      };
      return true;
    }
    entry.police = { rateBps: Number(tokens[1]), burstBytes: Number(tokens[2]), exceedAction: "drop" };
    return true;
  }
  return false;
}

function isPercent(token: string | undefined): boolean {
  return /^\d{1,3}$/u.test(token ?? "") && Number(token) >= 1 && Number(token) <= 100;
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
    ipv6StaticRoutes: [],
    ipv6Acls: [],
    ipv6AclBindings: [],
    prefixLists: [],
    routeMaps: [],
    vrfs: [],
    vlans: [],
    spanningTreeVlanPriorities: [],
    qos: { classMaps: [], policyMaps: [], servicePolicies: [] },
    vpn: { tunnels: [], proposals: [], ikePeers: [], ipsecProfiles: [] },
    appliedLines: [],
    unparsedLines: [],
    lines: [],
  };
  const vlanNames = new Map<number, string>();
  const loopbacks = new Map<number, ImportedLoopbackConfig>();
  const tunnels = new Map<number, ImportedTunnelConfig>();
  let current: ImportedInterfaceConfig | undefined;
  let currentLoopback: ImportedLoopbackConfig | undefined;
  let currentVlan: number | undefined;
  let inOspf = false;
  let inOspfv3 = false;
  let inBgp = false;
  let currentBgpAddressFamily: { type: "vpnv4" } | { type: "ipv4-vrf"; vrfId: string } | undefined;
  let currentVrf: VrfConfig | undefined;
  let currentRouteMap: RouteMapSequenceConfig | undefined;
  let currentRouteMapId: string | undefined;
  let currentIpv6Acl: Ipv6AclConfig | undefined;
  let currentClassMap: QosClassMapConfig | undefined;
  let currentPolicyMap: QosPolicyMapConfig | undefined;
  let currentPolicyClass: QosPolicyClassConfig | undefined;
  let currentTunnel: ImportedTunnelConfig | undefined;
  let currentProposal: ImportedIkeProposalConfig | undefined;
  let currentPeer: ImportedIkePeerConfig | undefined;
  let currentProfile: ImportedIpsecProfileConfig | undefined;
  // The source line currently being read, so every outcome can be reported with
  // an exact 1-based line number without threading it through every branch.
  let lineNumber = 0;
  const record = (line: string, outcome: "applied" | "unsupported"): void => {
    const redacted = redactConfigurationLine(line).trim();
    result.lines.push({ number: lineNumber, text: redacted, outcome, credential: isCredentialLine(line) });
  };
  const applied = (line: string): void => {
    result.appliedLines.push(line.trim());
    record(line, "applied");
  };
  const unparsed = (line: string): void => {
    result.unparsedLines.push(line.trim());
    record(line, "unsupported");
  };
  const clearQosContext = (): void => {
    currentClassMap = undefined;
    currentPolicyMap = undefined;
    currentPolicyClass = undefined;
  };
  const clearCryptoContext = (): void => {
    currentProposal = undefined;
    currentPeer = undefined;
    currentProfile = undefined;
  };

  const sourceLines = text.split(/\r\n|\r|\n/u);
  for (let index = 0; index < sourceLines.length; index++) {
    const raw = sourceLines[index]!;
    lineNumber = index + 1;
    const line = raw.replace(/\s+$/u, "");
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed === "!" || trimmed === "end") {
      current = undefined;
      currentLoopback = undefined;
      currentTunnel = undefined;
      currentVlan = undefined;
      inOspf = false;
      inOspfv3 = false;
      inBgp = false;
      currentBgpAddressFamily = undefined;
      currentVrf = undefined;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      inBgp = false;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      currentIpv6Acl = undefined;
      clearQosContext();
      clearCryptoContext();
      continue;
    }
    const tokens = trimmed.split(/\s+/u);
    const head = tokens[0]!.toLowerCase();
    const isIndented = raw.startsWith(" ") || raw.startsWith("\t");

    if (head === "hostname" && tokens[1]) { result.hostname = tokens[1]; applied(line); current = undefined; continue; }
    if ((head === "vrf" && tokens[1]?.toLowerCase() === "definition" && tokens[2])
      || (head === "ip" && tokens[1]?.toLowerCase() === "vrf" && tokens[2])) {
      const name = tokens[2]!;
      currentVrf = result.vrfs.find((vrf) => vrf.id === name) ?? {
        id: name,
        name,
        routeDistinguisher: "0:0",
        importRouteTargets: [],
        exportRouteTargets: [],
        staticRoutes: [],
      };
      if (!result.vrfs.includes(currentVrf)) result.vrfs.push(currentVrf);
      current = undefined;
      inBgp = false;
      applied(line);
      continue;
    }
    if (currentVrf && isIndented) {
      if (head === "rd" && tokens[1]) { currentVrf.routeDistinguisher = tokens[1]; applied(line); continue; }
      if (head === "route-target" && (tokens[1] === "import" || tokens[1] === "export") && tokens[2]) {
        const list = tokens[1] === "import" ? currentVrf.importRouteTargets : currentVrf.exportRouteTargets;
        if (!list.includes(tokens[2])) list.push(tokens[2]);
        applied(line);
        continue;
      }
    }
    if (head === "mpls" && tokens[1]?.toLowerCase() === "label" && tokens[2]?.toLowerCase() === "protocol" && tokens[3]?.toLowerCase() === "ldp") {
      result.ldp ??= {};
      applied(line);
      continue;
    }
    if (head === "mpls" && tokens[1]?.toLowerCase() === "ldp" && tokens[2]?.toLowerCase() === "router-id" && tokens[3]) {
      result.ldp = { routerIdInterface: tokens[3] };
      applied(line);
      continue;
    }
    if (head === "interface") {
      const spec = tokens.slice(1).join("");
      currentVlan = undefined;
      inOspf = false;
      inOspfv3 = false;
      inBgp = false;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      inBgp = false;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      currentIpv6Acl = undefined;
      clearQosContext();
      clearCryptoContext();
      currentVrf = undefined;
      const loopbackMatch = /^lo(?:opback)?(\d+)$/u.exec(normalizeInterfaceName(spec));
      if (loopbackMatch) {
        const id = Number(loopbackMatch[1]);
        currentLoopback = loopbacks.get(id) ?? { id, shutdown: false };
        loopbacks.set(id, currentLoopback);
        current = undefined;
        currentTunnel = undefined;
        applied(line);
        continue;
      }
      // `interface Tunnel<n>`: a logical GRE tunnel, not a cabled port.
      const tunnelMatch = /^tu(?:nnel)?(\d+)$/u.exec(normalizeInterfaceName(spec));
      if (tunnelMatch) {
        const id = Number(tunnelMatch[1]);
        currentTunnel = tunnels.get(id) ?? { id, shutdown: false };
        tunnels.set(id, currentTunnel);
        current = undefined;
        currentLoopback = undefined;
        applied(line);
        continue;
      }
      currentLoopback = undefined;
      currentTunnel = undefined;
      const actual = resolve.get(normalizeInterfaceName(spec));
      if (actual) { current = ensureInterface(actual); applied(line); } else { current = undefined; unparsed(line); }
      continue;
    }

    // --- MQC quality of service -------------------------------------------
    if (head === "class-map" && tokens.length >= 2) {
      const matchType = tokens[1]?.toLowerCase() === "match-all"
        ? "match-all" as const
        : tokens[1]?.toLowerCase() === "match-any" ? "match-any" as const : undefined;
      const name = matchType ? tokens[2] : tokens[1];
      if (!name) { unparsed(line); continue; }
      current = undefined;
      currentLoopback = undefined;
      currentIpv6Acl = undefined;
      inOspf = false;
      inOspfv3 = false;
      inBgp = false;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      currentPolicyMap = undefined;
      currentPolicyClass = undefined;
      currentClassMap = result.qos.classMaps.find((map) => map.id === name)
        // IOS defaults an unqualified class-map to match-all.
        ?? { id: name, matchType: matchType ?? "match-all", matches: [] };
      if (!result.qos.classMaps.includes(currentClassMap)) result.qos.classMaps.push(currentClassMap);
      applied(line);
      continue;
    }
    if (head === "policy-map" && tokens[1]) {
      current = undefined;
      currentLoopback = undefined;
      currentIpv6Acl = undefined;
      inOspf = false;
      inOspfv3 = false;
      inBgp = false;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      currentClassMap = undefined;
      currentPolicyClass = undefined;
      currentPolicyMap = result.qos.policyMaps.find((map) => map.id === tokens[1])
        ?? { id: tokens[1]!, classes: [] };
      if (!result.qos.policyMaps.includes(currentPolicyMap)) result.qos.policyMaps.push(currentPolicyMap);
      applied(line);
      continue;
    }
    if (currentClassMap && isIndented && head === "match") {
      const rule = parseQosMatch(tokens);
      if (rule) { currentClassMap.matches.push(rule); applied(line); } else unparsed(line);
      continue;
    }
    if (currentPolicyMap && isIndented && head === "class" && tokens[1]) {
      currentPolicyClass = currentPolicyMap.classes.find((entry) => entry.className === tokens[1])
        ?? { className: tokens[1]! };
      if (!currentPolicyMap.classes.includes(currentPolicyClass)) {
        currentPolicyMap.classes.push(currentPolicyClass);
      }
      applied(line);
      continue;
    }
    if (currentPolicyClass && isIndented) {
      if (applyQosClassLine(currentPolicyClass, tokens)) { applied(line); } else unparsed(line);
      continue;
    }

    // --- global control-protocol commands ---------------------------------
    if (trimmed.toLowerCase() === "ipv6 unicast-routing") {
      result.ipv6UnicastRoutingEnabled = true; applied(line); continue;
    }
    if (trimmed.toLowerCase() === "no ipv6 unicast-routing") {
      result.ipv6UnicastRoutingEnabled = false; applied(line); continue;
    }
    if (head === "ipv6" && tokens[1]?.toLowerCase() === "route") {
      const prefix = ipv6Cidr(tokens[2]);
      if (prefix && Ipv6Schema.safeParse(tokens[3]).success) {
        result.ipv6StaticRoutes.push({ network: prefix.address, prefixLength: prefix.prefixLength, nextHop: tokens[3]! });
        applied(line);
      } else unparsed(line);
      continue;
    }
    if (head === "ipv6" && tokens[1]?.toLowerCase() === "router"
      && tokens[2]?.toLowerCase() === "ospf" && /^\d+$/u.test(tokens[3] ?? "")) {
      result.ospfv3 = { processId: Number(tokens[3]), passiveInterfaces: [], interfaces: [] };
      inOspfv3 = true;
      inOspf = false;
      currentIpv6Acl = undefined;
      applied(line);
      continue;
    }
    if (head === "ipv6" && tokens[1]?.toLowerCase() === "access-list" && tokens[2]) {
      currentIpv6Acl = { id: tokens[2], type: "ipv6", rules: [] };
      result.ipv6Acls.push(currentIpv6Acl);
      inOspf = false;
      inOspfv3 = false;
      current = undefined;
      currentLoopback = undefined;
      clearQosContext();
      applied(line);
      continue;
    }
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
    if (head === "bridge" && tokens[1]?.toLowerCase() === "aging-time") {
      const seconds = boundedNumber(tokens[2], 1, 86_400);
      if (seconds === undefined) { unparsed(line); continue; }
      result.bridgeAgingTimeSeconds = seconds;
      applied(line);
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
    if (head === "ip" && tokens[1]?.toLowerCase() === "prefix-list" && tokens[2]
      && tokens[3]?.toLowerCase() === "seq" && /^\d+$/u.test(tokens[4] ?? "")
      && (tokens[5]?.toLowerCase() === "permit" || tokens[5]?.toLowerCase() === "deny")) {
      const [prefixAddress, prefixLengthText, extra] = (tokens[6] ?? "").split("/");
      const prefixLength = Number(prefixLengthText);
      const sequence = Number(tokens[4]);
      const geIndex = tokens.findIndex((token) => token.toLowerCase() === "ge");
      const leIndex = tokens.findIndex((token) => token.toLowerCase() === "le");
      const ge = geIndex >= 0 ? Number(tokens[geIndex + 1]) : undefined;
      const le = leIndex >= 0 ? Number(tokens[leIndex + 1]) : undefined;
      if (extra === undefined && isIpv4(prefixAddress) && Number.isInteger(prefixLength)
        && prefixLength >= 0 && prefixLength <= 32
        && (ge === undefined || Number.isInteger(ge)) && (le === undefined || Number.isInteger(le))) {
        const list = result.prefixLists.find((entry) => entry.id === tokens[2]) ?? { id: tokens[2]!, entries: [] };
        if (!result.prefixLists.includes(list)) result.prefixLists.push(list);
        list.entries.push({ sequence, action: tokens[5]!.toLowerCase() as "permit" | "deny", prefix: prefixAddress, prefixLength, ge, le });
        applied(line);
      } else unparsed(line);
      continue;
    }
    if (head === "route-map" && tokens[1]
      && (tokens[2]?.toLowerCase() === "permit" || tokens[2]?.toLowerCase() === "deny")
      && /^\d+$/u.test(tokens[3] ?? "")) {
      const map = result.routeMaps.find((entry) => entry.id === tokens[1]) ?? { id: tokens[1]!, sequences: [] };
      if (!result.routeMaps.includes(map)) result.routeMaps.push(map);
      currentRouteMap = {
        sequence: Number(tokens[3]),
        action: tokens[2]!.toLowerCase() as "permit" | "deny",
      };
      map.sequences.push(currentRouteMap);
      currentRouteMapId = map.id;
      inBgp = false;
      inOspf = false;
      inOspfv3 = false;
      current = undefined;
      currentLoopback = undefined;
      clearQosContext();
      applied(line);
      continue;
    }
    if (currentRouteMap && currentRouteMapId && isIndented) {
      if (head === "match" && tokens[1]?.toLowerCase() === "ip" && tokens[2]?.toLowerCase() === "address"
        && tokens[3]?.toLowerCase() === "prefix-list" && tokens[4]) {
        currentRouteMap.match = { ...currentRouteMap.match, prefixListIds: tokens.slice(4) };
        applied(line); continue;
      }
      if (head === "set" && tokens[1]?.toLowerCase() === "local-preference" && /^\d+$/u.test(tokens[2] ?? "")) {
        currentRouteMap.set = { ...currentRouteMap.set, localPreference: Number(tokens[2]) }; applied(line); continue;
      }
      if (head === "set" && tokens[1]?.toLowerCase() === "metric" && /^\d+$/u.test(tokens[2] ?? "")) {
        currentRouteMap.set = { ...currentRouteMap.set, med: Number(tokens[2]) }; applied(line); continue;
      }
      if (head === "set" && tokens[1]?.toLowerCase() === "weight" && /^\d+$/u.test(tokens[2] ?? "")) {
        currentRouteMap.set = { ...currentRouteMap.set, weight: Number(tokens[2]) }; applied(line); continue;
      }
      if (head === "set" && tokens[1]?.toLowerCase() === "origin"
        && (tokens[2]?.toLowerCase() === "igp" || tokens[2]?.toLowerCase() === "incomplete")) {
        currentRouteMap.set = { ...currentRouteMap.set, origin: tokens[2]!.toLowerCase() as "igp" | "incomplete" }; applied(line); continue;
      }
      if (head === "set" && tokens[1]?.toLowerCase() === "as-path" && tokens[2]?.toLowerCase() === "prepend"
        && result.bgp && tokens.slice(3).length > 0) {
        const values = tokens.slice(3).map(Number);
        const count = values.length === 1 && Number.isInteger(values[0]) && values[0]! >= 1 && values[0]! <= 10
          ? values[0]
          : values.every((asn) => asn === result.bgp!.localAs) ? values.length : undefined;
        if (count !== undefined && count <= 10) {
          currentRouteMap.set = { ...currentRouteMap.set, prependLocalAs: count }; applied(line); continue;
        }
      }
      unparsed(line); continue;
    }
    if (head === "router" && tokens[1]?.toLowerCase() === "bgp" && /^\d+$/u.test(tokens[2] ?? "")) {
      const localAs = Number(tokens[2]);
      if (localAs < 1 || localAs > 4_294_967_295) { unparsed(line); continue; }
      result.bgp = { localAs, neighbors: [], networks: [], vrfAddressFamilies: [] };
      inBgp = true;
      currentBgpAddressFamily = undefined;
      currentVrf = undefined;
      inOspf = false;
      inOspfv3 = false;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      currentIpv6Acl = undefined;
      current = undefined;
      currentLoopback = undefined;
      clearQosContext();
      applied(line);
      continue;
    }
    if (head === "router" && tokens[1]?.toLowerCase() === "ospf" && /^\d+$/u.test(tokens[2] ?? "")) {
      result.ospf = { processId: Number(tokens[2]), networks: [], passiveInterfaces: [] };
      inOspf = true;
      inOspfv3 = false;
      inBgp = false;
      currentIpv6Acl = undefined;
      current = undefined;
      currentLoopback = undefined;
      applied(line);
      continue;
    }
    // Other routing protocols stay unparsed and are reported honestly.
    if (head === "router") { inOspf = false; current = undefined; unparsed(line); continue; }

    if (inBgp && result.bgp && isIndented) {
      if (head === "address-family" && tokens[1]?.toLowerCase() === "vpnv4") {
        currentBgpAddressFamily = { type: "vpnv4" };
        applied(line);
        continue;
      }
      if (head === "address-family" && tokens[1]?.toLowerCase() === "ipv4" && tokens[2]?.toLowerCase() === "vrf" && tokens[3]) {
        currentBgpAddressFamily = { type: "ipv4-vrf", vrfId: tokens[3] };
        if (!result.bgp.vrfAddressFamilies.some((family) => family.vrfId === tokens[3])) {
          result.bgp.vrfAddressFamilies.push({ vrfId: tokens[3] });
        }
        applied(line);
        continue;
      }
      if (head === "exit-address-family") { currentBgpAddressFamily = undefined; applied(line); continue; }
      if (head === "bgp" && tokens[1]?.toLowerCase() === "router-id" && isIpv4(tokens[2])) {
        result.bgp.routerId = tokens[2]; applied(line); continue;
      }
      if (head === "network" && isIpv4(tokens[1]) && tokens[2]?.toLowerCase() === "mask") {
        const length = maskToPrefix(tokens[3]);
        if (length !== undefined) { result.bgp.networks.push({ network: tokens[1], prefixLength: length }); applied(line); }
        else unparsed(line);
        continue;
      }
      if (head === "neighbor" && isIpv4(tokens[1])) {
        const address = tokens[1];
        const existing = result.bgp.neighbors.find((neighbor) => neighbor.address === address);
        if (tokens[2]?.toLowerCase() === "remote-as" && /^\d+$/u.test(tokens[3] ?? "")) {
          const remoteAs = Number(tokens[3]);
          if (remoteAs < 1 || remoteAs > 4_294_967_295) { unparsed(line); continue; }
          if (existing) existing.remoteAs = remoteAs;
          else result.bgp.neighbors.push({ address, remoteAs, enabled: true });
          applied(line); continue;
        }
        if (!existing) { unparsed(line); continue; }
        if (currentBgpAddressFamily?.type === "vpnv4" && tokens[2]?.toLowerCase() === "activate") {
          existing.vpnv4Activated = true; applied(line); continue;
        }
        if (currentBgpAddressFamily?.type === "vpnv4" && tokens[2]?.toLowerCase() === "send-community" && tokens[3]?.toLowerCase() === "extended") {
          existing.sendCommunityExtended = true; applied(line); continue;
        }
        if (tokens[2]?.toLowerCase() === "description" && tokens[3]) {
          existing.description = tokens.slice(3).join(" "); applied(line); continue;
        }
        if (tokens[2]?.toLowerCase() === "update-source" && tokens[3]) {
          const actual = resolve.get(normalizeInterfaceName(tokens[3]))
            ?? (/^lo(?:opback)?\d+$/u.test(normalizeInterfaceName(tokens[3])) ? `Loopback${/(\d+)$/u.exec(tokens[3])?.[1]}` : undefined);
          if (actual) { existing.updateSource = actual; applied(line); } else unparsed(line);
          continue;
        }
        if (tokens[2]?.toLowerCase() === "ebgp-multihop" && /^\d+$/u.test(tokens[3] ?? "")) {
          existing.ebgpMultihop = Number(tokens[3]); applied(line); continue;
        }
        if (tokens[2]?.toLowerCase() === "next-hop-self") { existing.nextHopSelf = true; applied(line); continue; }
        if ((tokens[2]?.toLowerCase() === "prefix-list" || tokens[2]?.toLowerCase() === "route-map")
          && tokens[3] && (tokens[4]?.toLowerCase() === "in" || tokens[4]?.toLowerCase() === "out")) {
          const key = `${tokens[2]!.toLowerCase() === "prefix-list" ? "prefixList" : "routeMap"}${tokens[4]!.toLowerCase() === "in" ? "In" : "Out"}` as "prefixListIn" | "prefixListOut" | "routeMapIn" | "routeMapOut";
          existing[key] = tokens[3]; applied(line); continue;
        }
      }
      if (currentBgpAddressFamily?.type === "ipv4-vrf" && head === "redistribute"
        && (tokens[1]?.toLowerCase() === "connected" || tokens[1]?.toLowerCase() === "static")) {
        const vrfId = currentBgpAddressFamily.vrfId;
        const family = result.bgp.vrfAddressFamilies.find((entry) => entry.vrfId === vrfId)!;
        if (tokens[1]!.toLowerCase() === "connected") family.redistributeConnected = true;
        else family.redistributeStatic = true;
        applied(line);
        continue;
      }
      unparsed(line); continue;
    }

    if (inOspfv3 && result.ospfv3 && isIndented) {
      if (head === "router-id" && isIpv4(tokens[1])) {
        result.ospfv3.routerId = tokens[1]; applied(line); continue;
      }
      if (head === "passive-interface" && tokens[1]) {
        const actual = resolve.get(normalizeInterfaceName(tokens[1]))
          ?? (/^lo(?:opback)?\d+$/u.test(normalizeInterfaceName(tokens[1]))
            ? `Loopback${/(\d+)$/u.exec(tokens[1])?.[1]}`
            : undefined);
        if (actual) {
          result.ospfv3.passiveInterfaces.push(actual);
          applied(line);
        } else unparsed(line);
        continue;
      }
    }

    if (currentIpv6Acl && isIndented) {
      const action = head === "permit" || head === "deny" ? head : undefined;
      const protocolToken = tokens[1]?.toLowerCase();
      const protocol = protocolToken === "ipv6" ? "ipv6"
        : protocolToken === "tcp" ? 6
          : protocolToken === "udp" ? 17
            : protocolToken === "icmp" || protocolToken === "icmpv6" ? 58
              : undefined;
      const source = ipv6Matcher(tokens, 2);
      const destination = source ? ipv6Matcher(tokens, 2 + source.consumed) : undefined;
      if (action && protocol !== undefined && source && destination) {
        const portIndex = 2 + source.consumed + destination.consumed;
        const destinationPort = tokens[portIndex]?.toLowerCase() === "eq"
          && /^\d+$/u.test(tokens[portIndex + 1] ?? "")
          ? { kind: "eq" as const, port: Number(tokens[portIndex + 1]) }
          : undefined;
        currentIpv6Acl.rules.push({
          sequence: (currentIpv6Acl.rules.at(-1)?.sequence ?? 0) + 10,
          action,
          protocol,
          source: source.matcher,
          destination: destination.matcher,
          destinationPort,
        });
        applied(line);
      } else unparsed(line);
      continue;
    }

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
      if (head === "ipv6" && tokens[1]?.toLowerCase() === "address") {
        const address = ipv6Cidr(tokens[2]);
        if (address) {
          currentLoopback.ipv6 = [...(currentLoopback.ipv6 ?? []), address];
          applied(line);
          continue;
        }
      }
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
    // --- Tunnel interface body --------------------------------------------
    if (currentTunnel && isIndented) {
      const resolveSource = (name: string): string | undefined =>
        resolve.get(normalizeInterfaceName(name));
      if (applyTunnelLine(currentTunnel, tokens, head, resolveSource)) { applied(line); } else unparsed(line);
      continue;
    }

    // --- simplified IKEv2 / IPsec blocks ----------------------------------
    if (head === "crypto") {
      const kind = tokens.slice(1, 3).map((token) => token.toLowerCase()).join(" ");
      const name = tokens[3];
      current = undefined;
      currentLoopback = undefined;
      currentTunnel = undefined;
      clearQosContext();
      clearCryptoContext();
      if (kind === "ikev2 proposal" && name) {
        currentProposal = result.vpn.proposals.find((entry) => entry.id === name) ?? { id: name };
        if (!result.vpn.proposals.includes(currentProposal)) result.vpn.proposals.push(currentProposal);
        applied(line);
        continue;
      }
      if (kind === "ikev2 peer" && name) {
        currentPeer = result.vpn.ikePeers.find((entry) => entry.id === name)
          ?? { id: name, credentialResetRequired: false };
        if (!result.vpn.ikePeers.includes(currentPeer)) result.vpn.ikePeers.push(currentPeer);
        applied(line);
        continue;
      }
      if (kind === "ipsec profile" && name) {
        currentProfile = result.vpn.ipsecProfiles.find((entry) => entry.id === name) ?? { id: name };
        if (!result.vpn.ipsecProfiles.includes(currentProfile)) result.vpn.ipsecProfiles.push(currentProfile);
        applied(line);
        continue;
      }
      // Crypto maps, IKEv1 policies, ISAKMP keys, transform sets, trustpoints
      // and anything else are deliberately not mapped; they are preserved as
      // unparsed lines rather than approximated into something SimulatorNet
      // does not simulate.
      unparsed(line);
      continue;
    }
    if (currentProposal && isIndented) {
      if (applyProposalLine(currentProposal, tokens, head)) { applied(line); } else unparsed(line);
      continue;
    }
    if (currentPeer && isIndented) {
      if (applyPeerLine(currentPeer, tokens, head)) { applied(line); } else unparsed(line);
      continue;
    }
    if (currentProfile && isIndented) {
      if (applyProfileLine(currentProfile, tokens, head)) { applied(line); } else unparsed(line);
      continue;
    }

    if (head === "ip" && tokens[1]?.toLowerCase() === "route" && isIpv4(tokens[2]) && isIpv4(tokens[4])) {
      const prefix = maskToPrefix(tokens[3]);
      if (prefix !== undefined) { result.staticRoutes.push({ network: tokens[2], prefixLength: prefix, nextHop: tokens[4] }); applied(line); }
      else unparsed(line);
      current = undefined;
      continue;
    }
    if (head === "ip" && tokens[1]?.toLowerCase() === "route" && tokens[2]?.toLowerCase() === "vrf"
      && tokens[3] && isIpv4(tokens[4]) && isIpv4(tokens[6])) {
      const prefix = maskToPrefix(tokens[5]);
      const vrf = result.vrfs.find((entry) => entry.id === tokens[3] || entry.name === tokens[3]);
      if (prefix !== undefined && vrf) {
        vrf.staticRoutes.push({ network: tokens[4], prefixLength: prefix, nextHop: tokens[6] });
        applied(line);
      } else unparsed(line);
      current = undefined;
      continue;
    }
    if (head === "vlan" && /^\d+$/u.test(tokens[1] ?? "")) { currentVlan = Number(tokens[1]); current = undefined; applied(line); continue; }
    if (head === "name" && currentVlan !== undefined && tokens[1]) { vlanNames.set(currentVlan, tokens.slice(1).join(" ")); applied(line); continue; }

    if (current && isIndented) {
      if (head === "ipv6" && tokens[1]?.toLowerCase() === "address") {
        const address = ipv6Cidr(tokens[2]);
        if (address) {
          current.ipv6 = [...(current.ipv6 ?? []), address];
          applied(line);
          continue;
        }
      }
      if (head === "ipv6" && tokens[1]?.toLowerCase() === "traffic-filter" && tokens[2]
        && (tokens[3] === "in" || tokens[3] === "out")) {
        current.ipv6TrafficFilters = [
          ...(current.ipv6TrafficFilters ?? []),
          { aclId: tokens[2], direction: tokens[3] },
        ];
        applied(line);
        continue;
      }
      if (head === "ipv6" && tokens[1]?.toLowerCase() === "ospf") {
        const ospfv3 = current.ospfv3 ?? {};
        if (/^\d+$/u.test(tokens[2] ?? "") && tokens[3]?.toLowerCase() === "area" && tokens[4] === "0") {
          ospfv3.enabled = true;
          current.ospfv3 = ospfv3;
          applied(line);
          continue;
        }
        if (tokens[2]?.toLowerCase() === "cost" && /^\d+$/u.test(tokens[3] ?? "")) {
          ospfv3.cost = Number(tokens[3]);
          current.ospfv3 = ospfv3;
          applied(line);
          continue;
        }
      }
      if (head === "ip" && tokens[1]?.toLowerCase() === "address" && isIpv4(tokens[2])) {
        const prefix = maskToPrefix(tokens[3]);
        if (prefix !== undefined) { current.ipv4 = { address: tokens[2], prefixLength: prefix }; applied(line); continue; }
      }
      if (head === "mpls" && tokens[1]?.toLowerCase() === "ip") { current.mplsEnabled = true; applied(line); continue; }
      if ((head === "vrf" && tokens[1]?.toLowerCase() === "forwarding" && tokens[2])
        || (head === "ip" && tokens[1]?.toLowerCase() === "vrf" && tokens[2]?.toLowerCase() === "forwarding" && tokens[3])) {
        current.vrfId = head === "vrf" ? tokens[2] : tokens[3];
        applied(line);
        continue;
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
      if (head === "service-policy" && tokens[2]) {
        const direction = tokens[1]?.toLowerCase();
        if (direction === "input" || direction === "output") {
          current.servicePolicies = [
            ...(current.servicePolicies ?? []),
            { direction, policyMapId: tokens[2] },
          ];
          applied(line);
          continue;
        }
        unparsed(line);
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
  result.vpn.tunnels = [...tunnels.values()].sort((a, b) => a.id - b.id);
  // A tunnel that names a profile the file never defined keeps its other
  // settings but loses the binding: an invented profile would be a lie.
  for (const tunnel of result.vpn.tunnels) {
    if (tunnel.ipsecProfileId !== undefined
      && !result.vpn.ipsecProfiles.some((profile) => profile.id === tunnel.ipsecProfileId)) {
      tunnel.ipsecProfileId = undefined;
    }
  }
  result.vlans = [...vlanNames.entries()].map(([id, name]) => ({ id, name }));
  // Bindings are collected per interface and lifted into the device's QoS
  // configuration; a binding to a policy map the file never defined is dropped
  // rather than silently inventing one.
  result.qos.servicePolicies = result.interfaces.flatMap((iface) =>
    (iface.servicePolicies ?? [])
      .filter((binding) => result.qos.policyMaps.some((map) => map.id === binding.policyMapId))
      .map((binding) => ({
        interfaceName: iface.id,
        direction: binding.direction,
        policyMapId: binding.policyMapId,
      })));
  return result;
}

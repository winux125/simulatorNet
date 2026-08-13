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
  type EvpnConfig,
  type EvpnVniConfig,
  type LdpConfig,
  type NveInterfaceConfig,
  type NveMemberConfig,
  type AsPathListConfig,
  type CommunityListConfig,
  type Ipv6PrefixListConfig,
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
  /** `switchport trunk native vlan <id>`. */
  nativeVlan?: number;
  /** `switchport trunk allowed vlan <list>`; absent means "all VLANs". */
  allowedVlans?: number[];
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
  /**
   * `fabric forwarding mode anycast-gateway`. Only ever set on an SVI: a
   * distributed gateway is a VLAN interface, never a routed port or a Loopback.
   */
  anycastGateway?: boolean;
}

/**
 * `interface Vlan<n>` recognised from an imported startup-config.
 *
 * There is exactly one SVI model: it serves ordinary inter-VLAN routing and a
 * routed EVPN tenant gateway alike, so `vrf forwarding` and
 * `fabric forwarding mode anycast-gateway` are read here and nowhere else.
 */
export interface ImportedSviConfig {
  vlanId: number;
  description?: string;
  shutdown: boolean;
  ipv4?: { address: string; prefixLength: number };
  ipv6?: Array<{ address: string; prefixLength: number }>;
  /** `vrf forwarding <name>`: the tenant routing context this SVI belongs to. */
  vrfId?: string;
  /** `fabric forwarding mode anycast-gateway`, valid only on an SVI. */
  anycastGateway?: boolean;
}

/**
 * `interface Port-channel<n>` recognised from a configuration file.
 *
 * The bundle is a real logical interface, so the settings that live on it are
 * read here rather than inferred from a member. Membership stays exactly one
 * `channel-group` line per member: the two models must never be able to
 * disagree about which port belongs to which bundle.
 *
 * A bundle's administrative state is deliberately not read. It is derived from
 * its members, so `shutdown` on a Port-channel is reported as unsupported
 * instead of being accepted into a field nothing could apply.
 */
export interface ImportedPortChannelConfig {
  channelId: number;
  description?: string;
  switchportMode?: "access" | "trunk";
  accessVlan?: number;
  nativeVlan?: number;
  allowedVlans?: number[];
  /** `port-channel min-links <n>`. */
  minimumLinks?: number;
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
  /**
   * `interface Port-channel<n>` blocks. A bundle is logical, so it is never
   * matched against the device's physical port list; it exists once at least
   * one member declares `channel-group <n>`.
   */
  portChannels: ImportedPortChannelConfig[];
  /**
   * `interface Vlan<n>` blocks. An SVI is a logical interface, so it is never
   * matched against the device's physical port list; only a device kind that
   * actually routes between VLANs maps them.
   */
  svis: ImportedSviConfig[];
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
  /**
   * The recognised VXLAN subset: `interface nve1`, `source-interface`,
   * `member vni`, `peer-ip`, `ingress-replication protocol bgp` and the
   * `vlan configuration <id>` → `member vni` binding. EVPN multihoming/ESI,
   * L3VNI, anycast gateway, ARP suppression, multicast replication, VXLAN
   * routing/IRB and Type 5 are not mapped; they stay in `unparsedLines`.
   */
  nve?: NveInterfaceConfig;
  evpn?: EvpnConfig;
  vrfs: VrfConfig[];
  prefixLists: PrefixListConfig[];
  ipv6PrefixLists: Ipv6PrefixListConfig[];
  routeMaps: RouteMapConfig[];
  communityLists: CommunityListConfig[];
  asPathLists: AsPathListConfig[];
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

function isIpv6Text(value: string): boolean {
  return Ipv6Schema.safeParse(value).success;
}

/**
 * Lower-cased text only. This package stays free of the engine, so the full
 * canonical form is applied where it belongs: `BgpProcess.configure` and the
 * `LabDocument` canonicalizer.
 */
function normalizeIpv6Text(value: string): string {
  return value.toLowerCase();
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

/** `65000:100` or a well-known name, canonicalized; `undefined` if unsupported. */
function canonicalCommunity(value: string | undefined): string | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (text === "internet" || text === "no-export" || text === "no-advertise") return text;
  const match = /^(\d{1,5}):(\d{1,5})$/u.exec(text);
  if (!match || Number(match[1]) > 65_535 || Number(match[2]) > 65_535) return undefined;
  const value32 = (Number(match[1]) << 16 >>> 0) + Number(match[2]);
  if (value32 === 0) return "internet";
  if (value32 === 0xffff_ff01) return "no-export";
  if (value32 === 0xffff_ff02) return "no-advertise";
  return `${Number(match[1])}:${Number(match[2])}`;
}

/**
 * The documented educational AS-path pattern subset. An unsupported regular
 * expression is never stored: it is reported so the import stays honest.
 */
function safeAsPathMatcher(pattern: string): AsPathListConfig["entries"][number]["matcher"] | undefined {
  const text = pattern.trim();
  if (text === "^$") return { kind: "empty" };
  const asn = (value: string | undefined): number | undefined => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4_294_967_295 ? parsed : undefined;
  };
  const single = (regex: RegExp, kind: "contains" | "starts-with" | "ends-with") => {
    const match = regex.exec(text);
    const value = match ? asn(match[1]) : undefined;
    return value === undefined ? undefined : { kind, asn: value } as const;
  };
  const contains = single(/^_(\d{1,10})_$/u, "contains");
  if (contains) return contains;
  const starts = single(/^\^(\d{1,10})_$/u, "starts-with");
  if (starts) return starts;
  const ends = single(/^_(\d{1,10})\$$/u, "ends-with");
  if (ends) return ends;
  const exact = /^\^(\d{1,10}(?: \d{1,10})*)\$$/u.exec(text);
  if (!exact) return undefined;
  const asPath = exact[1]!.split(" ").map((value) => asn(value));
  return asPath.some((value) => value === undefined) || asPath.length > 32
    ? undefined
    : { kind: "exact", asPath: asPath as number[] };
}

function nextListSequence(entries: readonly { sequence: number }[]): number {
  return entries.reduce((highest, entry) => Math.max(highest, entry.sequence), 0) + 10;
}

function isIpv4(value: string | undefined): value is string {
  if (!value) return false;
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/** A 24-bit VXLAN Network Identifier. VNI 0 is reserved and never accepted. */
function isValidVniNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 16_777_215;
}

/**
 * Accept both the Cisco `0200.0000.0001` shape and the colon form, and return
 * one canonical spelling — or `undefined` when the value could never be a
 * gateway MAC, so the line is reported rather than half-understood.
 */
function normalizeFabricMac(value: string): string | undefined {
  const dotted = /^([0-9a-f]{4})\.([0-9a-f]{4})\.([0-9a-f]{4})$/iu.exec(value);
  const hex = dotted ? `${dotted[1]}${dotted[2]}${dotted[3]}`.toLowerCase() : undefined;
  const colon = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/iu.test(value) ? value.toLowerCase() : undefined;
  const normalized = hex ? (hex.match(/../gu) ?? []).join(":") : colon;
  if (normalized === undefined) return undefined;
  // A multicast or all-zero address could never be a usable next hop.
  if ((Number.parseInt(normalized.slice(0, 2), 16) & 0x01) === 1) return undefined;
  if (/^0{2}(:0{2}){5}$/u.test(normalized)) return undefined;
  return normalized;
}

/**
 * Canonicalize an Ethernet Segment Identifier, or `undefined` when it is not
 * one this simulator can use.
 *
 * The colon, dot and bare-hex spellings all normalize to the canonical
 * five-group form. ESI 0 means "single-homed" and MAX-ESI is reserved, so
 * neither can name a segment and both are refused here rather than stored.
 */
function normalizeEsiText(value: string): string | undefined {
  const compact = value.trim().toLowerCase().replace(/[.:-]/gu, "");
  if (!/^[0-9a-f]{20}$/u.test(compact)) return undefined;
  const normalized = (compact.match(/.{4}/gu) ?? []).join(":");
  if (normalized === "0000:0000:0000:0000:0000" || normalized === "ffff:ffff:ffff:ffff:ffff") return undefined;
  return normalized;
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

/** The canonical name of one logical bundle, as the rest of the model spells it. */
function portChannelInterfaceId(channelId: number): string {
  return `Port-channel${channelId}`;
}

/** A switchport target: a physical port or the logical bundle above it. */
interface SwitchportTarget {
  switchportMode?: "access" | "trunk";
  accessVlan?: number;
  nativeVlan?: number;
  allowedVlans?: number[];
}

/**
 * The `switchport …` lines a physical port and a Port-channel share.
 *
 * One implementation serves both, so a bundle can never read a VLAN list
 * differently from the member that inherits it. Returns `false` for a line this
 * subset does not model, which the caller then reports.
 */
function applySwitchportLine(target: SwitchportTarget, tokens: readonly string[]): boolean {
  if (tokens[0]?.toLowerCase() !== "switchport") return false;
  const second = tokens[1]?.toLowerCase();
  if (second === "mode" && (tokens[2] === "access" || tokens[2] === "trunk")) {
    target.switchportMode = tokens[2];
    return true;
  }
  if (second === "access" && tokens[2]?.toLowerCase() === "vlan" && /^\d+$/u.test(tokens[3] ?? "")) {
    const vlanId = Number(tokens[3]);
    if (vlanId < 1 || vlanId > 4_094) return false;
    target.accessVlan = vlanId;
    return true;
  }
  if (second !== "trunk") return false;
  if (tokens[2]?.toLowerCase() === "native" && tokens[3]?.toLowerCase() === "vlan" && /^\d+$/u.test(tokens[4] ?? "")) {
    const vlanId = Number(tokens[4]);
    if (vlanId < 1 || vlanId > 4_094) return false;
    target.nativeVlan = vlanId;
    return true;
  }
  // `switchport trunk allowed vlan <list>`. Only the plain comma/range list is
  // modelled: `add`, `remove`, `except` and `none` mutate a set this parser
  // never sees whole, so they are reported instead of half-applied.
  if (tokens[2]?.toLowerCase() === "allowed" && tokens[3]?.toLowerCase() === "vlan" && tokens.length === 5) {
    const allowed = parseVlanListText(tokens[4]!);
    if (!allowed) return false;
    target.allowedVlans = allowed;
    return true;
  }
  return false;
}

/** `10,20` or `10-12,20` into a sorted, deduplicated and bounded VLAN list. */
function parseVlanListText(text: string): number[] | undefined {
  if (!/^[\d,-]+$/u.test(text)) return undefined;
  const vlans = new Set<number>();
  for (const part of text.split(",")) {
    const range = /^(\d+)-(\d+)$/u.exec(part);
    if (range) {
      const first = Number(range[1]);
      const last = Number(range[2]);
      if (first < 1 || last > 4_094 || first > last || last - first > 4_094) return undefined;
      for (let vlanId = first; vlanId <= last; vlanId++) vlans.add(vlanId);
      continue;
    }
    if (!/^\d+$/u.test(part)) return undefined;
    const vlanId = Number(part);
    if (vlanId < 1 || vlanId > 4_094) return undefined;
    vlans.add(vlanId);
  }
  return vlans.size === 0 ? undefined : [...vlans].sort((a, b) => a - b);
}

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

/** The canonical interface name of an SVI, exactly as the renderer writes it. */
function sviInterfaceId(vlanId: number): string {
  return `Vlan${vlanId}`;
}

/** True for a parsed interface that is an SVI rather than a physical port. */
function isSviInterfaceId(id: string): boolean {
  return /^Vlan\d+$/u.test(id);
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
    portChannels: [],
    svis: [],
    loopbacks: [],
    staticRoutes: [],
    ipv6StaticRoutes: [],
    ipv6Acls: [],
    ipv6AclBindings: [],
    prefixLists: [],
    ipv6PrefixLists: [],
    routeMaps: [],
    communityLists: [],
    asPathLists: [],
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
  const portChannels = new Map<number, ImportedPortChannelConfig>();
  const tunnels = new Map<number, ImportedTunnelConfig>();
  let current: ImportedInterfaceConfig | undefined;
  let currentLoopback: ImportedLoopbackConfig | undefined;
  let currentPortChannel: ImportedPortChannelConfig | undefined;
  let currentVlan: number | undefined;
  let inOspf = false;
  let inOspfv3 = false;
  let inBgp = false;
  let currentBgpAddressFamily:
    | { type: "vpnv4" }
    | { type: "vpnv6" }
    | { type: "ipv6-unicast" }
    | { type: "l2vpn-evpn" }
    | { type: "ipv4-vrf"; vrfId: string }
    | { type: "ipv6-vrf"; vrfId: string }
    | undefined;
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
  // --- VXLAN / EVPN parse contexts ---------------------------------------
  // `interface nve1` declares each VNI and how it replicates; the VLAN it maps
  // is bound separately by `vlan configuration <id>` → `member vni <n>`, so the
  // two halves are collected apart and reconciled once the file has been read.
  let inNve = false;
  let nveSourceInterfaceId: string | undefined;
  let nveShutdown = false;
  let currentNveVni: number | undefined;
  const nveMembers = new Map<number, { replication: NveMemberConfig["replication"] }>();
  /** L3VNI → VRF name, from `member vni <n> associate-vrf <name>`. */
  const nveVrfMembers = new Map<number, string>();
  const vniToVlan = new Map<number, number>();
  let currentVlanConfiguration: number | undefined;
  let inEvpn = false;
  let currentEvpnVni: EvpnVniConfig | undefined;
  // `evpn ethernet-segment <name>` blocks and the `ethernet-segment <name>` line
  // that binds one to an interface are read apart and reconciled at the end, so
  // a segment defined after its attachment still finds it.
  const ethernetSegments = new Map<string, { esi?: string; redundancyMode?: "single-active" }>();
  const segmentAttachments = new Map<string, string>();
  let currentEthernetSegment: string | undefined;
  const clearVxlanContext = (): void => {
    inNve = false;
    currentNveVni = undefined;
    currentVlanConfiguration = undefined;
    inEvpn = false;
    currentEvpnVni = undefined;
    currentEthernetSegment = undefined;
  };
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
      clearVxlanContext();
      continue;
    }
    const tokens = trimmed.split(/\s+/u);
    const head = tokens[0]!.toLowerCase();
    const isIndented = raw.startsWith(" ") || raw.startsWith("\t");
    // A Port-channel block is exactly its indented body, so any top-level line
    // ends it. The `interface Port-channel<n>` branch below re-opens one after
    // this clear, which is why the two can never overlap.
    if (!isIndented) currentPortChannel = undefined;

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
      // IPv4 is the implicit family of a VRF; only IPv6 has to be declared.
      if (head === "address-family" && tokens[1]?.toLowerCase() === "ipv6" && tokens.length === 2) {
        currentVrf.addressFamilyIpv6 = true;
        currentVrf.ipv6StaticRoutes ??= [];
        applied(line);
        continue;
      }
      if (head === "address-family" && tokens[1]?.toLowerCase() === "ipv4" && tokens.length === 2) { applied(line); continue; }
      if (head === "exit-address-family") { applied(line); continue; }
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
    // --- VXLAN: interface nve1 body ---------------------------------------
    if (inNve && isIndented) {
      if (head === "source-interface" && tokens[1]) {
        const actual = resolve.get(normalizeInterfaceName(tokens[1]))
          ?? (/^lo(?:opback)?\d+$/u.test(normalizeInterfaceName(tokens[1]))
            ? `Loopback${/(\d+)$/u.exec(tokens[1])?.[1]}`
            : undefined);
        // A VTEP sources from a Loopback; anything else is reported, not mapped.
        if (actual?.startsWith("Loopback")) { nveSourceInterfaceId = actual; applied(line); } else unparsed(line);
        continue;
      }
      if (head === "shutdown" && tokens.length === 1) { nveShutdown = true; applied(line); continue; }
      if (head === "no" && tokens[1]?.toLowerCase() === "shutdown") { nveShutdown = false; applied(line); continue; }
      // `member vni <n> associate-vrf <name>` is an L3VNI: a routed transit
      // segment with no VLAN, so it never becomes an L2 member.
      if (head === "member" && tokens[1]?.toLowerCase() === "vni" && /^\d+$/u.test(tokens[2] ?? "")
        && tokens[3]?.toLowerCase() === "associate-vrf") {
        const vni = Number(tokens[2]);
        if (tokens.length !== 5 || !isValidVniNumber(vni)) { unparsed(line); continue; }
        currentNveVni = undefined;
        nveVrfMembers.set(vni, tokens[4]!);
        applied(line);
        continue;
      }
      // Exactly `member vni <n>`: an L2VNI, whose VLAN arrives separately.
      if (head === "member" && tokens[1]?.toLowerCase() === "vni" && /^\d+$/u.test(tokens[2] ?? "")) {
        const vni = Number(tokens[2]);
        if (tokens.length !== 3 || !isValidVniNumber(vni)) { unparsed(line); continue; }
        currentNveVni = vni;
        if (!nveMembers.has(vni)) nveMembers.set(vni, { replication: { type: "static", peerAddresses: [] } });
        applied(line);
        continue;
      }
      if (currentNveVni !== undefined && head === "ingress-replication"
        && tokens[1]?.toLowerCase() === "protocol" && tokens[2]?.toLowerCase() === "bgp") {
        nveMembers.set(currentNveVni, { replication: { type: "bgp-evpn" } });
        applied(line);
        continue;
      }
      if (currentNveVni !== undefined && head === "peer-ip" && isIpv4(tokens[1])) {
        const member = nveMembers.get(currentNveVni)!;
        if (member.replication.type !== "static") { unparsed(line); continue; }
        if (!member.replication.peerAddresses.includes(tokens[1]!)) member.replication.peerAddresses.push(tokens[1]!);
        applied(line);
        continue;
      }
      // Multicast replication and ARP suppression are deliberately not mapped;
      // they stay unparsed and are reported honestly.
      unparsed(line);
      continue;
    }
    // --- VXLAN: vlan configuration <id> body ------------------------------
    if (currentVlanConfiguration !== undefined && isIndented) {
      if (head === "member" && tokens[1]?.toLowerCase() === "vni" && /^\d+$/u.test(tokens[2] ?? "")) {
        const vni = Number(tokens[2]);
        if (tokens.length !== 3 || !isValidVniNumber(vni)) { unparsed(line); continue; }
        vniToVlan.set(vni, currentVlanConfiguration);
        applied(line);
        continue;
      }
      unparsed(line);
      continue;
    }
    if (head === "vlan" && tokens[1]?.toLowerCase() === "configuration" && /^\d+$/u.test(tokens[2] ?? "")) {
      const vlanId = Number(tokens[2]);
      if (vlanId < 1 || vlanId > 4_094) { unparsed(line); continue; }
      clearVxlanContext();
      current = undefined;
      currentVlan = undefined;
      currentVlanConfiguration = vlanId;
      applied(line);
      continue;
    }
    // --- BGP EVPN: the evpn block -----------------------------------------
    if (inEvpn && isIndented) {
      if (head === "vni" && /^\d+$/u.test(tokens[1] ?? "") && tokens[2]?.toLowerCase() === "l2") {
        const vni = Number(tokens[1]);
        if (!isValidVniNumber(vni)) { unparsed(line); continue; }
        result.evpn ??= { vnis: [] };
        currentEvpnVni = result.evpn.vnis.find((entry) => entry.vni === vni)
          ?? { vni, routeDistinguisher: "0:0", importRouteTargets: [], exportRouteTargets: [] };
        if (!result.evpn.vnis.includes(currentEvpnVni)) result.evpn.vnis.push(currentEvpnVni);
        applied(line);
        continue;
      }
      if (currentEvpnVni && head === "rd" && tokens[1]) {
        currentEvpnVni.routeDistinguisher = tokens[1];
        applied(line);
        continue;
      }
      if (currentEvpnVni && head === "route-target"
        && (tokens[1] === "import" || tokens[1] === "export") && tokens[2]) {
        const list = tokens[1] === "import" ? currentEvpnVni.importRouteTargets : currentEvpnVni.exportRouteTargets;
        if (!list.includes(tokens[2])) list.push(tokens[2]);
        applied(line);
        continue;
      }
      unparsed(line);
      continue;
    }
    // `fabric forwarding anycast-gateway-mac <mac>`: the one MAC every leaf
    // answers the tenant default gateway with.
    if (head === "fabric" && tokens[1]?.toLowerCase() === "forwarding"
      && tokens[2]?.toLowerCase() === "anycast-gateway-mac") {
      const mac = tokens.length === 4 ? normalizeFabricMac(tokens[3]!) : undefined;
      if (mac === undefined) { unparsed(line); continue; }
      result.evpn ??= { vnis: [] };
      result.evpn.anycastGatewayMac = mac;
      applied(line);
      continue;
    }
    // --- EVPN multihoming: `evpn ethernet-segment <name>` -------------------
    // Read before the plain `evpn` block below: this is a top-level block of its
    // own, not a line inside that one.
    if (currentEthernetSegment !== undefined && isIndented) {
      const segment = ethernetSegments.get(currentEthernetSegment)!;
      if (head === "identifier" && tokens.length === 2) {
        const esi = normalizeEsiText(tokens[1]!);
        // ESI 0 means single-homed and MAX-ESI is reserved, so neither can name
        // a segment: they are reported rather than stored.
        if (esi === undefined) { unparsed(line); continue; }
        segment.esi = esi;
        applied(line);
        continue;
      }
      if (head === "redundancy-mode" && tokens.length === 2) {
        // All-Active — and with it aliasing and MAC mobility — is not modelled,
        // so it is reported honestly instead of being downgraded in silence.
        if (tokens[1]?.toLowerCase() !== "single-active") { unparsed(line); continue; }
        segment.redundancyMode = "single-active";
        applied(line);
        continue;
      }
      unparsed(line);
      continue;
    }
    if (head === "evpn" && tokens[1]?.toLowerCase() === "ethernet-segment" && tokens.length === 3) {
      clearVxlanContext();
      current = undefined;
      currentLoopback = undefined;
      inBgp = false;
      inOspf = false;
      inOspfv3 = false;
      currentEthernetSegment = tokens[2]!;
      if (!ethernetSegments.has(currentEthernetSegment)) ethernetSegments.set(currentEthernetSegment, {});
      applied(line);
      continue;
    }
    if (head === "evpn" && tokens.length === 1) {
      clearVxlanContext();
      current = undefined;
      currentLoopback = undefined;
      inBgp = false;
      inOspf = false;
      inOspfv3 = false;
      inEvpn = true;
      result.evpn ??= { vnis: [] };
      applied(line);
      continue;
    }
    if (head === "interface") {
      const spec = tokens.slice(1).join("");
      currentVlan = undefined;
      inOspf = false;
      inOspfv3 = false;
      inBgp = false;
      clearVxlanContext();
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      inBgp = false;
      currentRouteMap = undefined;
      currentRouteMapId = undefined;
      currentIpv6Acl = undefined;
      clearQosContext();
      clearCryptoContext();
      currentVrf = undefined;
      // `interface nve1`: a logical overlay interface, not a cabled port. Only
      // nve1 exists, so any other number is reported rather than invented.
      if (/^nve\d+$/u.test(normalizeInterfaceName(spec))) {
        if (normalizeInterfaceName(spec) !== "nve1") { current = undefined; unparsed(line); continue; }
        inNve = true;
        currentNveVni = undefined;
        current = undefined;
        currentLoopback = undefined;
        currentTunnel = undefined;
        applied(line);
        continue;
      }
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
      // `interface Vlan<n>`: an SVI. It is a logical interface, so it is never
      // matched against the device's physical port list — but its body is the
      // ordinary interface body, which is what keeps one SVI model serving
      // plain inter-VLAN routing and a routed EVPN tenant gateway alike.
      const sviMatch = /^vl(?:an)?(\d+)$/u.exec(normalizeInterfaceName(spec));
      if (sviMatch) {
        const vlanId = Number(sviMatch[1]);
        if (vlanId < 1 || vlanId > 4_094) { current = undefined; unparsed(line); continue; }
        current = ensureInterface(sviInterfaceId(vlanId));
        currentLoopback = undefined;
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
      // `interface Port-channel<n>`: the logical bundle, not a cabled port. Its
      // membership is never read here — that stays one `channel-group` line per
      // member, so the two models cannot disagree about who belongs to what.
      const channelMatch = /^po(?:rt-channel)?(\d+)$/u.exec(normalizeInterfaceName(spec));
      if (channelMatch) {
        const id = Number(channelMatch[1]);
        if (id < 1 || id > 64) { current = undefined; unparsed(line); continue; }
        currentPortChannel = portChannels.get(id) ?? { channelId: id };
        portChannels.set(id, currentPortChannel);
        current = undefined;
        currentLoopback = undefined;
        currentTunnel = undefined;
        applied(line);
        continue;
      }
      currentLoopback = undefined;
      currentTunnel = undefined;
      const actual = resolve.get(normalizeInterfaceName(spec));
      if (actual) { current = ensureInterface(actual); applied(line); } else { current = undefined; unparsed(line); }
      continue;
    }

    // --- `interface Port-channel<n>` body ----------------------------------
    // Read before every other indented handler: while a bundle block is open no
    // physical interface is selected, so nothing else may claim these lines.
    if (currentPortChannel !== undefined && isIndented) {
      const channel = currentPortChannel;
      if (head === "description" && tokens.length > 1) {
        channel.description = tokens.slice(1).join(" ");
        applied(line);
        continue;
      }
      if (head === "port-channel" && tokens[1]?.toLowerCase() === "min-links" && /^\d+$/u.test(tokens[2] ?? "")) {
        const minimum = Number(tokens[2]);
        if (minimum < 1 || minimum > 8) { unparsed(line); continue; }
        channel.minimumLinks = minimum;
        applied(line);
        continue;
      }
      // `ethernet-segment <name>` binds the *bundle* to a segment. The binding
      // is reconciled with the segment definitions at the end, exactly as an
      // access port's is, so the order of the two blocks never matters.
      if (head === "ethernet-segment" && tokens.length === 2 && tokens[1]) {
        segmentAttachments.set(portChannelInterfaceId(channel.channelId), tokens[1]);
        applied(line);
        continue;
      }
      if (applySwitchportLine(channel, tokens)) { applied(line); continue; }
      // A bundle's administrative state is derived from its members, so
      // `shutdown` is reported rather than accepted into a field that could
      // never be applied back.
      unparsed(line);
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
    if (head === "ipv6" && tokens[1]?.toLowerCase() === "route" && tokens[2]?.toLowerCase() === "vrf" && tokens[3]) {
      const vrf = result.vrfs.find((entry) => entry.id === tokens[3] || entry.name === tokens[3]);
      const prefix = ipv6Cidr(tokens[4]);
      if (vrf?.addressFamilyIpv6 && prefix && Ipv6Schema.safeParse(tokens[5]).success) {
        vrf.ipv6StaticRoutes = [
          ...(vrf.ipv6StaticRoutes ?? []),
          { network: prefix.address, prefixLength: prefix.prefixLength, nextHop: tokens[5]! },
        ];
        applied(line);
      } else unparsed(line);
      continue;
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
    if (head === "ipv6" && tokens[1]?.toLowerCase() === "prefix-list" && tokens[2]
      && tokens[3]?.toLowerCase() === "seq" && /^\d+$/u.test(tokens[4] ?? "")
      && (tokens[5]?.toLowerCase() === "permit" || tokens[5]?.toLowerCase() === "deny")) {
      const prefix = ipv6Cidr(tokens[6]);
      const sequence = Number(tokens[4]);
      const geIndex = tokens.findIndex((token) => token.toLowerCase() === "ge");
      const leIndex = tokens.findIndex((token) => token.toLowerCase() === "le");
      const ge = geIndex >= 0 ? Number(tokens[geIndex + 1]) : undefined;
      const le = leIndex >= 0 ? Number(tokens[leIndex + 1]) : undefined;
      const bounded = (value: number | undefined) => value === undefined
        || (Number.isInteger(value) && value >= 0 && value <= 128);
      if (prefix && bounded(ge) && bounded(le)) {
        const list = result.ipv6PrefixLists.find((entry) => entry.id === tokens[2]) ?? { id: tokens[2]!, entries: [] };
        if (!result.ipv6PrefixLists.includes(list)) result.ipv6PrefixLists.push(list);
        list.entries.push({
          sequence,
          action: tokens[5]!.toLowerCase() as "permit" | "deny",
          prefix: prefix.address,
          prefixLength: prefix.prefixLength,
          ge,
          le,
        });
        applied(line);
      } else unparsed(line);
      continue;
    }
    if (head === "ip" && tokens[1]?.toLowerCase() === "community-list" && tokens[2]?.toLowerCase() === "standard"
      && tokens[3] && (tokens[4]?.toLowerCase() === "permit" || tokens[4]?.toLowerCase() === "deny")) {
      const communities = tokens.slice(5).map((value) => canonicalCommunity(value));
      if (!communities.length || communities.some((value) => value === undefined)) { unparsed(line); continue; }
      const list = result.communityLists.find((entry) => entry.id === tokens[3]) ?? { id: tokens[3]!, entries: [] };
      if (!result.communityLists.includes(list)) result.communityLists.push(list);
      list.entries.push({
        sequence: nextListSequence(list.entries),
        action: tokens[4]!.toLowerCase() as "permit" | "deny",
        communities: communities as string[],
      });
      applied(line);
      continue;
    }
    if (head === "ip" && tokens[1]?.toLowerCase() === "as-path" && tokens[2]?.toLowerCase() === "access-list"
      && tokens[3] && (tokens[4]?.toLowerCase() === "permit" || tokens[4]?.toLowerCase() === "deny")) {
      // Only the documented educational pattern subset is understood; anything
      // else is reported rather than stored as an executable expression.
      const matcher = safeAsPathMatcher(tokens.slice(5).join(" "));
      if (!matcher) { unparsed(line); continue; }
      const list = result.asPathLists.find((entry) => entry.id === tokens[3]) ?? { id: tokens[3]!, entries: [] };
      if (!result.asPathLists.includes(list)) result.asPathLists.push(list);
      list.entries.push({
        sequence: nextListSequence(list.entries),
        action: tokens[4]!.toLowerCase() as "permit" | "deny",
        matcher,
      });
      applied(line);
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
      if (head === "match" && tokens[1]?.toLowerCase() === "ipv6" && tokens[2]?.toLowerCase() === "address"
        && tokens[3]?.toLowerCase() === "prefix-list" && tokens.length > 4) {
        currentRouteMap.match = { ...currentRouteMap.match, ipv6PrefixListIds: tokens.slice(4) };
        applied(line); continue;
      }
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
      if (head === "match" && tokens[1]?.toLowerCase() === "route-source"
        && (tokens[2]?.toLowerCase() === "local" || tokens[2]?.toLowerCase() === "ebgp" || tokens[2]?.toLowerCase() === "ibgp")) {
        currentRouteMap.match = { ...currentRouteMap.match, source: tokens[2]!.toLowerCase() as "local" | "ebgp" | "ibgp" };
        applied(line); continue;
      }
      if (head === "match" && tokens[1]?.toLowerCase() === "route-type"
        && (tokens[2]?.toLowerCase() === "local" || tokens[2]?.toLowerCase() === "ebgp" || tokens[2]?.toLowerCase() === "ibgp")) {
        currentRouteMap.match = { ...currentRouteMap.match, source: tokens[2]!.toLowerCase() as "local" | "ebgp" | "ibgp" };
        applied(line); continue;
      }
      if (head === "match" && tokens[1]?.toLowerCase() === "community" && tokens[2]) {
        const all = tokens[2].toLowerCase() === "all";
        const ids = tokens.slice(all ? 3 : 2);
        if (!ids.length) { unparsed(line); continue; }
        currentRouteMap.match = {
          ...currentRouteMap.match,
          communityListIds: ids,
          communityMatchAll: all ? true : undefined,
        };
        applied(line); continue;
      }
      if (head === "match" && tokens[1]?.toLowerCase() === "as-path" && tokens[2]
        && tokens[2].toLowerCase() !== "length") {
        currentRouteMap.match = { ...currentRouteMap.match, asPathListIds: tokens.slice(2) };
        applied(line); continue;
      }
      if (head === "set" && tokens[1]?.toLowerCase() === "community" && tokens[2]) {
        if (tokens.length === 3 && tokens[2].toLowerCase() === "none") {
          currentRouteMap.set = { ...currentRouteMap.set, communityNone: true }; applied(line); continue;
        }
        const additive = tokens.at(-1)!.toLowerCase() === "additive";
        const values = (additive ? tokens.slice(2, -1) : tokens.slice(2)).map((value) => canonicalCommunity(value));
        if (!values.length || values.some((value) => value === undefined)) { unparsed(line); continue; }
        currentRouteMap.set = {
          ...currentRouteMap.set,
          communities: values as string[],
          communityAdditive: additive ? true : undefined,
        };
        applied(line); continue;
      }
      if (head === "set" && tokens[1]?.toLowerCase() === "as-path" && tokens[2]?.toLowerCase() === "prepend"
        && tokens.slice(3).length > 0) {
        const values = tokens.slice(3).map(Number);
        if (values.length <= 10 && values.every((asn) => Number.isInteger(asn) && asn >= 1 && asn <= 4_294_967_295)) {
          currentRouteMap.set = { ...currentRouteMap.set, prependAsns: values }; applied(line); continue;
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
      // A sub-address-family we do not model — `labeled-unicast`, `multicast`,
      // `l2vpn evpn` — must never be mistaken for the plain family it starts
      // with, so each form is matched on its exact token count.
      if (head === "address-family" && (tokens[1]?.toLowerCase() === "vpnv4" || tokens[1]?.toLowerCase() === "vpnv6")) {
        const unicast = tokens.length === 2 || (tokens.length === 3 && tokens[2]?.toLowerCase() === "unicast");
        if (!unicast) { unparsed(line); continue; }
        currentBgpAddressFamily = { type: tokens[1]!.toLowerCase() === "vpnv4" ? "vpnv4" : "vpnv6" };
        applied(line);
        continue;
      }
      if (head === "address-family" && tokens[1]?.toLowerCase() === "ipv6" && tokens[2]?.toLowerCase() === "unicast") {
        if (tokens.length !== 3) { unparsed(line); continue; }
        currentBgpAddressFamily = { type: "ipv6-unicast" };
        applied(line);
        continue;
      }
      // `address-family l2vpn evpn` rides the existing session; EVPN-VPWS and
      // every other l2vpn sub-family stays unparsed and is reported honestly.
      if (head === "address-family" && tokens[1]?.toLowerCase() === "l2vpn") {
        if (tokens.length !== 3 || tokens[2]?.toLowerCase() !== "evpn") { unparsed(line); continue; }
        currentBgpAddressFamily = { type: "l2vpn-evpn" };
        applied(line);
        continue;
      }
      if (head === "address-family" && tokens[1]?.toLowerCase() === "ipv4" && tokens[2]?.toLowerCase() === "vrf" && tokens[3]) {
        if (tokens.length !== 4) { unparsed(line); continue; }
        currentBgpAddressFamily = { type: "ipv4-vrf", vrfId: tokens[3] };
        if (!result.bgp.vrfAddressFamilies.some((family) => family.vrfId === tokens[3])) {
          result.bgp.vrfAddressFamilies.push({ vrfId: tokens[3] });
        }
        applied(line);
        continue;
      }
      if (head === "address-family" && tokens[1]?.toLowerCase() === "ipv6" && tokens[2]?.toLowerCase() === "vrf" && tokens[3]) {
        if (tokens.length !== 4) { unparsed(line); continue; }
        // Only a VRF that declares `address-family ipv6` can redistribute into
        // VPNv6; anything else stays unparsed and is reported honestly.
        const vrf = result.vrfs.find((entry) => entry.id === tokens[3] || entry.name === tokens[3]);
        if (!vrf?.addressFamilyIpv6) { unparsed(line); continue; }
        currentBgpAddressFamily = { type: "ipv6-vrf", vrfId: vrf.id };
        if (!result.bgp.vrfAddressFamilies.some((family) => family.vrfId === vrf.id)) {
          result.bgp.vrfAddressFamilies.push({ vrfId: vrf.id });
        }
        applied(line);
        continue;
      }
      // `advertise l2vpn evpn` turns one tenant's connected and static routes
      // into EVPN Type 5 prefixes. It is stored on the VRF that owns them.
      if (head === "advertise" && tokens[1]?.toLowerCase() === "l2vpn" && tokens[2]?.toLowerCase() === "evpn") {
        const vrfId = currentBgpAddressFamily?.type === "ipv4-vrf" ? currentBgpAddressFamily.vrfId : undefined;
        const vrf = vrfId === undefined ? undefined : result.vrfs.find((entry) => entry.id === vrfId);
        if (tokens.length === 3 && vrf) { vrf.advertiseEvpn = true; applied(line); } else unparsed(line);
        continue;
      }
      if (head === "exit-address-family") { currentBgpAddressFamily = undefined; applied(line); continue; }
      if (head === "bgp" && tokens[1]?.toLowerCase() === "router-id" && isIpv4(tokens[2])) {
        result.bgp.routerId = tokens[2]; applied(line); continue;
      }
      if (head === "bgp" && tokens[1]?.toLowerCase() === "cluster-id" && isIpv4(tokens[2])) {
        result.bgp.clusterId = tokens[2]; applied(line); continue;
      }
      if (head === "network" && isIpv4(tokens[1]) && tokens[2]?.toLowerCase() === "mask") {
        const length = maskToPrefix(tokens[3]);
        if (length !== undefined) { result.bgp.networks.push({ network: tokens[1], prefixLength: length }); applied(line); }
        else unparsed(line);
        continue;
      }
      if (head === "aggregate-address" && isIpv4(tokens[1]) && tokens[2]) {
        const length = maskToPrefix(tokens[2]);
        const modifiers = tokens.slice(3).map((token) => token.toLowerCase());
        if (length === undefined || length > 31 || modifiers.some((token) => token !== "summary-only" && token !== "as-set")) {
          unparsed(line); continue;
        }
        result.bgp.aggregates = [
          ...(result.bgp.aggregates ?? []).filter((entry) => entry.prefix !== tokens[1] || entry.prefixLength !== length),
          {
            prefix: tokens[1],
            prefixLength: length,
            summaryOnly: modifiers.includes("summary-only") ? true : undefined,
            asSet: modifiers.includes("as-set") ? true : undefined,
          },
        ];
        applied(line); continue;
      }
      if (currentBgpAddressFamily?.type === "ipv6-unicast" && head === "network") {
        const prefix = ipv6Cidr(tokens[1]);
        if (prefix) {
          result.bgp.ipv6Networks = [
            ...(result.bgp.ipv6Networks ?? []).filter((entry) =>
              entry.network !== prefix.address || entry.prefixLength !== prefix.prefixLength),
            { network: prefix.address, prefixLength: prefix.prefixLength },
          ];
          applied(line);
        } else unparsed(line);
        continue;
      }
      if (head === "neighbor" && (isIpv4(tokens[1]) || isIpv6Text(tokens[1] ?? ""))) {
        const address = isIpv4(tokens[1]) ? tokens[1]! : normalizeIpv6Text(tokens[1]!);
        const existing = result.bgp.neighbors.find((neighbor) => neighbor.address === address);
        if (tokens[2]?.toLowerCase() === "remote-as" && /^\d+$/u.test(tokens[3] ?? "")) {
          const remoteAs = Number(tokens[3]);
          if (remoteAs < 1 || remoteAs > 4_294_967_295) { unparsed(line); continue; }
          if (existing) existing.remoteAs = remoteAs;
          else result.bgp.neighbors.push({ address, remoteAs, enabled: true });
          applied(line); continue;
        }
        if (!existing) { unparsed(line); continue; }
        // Inside `address-family ipv6 unicast` every neighbor setting belongs
        // to that family's own block rather than to the flat IPv4 fields.
        if (currentBgpAddressFamily?.type === "ipv6-unicast") {
          const ipv6 = { ...(existing.ipv6 ?? {}) };
          const keyword = tokens[2]?.toLowerCase();
          if (keyword === "activate") ipv6.activated = true;
          else if (keyword === "next-hop-self" && tokens.length === 3) ipv6.nextHopSelf = true;
          else if (keyword === "route-reflector-client" && tokens.length === 3) ipv6.routeReflectorClient = true;
          else if (keyword === "send-community" && tokens.length === 3) ipv6.sendCommunityStandard = true;
          else if (keyword === "default-originate" && tokens.length === 3) ipv6.defaultOriginate = true;
          else if (keyword === "default-originate" && tokens[3]?.toLowerCase() === "route-map" && tokens[4]) {
            ipv6.defaultOriginate = true;
            ipv6.defaultOriginateRouteMap = tokens[4];
          } else if ((keyword === "prefix-list" || keyword === "route-map")
            && tokens[3] && (tokens[4]?.toLowerCase() === "in" || tokens[4]?.toLowerCase() === "out")) {
            const key = `${keyword === "prefix-list" ? "prefixList" : "routeMap"}${tokens[4]!.toLowerCase() === "in" ? "In" : "Out"}` as
              "prefixListIn" | "prefixListOut" | "routeMapIn" | "routeMapOut";
            ipv6[key] = tokens[3];
          } else { unparsed(line); continue; }
          existing.ipv6 = ipv6;
          applied(line); continue;
        }
        if (currentBgpAddressFamily?.type === "l2vpn-evpn") {
          const keyword = tokens[2]?.toLowerCase();
          if (keyword === "activate" && tokens.length === 3) { existing.evpnActivated = true; applied(line); continue; }
          if (keyword === "send-community" && tokens[3]?.toLowerCase() === "extended") {
            existing.sendCommunityExtended = true; applied(line); continue;
          }
          if (keyword === "route-reflector-client" && tokens.length === 3) {
            existing.routeReflectorClient = true; applied(line); continue;
          }
          unparsed(line); continue;
        }
        if (currentBgpAddressFamily?.type === "vpnv6" && tokens[2]?.toLowerCase() === "activate") {
          existing.vpnv6Activated = true; applied(line); continue;
        }
        if (currentBgpAddressFamily?.type === "vpnv4" && tokens[2]?.toLowerCase() === "activate") {
          existing.vpnv4Activated = true; applied(line); continue;
        }
        if ((currentBgpAddressFamily?.type === "vpnv4" || currentBgpAddressFamily?.type === "vpnv6")
          && tokens[2]?.toLowerCase() === "send-community" && tokens[3]?.toLowerCase() === "extended") {
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
        if (tokens[2]?.toLowerCase() === "route-reflector-client" && tokens.length === 3) {
          existing.routeReflectorClient = true; applied(line); continue;
        }
        if (tokens[2]?.toLowerCase() === "send-community" && tokens.length === 3) {
          existing.sendCommunityStandard = true; applied(line); continue;
        }
        if (tokens[2]?.toLowerCase() === "send-community" && tokens[3]?.toLowerCase() === "both") {
          existing.sendCommunityStandard = true; existing.sendCommunityExtended = true; applied(line); continue;
        }
        if (tokens[2]?.toLowerCase() === "default-originate" && tokens.length === 3) {
          existing.defaultOriginate = true; applied(line); continue;
        }
        if (tokens[2]?.toLowerCase() === "default-originate" && tokens[3]?.toLowerCase() === "route-map" && tokens[4]) {
          existing.defaultOriginate = true; existing.defaultOriginateRouteMap = tokens[4]; applied(line); continue;
        }
        if ((tokens[2]?.toLowerCase() === "prefix-list" || tokens[2]?.toLowerCase() === "route-map")
          && tokens[3] && (tokens[4]?.toLowerCase() === "in" || tokens[4]?.toLowerCase() === "out")) {
          const key = `${tokens[2]!.toLowerCase() === "prefix-list" ? "prefixList" : "routeMap"}${tokens[4]!.toLowerCase() === "in" ? "In" : "Out"}` as "prefixListIn" | "prefixListOut" | "routeMapIn" | "routeMapOut";
          existing[key] = tokens[3]; applied(line); continue;
        }
      }
      if ((currentBgpAddressFamily?.type === "ipv4-vrf" || currentBgpAddressFamily?.type === "ipv6-vrf")
        && head === "redistribute"
        && (tokens[1]?.toLowerCase() === "connected" || tokens[1]?.toLowerCase() === "static")) {
        const vrfId = currentBgpAddressFamily.vrfId;
        const family = result.bgp.vrfAddressFamilies.find((entry) => entry.vrfId === vrfId)!;
        const connected = tokens[1]!.toLowerCase() === "connected";
        if (currentBgpAddressFamily.type === "ipv6-vrf") {
          if (connected) family.redistributeConnectedIpv6 = true;
          else family.redistributeStaticIpv6 = true;
        } else if (connected) family.redistributeConnected = true;
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
      // `vrf forwarding <name>` puts this interface in a tenant routing
      // context; a VRF the file never defined is reported, never invented.
      if (head === "vrf" && tokens[1]?.toLowerCase() === "forwarding" && tokens[2] && tokens.length === 3) {
        const vrf = result.vrfs.find((entry) => entry.id === tokens[2] || entry.name === tokens[2]);
        if (vrf) { current.vrfId = vrf.id; applied(line); } else unparsed(line);
        continue;
      }
      // A distributed anycast gateway is an SVI property: a routed port has no
      // stretched tenant VLAN to present one gateway for, so the line is
      // reported rather than silently accepted anywhere else.
      if (head === "fabric" && tokens[1]?.toLowerCase() === "forwarding"
        && tokens[2]?.toLowerCase() === "mode" && tokens[3]?.toLowerCase() === "anycast-gateway"
        && tokens.length === 4) {
        if (isSviInterfaceId(current.id)) { current.anycastGateway = true; applied(line); } else unparsed(line);
        continue;
      }
      // `ethernet-segment <name>` binds this attachment to a segment. A CE hangs
      // off an access switchport, so an SVI or a routed port is reported rather
      // than quietly joined to a segment it could never serve.
      if (head === "ethernet-segment" && tokens.length === 2 && tokens[1]) {
        if (isSviInterfaceId(current.id)) { unparsed(line); continue; }
        segmentAttachments.set(current.id, tokens[1]);
        applied(line);
        continue;
      }
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
      // One switchport reader serves a physical port and a Port-channel alike,
      // so a bundle can never read a VLAN list differently from its members.
      if (head === "switchport") {
        if (applySwitchportLine(current, tokens)) applied(line); else unparsed(line);
        continue;
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

  // An SVI shares the physical interface body but is not a port: it never
  // reaches spanning tree, EtherChannel, discovery or a service policy.
  result.interfaces = [...interfaces.values()].filter((iface) => !isSviInterfaceId(iface.id));
  result.svis = [...interfaces.values()]
    .filter((iface) => isSviInterfaceId(iface.id))
    .map((iface): ImportedSviConfig => ({
      vlanId: Number(iface.id.slice("Vlan".length)),
      description: iface.description,
      shutdown: iface.shutdown,
      ipv4: iface.ipv4,
      ipv6: iface.ipv6,
      vrfId: iface.vrfId,
      anycastGateway: iface.anycastGateway,
    }))
    .sort((a, b) => a.vlanId - b.vlanId);
  result.loopbacks = [...loopbacks.values()].sort((a, b) => a.id - b.id);
  result.portChannels = [...portChannels.values()].sort((a, b) => a.channelId - b.channelId);
  // A VNI declared on nve1 needs a VLAN before it means anything, and the VLAN
  // arrives from a separate `vlan configuration` block. A VNI that never got
  // one is dropped rather than mapped to an invented VLAN.
  if (nveSourceInterfaceId !== undefined) {
    const members: NveMemberConfig[] = [...nveMembers.entries()]
      .flatMap(([vni, member]) => {
        const vlanId = vniToVlan.get(vni);
        if (vlanId === undefined) return [];
        return [{
          vni,
          vlanId,
          replication: member.replication.type === "static"
            ? { type: "static" as const, peerAddresses: [...member.replication.peerAddresses].sort() }
            : { type: "bgp-evpn" as const },
        }];
      })
      .sort((a, b) => a.vni - b.vni);
    // An L3VNI that names a VRF the file never defined loses its association
    // rather than inventing a routing context that does not exist.
    const vrfMembers = [...nveVrfMembers.entries()]
      .filter(([, vrfId]) => result.vrfs?.some((vrf) => vrf.id === vrfId || vrf.name === vrfId))
      .map(([vni, vrfId]) => ({
        vni,
        vrfId: result.vrfs!.find((vrf) => vrf.id === vrfId || vrf.name === vrfId)!.id,
      }))
      .sort((a, b) => a.vni - b.vni);
    result.nve = {
      id: "nve1",
      sourceInterfaceId: nveSourceInterfaceId,
      shutdown: nveShutdown,
      members,
      vrfMembers: vrfMembers.length > 0 ? vrfMembers : undefined,
    };
  }
  // A segment needs a usable ESI and a supported redundancy mode before it can
  // exist; one that has neither an identifier nor an attachment is dropped
  // rather than invented into something the engine would refuse anyway.
  const segments = [...ethernetSegments.entries()]
    .flatMap(([id, segment]) => {
      if (segment.esi === undefined || segment.redundancyMode !== "single-active") return [];
      const attachments = [...segmentAttachments.entries()]
        .filter(([, segmentId]) => segmentId === id)
        .map(([interfaceId]) => interfaceId)
        .sort((a, b) => a.localeCompare(b));
      return [{
        id,
        esi: segment.esi,
        redundancyMode: "single-active" as const,
        interfaces: attachments,
      }];
    })
    .sort((a, b) => a.esi.localeCompare(b.esi) || a.id.localeCompare(b.id));
  if (segments.length > 0) {
    result.evpn ??= { vnis: [] };
    result.evpn.ethernetSegments = segments;
  }
  if (result.evpn && result.evpn.vnis.length === 0 && result.evpn.anycastGatewayMac === undefined
    && (result.evpn.ethernetSegments ?? []).length === 0) {
    result.evpn = undefined;
  } else if (result.evpn) result.evpn.vnis.sort((a, b) => a.vni - b.vni);
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

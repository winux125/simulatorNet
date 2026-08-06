/**
 * The deterministic device-configuration renderer.
 *
 * Structured `DeviceConfig` is the single source of truth; the text produced
 * here is a *projection* of it, never a second copy that can drift. Sections are
 * emitted in one fixed order and every list is sorted canonically, so the same
 * configuration always renders byte-identically in the browser and in the
 * verifier.
 *
 * Two things never appear in the output:
 *
 * - runtime state (ARP/MAC tables, learned routes, leases, sessions, counters);
 * - credential material. A password, key, community string, verifier, salt,
 *   hash or fingerprint is rendered as `<configured>` and nothing else.
 */
import {
  dscpName,
  type AaaConfiguration,
  type AccessPointDeviceConfig,
  type BridgeDeviceConfig,
  type CloudDeviceConfig,
  DEFAULT_CDP_HOLD_SECONDS,
  DEFAULT_CDP_INTERVAL_SECONDS,
  DEFAULT_LLDP_HOLD_SECONDS,
  DEFAULT_LLDP_INTERVAL_SECONDS,
  type ConsoleAccessConfiguration,
  type DeviceConfig,
  type DeviceType,
  type EvpnConfig,
  type VrfConfig,
  type FirewallDeviceConfig,
  type Ipv4AclConfig,
  type Ipv6AclConfig,
  type Ipv6InterfaceAddress,
  type Layer3SwitchDeviceConfig,
  type LoopbackInterfaceConfig,
  type NeighborDiscoveryConfig,
  type NveInterfaceConfig,
  type OspfProcessConfig,
  type Ospfv3ProcessConfig,
  type BgpProcessConfig,
  type Ipv6PrefixListConfig,
  type PrefixListConfig,
  type RouteMapConfig,
  type CommunityListConfig,
  type AsPathListConfig,
  type QosConfiguration,
  type RemoteAccessConfiguration,
  type RouterDeviceConfig,
  type ServerDeviceConfig,
  type SnmpAgentConfiguration,
  type SpanningTreeConfig,
  type SwitchDeviceConfig,
  type VpnConfiguration,
  type WirelessAccessPointConfiguration,
  type WirelessRouterDeviceConfig,
} from "@sim/contracts";
import { maskFromPrefixLength, normalizeConfigurationText, REDACTED_SECRET } from "./text";

/**
 * Device kinds that own a human-readable configuration file.
 *
 * A PC, laptop, smartphone, hub or traffic generator deliberately does not:
 * dressing a host up as a Cisco appliance would teach the wrong thing, so those
 * devices keep the Desktop / IP Configuration surface instead.
 */
const READABLE_KINDS: ReadonlySet<DeviceType> = new Set<DeviceType>([
  "router",
  "firewall",
  "cloud",
  "l2-switch",
  "l3-switch",
  "bridge",
  "access-point",
  "wireless-router",
  "server",
]);

export function supportsDeviceConfigurationText(kind: DeviceType): boolean {
  return READABLE_KINDS.has(kind);
}

/** Which syntax a device's configuration file is written in. */
export type ConfigurationDialect = "ios-like" | "simulatornet";

export function configurationDialect(kind: DeviceType): ConfigurationDialect {
  return kind === "router" || kind === "cloud" || kind === "l2-switch" || kind === "l3-switch" || kind === "bridge"
    ? "ios-like"
    : "simulatornet";
}

const byString = (a: string, b: string): number => a.localeCompare(b);
const byId = <T extends { id: string }>(a: T, b: T): number => byString(a.id, b.id);
const bySequence = <T extends { sequence: number }>(a: T, b: T): number => a.sequence - b.sequence;
const byInterfaceName = <T extends { interfaceName: string }>(a: T, b: T): number =>
  byString(a.interfaceName, b.interfaceName);

function sorted<T>(values: readonly T[] | undefined, compare: (a: T, b: T) => number): T[] {
  return [...(values ?? [])].sort(compare);
}

/**
 * IOS prints a setting only when it differs from the default, and an
 * administratively-up interface is the default. Rendering the whole default
 * state would make every Compare view noisy and every `.cfg` unfamiliar.
 */
function adminStateLines(shutdown: boolean): string[] {
  return shutdown ? [" shutdown"] : [];
}

function ipv6Lines(addresses: readonly Ipv6InterfaceAddress[] | undefined, indent = " "): string[] {
  return sorted(addresses, (a, b) => byString(a.address, b.address) || a.prefixLength - b.prefixLength)
    .map((address) => `${indent}ipv6 address ${address.address}/${address.prefixLength}`);
}

// --- matchers ---------------------------------------------------------------

type Ipv4Matcher =
  | { kind: "any" }
  | { kind: "host"; address: string }
  | { kind: "network"; address: string; wildcard: string };

type Ipv6Matcher =
  | { kind: "any" }
  | { kind: "host"; address: string }
  | { kind: "prefix"; address: string; prefixLength: number };

type PortMatcher =
  | { kind: "any" }
  | { kind: "eq"; port: number }
  | { kind: "range"; start: number; end: number };

function ipv4MatcherText(matcher: Ipv4Matcher): string {
  if (matcher.kind === "any") return "any";
  if (matcher.kind === "host") return `host ${matcher.address}`;
  return `${matcher.address} ${matcher.wildcard}`;
}

function ipv6MatcherText(matcher: Ipv6Matcher): string {
  if (matcher.kind === "any") return "any";
  if (matcher.kind === "host") return `host ${matcher.address}`;
  return `${matcher.address}/${matcher.prefixLength}`;
}

function portMatcherText(matcher: PortMatcher | undefined): string {
  if (!matcher || matcher.kind === "any") return "";
  return matcher.kind === "eq" ? ` eq ${matcher.port}` : ` range ${matcher.start} ${matcher.end}`;
}

function protocolText(protocol: string | number): string {
  if (protocol === 1) return "icmp";
  if (protocol === 6) return "tcp";
  if (protocol === 17) return "udp";
  if (protocol === 47) return "gre";
  if (protocol === 50) return "esp";
  if (protocol === 58) return "icmp";
  return String(protocol);
}

// --- shared sections --------------------------------------------------------

function secretLines(access: ConsoleAccessConfiguration | undefined): string[] {
  if (!access) return [];
  const out: string[] = [];
  if (access.enableSecretVerifier) out.push(`enable secret ${REDACTED_SECRET}`);
  for (const user of sorted(access.users, (a, b) => byString(a.username, b.username))) {
    if (!user.enabled) continue;
    out.push(`username ${user.username} privilege ${user.privilegeLevel} secret ${REDACTED_SECRET}`);
  }
  if (access.credentialResetRequired) {
    out.push("! an imported credential could not be verified and must be reset");
  }
  if (out.length > 0) out.push("!");
  return out;
}

function bannerLines(access: ConsoleAccessConfiguration | undefined): string[] {
  const out: string[] = [];
  if (access?.motdBanner) out.push(`banner motd ^C${access.motdBanner}^C`);
  if (access?.loginBanner) out.push(`banner login ^C${access.loginBanner}^C`);
  if (out.length > 0) out.push("!");
  return out;
}

function consoleLineLines(access: ConsoleAccessConfiguration | undefined): string[] {
  if (!access || access.mode === "none") return [];
  const out = ["line con 0"];
  if (access.mode === "press-return") out.push(" login");
  if (access.mode === "password-only") {
    out.push(` password ${REDACTED_SECRET}`, " login");
  }
  if (access.mode === "local-user") out.push(" login local");
  out.push("!");
  return out;
}

function remoteAccessLines(remote: RemoteAccessConfiguration | undefined): string[] {
  if (!remote) return [];
  const out: string[] = [];
  if (remote.ssh.domainName) out.push(`ip domain-name ${remote.ssh.domainName}`);
  if (remote.ssh.enabled) {
    out.push(`ip ssh version ${remote.ssh.version}`);
    // A fingerprint is derived identity, not a key — and still never printed.
    if (remote.ssh.hostKeyFingerprint) out.push(`! ssh host key ${REDACTED_SECRET}`);
  }
  if (!remote.telnetEnabled) out.push("no transport input telnet");
  for (const line of sorted(remote.vtyLines, (a, b) => a.first - b.first || a.last - b.last)) {
    out.push(`line vty ${line.first} ${line.last}`);
    if (line.passwordVerifier) out.push(` password ${REDACTED_SECRET}`);
    if (line.loginMode === "password") out.push(" login");
    if (line.loginMode === "local") out.push(" login local");
    if (line.authenticationListName) out.push(` login authentication ${line.authenticationListName}`);
    if (line.authorizationListName) out.push(` authorization exec ${line.authorizationListName}`);
    out.push(line.transports.length === 0
      ? " transport input none"
      : ` transport input ${[...line.transports].sort(byString).join(" ")}`);
    const minutes = Math.floor(line.execTimeoutSeconds / 60);
    out.push(` exec-timeout ${minutes} ${line.execTimeoutSeconds - minutes * 60}`);
  }
  if (out.length > 0) out.push("!");
  return out;
}

function aaaLines(aaa: AaaConfiguration | undefined): string[] {
  if (!aaa?.enabled) return [];
  const out = ["aaa new-model"];
  const list = (prefix: string, entries: readonly { name: string; methods: readonly string[] }[]): void => {
    for (const entry of sorted(entries, (a, b) => byString(a.name, b.name))) {
      out.push(`${prefix} ${entry.name} ${entry.methods.join(" ")}`);
    }
  };
  list("aaa authentication login", aaa.authenticationLogin);
  list("aaa authorization exec", aaa.authorizationExec);
  for (const entry of sorted(aaa.authorizationCommands, (a, b) => a.privilegeLevel - b.privilegeLevel || byString(a.name, b.name))) {
    out.push(`aaa authorization commands ${entry.privilegeLevel} ${entry.name} ${entry.methods.join(" ")}`);
  }
  for (const entry of sorted(aaa.accountingExec, (a, b) => byString(a.name, b.name))) {
    out.push(`aaa accounting exec ${entry.name} ${entry.mode} ${entry.methods.join(" ")}`);
  }
  for (const entry of sorted(aaa.accountingCommands, (a, b) => byString(a.name, b.name))) {
    const level = entry.privilegeLevel === undefined ? "" : `${entry.privilegeLevel} `;
    out.push(`aaa accounting commands ${level}${entry.name} ${entry.mode} ${entry.methods.join(" ")}`);
  }
  for (const server of sorted(aaa.servers, (a, b) => byString(a.name, b.name))) {
    out.push(`${server.protocol === "radius" ? "radius" : "tacacs"} server ${server.name}`);
    out.push(` address ipv4 ${server.address}`);
    if (server.authenticationPort !== undefined) out.push(` auth-port ${server.authenticationPort}`);
    if (server.accountingPort !== undefined) out.push(` acct-port ${server.accountingPort}`);
    if (server.sharedKeyFingerprint) out.push(` key ${REDACTED_SECRET}`);
    out.push(` timeout ${server.timeoutSeconds}`, ` retransmit ${server.retries}`);
  }
  out.push("!");
  return out;
}

function snmpLines(snmp: SnmpAgentConfiguration | undefined): string[] {
  if (!snmp?.enabled) return [];
  const out: string[] = [];
  for (const community of sorted(snmp.communities, byId)) {
    if (!community.enabled) continue;
    const scope = community.managerAddress ? ` ${community.managerAddress}` : "";
    out.push(`snmp-server community ${REDACTED_SECRET} ${community.access === "read-only" ? "ro" : "ro"}${scope}`);
  }
  if (snmp.location) out.push(`snmp-server location ${snmp.location}`);
  if (snmp.contact) out.push(`snmp-server contact ${snmp.contact}`);
  if (snmp.trapsEnabled) {
    const types = [...snmp.enabledTrapTypes].sort(byString);
    out.push(types.length === 0 ? "snmp-server enable traps" : `snmp-server enable traps ${types.join(" ")}`);
  }
  for (const destination of sorted(snmp.trapDestinations, byId)) {
    if (!destination.enabled) continue;
    out.push(`snmp-server host ${destination.address} version ${destination.version} ${REDACTED_SECRET} port ${destination.port}`);
  }
  if (out.length > 0) out.push("!");
  return out;
}

function discoveryLines(discovery: NeighborDiscoveryConfig | undefined): string[] {
  if (!discovery) return [];
  const out: string[] = [];
  // Neighbour discovery is off by default here, so only an enabled protocol —
  // and only a non-default timer — is worth a line.
  if (discovery.cdpEnabled) {
    out.push("cdp run");
    if (discovery.cdpIntervalSeconds !== DEFAULT_CDP_INTERVAL_SECONDS) {
      out.push(`cdp timer ${discovery.cdpIntervalSeconds}`);
    }
    if (discovery.cdpHoldTimeSeconds !== DEFAULT_CDP_HOLD_SECONDS) {
      out.push(`cdp holdtime ${discovery.cdpHoldTimeSeconds}`);
    }
  }
  if (discovery.lldpEnabled) {
    out.push("lldp run");
    if (discovery.lldpIntervalSeconds !== DEFAULT_LLDP_INTERVAL_SECONDS) {
      out.push(`lldp timer ${discovery.lldpIntervalSeconds}`);
    }
    if (discovery.lldpHoldTimeSeconds !== DEFAULT_LLDP_HOLD_SECONDS) {
      out.push(`lldp holdtime ${discovery.lldpHoldTimeSeconds}`);
    }
  }
  if (out.length > 0) out.push("!");
  return out;
}

function discoveryInterfaceLines(discovery: NeighborDiscoveryConfig | undefined, interfaceId: string): string[] {
  const entry = discovery?.interfaces.find((candidate) => candidate.interfaceId === interfaceId);
  if (!entry) return [];
  const out: string[] = [];
  if (!entry.cdpEnabled) out.push(" no cdp enable");
  if (!entry.lldpTransmit) out.push(" no lldp transmit");
  if (!entry.lldpReceive) out.push(" no lldp receive");
  return out;
}

function spanningTreeLines(stp: SpanningTreeConfig | undefined): string[] {
  if (!stp || stp.mode === "disabled") return [];
  const out = [stp.mode === "rstp" ? "spanning-tree mode rapid-pvst" : "spanning-tree mode pvst"];
  for (const vlan of sorted(stp.vlans, (a, b) => a.vlanId - b.vlanId)) {
    out.push(`spanning-tree vlan ${vlan.vlanId} priority ${vlan.priority}`);
  }
  out.push(
    `spanning-tree hello-time ${stp.helloTimeSeconds}`,
    `spanning-tree max-age ${stp.maxAgeSeconds}`,
    `spanning-tree forward-time ${stp.forwardDelaySeconds}`,
    "!",
  );
  return out;
}

function spanningTreePortLines(stp: SpanningTreeConfig | undefined, interfaceId: string): string[] {
  const port = stp?.ports.find((candidate) => candidate.interfaceId === interfaceId);
  if (!port || stp?.mode === "disabled") return [];
  const out: string[] = [];
  if (port.cost !== undefined) out.push(` spanning-tree cost ${port.cost}`);
  out.push(` spanning-tree port-priority ${port.priority}`);
  if (port.portFast) out.push(" spanning-tree portfast");
  if (port.bpduGuard) out.push(" spanning-tree bpduguard enable");
  return out;
}

function servicePolicyLines(qos: QosConfiguration | undefined, interfaceName: string): string[] {
  return sorted(qos?.servicePolicies.filter((entry) => entry.interfaceName === interfaceName), (a, b) =>
    byString(a.direction, b.direction) || byString(a.policyMapId, b.policyMapId))
    .map((entry) => ` service-policy ${entry.direction} ${entry.policyMapId}`);
}

function aclBindingLines(
  bindings: readonly { interfaceName: string; direction: "in" | "out"; aclId: string }[] | undefined,
  interfaceName: string,
  keyword: string,
): string[] {
  return sorted(bindings?.filter((entry) => entry.interfaceName === interfaceName), (a, b) =>
    byString(a.direction, b.direction) || byString(a.aclId, b.aclId))
    .map((entry) => ` ${keyword} ${entry.aclId} ${entry.direction}`);
}

function ospfInterfaceLines(ospf: OspfProcessConfig | undefined, interfaceId: string): string[] {
  const entry = ospf?.interfaces.find((candidate) => candidate.interfaceId === interfaceId);
  if (!entry || !ospf) return [];
  const out: string[] = [];
  if (entry.enabled) out.push(` ip ospf ${ospf.processId} area ${entry.area ?? 0}`);
  if (entry.cost !== undefined) out.push(` ip ospf cost ${entry.cost}`);
  if (entry.priority !== undefined) out.push(` ip ospf priority ${entry.priority}`);
  if (entry.networkType !== undefined) out.push(` ip ospf network ${entry.networkType}`);
  if (entry.helloIntervalSeconds !== undefined) out.push(` ip ospf hello-interval ${entry.helloIntervalSeconds}`);
  if (entry.deadIntervalSeconds !== undefined) out.push(` ip ospf dead-interval ${entry.deadIntervalSeconds}`);
  return out;
}

function ospfv3InterfaceLines(ospfv3: Ospfv3ProcessConfig | undefined, interfaceId: string): string[] {
  const entry = ospfv3?.interfaces.find((candidate) => candidate.interfaceId === interfaceId);
  if (!entry || !ospfv3) return [];
  const out: string[] = [];
  if (entry.enabled) out.push(` ipv6 ospf ${ospfv3.processId} area ${entry.area ?? 0}`);
  if (entry.cost !== undefined) out.push(` ipv6 ospf cost ${entry.cost}`);
  return out;
}

function ospfProcessLines(ospf: OspfProcessConfig | undefined): string[] {
  if (!ospf) return [];
  const out = [`router ospf ${ospf.processId}`];
  if (ospf.routerId) out.push(` router-id ${ospf.routerId}`);
  for (const network of sorted(ospf.networks, (a, b) => byString(a.network, b.network))) {
    out.push(` network ${network.network} ${network.wildcard} area ${network.area}`);
  }
  for (const name of [...ospf.passiveInterfaces].sort(byString)) out.push(` passive-interface ${name}`);
  out.push("!");
  return out;
}

function ospfv3ProcessLines(ospfv3: Ospfv3ProcessConfig | undefined): string[] {
  if (!ospfv3) return [];
  const out = [`ipv6 router ospf ${ospfv3.processId}`];
  if (ospfv3.routerId) out.push(` router-id ${ospfv3.routerId}`);
  for (const name of [...ospfv3.passiveInterfaces].sort(byString)) out.push(` passive-interface ${name}`);
  out.push("!");
  return out;
}

/** `^$`, `_65001_`, … — the same educational subset the parser accepts back. */
function asPathPatternText(matcher: AsPathListConfig["entries"][number]["matcher"]): string {
  switch (matcher.kind) {
    case "empty": return "^$";
    case "contains": return `_${matcher.asn}_`;
    case "starts-with": return `^${matcher.asn}_`;
    case "ends-with": return `_${matcher.asn}$`;
    case "exact": return `^${matcher.asPath.join(" ")}$`;
    case "length": return `length ${matcher.operator} ${matcher.length}`;
  }
}

function routePolicyLines(
  prefixLists: readonly PrefixListConfig[] | undefined,
  routeMaps: readonly RouteMapConfig[] | undefined,
  communityLists: readonly CommunityListConfig[] | undefined,
  asPathLists: readonly AsPathListConfig[] | undefined,
  ipv6PrefixLists: readonly Ipv6PrefixListConfig[] | undefined,
): string[] {
  const out: string[] = [];
  for (const list of sorted(prefixLists, byId)) {
    for (const entry of sorted(list.entries, bySequence)) {
      out.push(`ip prefix-list ${list.id} seq ${entry.sequence} ${entry.action} ${entry.prefix}/${entry.prefixLength}`
        + `${entry.ge === undefined ? "" : ` ge ${entry.ge}`}${entry.le === undefined ? "" : ` le ${entry.le}`}`);
    }
  }
  for (const list of sorted(ipv6PrefixLists, byId)) {
    for (const entry of sorted(list.entries, bySequence)) {
      out.push(`ipv6 prefix-list ${list.id} seq ${entry.sequence} ${entry.action} ${entry.prefix}/${entry.prefixLength}`
        + `${entry.ge === undefined ? "" : ` ge ${entry.ge}`}${entry.le === undefined ? "" : ` le ${entry.le}`}`);
    }
  }
  for (const list of sorted(communityLists, byId)) {
    for (const entry of sorted(list.entries, bySequence)) {
      out.push(`ip community-list standard ${list.id} ${entry.action} ${entry.communities.join(" ")}`);
    }
  }
  for (const list of sorted(asPathLists, byId)) {
    for (const entry of sorted(list.entries, bySequence)) {
      out.push(`ip as-path access-list ${list.id} ${entry.action} ${asPathPatternText(entry.matcher)}`);
    }
  }
  for (const map of sorted(routeMaps, byId)) {
    for (const sequence of sorted(map.sequences, bySequence)) {
      out.push(`route-map ${map.id} ${sequence.action} ${sequence.sequence}`);
      if (sequence.match?.prefixListIds?.length) out.push(` match ip address prefix-list ${sequence.match.prefixListIds.join(" ")}`);
      if (sequence.match?.ipv6PrefixListIds?.length) out.push(` match ipv6 address prefix-list ${sequence.match.ipv6PrefixListIds.join(" ")}`);
      if (sequence.match?.neighbor) out.push(` match neighbor ${sequence.match.neighbor}`);
      if (sequence.match?.maximumAsPathLength !== undefined) out.push(` match as-path length ${sequence.match.maximumAsPathLength}`);
      if (sequence.match?.source) out.push(` match route-source ${sequence.match.source}`);
      if (sequence.match?.communityListIds?.length) {
        out.push(` match community ${sequence.match.communityMatchAll ? "all " : ""}${sequence.match.communityListIds.join(" ")}`);
      }
      if (sequence.match?.asPathListIds?.length) out.push(` match as-path ${sequence.match.asPathListIds.join(" ")}`);
      if (sequence.set?.localPreference !== undefined) out.push(` set local-preference ${sequence.set.localPreference}`);
      if (sequence.set?.med !== undefined) out.push(` set metric ${sequence.set.med}`);
      if (sequence.set?.weight !== undefined) out.push(` set weight ${sequence.set.weight}`);
      if (sequence.set?.prependAsns?.length) out.push(` set as-path prepend ${sequence.set.prependAsns.join(" ")}`);
      else if (sequence.set?.prependLocalAs !== undefined) out.push(` set as-path prepend ${sequence.set.prependLocalAs}`);
      if (sequence.set?.communityNone) out.push(" set community none");
      else if (sequence.set?.communities?.length) {
        out.push(` set community ${sequence.set.communities.join(" ")}${sequence.set.communityAdditive ? " additive" : ""}`);
      }
      if (sequence.set?.origin !== undefined) out.push(` set origin ${sequence.set.origin}`);
      out.push("!");
    }
  }
  return out;
}

function bgpProcessLines(bgp: BgpProcessConfig | undefined, vrfs?: readonly VrfConfig[]): string[] {
  if (!bgp) return [];
  const out = [`router bgp ${bgp.localAs}`];
  if (bgp.routerId) out.push(` bgp router-id ${bgp.routerId}`);
  if (bgp.clusterId) out.push(` bgp cluster-id ${bgp.clusterId}`);
  for (const neighbor of sorted(bgp.neighbors, (a, b) => byString(a.address, b.address))) {
    out.push(` neighbor ${neighbor.address} remote-as ${neighbor.remoteAs}`);
    if (neighbor.description) out.push(` neighbor ${neighbor.address} description ${neighbor.description}`);
    if (neighbor.updateSource) out.push(` neighbor ${neighbor.address} update-source ${neighbor.updateSource}`);
    if (neighbor.ebgpMultihop !== undefined) out.push(` neighbor ${neighbor.address} ebgp-multihop ${neighbor.ebgpMultihop}`);
    if (neighbor.nextHopSelf) out.push(` neighbor ${neighbor.address} next-hop-self`);
    if (neighbor.routeReflectorClient) out.push(` neighbor ${neighbor.address} route-reflector-client`);
    if (neighbor.sendCommunityStandard) {
      out.push(` neighbor ${neighbor.address} send-community${neighbor.sendCommunityExtended ? " both" : ""}`);
    }
    if (neighbor.prefixListIn) out.push(` neighbor ${neighbor.address} prefix-list ${neighbor.prefixListIn} in`);
    if (neighbor.prefixListOut) out.push(` neighbor ${neighbor.address} prefix-list ${neighbor.prefixListOut} out`);
    if (neighbor.routeMapIn) out.push(` neighbor ${neighbor.address} route-map ${neighbor.routeMapIn} in`);
    if (neighbor.routeMapOut) out.push(` neighbor ${neighbor.address} route-map ${neighbor.routeMapOut} out`);
    if (neighbor.defaultOriginate) {
      out.push(` neighbor ${neighbor.address} default-originate`
        + `${neighbor.defaultOriginateRouteMap ? ` route-map ${neighbor.defaultOriginateRouteMap}` : ""}`);
    }
    if (neighbor.enabled === false) out.push(` neighbor ${neighbor.address} shutdown`);
  }
  for (const network of sorted(bgp.networks, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
    out.push(` network ${network.network} mask ${maskFromPrefixLength(network.prefixLength)}`);
  }
  for (const aggregate of sorted(bgp.aggregates, (a, b) => byString(a.prefix, b.prefix) || a.prefixLength - b.prefixLength)) {
    out.push(` aggregate-address ${aggregate.prefix} ${maskFromPrefixLength(aggregate.prefixLength)}`
      + `${aggregate.summaryOnly ? " summary-only" : ""}${aggregate.asSet ? " as-set" : ""}`);
  }
  // IPv6 unicast: only the per-family settings live inside the block, so an
  // IPv4-only process renders exactly as it did before M10.13.
  const ipv6Neighbors = sorted(bgp.neighbors?.filter((neighbor) => neighbor.ipv6 !== undefined), (a, b) => byString(a.address, b.address));
  const ipv6Networks = sorted(bgp.ipv6Networks, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength);
  if (ipv6Neighbors.length > 0 || ipv6Networks.length > 0) {
    out.push(" address-family ipv6 unicast");
    for (const neighbor of ipv6Neighbors) {
      const ipv6 = neighbor.ipv6!;
      if (ipv6.activated) out.push(`  neighbor ${neighbor.address} activate`);
      if (ipv6.nextHopSelf) out.push(`  neighbor ${neighbor.address} next-hop-self`);
      if (ipv6.routeReflectorClient) out.push(`  neighbor ${neighbor.address} route-reflector-client`);
      if (ipv6.sendCommunityStandard) out.push(`  neighbor ${neighbor.address} send-community`);
      if (ipv6.prefixListIn) out.push(`  neighbor ${neighbor.address} prefix-list ${ipv6.prefixListIn} in`);
      if (ipv6.prefixListOut) out.push(`  neighbor ${neighbor.address} prefix-list ${ipv6.prefixListOut} out`);
      if (ipv6.routeMapIn) out.push(`  neighbor ${neighbor.address} route-map ${ipv6.routeMapIn} in`);
      if (ipv6.routeMapOut) out.push(`  neighbor ${neighbor.address} route-map ${ipv6.routeMapOut} out`);
      if (ipv6.defaultOriginate) {
        out.push(`  neighbor ${neighbor.address} default-originate`
          + `${ipv6.defaultOriginateRouteMap ? ` route-map ${ipv6.defaultOriginateRouteMap}` : ""}`);
      }
    }
    for (const network of ipv6Networks) out.push(`  network ${network.network}/${network.prefixLength}`);
    out.push(" exit-address-family");
  }
  const vpnNeighbors = sorted(bgp.neighbors?.filter((neighbor) => neighbor.vpnv4Activated || (neighbor.sendCommunityExtended && !neighbor.vpnv6Activated)), (a, b) => byString(a.address, b.address));
  if (vpnNeighbors.length > 0) {
    out.push(" address-family vpnv4");
    for (const neighbor of vpnNeighbors) {
      if (neighbor.vpnv4Activated) out.push(`  neighbor ${neighbor.address} activate`);
      if (neighbor.routeReflectorClient && neighbor.vpnv4Activated) {
        out.push(`  neighbor ${neighbor.address} route-reflector-client`);
      }
      if (neighbor.sendCommunityExtended) out.push(`  neighbor ${neighbor.address} send-community extended`);
    }
    out.push(" exit-address-family");
  }
  const vpn6Neighbors = sorted(bgp.neighbors?.filter((neighbor) => neighbor.vpnv6Activated), (a, b) => byString(a.address, b.address));
  if (vpn6Neighbors.length > 0) {
    out.push(" address-family vpnv6");
    for (const neighbor of vpn6Neighbors) {
      out.push(`  neighbor ${neighbor.address} activate`);
      if (neighbor.routeReflectorClient) out.push(`  neighbor ${neighbor.address} route-reflector-client`);
      if (neighbor.sendCommunityExtended) out.push(`  neighbor ${neighbor.address} send-community extended`);
    }
    out.push(" exit-address-family");
  }
  // A VRF that advertises into EVPN gets its own `address-family ipv4 vrf`
  // block even when it redistributes nothing, so the flag is never lost.
  const evpnVrfs = sorted(vrfs?.filter((vrf) => vrf.advertiseEvpn === true), (a, b) => byString(a.id, b.id));
  const families = sorted(bgp.vrfAddressFamilies, (a, b) => byString(a.vrfId, b.vrfId));
  const vrfIds = [...new Set([...families.map((family) => family.vrfId), ...evpnVrfs.map((vrf) => vrf.id)])].sort();
  for (const vrfId of vrfIds) {
    const family = families.find((entry) => entry.vrfId === vrfId)
      ?? { vrfId, redistributeConnected: false, redistributeStatic: false };
    const advertises = evpnVrfs.some((vrf) => vrf.id === vrfId);
    if (family.redistributeConnected || family.redistributeStatic || advertises) {
      out.push(` address-family ipv4 vrf ${vrfId}`);
      if (family.redistributeConnected) out.push("  redistribute connected");
      if (family.redistributeStatic) out.push("  redistribute static");
      if (advertises) out.push("  advertise l2vpn evpn");
      out.push(" exit-address-family");
    }
    if (family.redistributeConnectedIpv6 || family.redistributeStaticIpv6) {
      out.push(` address-family ipv6 vrf ${family.vrfId}`);
      if (family.redistributeConnectedIpv6) out.push("  redistribute connected");
      if (family.redistributeStaticIpv6) out.push("  redistribute static");
      out.push(" exit-address-family");
    }
  }
  out.push(...evpnAddressFamilyLines(bgp));
  out.push("!");
  return out;
}

/**
 * `address-family l2vpn evpn` for one BGP process.
 *
 * The family rides the existing session, so only the per-neighbor activation
 * and the extended-community flag live inside the block; nothing about the
 * neighbor itself is repeated.
 */
function evpnAddressFamilyLines(bgp: BgpProcessConfig | undefined): string[] {
  const neighbors = sorted(bgp?.neighbors?.filter((neighbor) => neighbor.evpnActivated), (a, b) => byString(a.address, b.address));
  if (neighbors.length === 0) return [];
  const out = [" address-family l2vpn evpn"];
  for (const neighbor of neighbors) {
    out.push(`  neighbor ${neighbor.address} activate`);
    if (neighbor.routeReflectorClient) out.push(`  neighbor ${neighbor.address} route-reflector-client`);
    if (neighbor.sendCommunityExtended) out.push(`  neighbor ${neighbor.address} send-community extended`);
  }
  out.push(" exit-address-family");
  return out;
}

/**
 * The tenant VRFs an L3 Switch VTEP carries, and their static routes.
 *
 * `advertise l2vpn evpn` renders under `router bgp` with the rest of the BGP
 * process, so this block stays purely the routing context: name, RD and the
 * route targets that decide what it may import and export.
 */
function vtepVrfLines(vrfs: readonly VrfConfig[] | undefined): string[] {
  const sortedVrfs = sorted(vrfs, (a, b) => byString(a.id, b.id));
  if (sortedVrfs.length === 0) return [];
  const out: string[] = [];
  for (const vrf of sortedVrfs) {
    out.push(`vrf definition ${vrf.name}`, ` rd ${vrf.routeDistinguisher}`);
    for (const target of sorted(vrf.importRouteTargets, byString)) out.push(` route-target import ${target}`);
    for (const target of sorted(vrf.exportRouteTargets, byString)) out.push(` route-target export ${target}`);
    out.push("!");
  }
  for (const vrf of sortedVrfs) {
    for (const route of sorted(vrf.staticRoutes, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
      out.push(`ip route vrf ${vrf.name} ${route.network} ${maskFromPrefixLength(route.prefixLength)} ${route.nextHop}`);
    }
  }
  return out;
}

/** `interface nve1` plus the `vlan configuration <id>` mappings it implies. */
function nveLines(nve: NveInterfaceConfig | undefined): string[] {
  if (!nve) return [];
  const members = sorted(nve.members, (a, b) => a.vni - b.vni);
  const out = [`interface ${nve.id}`];
  out.push(nve.shutdown ? " shutdown" : " no shutdown");
  out.push(` source-interface ${nve.sourceInterfaceId}`);
  for (const member of members) {
    out.push(` member vni ${member.vni}`);
    if (member.replication.type === "bgp-evpn") {
      out.push("  ingress-replication protocol bgp");
      continue;
    }
    for (const peer of sorted(member.replication.peerAddresses, byString)) out.push(`  peer-ip ${peer}`);
  }
  // L3VNIs come after the bridged members, exactly as they are entered: a
  // routed transit segment has no VLAN and therefore no `vlan configuration`.
  for (const member of sorted(nve.vrfMembers, (a, b) => a.vni - b.vni)) {
    out.push(` member vni ${member.vni} associate-vrf ${member.vrfId}`);
  }
  out.push("!");
  for (const member of members) {
    out.push(`vlan configuration ${member.vlanId}`, ` member vni ${member.vni}`, "!");
  }
  return out;
}

/** The `evpn` block: one `vni <id> l2` per VNI with its RD and route targets. */
function evpnLines(evpn: EvpnConfig | undefined): string[] {
  const vnis = sorted(evpn?.vnis, (a, b) => a.vni - b.vni);
  if (vnis.length === 0) return [];
  const out = ["evpn"];
  for (const vni of vnis) {
    out.push(` vni ${vni.vni} l2`, `  rd ${vni.routeDistinguisher}`);
    for (const target of sorted(vni.importRouteTargets, byString)) out.push(`  route-target import ${target}`);
    for (const target of sorted(vni.exportRouteTargets, byString)) out.push(`  route-target export ${target}`);
  }
  out.push("!");
  return out;
}

function aclLines(acls: readonly Ipv4AclConfig[] | undefined): string[] {
  const out: string[] = [];
  for (const acl of sorted(acls, byId)) {
    out.push(`ip access-list ${acl.type} ${acl.id}`);
    if (acl.type === "standard") {
      for (const rule of sorted(acl.rules, bySequence)) {
        out.push(` ${rule.sequence} ${rule.action} ${ipv4MatcherText(rule.source)}`);
      }
    } else {
      for (const rule of sorted(acl.rules, bySequence)) {
        out.push(` ${rule.sequence} ${rule.action} ${protocolText(rule.protocol)}`
          + ` ${ipv4MatcherText(rule.source)}${portMatcherText(rule.sourcePort)}`
          + ` ${ipv4MatcherText(rule.destination)}${portMatcherText(rule.destinationPort)}`);
      }
    }
    out.push("!");
  }
  return out;
}

function ipv6AclLines(acls: readonly Ipv6AclConfig[] | undefined): string[] {
  const out: string[] = [];
  for (const acl of sorted(acls, byId)) {
    out.push(`ipv6 access-list ${acl.id}`);
    for (const rule of sorted(acl.rules, bySequence)) {
      out.push(` ${rule.sequence} ${rule.action} ${protocolText(rule.protocol)}`
        + ` ${ipv6MatcherText(rule.source)}${portMatcherText(rule.sourcePort)}`
        + ` ${ipv6MatcherText(rule.destination)}${portMatcherText(rule.destinationPort)}`);
    }
    out.push("!");
  }
  return out;
}

function qosLines(qos: QosConfiguration | undefined): string[] {
  if (!qos) return [];
  const out: string[] = [];
  for (const map of sorted(qos.classMaps, byId)) {
    out.push(`class-map ${map.matchType} ${map.id}`);
    for (const rule of map.matches) {
      if (rule.kind === "any") out.push(" match any");
      else if (rule.kind === "access-group") out.push(` match access-group name ${rule.aclId}`);
      else if (rule.kind === "ipv6-access-group") out.push(` match ipv6 access-group name ${rule.aclId}`);
      else if (rule.kind === "protocol") out.push(` match protocol ${rule.protocol}`);
      else if (rule.kind === "source-port") out.push(` match source-port${portMatcherText(rule.port) || " any"}`);
      else if (rule.kind === "destination-port") out.push(` match destination-port${portMatcherText(rule.port) || " any"}`);
      else if (rule.kind === "dscp") out.push(` match dscp ${rule.values.map(dscpName).join(" ")}`);
      else if (rule.kind === "precedence") out.push(` match precedence ${rule.values.join(" ")}`);
      else if (rule.kind === "cos") out.push(` match cos ${rule.values.join(" ")}`);
      else if (rule.kind === "source-prefix") {
        out.push(` match source-address ${rule.ipv4 ? ipv4MatcherText(rule.ipv4) : rule.ipv6 ? ipv6MatcherText(rule.ipv6) : "any"}`);
      } else if (rule.kind === "destination-prefix") {
        out.push(` match destination-address ${rule.ipv4 ? ipv4MatcherText(rule.ipv4) : rule.ipv6 ? ipv6MatcherText(rule.ipv6) : "any"}`);
      } else out.push(` match traffic-flow ${rule.flowId}`);
    }
    out.push("!");
  }
  for (const map of sorted(qos.policyMaps, byId)) {
    out.push(`policy-map ${map.id}`);
    // Scheduling order is the policy map's own order, never sorted: strict
    // priority followed by deficit round robin reads it top to bottom.
    for (const entry of map.classes) {
      out.push(` class ${entry.className}`);
      if (entry.marking?.dscp !== undefined) out.push(`  set dscp ${dscpName(entry.marking.dscp)}`);
      if (entry.marking?.precedence !== undefined) out.push(`  set precedence ${entry.marking.precedence}`);
      if (entry.marking?.cos !== undefined) out.push(`  set cos ${entry.marking.cos}`);
      if (entry.priority?.percent !== undefined) out.push(`  priority percent ${entry.priority.percent}`);
      if (entry.priority?.rateBps !== undefined) out.push(`  priority ${entry.priority.rateBps}`);
      if (entry.bandwidthPercent !== undefined) out.push(`  bandwidth percent ${entry.bandwidthPercent}`);
      if (entry.police) {
        const exceed = entry.police.exceedAction === "set-dscp-transmit" && entry.police.exceedDscp !== undefined
          ? `set-dscp-transmit ${dscpName(entry.police.exceedDscp)}`
          : "drop";
        out.push(`  police ${entry.police.rateBps} ${entry.police.burstBytes} conform-action transmit exceed-action ${exceed}`);
      }
      if (entry.shape) {
        const burst = entry.shape.burstBytes === undefined ? "" : ` ${entry.shape.burstBytes}`;
        out.push(`  shape average ${entry.shape.averageRateBps}${burst}`);
      }
      if (entry.queueLimitPackets !== undefined) out.push(`  queue-limit ${entry.queueLimitPackets} packets`);
    }
    out.push("!");
  }
  return out;
}

function vpnLines(vpn: VpnConfiguration | undefined): string[] {
  if (!vpn) return [];
  const out: string[] = [];
  for (const proposal of sorted(vpn.proposals, byId)) {
    out.push(`crypto ikev2 proposal ${proposal.id}`,
      ` encryption ${proposal.encryption}`,
      ` integrity ${proposal.integrity}`,
      "!");
  }
  for (const peer of sorted(vpn.ikePeers, byId)) {
    out.push(`crypto ikev2 peer ${peer.id}`, ` address ${peer.address}`);
    if (peer.localIdentity) out.push(` identity local ${peer.localIdentity}`);
    if (peer.remoteIdentity) out.push(` identity remote ${peer.remoteIdentity}`);
    // The key itself never reaches this renderer: only its presence is shown.
    if (peer.preSharedKeyVerifier) out.push(` pre-shared-key ${REDACTED_SECRET}`);
    if (peer.credentialResetRequired) out.push(" ! pre-shared key must be reset before this peer can protect");
    out.push(` proposal ${peer.proposalId}`, ` lifetime ${peer.lifetimeSeconds}`, "!");
  }
  for (const profile of sorted(vpn.ipsecProfiles, byId)) {
    out.push(`crypto ipsec profile ${profile.id}`,
      ` set ikev2-peer ${profile.ikePeerId}`,
      ` set proposal ${profile.proposalId}`,
      ` lifetime ${profile.lifetimeSeconds}`,
      "!");
  }
  return out;
}

function tunnelLines(vpn: VpnConfiguration | undefined): string[] {
  const out: string[] = [];
  for (const tunnel of sorted(vpn?.tunnels, (a, b) => a.id - b.id)) {
    out.push(`interface Tunnel${tunnel.id}`);
    if (tunnel.description) out.push(` description ${tunnel.description}`);
    if (tunnel.ipv4) out.push(` ip address ${tunnel.ipv4.address} ${maskFromPrefixLength(tunnel.ipv4.prefixLength)}`);
    out.push(...ipv6Lines(tunnel.ipv6));
    out.push(tunnel.source.type === "interface"
      ? ` tunnel source ${tunnel.source.interfaceId}`
      : ` tunnel source ${tunnel.source.address}`);
    out.push(` tunnel destination ${tunnel.destinationAddress}`, " tunnel mode gre ip",
      ` tunnel mtu ${tunnel.mtu}`, ` tunnel ttl ${tunnel.ttl}`);
    if (tunnel.ipsecProfileId) out.push(` tunnel protection ipsec profile ${tunnel.ipsecProfileId}`);
    out.push(...adminStateLines(tunnel.shutdown), "!");
  }
  return out;
}

function loopbackLines(loopbacks: readonly LoopbackInterfaceConfig[] | undefined): string[] {
  const out: string[] = [];
  for (const loopback of sorted(loopbacks, (a, b) => a.id - b.id)) {
    out.push(`interface Loopback${loopback.id}`);
    if (loopback.description) out.push(` description ${loopback.description}`);
    if (loopback.ipv4) out.push(` ip address ${loopback.ipv4.address} ${maskFromPrefixLength(loopback.ipv4.prefixLength)}`);
    out.push(...ipv6Lines(loopback.ipv6));
    out.push(...adminStateLines(loopback.shutdown), "!");
  }
  return out;
}

function natLines(config: RouterDeviceConfig | FirewallDeviceConfig | CloudDeviceConfig): string[] {
  const out: string[] = [];
  for (const role of sorted(config.natInterfaceRoles, byInterfaceName)) {
    out.push(`! ${role.interfaceName} is NAT ${role.role}`);
  }
  for (const pool of sorted(config.natPools, byId)) {
    out.push(`ip nat pool ${pool.id} ${pool.startAddress} ${pool.endAddress}`);
  }
  for (const rule of sorted(config.natRules, bySequence)) {
    if (rule.kind === "static") {
      out.push(`ip nat inside source static ${rule.insideLocal} ${rule.insideGlobal}`);
    } else if (rule.kind === "dynamic") {
      const source = rule.source.kind === "any" ? "any" : `list ${rule.source.aclId}`;
      out.push(`ip nat inside source ${source} pool ${rule.poolId}`);
    } else {
      const source = rule.source.kind === "any" ? "any" : `list ${rule.source.aclId}`;
      const outside = rule.outsideAddress === "interface" ? "interface" : rule.outsideAddress;
      out.push(`ip nat inside source ${source} ${outside} overload`);
    }
  }
  if (out.length > 0) out.push("!");
  return out;
}

// --- device renderers -------------------------------------------------------

function renderRoutedDevice(config: RouterDeviceConfig | FirewallDeviceConfig | CloudDeviceConfig): string[] {
  const out: string[] = ["!", `hostname ${config.hostname ?? ""}`.trimEnd(), "!"];
  const isCloud = config.kind === "cloud";
  if (!isCloud) {
    out.push(...secretLines(config.consoleAccess));
    out.push(...bannerLines(config.consoleAccess));
  }
  if (config.ipv6UnicastRoutingEnabled) out.push("ipv6 unicast-routing", "!");
  out.push(...aaaLines(config.aaa));
  out.push(...qosLines(config.qos));
  out.push(...vpnLines(config.vpn));

  if (config.kind === "router") {
    if (config.ldp?.routerIdInterface) out.push("mpls label protocol ldp", `mpls ldp router-id ${config.ldp.routerIdInterface} force`, "!");
    for (const vrf of sorted(config.vrfs, byId)) {
      out.push(`vrf definition ${vrf.name}`, ` rd ${vrf.routeDistinguisher}`);
      for (const target of sorted(vrf.importRouteTargets, byString)) out.push(` route-target import ${target}`);
      for (const target of sorted(vrf.exportRouteTargets, byString)) out.push(` route-target export ${target}`);
      // IPv4 is implicit inside a VRF; only a second address family is declared.
      if (vrf.addressFamilyIpv6) out.push(" address-family ipv6", " exit-address-family");
      out.push("!");
    }
  }

  for (const iface of sorted(config.interfaces, byId)) {
    out.push(`interface ${iface.id}`);
    if (iface.description) out.push(` description ${iface.description}`);
    // IOS removes an existing address when VRF forwarding is applied, so the
    // canonical projection always renders VRF membership before addressing.
    if (config.kind === "router" && iface.vrfId) out.push(` vrf forwarding ${iface.vrfId}`);
    if (iface.ipv4) out.push(` ip address ${iface.ipv4.address} ${maskFromPrefixLength(iface.ipv4.prefixLength)}`);
    else if (iface.routed) out.push(" no ip address");
    out.push(...ipv6Lines(iface.ipv6));
    const role = config.natInterfaceRoles.find((entry) => entry.interfaceName === iface.id);
    if (role) out.push(` ip nat ${role.role}`);
    out.push(...aclBindingLines(config.aclBindings, iface.id, "ip access-group"));
    out.push(...aclBindingLines(config.ipv6AclBindings, iface.id, "ipv6 traffic-filter"));
    out.push(...ospfInterfaceLines(config.ospf, iface.id));
    out.push(...ospfv3InterfaceLines(config.ospfv3, iface.id));
    out.push(...servicePolicyLines(config.qos, iface.id));
    out.push(...discoveryInterfaceLines(config.discovery, iface.id));
    if (config.kind === "router" && iface.mplsEnabled) out.push(" mpls ip");
    out.push(...adminStateLines(iface.shutdown), "!");
  }
  for (const sub of sorted(config.subinterfaces, byId)) {
    out.push(`interface ${sub.id}`,
      ` encapsulation dot1Q ${sub.vlan}${sub.native ? " native" : ""}`);
    if (config.kind === "router" && sub.vrfId) out.push(` vrf forwarding ${sub.vrfId}`);
    if (sub.ipv4) out.push(` ip address ${sub.ipv4.address} ${maskFromPrefixLength(sub.ipv4.prefixLength)}`);
    out.push(...ipv6Lines(sub.ipv6));
    out.push(...aclBindingLines(config.aclBindings, sub.id, "ip access-group"));
    out.push(...servicePolicyLines(config.qos, sub.id));
    out.push("!");
  }
  out.push(...loopbackLines(config.loopbacks));
  out.push(...tunnelLines(config.vpn));

  for (const advertisement of sorted(config.routerAdvertisements, byInterfaceName)) {
    out.push(`! router advertisements on ${advertisement.interfaceName}`);
    for (const prefix of advertisement.prefixes) {
      out.push(`!  prefix ${prefix.prefix}/${prefix.prefixLength}`
        + `${prefix.autonomous ? " autonomous" : ""}${prefix.onLink ? " on-link" : ""}`);
    }
  }
  for (const pool of sorted(config.dhcpPools, byId)) {
    out.push(`ip dhcp pool ${pool.id}`,
      ` network ${pool.network} ${maskFromPrefixLength(pool.prefixLength)}`);
    if (pool.defaultGateway) out.push(` default-router ${pool.defaultGateway}`);
    out.push(` range ${pool.rangeStart} ${pool.rangeEnd}`, ` lease ${pool.leaseSeconds}`, "!");
  }
  for (const pool of sorted(config.dhcpv6Pools, byId)) {
    out.push(`ipv6 dhcp pool ${pool.id}`,
      ` address prefix ${pool.prefix}/${pool.prefixLength}`,
      ` range ${pool.rangeStart} ${pool.rangeEnd}`,
      "!");
  }
  out.push(...ospfProcessLines(config.ospf));
  out.push(...ospfv3ProcessLines(config.ospfv3));
  out.push(...routePolicyLines(config.prefixLists, config.routeMaps, config.communityLists, config.asPathLists, config.ipv6PrefixLists));
  out.push(...bgpProcessLines(config.bgp));
  for (const route of sorted(config.staticRoutes, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
    out.push(`ip route ${route.network} ${maskFromPrefixLength(route.prefixLength)} ${route.nextHop}`);
  }
  if (config.kind === "router") {
    for (const vrf of sorted(config.vrfs, byId)) {
      for (const route of sorted(vrf.staticRoutes, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
        out.push(`ip route vrf ${vrf.id} ${route.network} ${maskFromPrefixLength(route.prefixLength)} ${route.nextHop}`);
      }
    }
  }
  for (const route of sorted(config.ipv6StaticRoutes, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
    out.push(`ipv6 route ${route.network}/${route.prefixLength} ${route.nextHop}`);
  }
  let vrfIpv6Routes = 0;
  if (config.kind === "router") {
    for (const vrf of sorted(config.vrfs, byId)) {
      for (const route of sorted(vrf.ipv6StaticRoutes, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
        out.push(`ipv6 route vrf ${vrf.id} ${route.network}/${route.prefixLength} ${route.nextHop}`);
        vrfIpv6Routes++;
      }
    }
  }
  if (config.staticRoutes.length > 0 || (config.ipv6StaticRoutes?.length ?? 0) > 0 || vrfIpv6Routes > 0) out.push("!");
  out.push(...aclLines(config.acls));
  out.push(...ipv6AclLines(config.ipv6Acls));
  out.push(...natLines(config));
  if (config.kind === "firewall") out.push(...firewallLines(config));
  if (config.kind === "cloud") {
    for (const impairment of sorted(config.impairments, byInterfaceName)) {
      out.push(`! ${impairment.interfaceName} impairment: `
        + `${impairment.additionalLatencyNs} ns latency, loss ${impairment.packetLossRate}`);
    }
    if (config.impairments.length > 0) out.push("!");
  }
  out.push(...discoveryLines(config.discovery));
  if (!isCloud) {
    out.push(...consoleLineLines(config.consoleAccess));
    out.push(...remoteAccessLines(config.remoteAccess));
    out.push(...snmpLines(config.snmp));
  }
  out.push("end");
  return out;
}

/**
 * The firewall zone/policy block. It is deliberately *not* dressed up as Cisco
 * ZBF syntax: SimulatorNet's stateful policy model is its own, so it is written
 * in SimulatorNet's own vocabulary and reads unambiguously.
 */
function firewallLines(config: FirewallDeviceConfig): string[] {
  const out: string[] = [];
  for (const zone of sorted(config.zones, byInterfaceName)) {
    out.push(`firewall zone ${zone.zone} interface ${zone.interfaceName}`);
  }
  if (config.zones.length > 0) out.push("!");
  out.push(`firewall default-policy ${config.defaultPolicy}`);
  for (const policy of sorted(config.firewallPolicies, bySequence)) {
    const source = policy.source ? ipv4MatcherText(policy.source) : "any";
    const destination = policy.destination ? ipv4MatcherText(policy.destination) : "any";
    const states = policy.states && policy.states.length > 0 ? ` state ${[...policy.states].sort(byString).join(",")}` : "";
    out.push(`firewall policy ${policy.sequence} ${policy.action} from ${policy.sourceZone} to ${policy.destinationZone}`
      + ` protocol ${protocolText(policy.protocol)}`
      + ` source ${source}${portMatcherText(policy.sourcePort)}`
      + ` destination ${destination}${portMatcherText(policy.destinationPort)}${states}`);
  }
  out.push("!");
  return out;
}

function renderSwitch(config: SwitchDeviceConfig): string[] {
  const out: string[] = ["!", `hostname ${config.hostname ?? ""}`.trimEnd(), "!"];
  out.push(...secretLines(config.consoleAccess));
  out.push(...bannerLines(config.consoleAccess));
  out.push(...aaaLines(config.aaa));
  for (const vlan of sorted(config.vlans, (a, b) => a.id - b.id)) {
    if (vlan.id === 1) continue;
    out.push(`vlan ${vlan.id}`, ` name ${vlan.name}`, "!");
  }
  out.push(...spanningTreeLines(config.spanningTree));
  for (const channel of sorted(config.etherChannels, (a, b) => a.channelId - b.channelId)) {
    out.push(`interface Port-channel${channel.channelId}`);
    if (channel.switchport) {
      out.push(` switchport mode ${channel.switchport.mode}`);
      if (channel.switchport.mode === "access") out.push(` switchport access vlan ${channel.switchport.accessVlan}`);
      else out.push(` switchport trunk native vlan ${channel.switchport.nativeVlan}`);
    }
    if (channel.minimumLinks !== undefined) out.push(` port-channel min-links ${channel.minimumLinks}`);
    out.push("!");
  }
  const channelOf = new Map<string, { channelId: number; mode: string }>();
  for (const channel of config.etherChannels ?? []) {
    for (const member of channel.members) channelOf.set(member, { channelId: channel.channelId, mode: channel.mode });
  }
  for (const iface of sorted(config.interfaces, byId)) {
    out.push(`interface ${iface.id}`);
    if (iface.description) out.push(` description ${iface.description}`);
    out.push(...switchportLines(iface));
    const channel = channelOf.get(iface.id);
    if (channel) out.push(` channel-group ${channel.channelId} mode ${channel.mode}`);
    out.push(...spanningTreePortLines(config.spanningTree, iface.id));
    out.push(...discoveryInterfaceLines(config.discovery, iface.id));
    out.push(...adminStateLines(iface.shutdown), "!");
  }
  if (config.managementSvi) {
    const svi = config.managementSvi;
    out.push(`interface Vlan${svi.vlanId}`);
    if (svi.description) out.push(` description ${svi.description}`);
    if (svi.ipAddress !== undefined && svi.prefixLength !== undefined) {
      out.push(` ip address ${svi.ipAddress} ${maskFromPrefixLength(svi.prefixLength)}`);
    }
    out.push(...adminStateLines(!svi.adminUp), "!");
  }
  if (config.managementDefaultGateway) {
    out.push(`ip default-gateway ${config.managementDefaultGateway}`, "!");
  }
  out.push(...discoveryLines(config.discovery));
  out.push(...consoleLineLines(config.consoleAccess));
  out.push(...remoteAccessLines(config.remoteAccess));
  out.push(...snmpLines(config.snmp));
  out.push("end");
  return out;
}

function switchportLines(iface: { mode: "access" | "trunk"; accessVlan: number; nativeVlan: number; allowedVlans?: number[] }): string[] {
  if (iface.mode === "access") {
    // VLAN 1 is the default access VLAN, so IOS does not print it.
    return iface.accessVlan === 1
      ? [" switchport mode access"]
      : [" switchport mode access", ` switchport access vlan ${iface.accessVlan}`];
  }
  const out = [" switchport mode trunk"];
  if (iface.nativeVlan !== 1) out.push(` switchport trunk native vlan ${iface.nativeVlan}`);
  if (iface.allowedVlans !== undefined) {
    out.push(` switchport trunk allowed vlan ${[...iface.allowedVlans].sort((a, b) => a - b).join(",")}`);
  }
  return out;
}

function renderLayer3Switch(config: Layer3SwitchDeviceConfig): string[] {
  const out: string[] = ["!", `hostname ${config.hostname ?? ""}`.trimEnd(), "!"];
  out.push(...secretLines(config.consoleAccess));
  out.push(...bannerLines(config.consoleAccess));
  out.push(config.ipRoutingEnabled ? "ip routing" : "no ip routing");
  if (config.ipv6UnicastRoutingEnabled) out.push("ipv6 unicast-routing");
  // The fabric gateway MAC precedes every SVI that adopts it.
  if (config.evpn?.anycastGatewayMac !== undefined) {
    out.push(`fabric forwarding anycast-gateway-mac ${config.evpn.anycastGatewayMac}`);
  }
  out.push("!");
  out.push(...aaaLines(config.aaa));
  // Tenant VRFs precede the SVIs that join them and the NVE that carries them.
  out.push(...vtepVrfLines(config.vrfs));
  for (const vlan of sorted(config.vlans, (a, b) => a.id - b.id)) {
    if (vlan.id === 1) continue;
    out.push(`vlan ${vlan.id}`, ` name ${vlan.name}`, "!");
  }
  out.push(...spanningTreeLines(config.spanningTree));
  out.push(...qosLines(config.qos));
  const channelOf = new Map<string, { channelId: number; mode: string }>();
  for (const channel of config.etherChannels ?? []) {
    for (const member of channel.members) channelOf.set(member, { channelId: channel.channelId, mode: channel.mode });
  }
  for (const iface of sorted(config.interfaces, byId)) {
    out.push(`interface ${iface.id}`);
    if (iface.description) out.push(` description ${iface.description}`);
    if (iface.mode === "routed") {
      out.push(" no switchport");
      if (iface.ipv4) out.push(` ip address ${iface.ipv4.address} ${maskFromPrefixLength(iface.ipv4.prefixLength)}`);
      else out.push(" no ip address");
      out.push(...ipv6Lines(iface.ipv6));
      out.push(...aclBindingLines(config.aclBindings, iface.id, "ip access-group"));
      out.push(...aclBindingLines(config.ipv6AclBindings, iface.id, "ipv6 traffic-filter"));
      out.push(...ospfInterfaceLines(config.ospf, iface.id));
      out.push(...ospfv3InterfaceLines(config.ospfv3, iface.id));
    } else {
      out.push(...switchportLines(iface));
    }
    const channel = channelOf.get(iface.id);
    if (channel) out.push(` channel-group ${channel.channelId} mode ${channel.mode}`);
    out.push(...spanningTreePortLines(config.spanningTree, iface.id));
    out.push(...servicePolicyLines(config.qos, iface.id));
    out.push(...discoveryInterfaceLines(config.discovery, iface.id));
    out.push(...adminStateLines(iface.shutdown), "!");
  }
  for (const svi of sorted(config.svis, (a, b) => a.vlanId - b.vlanId)) {
    out.push(`interface Vlan${svi.vlanId}`);
    if (svi.description) out.push(` description ${svi.description}`);
    // The routing context precedes the address, exactly as it must be entered.
    if (svi.vrfId !== undefined) out.push(` vrf forwarding ${svi.vrfId}`);
    if (svi.ipAddress !== undefined && svi.prefixLength !== undefined) {
      out.push(` ip address ${svi.ipAddress} ${maskFromPrefixLength(svi.prefixLength)}`);
    }
    out.push(...ipv6Lines(svi.ipv6));
    if (svi.anycastGateway === true) out.push(" fabric forwarding mode anycast-gateway");
    out.push(...aclBindingLines(config.aclBindings, `Vlan${svi.vlanId}`, "ip access-group"));
    out.push(...ospfInterfaceLines(config.ospf, `Vlan${svi.vlanId}`));
    out.push(...adminStateLines(!svi.adminUp), "!");
  }
  out.push(...loopbackLines(config.loopbacks));
  // The NVE names its source Loopback and its VLANs, so it renders after both.
  out.push(...nveLines(config.nve));
  out.push(...evpnLines(config.evpn));
  out.push(...ospfProcessLines(config.ospf));
  out.push(...ospfv3ProcessLines(config.ospfv3));
  out.push(...routePolicyLines(config.prefixLists, config.routeMaps, config.communityLists, config.asPathLists, config.ipv6PrefixLists));
  out.push(...bgpProcessLines(config.bgp, config.vrfs));
  for (const route of sorted(config.staticRoutes, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
    out.push(`ip route ${route.network} ${maskFromPrefixLength(route.prefixLength)} ${route.nextHop}`);
  }
  for (const route of sorted(config.ipv6StaticRoutes, (a, b) => byString(a.network, b.network) || a.prefixLength - b.prefixLength)) {
    out.push(`ipv6 route ${route.network}/${route.prefixLength} ${route.nextHop}`);
  }
  if (config.staticRoutes.length > 0 || (config.ipv6StaticRoutes?.length ?? 0) > 0) out.push("!");
  out.push(...aclLines(config.acls));
  out.push(...ipv6AclLines(config.ipv6Acls));
  out.push(...discoveryLines(config.discovery));
  out.push(...consoleLineLines(config.consoleAccess));
  out.push(...remoteAccessLines(config.remoteAccess));
  out.push(...snmpLines(config.snmp));
  out.push("end");
  return out;
}

function renderBridge(config: BridgeDeviceConfig): string[] {
  const out: string[] = ["!", `hostname ${config.hostname ?? ""}`.trimEnd(), "!"];
  out.push(...secretLines(config.consoleAccess));
  out.push(`bridge aging-time ${Math.round(config.agingTimeNs / 1_000_000_000)}`, "!");
  for (const iface of sorted(config.interfaces, byId)) {
    out.push(`interface ${iface.id}`);
    if (iface.description) out.push(` description ${iface.description}`);
    out.push(...adminStateLines(iface.shutdown), "!");
  }
  out.push(...consoleLineLines(config.consoleAccess));
  out.push("end");
  return out;
}

function wirelessLines(access: WirelessAccessPointConfiguration, indent: string): string[] {
  const out = [
    `${indent}ssid ${access.ssid}`,
    `${indent}band ${access.band}`,
    `${indent}channel ${access.channel}`,
    `${indent}radio-domain ${access.radioDomainId}`,
    `${indent}broadcast-ssid ${access.broadcastSsid ? "enabled" : "disabled"}`,
    `${indent}client-isolation ${access.clientIsolation ? "enabled" : "disabled"}`,
    `${indent}maximum-clients ${access.maximumClients}`,
    `${indent}priority ${access.priority}`,
    `${indent}state ${access.enabled ? "enabled" : "disabled"}`,
  ];
  // WPA2-Personal is an educational authentication model: only an opaque,
  // SSID-scoped verifier exists, and it is never rendered.
  out.push(access.security.mode === "wpa2-personal"
    ? `${indent}security wpa2-personal passphrase ${REDACTED_SECRET}`
    : `${indent}security open`);
  return out;
}

function renderAccessPoint(config: AccessPointDeviceConfig): string[] {
  const out: string[] = [
    "! SimulatorNet access point configuration",
    `hostname ${config.hostname ?? ""}`.trimEnd(),
    "!",
    "radio",
    ` state ${config.radio.enabled ? "enabled" : "disabled"}`,
    ` band ${config.radio.band}`,
    ` supported-channels ${[...config.radio.supportedChannels].sort((a, b) => a - b).join(",")}`,
    ` radio-domain ${config.radio.radioDomainId}`,
    "!",
    "wireless",
    ...wirelessLines(config.accessPoint, " "),
    "!",
  ];
  for (const iface of sorted(config.interfaces, byId)) {
    out.push(`interface ${iface.id}`);
    if (iface.description) out.push(` description ${iface.description}`);
    out.push(...adminStateLines(iface.shutdown), "!");
  }
  out.push("! a standalone access point bridges wireless to Ethernet only:",
    "! it performs no routing, DHCP, NAT or firewall function.",
    "end");
  return out;
}

function renderWirelessRouter(config: WirelessRouterDeviceConfig): string[] {
  const out: string[] = [
    "! SimulatorNet wireless router configuration",
    `hostname ${config.hostname ?? ""}`.trimEnd(),
    "!",
    "radio",
    ` state ${config.radio.enabled ? "enabled" : "disabled"}`,
    ` band ${config.radio.band}`,
    ` supported-channels ${[...config.radio.supportedChannels].sort((a, b) => a - b).join(",")}`,
    ` radio-domain ${config.radio.radioDomainId}`,
    "!",
    "wireless",
    ...wirelessLines(config.accessPoint, " "),
    "!",
    "lan",
    ` address ${config.lan.address}/${config.lan.prefixLength}`,
    ` dhcp ${config.lan.dhcpEnabled ? "enabled" : "disabled"}`,
    ` dhcp-range ${config.lan.dhcpRangeStart} ${config.lan.dhcpRangeEnd}`,
  ];
  if (config.lan.ipv6Address !== undefined && config.lan.ipv6PrefixLength !== undefined) {
    out.push(` ipv6 address ${config.lan.ipv6Address}/${config.lan.ipv6PrefixLength}`);
  }
  out.push(` ipv6 router-advertisements ${config.lan.routerAdvertisementEnabled ? "enabled" : "disabled"}`,
    ` dhcpv6 ${config.lan.dhcpv6Enabled ? "enabled" : "disabled"}`,
    "!",
    "wan",
    ` mode ${config.wan.mode}`);
  if (config.wan.address !== undefined && config.wan.prefixLength !== undefined) {
    out.push(` address ${config.wan.address}/${config.wan.prefixLength}`);
  }
  if (config.wan.defaultGateway) out.push(` default-gateway ${config.wan.defaultGateway}`);
  if (config.wan.dnsServer) out.push(` dns-server ${config.wan.dnsServer}`);
  out.push("!",
    `nat ${config.natEnabled ? "enabled" : "disabled"}`,
    `firewall ${config.firewallEnabled ? "enabled" : "disabled"}`,
    "!");
  for (const iface of sorted(config.interfaces, byId)) {
    out.push(`interface ${iface.id}`);
    if (iface.description) out.push(` description ${iface.description}`);
    out.push(...adminStateLines(iface.shutdown), "!");
  }
  out.push("end");
  return out;
}

function renderServer(config: ServerDeviceConfig): string[] {
  const out: string[] = [
    "! SimulatorNet server configuration",
    `hostname ${config.hostname ?? ""}`.trimEnd(),
    "!",
  ];
  out.push(...secretLines(config.consoleAccess));
  for (const iface of sorted(config.interfaces, byId)) {
    out.push(`interface ${iface.id}`);
    if (iface.description) out.push(` description ${iface.description}`);
    if (iface.ipv4) out.push(` ip address ${iface.ipv4.address} ${maskFromPrefixLength(iface.ipv4.prefixLength)}`);
    out.push(...ipv6Lines(iface.ipv6));
    out.push(...adminStateLines(iface.shutdown), "!");
  }
  if (config.dhcpClientEnabled) out.push("ip address dhcp");
  if (config.defaultGateway) out.push(`ip default-gateway ${config.defaultGateway}`);
  if (config.dnsServer) out.push(`ip name-server ${config.dnsServer}`);
  if (config.ipv6) {
    out.push(`ipv6 mode ${config.ipv6.mode}`);
    if (config.ipv6.address !== undefined && config.ipv6.prefixLength !== undefined) {
      out.push(`ipv6 address ${config.ipv6.address}/${config.ipv6.prefixLength}`);
    }
    if (config.ipv6.defaultRouter) out.push(`ipv6 default-router ${config.ipv6.defaultRouter}`);
  }
  out.push("!");
  for (const service of sorted(config.enabledServices, byId)) {
    out.push(`service ${service.type} ${service.id}`,
      ` state ${service.enabled ? "enabled" : "disabled"}`,
      ` port ${service.port}`);
    if (service.type === "dns") {
      for (const record of sorted(service.records, (a, b) => byString(a.name, b.name))) {
        out.push(` record ${record.recordType ?? "A"} ${record.name} ${record.address}`);
      }
    } else if (service.type === "http") {
      for (const resource of sorted(service.resources, (a, b) => byString(a.path, b.path))) {
        out.push(` resource ${resource.path} ${resource.contentType} ${resource.body.length} bytes`);
      }
    } else if (service.type === "tftp") {
      for (const file of sorted(service.files, (a, b) => byString(a.filename, b.filename))) {
        out.push(` file ${file.filename} ${file.content.length} bytes`);
      }
    } else if (service.type === "syslog") {
      out.push(` retention ${service.retention}`);
    } else if (service.type === "ntp") {
      out.push(` offset ${service.offsetNs} ns`);
    } else if (service.type === "radius" || service.type === "tacacs") {
      // Users, clients and shared keys exist only as opaque fingerprints.
      out.push(` users ${service.users.length}`, ` clients ${service.clients.length}`,
        ` restrict-to-configured-clients ${service.restrictToConfiguredClients ? "enabled" : "disabled"}`);
      for (const user of sorted(service.users, (a, b) => byString(a.username, b.username))) {
        out.push(`  user ${user.username} privilege ${user.privilegeLevel} secret ${REDACTED_SECRET}`);
      }
    } else {
      for (const target of sorted(service.targets, byId)) {
        out.push(`  target ${target.name} ${target.address}:${target.port} community ${REDACTED_SECRET}`);
      }
    }
    out.push("!");
  }
  out.push(...discoveryLines(config.discovery));
  out.push(...consoleLineLines(config.consoleAccess));
  out.push("end");
  return out;
}

/**
 * A host is *not* rendered as a network appliance. It gets an honest, readable
 * summary that plainly says where its real configuration surface is.
 */
function renderHostSummary(config: DeviceConfig): string[] {
  const out: string[] = [
    `! ${config.kind} '${config.hostname ?? ""}'`.trimEnd(),
    "! This device is configured through Desktop / IP Configuration,",
    "! not through a Cisco IOS-like configuration file.",
    "!",
  ];
  if ("ipv4" in config && config.ipv4) {
    out.push(`address ${config.ipv4.address}/${config.ipv4.prefixLength}`);
    if (config.ipv4.defaultGateway) out.push(`default-gateway ${config.ipv4.defaultGateway}`);
  }
  if ("dhcpEnabled" in config && config.dhcpEnabled) out.push("address dhcp");
  if ("dnsServer" in config && config.dnsServer) out.push(`dns-server ${config.dnsServer}`);
  if ("ipv6" in config && config.ipv6) {
    out.push(`ipv6 mode ${config.ipv6.mode}`);
    if (config.ipv6.address !== undefined && config.ipv6.prefixLength !== undefined) {
      out.push(`ipv6 address ${config.ipv6.address}/${config.ipv6.prefixLength}`);
    }
  }
  if (config.kind === "external-appliance") {
    out.push(`source-platform ${config.sourcePlatform}`);
    if (config.sourceNodeKind) out.push(`source-node-kind ${config.sourceNodeKind}`);
    out.push("! imported configuration text is preserved in the import report and never executed");
  }
  out.push("end");
  return out;
}

/**
 * Render one device's configuration as deterministic, secret-free text.
 *
 * The same structured configuration always produces the same bytes, so a `.cfg`
 * projection, a Compare view and a stored startup snapshot can never disagree.
 */
export function renderDeviceConfiguration(config: DeviceConfig): string {
  const lines = ((): string[] => {
    switch (config.kind) {
      case "router":
      case "firewall":
      case "cloud":
        return renderRoutedDevice(config);
      case "l2-switch":
        return renderSwitch(config);
      case "l3-switch":
        return renderLayer3Switch(config);
      case "bridge":
        return renderBridge(config);
      case "access-point":
        return renderAccessPoint(config);
      case "wireless-router":
        return renderWirelessRouter(config);
      case "server":
        return renderServer(config);
      default:
        return renderHostSummary(config);
    }
  })();
  return normalizeConfigurationText(lines.join("\n"));
}

/** `show running-config` text for a device's current structured configuration. */
export function renderRunningConfiguration(config: DeviceConfig): string {
  return renderDeviceConfiguration(config);
}

/**
 * `show startup-config` text.
 *
 * `undefined` means the NVRAM is empty — the state after `erase startup-config`
 * — and IOS says exactly that rather than printing nothing.
 */
export function renderStartupConfiguration(config: DeviceConfig | undefined): string {
  if (!config) return "% startup-config is not present\n";
  return renderDeviceConfiguration(config);
}

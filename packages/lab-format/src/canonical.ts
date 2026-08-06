import {
  DEFAULT_CDP_HOLD_SECONDS,
  DEFAULT_CDP_INTERVAL_SECONDS,
  DEFAULT_LLDP_HOLD_SECONDS,
  DEFAULT_LLDP_INTERVAL_SECONDS,
  DEFAULT_STP_FORWARD_DELAY_SECONDS,
  DEFAULT_STP_HELLO_SECONDS,
  DEFAULT_STP_MAX_AGE_SECONDS,
  isDefaultPhysicalLayout,
  isDefaultQosConfiguration,
  isDefaultVpnConfiguration,
  type LabPhysicalLayout,
  type NeighborDiscoveryConfig,
  type QosConfiguration,
  type VpnConfiguration,
} from "@sim/contracts";
import type {
  ConsoleAccessConfiguration,
  DeviceConfig,
  BridgeDeviceConfig,
  CloudDeviceConfig,
  ExternalApplianceDeviceConfig,
  FirewallDeviceConfig,
  HubDeviceConfig,
  Layer3SwitchDeviceConfig,
  Layer3SwitchInterfaceConfig,
  LabDocument,
  LabDocumentDraft,
  LabStartupConfigurations,
  NodeSpec,
  PcDeviceConfig,
  PhysicalInterfaceConfig,
  RouterDeviceConfig,
  RouterPhysicalInterfaceConfig,
  ServerDeviceConfig,
  SwitchDeviceConfig,
  SwitchInterfaceConfig,
  TrafficGeneratorDeviceConfig,
  AccessPointDeviceConfig,
  LaptopDeviceConfig,
  SmartphoneDeviceConfig,
  WirelessRouterDeviceConfig,
  WirelessRadioSettings,
  WirelessStationConfiguration,
  WirelessAccessPointConfiguration,
} from "@sim/contracts";
import type {
  AaaConfiguration,
  ManagementSviConfig,
  RemoteAccessConfiguration,
  SnmpAgentConfiguration,
} from "@sim/contracts";
import {
  ipToInt,
  isDefaultAaaConfiguration,
  isDefaultRemoteAccess,
  isDefaultSnmpAgentConfiguration,
  normalizeAaaConfiguration,
  normalizeSnmpAgentConfiguration,
  macFromIndex,
  normalizeIpv6,
  normalizeServiceConfiguration,
  normalizeVtyLines,
} from "@sim/sim-core";
import { parseLabDocument } from "./parse";
import { validateLabSemantics } from "./semantic";

/** Deterministic ordering across both families: IPv4 first, then IPv6. */
function compareIpAddressText(left: string, right: string): number {
  const leftV6 = left.includes(":");
  const rightV6 = right.includes(":");
  if (leftV6 !== rightV6) return leftV6 ? 1 : -1;
  return leftV6 ? left.localeCompare(right) : ipToInt(left) - ipToInt(right);
}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

function canonicalInterfaces(nodes: readonly NodeSpec[]): NodeSpec[] {
  const used = new Set(
    nodes.flatMap((node) => node.interfaces.flatMap((iface) => (iface.mac ? [iface.mac.toLowerCase()] : []))),
  );
  let generatedIndex = 1;
  const nextMac = (): string => {
    for (;;) {
      const candidate = macFromIndex(generatedIndex++);
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };

  return [...nodes].sort(byId).map((node) => ({
    ...node,
    interfaces: [...node.interfaces]
      .sort(byId)
      .map((iface) => ({ ...iface, mac: iface.mac?.toLowerCase() ?? nextMac() })),
  }));
}

function canonicalConsoleAccess(
  config: { consoleAccess?: ConsoleAccessConfiguration } | undefined,
): ConsoleAccessConfiguration | undefined {
  const access = config?.consoleAccess;
  if (!access) return undefined;
  return {
    mode: access.mode,
    users: [...access.users]
      .sort(byId)
      .map((user) => ({ ...user, passwordVerifier: { ...user.passwordVerifier } })),
    consolePasswordVerifier: access.consolePasswordVerifier ? { ...access.consolePasswordVerifier } : undefined,
    enableSecretVerifier: access.enableSecretVerifier ? { ...access.enableSecretVerifier } : undefined,
    maximumAttempts: access.maximumAttempts,
    loginBanner: access.loginBanner,
    motdBanner: access.motdBanner,
    credentialResetRequired: access.credentialResetRequired,
  };
}

/**
 * Remote-management configuration in canonical order: VTY blocks by first then
 * last line, transports in a fixed order. Ordering is observable in the saved
 * document, so it must never depend on insertion order. Verifiers are copied
 * verbatim; no secret is ever materialized here.
 */
function canonicalRemoteAccess(
  config: { remoteAccess?: RemoteAccessConfiguration } | undefined,
): RemoteAccessConfiguration | undefined {
  const remote = config?.remoteAccess;
  if (isDefaultRemoteAccess(remote) || !remote) return undefined;
  return {
    telnetEnabled: remote.telnetEnabled,
    ssh: { ...remote.ssh },
    vtyLines: normalizeVtyLines(remote.vtyLines).map((line) => ({
      ...line,
      transports: (["telnet", "ssh"] as const).filter((protocol) => line.transports.includes(protocol)),
      passwordVerifier: line.passwordVerifier ? { ...line.passwordVerifier } : undefined,
    })),
  };
}

function commonInterface(
  id: string,
  existing: PhysicalInterfaceConfig | undefined,
): PhysicalInterfaceConfig {
  return {
    id,
    description: existing?.description,
    shutdown: existing?.shutdown ?? false,
  };
}

function pcConfiguration(node: NodeSpec, config: PcDeviceConfig | undefined): PcDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "pc",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    ipv4: config?.ipv4,
    dhcpEnabled: config?.dhcpEnabled ?? false,
    dnsServer: config?.dnsServer,
    ipv6: config?.ipv6 ? {
      ...config.ipv6,
      address: config.ipv6.address ? normalizeIpv6(config.ipv6.address) : undefined,
      defaultRouter: config.ipv6.defaultRouter ? normalizeIpv6(config.ipv6.defaultRouter) : undefined,
      dnsServer: config.ipv6.dnsServer ? normalizeIpv6(config.ipv6.dnsServer) : undefined,
    } : undefined,
  };
}

function serverConfiguration(node: NodeSpec, config: ServerDeviceConfig | undefined): ServerDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "server",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => ({
      ...commonInterface(iface.id, interfaces.get(iface.id)),
      ipv4: interfaces.get(iface.id)?.ipv4,
      ipv6: interfaces.get(iface.id)?.ipv6?.map((address) => ({ ...address, address: normalizeIpv6(address.address) })),
    })),
    defaultGateway: config?.defaultGateway,
    dhcpClientEnabled: config?.dhcpClientEnabled ?? false,
    dnsServer: config?.dnsServer,
    ipv6: config?.ipv6 ? {
      ...config.ipv6,
      address: config.ipv6.address ? normalizeIpv6(config.ipv6.address) : undefined,
      defaultRouter: config.ipv6.defaultRouter ? normalizeIpv6(config.ipv6.defaultRouter) : undefined,
      dnsServer: config.ipv6.dnsServer ? normalizeIpv6(config.ipv6.dnsServer) : undefined,
    } : undefined,
    dhcpv6Pools: [...(config?.dhcpv6Pools ?? [])].sort(byId).map((pool) => ({ ...pool })),
    enabledServices: [...(config?.enabledServices ?? [])]
      .sort(byId)
      .map((service) => normalizeServiceConfiguration(service)),
    discovery: canonicalDiscovery(config?.discovery),
    consoleAccess: canonicalConsoleAccess(config),
  };
}

function hubConfiguration(node: NodeSpec, config: HubDeviceConfig | undefined): HubDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "hub",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
  };
}

function bridgeConfiguration(node: NodeSpec, config: BridgeDeviceConfig | undefined): BridgeDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "bridge",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    agingTimeNs: config?.agingTimeNs ?? 300_000_000_000,
    consoleAccess: canonicalConsoleAccess(config),
  };
}

function switchConfiguration(node: NodeSpec, config: SwitchDeviceConfig | undefined): SwitchDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  const vlans = new Map((config?.vlans ?? []).map((vlan) => [vlan.id, vlan]));
  if (!vlans.has(1)) vlans.set(1, { id: 1, name: "default" });
  return {
    kind: "l2-switch",
    hostname: config?.hostname ?? node.name ?? node.id,
    vlans: [...vlans.values()].sort((a, b) => a.id - b.id),
    interfaces: node.interfaces.map((iface): SwitchInterfaceConfig => {
      const current = interfaces.get(iface.id);
      return {
        ...commonInterface(iface.id, current),
        mode: current?.mode ?? "access",
        accessVlan: current?.accessVlan ?? 1,
        nativeVlan: current?.nativeVlan ?? 1,
        allowedVlans: current?.allowedVlans
          ? [...current.allowedVlans].sort((a, b) => a - b)
          : undefined,
      };
    }),
    ...canonicalSwitchProtocols(config),
    consoleAccess: canonicalConsoleAccess(config),
    managementSvi: canonicalManagementSvi(config?.managementSvi),
    managementDefaultGateway: config?.managementDefaultGateway,
    remoteAccess: canonicalRemoteAccess(config),
    aaa: canonicalAaa(config),
    snmp: canonicalSnmp(config),
  };
}

function canonicalManagementSvi(svi: ManagementSviConfig | undefined): ManagementSviConfig | undefined {
  return svi ? { ...svi } : undefined;
}

/** AAA in canonical order; absent when nothing was configured. */
function canonicalAaa(config: { aaa?: AaaConfiguration } | undefined): AaaConfiguration | undefined {
  const aaa = config?.aaa;
  return isDefaultAaaConfiguration(aaa) || !aaa ? undefined : normalizeAaaConfiguration(aaa);
}

/** SNMP agent configuration in canonical order; absent when unconfigured. */
function canonicalSnmp(
  config: { snmp?: SnmpAgentConfiguration } | undefined,
): SnmpAgentConfiguration | undefined {
  const snmp = config?.snmp;
  return isDefaultSnmpAgentConfiguration(snmp) || !snmp ? undefined : normalizeSnmpAgentConfiguration(snmp);
}

/**
 * Control-protocol configuration in canonical order: spanning-tree VLANs by
 * VLAN id, ports by interface id, EtherChannels by channel id with members by
 * interface id, and discovery interfaces by id. Ordering is observable in the
 * serialized document, so it must never depend on insertion order.
 */
function canonicalSwitchProtocols(
  config: Partial<Pick<SwitchDeviceConfig, "spanningTree" | "etherChannels" | "discovery">> | undefined,
) {
  const spanningTree = config?.spanningTree;
  const discovery = config?.discovery;
  return {
    spanningTree: {
      mode: spanningTree?.mode ?? "disabled",
      helloTimeSeconds: spanningTree?.helloTimeSeconds ?? DEFAULT_STP_HELLO_SECONDS,
      maxAgeSeconds: spanningTree?.maxAgeSeconds ?? DEFAULT_STP_MAX_AGE_SECONDS,
      forwardDelaySeconds: spanningTree?.forwardDelaySeconds ?? DEFAULT_STP_FORWARD_DELAY_SECONDS,
      vlans: [...(spanningTree?.vlans ?? [])]
        .sort((a, b) => a.vlanId - b.vlanId)
        .map((vlan) => ({ ...vlan })),
      ports: [...(spanningTree?.ports ?? [])]
        .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId))
        .map((port) => ({ ...port })),
    },
    etherChannels: [...(config?.etherChannels ?? [])]
      .sort((a, b) => a.channelId - b.channelId)
      .map((channel) => ({
        ...channel,
        members: [...channel.members].sort((a, b) => a.localeCompare(b)),
        switchport: channel.switchport
          ? {
              ...channel.switchport,
              allowedVlans: channel.switchport.allowedVlans
                ? [...channel.switchport.allowedVlans].sort((a, b) => a - b)
                : undefined,
            }
          : undefined,
      })),
    discovery: canonicalDiscovery(discovery),
  };
}

function canonicalDiscovery(discovery: NeighborDiscoveryConfig | undefined): NeighborDiscoveryConfig {
  return {
    cdpEnabled: discovery?.cdpEnabled ?? false,
    lldpEnabled: discovery?.lldpEnabled ?? false,
    cdpIntervalSeconds: discovery?.cdpIntervalSeconds ?? DEFAULT_CDP_INTERVAL_SECONDS,
    cdpHoldTimeSeconds: discovery?.cdpHoldTimeSeconds ?? DEFAULT_CDP_HOLD_SECONDS,
    lldpIntervalSeconds: discovery?.lldpIntervalSeconds ?? DEFAULT_LLDP_INTERVAL_SECONDS,
    lldpHoldTimeSeconds: discovery?.lldpHoldTimeSeconds ?? DEFAULT_LLDP_HOLD_SECONDS,
    interfaces: [...(discovery?.interfaces ?? [])]
      .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId))
      .map((iface) => ({ ...iface })),
  };
}

/** Loopbacks by numeric id, OSPF networks by network then wildcard. */
function canonicalRoutedProtocols(
  config: Partial<Pick<
    RouterDeviceConfig,
    "loopbacks" | "ospf" | "ospfv3" | "bgp" | "prefixLists" | "ipv6PrefixLists" | "routeMaps" | "communityLists" | "asPathLists"
  >> | undefined,
) {
  return {
    loopbacks: [...(config?.loopbacks ?? [])]
      .sort((a, b) => a.id - b.id)
      .map((loopback) => ({
        ...loopback,
        ipv6: loopback.ipv6?.map((address) => ({ ...address, address: normalizeIpv6(address.address) })),
      })),
    ospf: config?.ospf === undefined
      ? undefined
      : {
          processId: config.ospf.processId,
          routerId: config.ospf.routerId,
          networks: [...config.ospf.networks]
            .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || ipToInt(a.wildcard) - ipToInt(b.wildcard))
            .map((statement) => ({ ...statement })),
          passiveInterfaces: [...config.ospf.passiveInterfaces].sort((a, b) => a.localeCompare(b)),
          interfaces: [...config.ospf.interfaces]
            .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId))
            .map((iface) => ({ ...iface })),
        },
    ospfv3: config?.ospfv3 === undefined
      ? undefined
      : {
          processId: config.ospfv3.processId,
          routerId: config.ospfv3.routerId,
          passiveInterfaces: [...config.ospfv3.passiveInterfaces].sort((a, b) => a.localeCompare(b)),
          interfaces: [...config.ospfv3.interfaces]
            .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId))
            .map((iface) => ({ ...iface })),
        },
    bgp: config?.bgp === undefined ? undefined : {
      ...config.bgp,
      // A neighbor address may now be IPv6, so ordering is family-aware and
      // IPv4 peers keep their existing position ahead of IPv6 ones.
      neighbors: [...config.bgp.neighbors]
        .map((neighbor) => ({
          ...neighbor,
          address: neighbor.address.includes(":") ? normalizeIpv6(neighbor.address) : neighbor.address,
          ...(neighbor.ipv6 ? { ipv6: { ...neighbor.ipv6 } } : {}),
        }))
        .sort((a, b) => compareIpAddressText(a.address, b.address)),
      networks: [...config.bgp.networks]
        .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength)
        .map((network) => ({ ...network })),
      ipv6Networks: config.bgp.ipv6Networks === undefined ? undefined : [...config.bgp.ipv6Networks]
        .map((network) => ({ ...network, network: normalizeIpv6(network.network) }))
        .sort((a, b) => a.network.localeCompare(b.network) || a.prefixLength - b.prefixLength),
      aggregates: config.bgp.aggregates === undefined ? undefined : [...config.bgp.aggregates]
        .sort((a, b) => ipToInt(a.prefix) - ipToInt(b.prefix) || a.prefixLength - b.prefixLength)
        .map((aggregate) => ({ ...aggregate })),
      vrfAddressFamilies: [...config.bgp.vrfAddressFamilies]
        .sort((a, b) => a.vrfId.localeCompare(b.vrfId))
        .map((family) => ({ ...family })),
    },
    prefixLists: [...(config?.prefixLists ?? [])]
      .sort(byId)
      .map((list) => ({ ...list, entries: [...list.entries].sort((a, b) => a.sequence - b.sequence).map((entry) => ({ ...entry })) })),
    ipv6PrefixLists: config?.ipv6PrefixLists === undefined ? undefined : [...config.ipv6PrefixLists]
      .sort(byId)
      .map((list) => ({
        ...list,
        entries: [...list.entries]
          .sort((a, b) => a.sequence - b.sequence)
          .map((entry) => ({ ...entry, prefix: normalizeIpv6(entry.prefix) })),
      })),
    routeMaps: [...(config?.routeMaps ?? [])]
      .sort(byId)
      .map((map) => ({ ...map, sequences: [...map.sequences].sort((a, b) => a.sequence - b.sequence).map((sequence) => ({
        ...sequence,
        match: sequence.match ? {
          ...sequence.match,
          prefixListIds: sequence.match.prefixListIds ? [...sequence.match.prefixListIds].sort() : undefined,
          ipv6PrefixListIds: sequence.match.ipv6PrefixListIds ? [...sequence.match.ipv6PrefixListIds].sort() : undefined,
          communityListIds: sequence.match.communityListIds ? [...sequence.match.communityListIds].sort() : undefined,
          asPathListIds: sequence.match.asPathListIds ? [...sequence.match.asPathListIds].sort() : undefined,
        } : undefined,
        // `set community` and `set as-path prepend` are ordered actions: the
        // engine already canonicalizes communities and a prepend list is
        // positional, so neither is re-sorted here.
        set: sequence.set ? {
          ...sequence.set,
          communities: sequence.set.communities ? [...sequence.set.communities] : undefined,
          prependAsns: sequence.set.prependAsns ? [...sequence.set.prependAsns] : undefined,
        } : undefined,
      })) })),
    communityLists: config?.communityLists === undefined ? undefined : [...config.communityLists]
      .sort(byId)
      .map((list) => ({
        ...list,
        entries: [...list.entries].sort((a, b) => a.sequence - b.sequence)
          .map((entry) => ({ ...entry, communities: [...entry.communities] })),
      })),
    asPathLists: config?.asPathLists === undefined ? undefined : [...config.asPathLists]
      .sort(byId)
      .map((list) => ({
        ...list,
        entries: [...list.entries].sort((a, b) => a.sequence - b.sequence)
          .map((entry) => ({ ...entry, matcher: { ...entry.matcher } })),
      })),
  };
}

function canonicalAcls(
  config: Pick<RouterDeviceConfig, "acls" | "aclBindings" | "ipv6Acls" | "ipv6AclBindings"> | undefined,
) {
  return {
    acls: [...(config?.acls ?? [])]
      .sort(byId)
      .map((acl) => acl.type === "standard"
        ? {
            ...acl,
            rules: [...acl.rules]
              .sort((a, b) => a.sequence - b.sequence)
              .map((rule) => ({ ...rule, source: { ...rule.source } })),
          }
        : {
            ...acl,
            rules: [...acl.rules]
              .sort((a, b) => a.sequence - b.sequence)
              .map((rule) => ({
                ...rule,
                source: { ...rule.source },
                destination: { ...rule.destination },
                sourcePort: rule.sourcePort ? { ...rule.sourcePort } : undefined,
                destinationPort: rule.destinationPort ? { ...rule.destinationPort } : undefined,
              })),
          }),
    aclBindings: [...(config?.aclBindings ?? [])]
      .sort((a, b) =>
        a.interfaceName.localeCompare(b.interfaceName)
        || a.direction.localeCompare(b.direction)
        || a.aclId.localeCompare(b.aclId))
      .map((binding) => ({ ...binding })),
    ipv6Acls: [...(config?.ipv6Acls ?? [])]
      .sort(byId)
      .map((acl) => ({
        ...acl,
        rules: [...acl.rules]
          .sort((a, b) => a.sequence - b.sequence)
          .map((rule) => ({
            ...rule,
            source: { ...rule.source },
            destination: { ...rule.destination },
            sourcePort: rule.sourcePort ? { ...rule.sourcePort } : undefined,
            destinationPort: rule.destinationPort ? { ...rule.destinationPort } : undefined,
          })),
      })),
    ipv6AclBindings: [...(config?.ipv6AclBindings ?? [])]
      .sort((a, b) =>
        a.interfaceName.localeCompare(b.interfaceName)
        || a.direction.localeCompare(b.direction)
        || a.aclId.localeCompare(b.aclId))
      .map((binding) => ({ ...binding })),
  };
}

/**
 * Canonical QoS ordering: class maps and policy maps by id, matches and classes
 * in their configured order (that order is semantic), bindings by interface and
 * direction. Absent when nothing is configured, so an untouched lab round-trips
 * byte-identically and a schema-v1 lab keeps opening without a `qos` block.
 */
function canonicalQos(configuration: QosConfiguration | undefined): QosConfiguration | undefined {
  if (isDefaultQosConfiguration(configuration)) return undefined;
  return {
    classMaps: [...configuration!.classMaps].sort(byId).map((map) => ({
      id: map.id,
      matchType: map.matchType,
      matches: map.matches.map((rule) => ({ ...rule })),
    })),
    policyMaps: [...configuration!.policyMaps].sort(byId).map((map) => ({
      id: map.id,
      classes: map.classes.map((entry) => ({
        ...entry,
        marking: entry.marking ? { ...entry.marking } : undefined,
        priority: entry.priority ? { ...entry.priority } : undefined,
        police: entry.police ? { ...entry.police } : undefined,
        shape: entry.shape ? { ...entry.shape } : undefined,
      })),
    })),
    servicePolicies: [...configuration!.servicePolicies]
      .sort((a, b) =>
        a.interfaceName.localeCompare(b.interfaceName)
        || a.direction.localeCompare(b.direction)
        || a.policyMapId.localeCompare(b.policyMapId))
      .map((binding) => ({ ...binding })),
  };
}

/**
 * Canonical VPN ordering: tunnels by numeric id, proposals, peers and profiles
 * by id. Absent when nothing is configured, so a schema-v1 lab written before
 * M10.9 keeps opening and an untouched lab round-trips byte-identically.
 * Runtime — IKE state, SAs, SPIs, sequence numbers, counters — is never here.
 */
function canonicalVpn(configuration: VpnConfiguration | undefined): VpnConfiguration | undefined {
  if (isDefaultVpnConfiguration(configuration) || !configuration) return undefined;
  return {
    tunnels: [...configuration.tunnels].sort((a, b) => a.id - b.id).map((tunnel) => withoutUndefined({
      ...tunnel,
      source: { ...tunnel.source },
      ipv4: tunnel.ipv4 ? { ...tunnel.ipv4 } : undefined,
      ipv6: tunnel.ipv6 ? tunnel.ipv6.map((address) => ({ ...address })) : undefined,
    })),
    proposals: [...configuration.proposals].sort(byId).map((entry) => ({ ...entry })),
    ikePeers: [...configuration.ikePeers].sort(byId).map((peer) => withoutUndefined({
      ...peer,
      preSharedKeyVerifier: peer.preSharedKeyVerifier ? { ...peer.preSharedKeyVerifier } : undefined,
    })),
    ipsecProfiles: [...configuration.ipsecProfiles].sort(byId).map((entry) => ({ ...entry })),
  };
}

/**
 * Drop keys whose value is `undefined`, so an optional field that was never
 * configured is *absent* rather than present-and-undefined. Without this a
 * serialize → canonicalize round trip would differ from the original document
 * by exactly those keys.
 */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/**
 * Canonical physical placement: sites, rooms and racks by id, placements by
 * device id. Ordering is observable in the saved document, so it must never
 * depend on insertion order. Absent when nothing is placed, so a lab written
 * before M10.8.1 round-trips byte-identically without a `physical` block.
 */
function canonicalPhysical(layout: LabPhysicalLayout | undefined): LabPhysicalLayout | undefined {
  if (isDefaultPhysicalLayout(layout) || !layout) return undefined;
  return {
    sites: [...layout.sites].sort(byId).map((site) => ({
      id: site.id,
      name: site.name,
      rooms: [...site.rooms].sort(byId).map((room) => ({
        id: room.id,
        name: room.name,
        backgroundAssetId: room.backgroundAssetId,
        racks: [...room.racks].sort(byId).map((rack) => ({
          ...rack,
          position: { ...rack.position },
        })),
      })),
    })),
    devicePlacements: [...layout.devicePlacements]
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
      .map((placement) => ({ ...placement })),
  };
}

function canonicalRoutedIpv6(
  config: Partial<Pick<
    RouterDeviceConfig,
    "ipv6UnicastRoutingEnabled" | "ipv6StaticRoutes" | "routerAdvertisements" | "dhcpv6Pools"
  >> | undefined,
) {
  return {
    ipv6UnicastRoutingEnabled: config?.ipv6UnicastRoutingEnabled ?? false,
    ipv6StaticRoutes: [...(config?.ipv6StaticRoutes ?? [])]
      .sort((a, b) =>
        normalizeIpv6(a.network).localeCompare(normalizeIpv6(b.network))
        || a.prefixLength - b.prefixLength
        || normalizeIpv6(a.nextHop).localeCompare(normalizeIpv6(b.nextHop)))
      .map((route) => ({
        ...route,
        network: normalizeIpv6(route.network),
        nextHop: normalizeIpv6(route.nextHop),
      })),
    routerAdvertisements: [...(config?.routerAdvertisements ?? [])]
      .sort((a, b) => a.interfaceName.localeCompare(b.interfaceName))
      .map((advertisement) => ({
        ...advertisement,
        dnsServers: [...advertisement.dnsServers].map(normalizeIpv6).sort((a, b) => a.localeCompare(b)),
        prefixes: [...advertisement.prefixes]
          .sort((a, b) =>
            normalizeIpv6(a.prefix).localeCompare(normalizeIpv6(b.prefix))
            || a.prefixLength - b.prefixLength)
          .map((prefix) => ({ ...prefix, prefix: normalizeIpv6(prefix.prefix) })),
      })),
    dhcpv6Pools: [...(config?.dhcpv6Pools ?? [])]
      .sort(byId)
      .map((pool) => ({
        ...pool,
        prefix: normalizeIpv6(pool.prefix),
        rangeStart: normalizeIpv6(pool.rangeStart),
        rangeEnd: normalizeIpv6(pool.rangeEnd),
        dnsServers: [...pool.dnsServers].map(normalizeIpv6).sort((a, b) => a.localeCompare(b)),
      })),
  };
}

function canonicalNat(config: RouterDeviceConfig | undefined) {
  return {
    natPools: [...(config?.natPools ?? [])].sort(byId).map((pool) => ({ ...pool })),
    natRules: [...(config?.natRules ?? [])]
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
      .map((rule) => rule.kind === "static" ? { ...rule } : { ...rule, source: { ...rule.source } }),
    natInterfaceRoles: [...(config?.natInterfaceRoles ?? [])]
      .sort((a, b) => a.interfaceName.localeCompare(b.interfaceName) || a.role.localeCompare(b.role))
      .map((role) => ({ ...role })),
  };
}

function routerConfiguration(node: NodeSpec, config: RouterDeviceConfig | undefined): RouterDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "router",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface): RouterPhysicalInterfaceConfig => {
      const current = interfaces.get(iface.id);
      return {
        ...commonInterface(iface.id, current),
        routed: current?.routed ?? false,
        ipv4: current?.ipv4,
        ipv6: current?.ipv6?.map((address) => ({ ...address, address: normalizeIpv6(address.address) })),
        mplsEnabled: current?.mplsEnabled,
        vrfId: current?.vrfId,
      };
    }),
    subinterfaces: [...(config?.subinterfaces ?? [])].sort(byId).map((iface) => ({
      ...iface,
      ipv6: iface.ipv6?.map((address) => ({ ...address, address: normalizeIpv6(address.address) })),
    })),
    staticRoutes: [...(config?.staticRoutes ?? [])]
      .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength || a.nextHop.localeCompare(b.nextHop))
      .map((route) => ({ ...route })),
    dhcpPools: [...(config?.dhcpPools ?? [])].sort(byId).map((pool) => ({ ...pool })),
    ...canonicalRoutedIpv6(config),
    ...canonicalAcls(config),
    qos: canonicalQos(config?.qos),
    vpn: canonicalVpn(config?.vpn),
    ...canonicalNat(config),
    ldp: config?.ldp === undefined ? undefined : { ...config.ldp },
    vrfs: [...(config?.vrfs ?? [])]
      .sort(byId)
      .map((vrf) => ({
        ...vrf,
        importRouteTargets: [...vrf.importRouteTargets].sort(),
        exportRouteTargets: [...vrf.exportRouteTargets].sort(),
        staticRoutes: [...vrf.staticRoutes]
          .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength || a.nextHop.localeCompare(b.nextHop))
          .map((route) => ({ ...route })),
        // Omitted rather than emitted empty, so an IPv4-only VRF serializes
        // exactly as it did before M10.13.
        ipv6StaticRoutes: vrf.ipv6StaticRoutes === undefined
          ? undefined
          : [...vrf.ipv6StaticRoutes]
            .map((route) => ({
              ...route,
              network: normalizeIpv6(route.network),
              nextHop: normalizeIpv6(route.nextHop),
            }))
            .sort((a, b) => a.network.localeCompare(b.network)
              || a.prefixLength - b.prefixLength
              || a.nextHop.localeCompare(b.nextHop)),
      })),
    ...canonicalRoutedProtocols(config),
    discovery: canonicalDiscovery(config?.discovery),
    consoleAccess: canonicalConsoleAccess(config),
    remoteAccess: canonicalRemoteAccess(config),
    aaa: canonicalAaa(config),
    snmp: canonicalSnmp(config),
  };
}

function firewallConfiguration(
  node: NodeSpec,
  config: FirewallDeviceConfig | undefined,
): FirewallDeviceConfig {
  const router = routerConfiguration(node, config
    ? { ...config, kind: "router" }
    : undefined);
  return {
    ...router,
    kind: "firewall",
    zones: [...(config?.zones ?? [])]
      .sort((a, b) => a.interfaceName.localeCompare(b.interfaceName))
      .map((zone) => ({ ...zone })),
    firewallPolicies: [...(config?.firewallPolicies ?? [])]
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
      .map((policy) => ({
        ...policy,
        source: policy.source ? { ...policy.source } : undefined,
        destination: policy.destination ? { ...policy.destination } : undefined,
        sourcePort: policy.sourcePort ? { ...policy.sourcePort } : undefined,
        destinationPort: policy.destinationPort ? { ...policy.destinationPort } : undefined,
        states: policy.states ? [...policy.states] : undefined,
      })),
    defaultPolicy: config?.defaultPolicy ?? "deny",
  };
}

function cloudConfiguration(
  node: NodeSpec,
  config: CloudDeviceConfig | undefined,
): CloudDeviceConfig {
  const router = routerConfiguration(node, config
    ? { ...config, kind: "router" }
    : undefined);
  return {
    ...router,
    kind: "cloud",
    impairments: [...(config?.impairments ?? [])]
      .sort((a, b) => a.interfaceName.localeCompare(b.interfaceName))
      .map((impairment) => ({ ...impairment })),
  };
}

function trafficGeneratorConfiguration(
  node: NodeSpec,
  config: TrafficGeneratorDeviceConfig | undefined,
): TrafficGeneratorDeviceConfig {
  const pc = pcConfiguration(node, config
    ? { ...config, kind: "pc" }
    : undefined);
  return {
    ...pc,
    kind: "traffic-generator",
    flows: [...(config?.flows ?? [])].sort(byId).map((flow) => ({ ...flow })),
  };
}

function layer3SwitchConfiguration(
  node: NodeSpec,
  config: Layer3SwitchDeviceConfig | undefined,
): Layer3SwitchDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  const vlans = new Map((config?.vlans ?? []).map((vlan) => [vlan.id, vlan]));
  if (!vlans.has(1)) vlans.set(1, { id: 1, name: "default" });
  return {
    kind: "l3-switch",
    hostname: config?.hostname ?? node.name ?? node.id,
    vlans: [...vlans.values()].sort((a, b) => a.id - b.id),
    interfaces: node.interfaces.map((iface): Layer3SwitchInterfaceConfig => {
      const current = interfaces.get(iface.id);
      if (current?.mode === "routed") {
        return {
          ...commonInterface(iface.id, current),
          mode: "routed",
          ipv4: current.ipv4,
          ipv6: current.ipv6?.map((address) => ({ ...address, address: normalizeIpv6(address.address) })),
        };
      }
      return {
        ...commonInterface(iface.id, current),
        mode: current?.mode ?? "access",
        accessVlan: current?.accessVlan ?? 1,
        nativeVlan: current?.nativeVlan ?? 1,
        allowedVlans: current?.allowedVlans ? [...current.allowedVlans].sort((a, b) => a - b) : undefined,
      };
    }),
    svis: [...(config?.svis ?? [])].sort((a, b) => a.vlanId - b.vlanId).map((svi) => ({
      ...svi,
      ipv6: svi.ipv6?.map((address) => ({ ...address, address: normalizeIpv6(address.address) })),
    })),
    staticRoutes: [...(config?.staticRoutes ?? [])]
      .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength || a.nextHop.localeCompare(b.nextHop))
      .map((route) => ({ ...route })),
    ipRoutingEnabled: config?.ipRoutingEnabled ?? false,
    ...canonicalRoutedIpv6(config),
    ...canonicalAcls(config),
    qos: canonicalQos(config?.qos),
    ...canonicalSwitchProtocols(config),
    ...canonicalRoutedProtocols(config),
    ...canonicalVxlan(config),
    consoleAccess: canonicalConsoleAccess(config),
    remoteAccess: canonicalRemoteAccess(config),
    aaa: canonicalAaa(config),
    snmp: canonicalSnmp(config),
  };
}

/**
 * VXLAN members order by VNI, static peers by address and route targets are
 * deduplicated and sorted, so an identical overlay always serializes to
 * identical bytes. An absent block stays absent: a pre-M10.14 lab is unchanged.
 */
function canonicalVxlan(config: Layer3SwitchDeviceConfig | undefined) {
  return {
    nve: config?.nve === undefined ? undefined : {
      id: "nve1" as const,
      sourceInterfaceId: config.nve.sourceInterfaceId,
      shutdown: config.nve.shutdown,
      members: [...config.nve.members]
        .sort((a, b) => a.vni - b.vni)
        .map((member) => ({
          vni: member.vni,
          vlanId: member.vlanId,
          replication: member.replication.type === "static"
            ? {
                type: "static" as const,
                peerAddresses: [...new Set(member.replication.peerAddresses)]
                  .sort((a, b) => ipToInt(a) - ipToInt(b)),
              }
            : { type: "bgp-evpn" as const },
        })),
      // An absent L3VNI list stays absent, so a pre-M10.15 NVE is byte-identical.
      vrfMembers: config.nve.vrfMembers === undefined ? undefined : [...config.nve.vrfMembers]
        .sort((a, b) => a.vni - b.vni)
        .map((member) => ({ vni: member.vni, vrfId: member.vrfId })),
    },
    evpn: config?.evpn === undefined ? undefined : {
      vnis: [...config.evpn.vnis]
        .sort((a, b) => a.vni - b.vni)
        .map((vni) => ({
          vni: vni.vni,
          routeDistinguisher: vni.routeDistinguisher,
          importRouteTargets: [...new Set(vni.importRouteTargets)].sort(),
          exportRouteTargets: [...new Set(vni.exportRouteTargets)].sort(),
        })),
      anycastGatewayMac: config.evpn.anycastGatewayMac?.toLowerCase(),
    },
    vrfs: config?.vrfs === undefined ? undefined : [...config.vrfs]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((vrf) => ({
        ...vrf,
        importRouteTargets: [...new Set(vrf.importRouteTargets)].sort(),
        exportRouteTargets: [...new Set(vrf.exportRouteTargets)].sort(),
        staticRoutes: [...vrf.staticRoutes]
          .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength),
      })),
  };
}

function externalApplianceConfiguration(
  node: NodeSpec,
  config: ExternalApplianceDeviceConfig | undefined,
): ExternalApplianceDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "external-appliance",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    sourcePlatform: config?.sourcePlatform ?? "unknown",
    sourceVendor: config?.sourceVendor,
    sourceNodeKind: config?.sourceNodeKind,
    sourceTemplate: config?.sourceTemplate,
    sourceIconHint: config?.sourceIconHint,
    unparsedConfig: config?.unparsedConfig,
    importWarnings: config?.importWarnings ? [...config.importWarnings] : [],
    authHint: config?.authHint ?? "unknown",
  };
}

function canonicalWirelessRadio(
  radio: WirelessRadioSettings | undefined,
): WirelessRadioSettings {
  return {
    enabled: radio?.enabled ?? true,
    band: radio?.band ?? "2.4ghz",
    supportedChannels: [...(radio?.supportedChannels ?? [1, 6, 11])]
      .sort((a, b) => a - b),
    radioDomainId: radio?.radioDomainId ?? "local-lab",
  };
}

function canonicalAccessPoint(
  accessPoint: WirelessAccessPointConfiguration | undefined,
  radio: WirelessRadioSettings,
): WirelessAccessPointConfiguration {
  return {
    ssid: accessPoint?.ssid ?? "SimulatorNet",
    broadcastSsid: accessPoint?.broadcastSsid ?? true,
    band: accessPoint?.band ?? radio.band,
    channel: accessPoint?.channel ?? radio.supportedChannels[0] ?? 1,
    enabled: accessPoint?.enabled ?? radio.enabled,
    radioDomainId: accessPoint?.radioDomainId ?? radio.radioDomainId,
    priority: accessPoint?.priority ?? 100,
    maximumClients: accessPoint?.maximumClients ?? 32,
    clientIsolation: accessPoint?.clientIsolation ?? false,
    security: accessPoint?.security.mode === "wpa2-personal"
      ? {
          mode: "wpa2-personal",
          credentialVerifier: { ...accessPoint.security.credentialVerifier },
        }
      : { mode: "open" },
  };
}

function canonicalStation(
  station: WirelessStationConfiguration | undefined,
): WirelessStationConfiguration {
  return {
    radio: canonicalWirelessRadio(station?.radio),
    savedNetworks: [...(station?.savedNetworks ?? [])]
      .sort(byId)
      .map((network) => ({
        ...network,
        credentialVerifier: network.credentialVerifier
          ? { ...network.credentialVerifier }
          : undefined,
      })),
    autoConnect: station?.autoConnect ?? true,
    preferredSsid: station?.preferredSsid,
    preferredBssid: station?.preferredBssid?.toLowerCase(),
  };
}

function accessPointConfiguration(
  node: NodeSpec,
  config: AccessPointDeviceConfig | undefined,
): AccessPointDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  const radio = canonicalWirelessRadio(config?.radio);
  return {
    kind: "access-point",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    radio,
    accessPoint: canonicalAccessPoint(config?.accessPoint, radio),
  };
}

function wirelessHostConfiguration(
  node: NodeSpec,
  config: LaptopDeviceConfig | SmartphoneDeviceConfig | undefined,
): LaptopDeviceConfig | SmartphoneDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  const common = {
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    ipv4: config?.ipv4,
    dhcpEnabled: config?.dhcpEnabled ?? false,
    dnsServer: config?.dnsServer,
    ipv6: config?.ipv6 ? {
      ...config.ipv6,
      address: config.ipv6.address ? normalizeIpv6(config.ipv6.address) : undefined,
      defaultRouter: config.ipv6.defaultRouter ? normalizeIpv6(config.ipv6.defaultRouter) : undefined,
      dnsServer: config.ipv6.dnsServer ? normalizeIpv6(config.ipv6.dnsServer) : undefined,
    } : undefined,
    wireless: canonicalStation(config?.wireless),
  };
  return node.kind === "laptop"
    ? { kind: "laptop", ...common }
    : { kind: "smartphone", ...common };
}

function wirelessRouterConfiguration(
  node: NodeSpec,
  config: WirelessRouterDeviceConfig | undefined,
): WirelessRouterDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  const radio = canonicalWirelessRadio(config?.radio);
  return {
    kind: "wireless-router",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    radio,
    accessPoint: canonicalAccessPoint(config?.accessPoint, radio),
    lan: {
      address: config?.lan.address ?? "192.168.50.1",
      prefixLength: config?.lan.prefixLength ?? 24,
      dhcpEnabled: config?.lan.dhcpEnabled ?? true,
      dhcpRangeStart: config?.lan.dhcpRangeStart ?? "192.168.50.100",
      dhcpRangeEnd: config?.lan.dhcpRangeEnd ?? "192.168.50.150",
      ipv6Address: config?.lan.ipv6Address
        ? normalizeIpv6(config.lan.ipv6Address)
        : undefined,
      ipv6PrefixLength: config?.lan.ipv6PrefixLength,
      routerAdvertisementEnabled: config?.lan.routerAdvertisementEnabled ?? false,
      dhcpv6Enabled: config?.lan.dhcpv6Enabled ?? false,
    },
    wan: {
      mode: config?.wan.mode ?? "dhcp",
      address: config?.wan.address,
      prefixLength: config?.wan.prefixLength,
      defaultGateway: config?.wan.defaultGateway,
      dnsServer: config?.wan.dnsServer && config.wan.dnsServer.includes(":")
        ? normalizeIpv6(config.wan.dnsServer)
        : config?.wan.dnsServer,
    },
    natEnabled: config?.natEnabled ?? true,
    firewallEnabled: config?.firewallEnabled ?? true,
  };
}

/**
 * Fill one device configuration with its schema defaults, exactly as
 * `canonicalizeLabDocument` does for a whole document.
 *
 * Startup snapshots, drift comparison and a reload all go through this, so a
 * configuration built by the engine and one read from a file are the same
 * object when they describe the same device. Passing `undefined` produces the
 * factory-default configuration a device boots with after `erase startup-config`.
 */
export function canonicalizeDeviceConfiguration(
  node: NodeSpec,
  existing: DeviceConfig | undefined,
): DeviceConfig {
  return configurationFor(node, existing);
}

function configurationFor(node: NodeSpec, existing: DeviceConfig | undefined): DeviceConfig {
  if (node.kind === "pc") return pcConfiguration(node, existing?.kind === "pc" ? existing : undefined);
  if (node.kind === "server") return serverConfiguration(node, existing?.kind === "server" ? existing : undefined);
  if (node.kind === "hub") return hubConfiguration(node, existing?.kind === "hub" ? existing : undefined);
  if (node.kind === "bridge") return bridgeConfiguration(node, existing?.kind === "bridge" ? existing : undefined);
  if (node.kind === "l2-switch") {
    return switchConfiguration(node, existing?.kind === "l2-switch" ? existing : undefined);
  }
  if (node.kind === "l3-switch") {
    return layer3SwitchConfiguration(node, existing?.kind === "l3-switch" ? existing : undefined);
  }
  if (node.kind === "router") {
    return routerConfiguration(node, existing?.kind === "router" ? existing : undefined);
  }
  if (node.kind === "firewall") {
    return firewallConfiguration(node, existing?.kind === "firewall" ? existing : undefined);
  }
  if (node.kind === "cloud") {
    return cloudConfiguration(node, existing?.kind === "cloud" ? existing : undefined);
  }
  if (node.kind === "traffic-generator") {
    return trafficGeneratorConfiguration(
      node,
      existing?.kind === "traffic-generator" ? existing : undefined,
    );
  }
  if (node.kind === "access-point") {
    return accessPointConfiguration(
      node,
      existing?.kind === "access-point" ? existing : undefined,
    );
  }
  if (node.kind === "laptop") {
    return wirelessHostConfiguration(
      node,
      existing?.kind === "laptop" ? existing : undefined,
    );
  }
  if (node.kind === "smartphone") {
    return wirelessHostConfiguration(
      node,
      existing?.kind === "smartphone" ? existing : undefined,
    );
  }
  if (node.kind === "wireless-router") {
    return wirelessRouterConfiguration(
      node,
      existing?.kind === "wireless-router" ? existing : undefined,
    );
  }
  return externalApplianceConfiguration(
    node,
    existing?.kind === "external-appliance" ? existing : undefined,
  );
}

/**
 * Accepts a draft as well as a complete document: `parseLabDocument` applies
 * every schema default, which is exactly what `LabDocumentDraft` exists for —
 * a demo or fixture may omit `spanningTree: { mode: "disabled" }` on every
 * switch and still canonicalize to a fully-populated `LabDocument`.
 */
export function canonicalizeLabDocument(document: LabDocument | LabDocumentDraft): LabDocument {
  const parsed = parseLabDocument(document);
  const nodes = canonicalInterfaces(parsed.topology.nodes);
  const configurations: Record<string, DeviceConfig> = {};
  for (const node of nodes) configurations[node.id] = configurationFor(node, parsed.configurations[node.id]);

  const canonical: LabDocument = {
    schemaVersion: 1,
    id: parsed.id,
    title: parsed.title,
    description: parsed.description,
    instructions: parsed.instructions,
    expectedOutcome: parsed.expectedOutcome,
    sourceImport: parsed.sourceImport === undefined
      ? undefined
      : {
          platform: parsed.sourceImport.platform,
          originalFilename: parsed.sourceImport.originalFilename,
          sourceVersion: parsed.sourceImport.sourceVersion,
          warnings: [...parsed.sourceImport.warnings],
        },
    diagram: parsed.diagram === undefined
      ? undefined
      : {
          assets: parsed.diagram.assets === undefined
            ? undefined
            : [...parsed.diagram.assets].sort(byId).map((asset) => ({ ...asset })),
          annotations: [...parsed.diagram.annotations].sort(byId).map((annotation) => (
            "position" in annotation
              ? { ...annotation, position: { ...annotation.position } }
              : {
                  ...annotation,
                  start: { ...annotation.start },
                  end: { ...annotation.end },
                  ...(annotation.bend ? { bend: { ...annotation.bend } } : {}),
                }
          )),
          linkLabels: [...parsed.diagram.linkLabels]
            .sort((a, b) => a.linkId.localeCompare(b.linkId))
            .map((label) => ({ ...label })),
          linkStyles: [...parsed.diagram.linkStyles]
            .sort((a, b) => a.linkId.localeCompare(b.linkId))
            .map((style) => ({
              ...style,
              vertices: style.vertices.map((vertex) => ({ ...vertex })),
            })),
        },
    physical: canonicalPhysical(parsed.physical),
    simulation: { seed: parsed.simulation.seed },
    topology: {
      schemaVersion: 1,
      nodes,
      links: [...parsed.topology.links].sort(byId).map((link) => ({
        id: link.id,
        a: { ...link.a },
        b: { ...link.b },
        propagationDelayNs: link.propagationDelayNs,
        capacityBps: link.capacityBps,
        queueLimitPackets: link.queueLimitPackets,
      })),
    },
    configurations,
    startupConfigurations: canonicalStartupConfigurations(nodes, parsed.startupConfigurations),
  };
  validateLabSemantics(canonical);
  return canonical;
}

/**
 * Canonicalize the saved startup snapshots.
 *
 * Entries are rebuilt in sorted node order so the serialized record is stable,
 * a saved configuration is filled with the same schema defaults as the running
 * one (otherwise a device could look "modified" purely because one snapshot
 * spelled a default out), and an entry for a device that no longer exists — or
 * one whose kind no longer matches — is dropped rather than resurrected.
 *
 * The whole map is omitted when nothing is stored, so a lab that has never used
 * `copy running-config startup-config` round-trips byte-identically.
 */
function canonicalStartupConfigurations(
  nodes: readonly NodeSpec[],
  existing: LabStartupConfigurations | undefined,
): LabStartupConfigurations | undefined {
  if (!existing) return undefined;
  const startup: LabStartupConfigurations = {};
  for (const node of nodes) {
    const entry = existing[node.id];
    if (!entry) continue;
    if (entry.state === "absent") { startup[node.id] = { state: "absent" }; continue; }
    if (entry.configuration.kind !== node.kind) continue;
    startup[node.id] = { state: "saved", configuration: configurationFor(node, entry.configuration) };
  }
  return Object.keys(startup).length === 0 ? undefined : startup;
}

export function stringifyLabDocument(document: LabDocument): string {
  return `${JSON.stringify(canonicalizeLabDocument(document), null, 2)}\n`;
}

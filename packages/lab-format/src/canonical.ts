import {
  DEFAULT_CDP_HOLD_SECONDS,
  DEFAULT_CDP_INTERVAL_SECONDS,
  DEFAULT_LLDP_HOLD_SECONDS,
  DEFAULT_LLDP_INTERVAL_SECONDS,
  DEFAULT_STP_FORWARD_DELAY_SECONDS,
  DEFAULT_STP_HELLO_SECONDS,
  DEFAULT_STP_MAX_AGE_SECONDS,
  type NeighborDiscoveryConfig,
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
import { ipToInt, macFromIndex, normalizeIpv6, normalizeServiceConfiguration } from "@sim/sim-core";
import { parseLabDocument } from "./parse";
import { validateLabSemantics } from "./semantic";

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
  };
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
  config: Partial<Pick<RouterDeviceConfig, "loopbacks" | "ospf" | "ospfv3">> | undefined,
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
    ...canonicalNat(config),
    ...canonicalRoutedProtocols(config),
    discovery: canonicalDiscovery(config?.discovery),
    consoleAccess: canonicalConsoleAccess(config),
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
    ...canonicalSwitchProtocols(config),
    ...canonicalRoutedProtocols(config),
    consoleAccess: canonicalConsoleAccess(config),
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

export function canonicalizeLabDocument(document: LabDocument): LabDocument {
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
    simulation: { seed: parsed.simulation.seed },
    topology: {
      schemaVersion: 1,
      nodes,
      links: [...parsed.topology.links].sort(byId).map((link) => ({
        id: link.id,
        a: { ...link.a },
        b: { ...link.b },
        propagationDelayNs: link.propagationDelayNs,
      })),
    },
    configurations,
  };
  validateLabSemantics(canonical);
  return canonical;
}

export function stringifyLabDocument(document: LabDocument): string {
  return `${JSON.stringify(canonicalizeLabDocument(document), null, 2)}\n`;
}

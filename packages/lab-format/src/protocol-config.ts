import type {
  EtherChannelConfig,
  EvpnConfig,
  NveInterfaceConfig,
  LoopbackInterfaceConfig,
  NeighborDiscoveryConfig,
  OspfProcessConfig,
  Ospfv3ProcessConfig,
  SpanningTreeConfig,
  VpnConfiguration,
  BgpProcessConfig,
  PrefixListConfig,
  Ipv6PrefixListConfig,
  RouteMapConfig,
  CommunityListConfig,
  AsPathListConfig,
  VrfConfig,
} from "@sim/contracts";
import {
  DEFAULT_STP_PORT_PRIORITY_VALUE,
  isDefaultVpnConfiguration,
} from "@sim/contracts";
import {
  type AsPathList,
  type CommunityList,
  type L2Switch,
  type Layer3Switch,
  loopbackName,
  NS_PER_S,
  parseTunnelName,
  portChannelName,
  type Router,
} from "@sim/sim-core";

/**
 * Translation between the persisted, second-based control-protocol
 * configuration and the engine's virtual-nanosecond runtime. Only configuration
 * crosses this boundary in either direction; adjacencies, elected roles, tables
 * and learned routes stay inside the engine.
 */

const seconds = (value: number): number => value * NS_PER_S;
const toSeconds = (value: number): number => Math.round(value / NS_PER_S);

// --- apply -----------------------------------------------------------------

export function applySpanningTreeConfiguration(device: L2Switch, config: SpanningTreeConfig): void {
  device.spanningTree.setTimers({
    helloTimeNs: seconds(config.helloTimeSeconds),
    maxAgeNs: seconds(config.maxAgeSeconds),
    forwardDelayNs: seconds(config.forwardDelaySeconds),
  });
  for (const vlan of config.vlans) device.spanningTree.setBridgePriority(vlan.vlanId, vlan.priority);
  for (const port of config.ports) {
    device.spanningTree.setPortCost(port.interfaceId, port.cost);
    device.spanningTree.setPortPriority(port.interfaceId, port.priority);
    device.spanningTree.setPortFast(port.interfaceId, port.portFast);
    device.spanningTree.setBpduGuard(port.interfaceId, port.bpduGuard);
  }
  // The mode is applied last so the instances are built with final timers.
  device.setSpanningTreeMode(config.mode);
}

export function applyEtherChannelConfiguration(
  device: L2Switch,
  channels: readonly EtherChannelConfig[],
): void {
  for (const channel of channels) {
    for (const member of channel.members) device.addChannelGroupMember(channel.channelId, member, channel.mode);
    if (channel.minimumLinks !== undefined) {
      device.etherChannel.setMinimumLinks(channel.channelId, channel.minimumLinks);
    }
    if (channel.description !== undefined) {
      device.etherChannel.setDescription(channel.channelId, channel.description);
    }
    const switchport = channel.switchport;
    if (!switchport) continue;
    const logical = portChannelName(channel.channelId);
    if (switchport.mode === "access") device.setAccess(logical, switchport.accessVlan);
    else device.setTrunk(logical, { nativeVlan: switchport.nativeVlan, allowedVlans: switchport.allowedVlans });
  }
}

export function applyDiscoveryConfiguration(
  device: { discovery: L2Switch["discovery"] },
  config: NeighborDiscoveryConfig,
): void {
  device.discovery.setTimers({
    cdpIntervalNs: seconds(config.cdpIntervalSeconds),
    cdpHoldTimeNs: seconds(config.cdpHoldTimeSeconds),
    lldpIntervalNs: seconds(config.lldpIntervalSeconds),
    lldpHoldTimeNs: seconds(config.lldpHoldTimeSeconds),
  });
  for (const iface of config.interfaces) {
    device.discovery.setInterfaceCdpEnabled(iface.interfaceId, iface.cdpEnabled);
    device.discovery.setInterfaceLldpTransmit(iface.interfaceId, iface.lldpTransmit);
    device.discovery.setInterfaceLldpReceive(iface.interfaceId, iface.lldpReceive);
  }
  if (config.cdpEnabled) device.discovery.setCdpEnabled(true);
  if (config.lldpEnabled) device.discovery.setLldpEnabled(true);
}

export function applyLoopbackConfiguration(
  device: Router | Layer3Switch,
  loopbacks: readonly LoopbackInterfaceConfig[],
): void {
  for (const loopback of loopbacks) {
    const iface = device.getOrCreateLoopback(loopback.id);
    const physical = iface.physical;
    if (loopback.description !== undefined) physical.setDescription(loopback.description);
    if (loopback.shutdown) physical.shutdown();
    else physical.noShutdown();
    if (loopback.ipv4) {
      device.setInterfaceIp(loopbackName(loopback.id), loopback.ipv4.address, loopback.ipv4.prefixLength);
    }
    for (const address of loopback.ipv6 ?? []) {
      device.setInterfaceIpv6(loopbackName(loopback.id), address.address, address.prefixLength);
    }
  }
}

/**
 * Site-to-site VPN configuration. Proposals, peers and profiles are applied
 * before the tunnels that reference them, so a `tunnel protection ipsec profile`
 * binding always resolves. Nothing runtime is rebuilt: negotiation starts from
 * scratch, exactly as it does in the verifier.
 */
export function applyVpnConfiguration(device: Router, configuration: VpnConfiguration | undefined): void {
  if (!configuration || isDefaultVpnConfiguration(configuration)) return;
  for (const proposal of configuration.proposals) {
    device.defineIpsecProposal({
      id: proposal.id,
      encryption: proposal.encryption,
      integrity: proposal.integrity,
    });
  }
  for (const peer of configuration.ikePeers) {
    device.defineIkePeer({
      id: peer.id,
      remoteAddress: peer.address,
      localIdentity: peer.localIdentity,
      remoteIdentity: peer.remoteIdentity,
      preSharedKeyVerifier: peer.preSharedKeyVerifier,
      proposalId: peer.proposalId,
      lifetimeNs: peer.lifetimeSeconds * NS_PER_S,
      credentialResetRequired: peer.credentialResetRequired,
    });
  }
  for (const profile of configuration.ipsecProfiles) {
    device.defineIpsecProfile({
      id: profile.id,
      ikePeerId: profile.ikePeerId,
      proposalId: profile.proposalId,
      lifetimeNs: profile.lifetimeSeconds * NS_PER_S,
    });
  }
  for (const tunnel of configuration.tunnels) {
    device.configureTunnel(tunnel.id, {
      source: tunnel.source.type === "interface"
        ? { type: "interface", interfaceId: tunnel.source.interfaceId }
        : { type: "address", address: tunnel.source.address },
      destinationAddress: tunnel.destinationAddress,
      mode: tunnel.mode,
      ipv4Addresses: tunnel.ipv4
        ? [{ address: tunnel.ipv4.address, prefixLength: tunnel.ipv4.prefixLength }]
        : [],
      ipv6Addresses: (tunnel.ipv6 ?? []).map((address) => ({
        address: address.address,
        prefixLength: address.prefixLength,
      })),
      mtu: tunnel.mtu,
      ttl: tunnel.ttl,
      adminUp: !tunnel.shutdown,
      ipsecProfileId: tunnel.ipsecProfileId,
    });
    if (tunnel.description !== undefined) {
      device.getOrCreateTunnel(tunnel.id).physical.setDescription(tunnel.description);
    }
  }
}

export function serializeVpnConfiguration(device: Router): VpnConfiguration | undefined {
  const summaries = new Map(device.tunnelSummaries().map((row) => [row.name, row]));
  const configuration: VpnConfiguration = {
    tunnels: device.tunnelConfigurations().map((tunnel) => {
      const id = parseTunnelName(tunnel.id) ?? 0;
      const summary = summaries.get(tunnel.id);
      const primary = tunnel.ipv4Addresses[0];
      return {
        id,
        description: device.getOrCreateTunnel(id).physical.description,
        shutdown: summary ? !summary.adminUp : !tunnel.adminUp,
        source: tunnel.source.type === "interface"
          ? { type: "interface" as const, interfaceId: tunnel.source.interfaceId }
          : { type: "address" as const, address: tunnel.source.address },
        destinationAddress: tunnel.destinationAddress,
        mode: tunnel.mode,
        ipv4: primary ? { address: primary.address, prefixLength: primary.prefixLength } : undefined,
        ipv6: tunnel.ipv6Addresses.length > 0
          ? tunnel.ipv6Addresses.map((address) => ({
              address: address.address,
              prefixLength: address.prefixLength,
            }))
          : undefined,
        mtu: tunnel.mtu,
        ttl: tunnel.ttl,
        ipsecProfileId: tunnel.ipsecProfileId,
      };
    }),
    proposals: device.ipsecProposalConfigurations().map((proposal) => ({ ...proposal })),
    ikePeers: device.ikePeerConfigurations().map((peer) => ({
      id: peer.id,
      address: peer.remoteAddress,
      localIdentity: peer.localIdentity,
      remoteIdentity: peer.remoteIdentity,
      preSharedKeyVerifier: peer.preSharedKeyVerifier,
      proposalId: peer.proposalId,
      lifetimeSeconds: toSeconds(peer.lifetimeNs),
      credentialResetRequired: peer.credentialResetRequired ?? false,
    })),
    ipsecProfiles: device.ipsecProfileConfigurations().map((profile) => ({
      id: profile.id,
      ikePeerId: profile.ikePeerId,
      proposalId: profile.proposalId,
      lifetimeSeconds: toSeconds(profile.lifetimeNs),
    })),
  };
  return isDefaultVpnConfiguration(configuration) ? undefined : configuration;
}

/**
 * VXLAN tunnel-endpoint configuration.
 *
 * The `evpn` blocks are applied before the NVE members that reference their
 * VNIs, so an `ingress-replication protocol bgp` member always finds its RD and
 * route targets. Nothing runtime crosses this boundary: the remote MAC table,
 * EVPN-learned membership and every counter are relearned from scratch, exactly
 * as they are in the verifier.
 */
export function applyVxlanConfiguration(
  device: Layer3Switch,
  nve: NveInterfaceConfig | undefined,
  evpn: EvpnConfig | undefined,
): void {
  for (const vni of evpn?.vnis ?? []) {
    device.defineEvpnVni({
      vni: vni.vni,
      routeDistinguisher: vni.routeDistinguisher,
      importRouteTargets: [...vni.importRouteTargets],
      exportRouteTargets: [...vni.exportRouteTargets],
    });
  }
  // Setting the fabric MAC re-stamps every SVI already marked as an anycast
  // gateway, so the two blocks may be applied in either order.
  if (evpn?.anycastGatewayMac !== undefined) {
    device.setFabricAnycastGatewayMac(evpn.anycastGatewayMac);
  }
  if (!nve) return;
  device.configureNve({
    id: nve.id,
    sourceInterfaceId: nve.sourceInterfaceId,
    adminUp: !nve.shutdown,
    members: nve.members.map((member) => ({
      vni: member.vni,
      vlanId: member.vlanId,
      replication: member.replication.type === "static"
        ? { type: "static", peerAddresses: [...member.replication.peerAddresses] }
        : { type: "bgp-evpn" },
    })),
    vrfMembers: nve.vrfMembers?.map((member) => ({ vni: member.vni, vrfId: member.vrfId })),
  });
}

/**
 * Ethernet Segments are applied *after* the NVE and the switchports exist: a
 * segment names an attachment and derives its VLANs from the VLAN-to-VNI map,
 * so neither can be missing when it is configured.
 */
export function applyEthernetSegmentConfiguration(
  device: Layer3Switch,
  evpn: EvpnConfig | undefined,
): void {
  for (const segment of evpn?.ethernetSegments ?? []) {
    device.configureEthernetSegment({
      id: segment.id,
      esi: segment.esi,
      redundancyMode: segment.redundancyMode,
      interfaces: [...segment.interfaces],
    });
  }
}

export function serializeNveConfiguration(device: Layer3Switch): NveInterfaceConfig | undefined {
  const nve = device.nveConfiguration();
  if (!nve) return undefined;
  return {
    id: "nve1",
    sourceInterfaceId: nve.sourceInterfaceId,
    shutdown: !nve.adminUp,
    members: nve.members.map((member) => ({
      vni: member.vni,
      vlanId: member.vlanId,
      replication: member.replication.type === "static"
        ? { type: "static" as const, peerAddresses: [...member.replication.peerAddresses] }
        : { type: "bgp-evpn" as const },
    })),
    vrfMembers: nve.vrfMembers === undefined || nve.vrfMembers.length === 0
      ? undefined
      : nve.vrfMembers.map((member) => ({ vni: member.vni, vrfId: member.vrfId })),
  };
}

/**
 * The tenant VRFs an L3 Switch VTEP carries.
 *
 * Only configuration crosses this boundary: imported EVPN Type 5 prefixes and
 * every routed-overlay counter are runtime, and the browser worker and the
 * verifier each rebuild them from these definitions alone.
 */
export function serializeVtepVrfConfiguration(device: Layer3Switch): VrfConfig[] | undefined {
  const vrfs = device.vrfConfigurations().map((vrf): VrfConfig => ({
    id: vrf.id,
    name: vrf.name,
    routeDistinguisher: vrf.routeDistinguisher,
    importRouteTargets: [...vrf.importRouteTargets],
    exportRouteTargets: [...vrf.exportRouteTargets],
    staticRoutes: device.vrfStaticRouteConfigurations(vrf.id).map((route) => ({
      network: route.network,
      prefixLength: route.prefixLength,
      nextHop: route.nextHop!,
    })),
    advertiseEvpn: vrf.advertiseEvpn === true ? true : undefined,
  }));
  return vrfs.length > 0 ? vrfs : undefined;
}

export function serializeEvpnConfiguration(device: Layer3Switch): EvpnConfig | undefined {
  const vnis = device.evpnVniConfigurations().map((entry) => ({
    vni: entry.vni,
    routeDistinguisher: entry.routeDistinguisher,
    importRouteTargets: [...entry.importRouteTargets],
    exportRouteTargets: [...entry.exportRouteTargets],
  }));
  const anycastGatewayMac = device.fabricConfiguration().anycastGatewayMac;
  const segments = device.ethernetSegmentConfigurations().map((segment) => ({
    id: segment.id,
    esi: segment.esi,
    redundancyMode: segment.redundancyMode,
    interfaces: [...segment.interfaces],
  }));
  if (vnis.length === 0 && anycastGatewayMac === undefined && segments.length === 0) return undefined;
  return {
    vnis,
    anycastGatewayMac,
    // A fabric with no multihoming keeps exactly its pre-M10.16 shape, so an
    // older lab round-trips without gaining an empty key.
    ...(segments.length === 0 ? {} : { ethernetSegments: segments }),
  };
}

export function applyOspfConfiguration(device: Router | Layer3Switch, config: OspfProcessConfig): void {
  device.ospf.createProcess(config.processId);
  if (config.routerId !== undefined) device.ospf.setRouterId(config.routerId);
  for (const statement of config.networks) {
    device.ospf.addNetwork(statement.network, statement.wildcard, statement.area);
  }
  for (const iface of config.interfaces) {
    device.ospf.configureInterface(iface.interfaceId, {
      area: iface.area,
      cost: iface.cost,
      priority: iface.priority,
      networkType: iface.networkType,
      helloIntervalNs: iface.helloIntervalSeconds === undefined ? undefined : seconds(iface.helloIntervalSeconds),
      deadIntervalNs: iface.deadIntervalSeconds === undefined ? undefined : seconds(iface.deadIntervalSeconds),
      enabled: iface.enabled,
    });
  }
  for (const passive of config.passiveInterfaces) device.ospf.setPassiveInterface(passive, true);
}

export function applyOspfv3Configuration(device: Router | Layer3Switch, config: Ospfv3ProcessConfig): void {
  device.ospfv3.createProcess(config.processId);
  if (config.routerId !== undefined) device.ospfv3.setRouterId(config.routerId);
  for (const iface of config.interfaces) {
    device.ospfv3.configureInterface(iface.interfaceId, {
      area: iface.area,
      cost: iface.cost,
      priority: iface.priority,
      networkType: iface.networkType,
      helloIntervalNs: iface.helloIntervalSeconds === undefined ? undefined : seconds(iface.helloIntervalSeconds),
      deadIntervalNs: iface.deadIntervalSeconds === undefined ? undefined : seconds(iface.deadIntervalSeconds),
      enabled: iface.enabled,
    });
  }
  for (const passive of config.passiveInterfaces) device.ospfv3.setPassiveInterface(passive, true);
}

export function applyBgpConfiguration(
  device: Router | Layer3Switch,
  bgp: BgpProcessConfig | undefined,
  prefixLists: readonly PrefixListConfig[] = [],
  routeMaps: readonly RouteMapConfig[] = [],
  communityLists: readonly CommunityListConfig[] = [],
  asPathLists: readonly AsPathListConfig[] = [],
  ipv6PrefixLists: readonly Ipv6PrefixListConfig[] = [],
): void {
  // Reusable lists come first: a route map may reference any of them, and the
  // engine denies a route that names a list it cannot resolve.
  device.bgp.routingPolicy.setPrefixLists(prefixLists);
  device.bgp.routingPolicy.setIpv6PrefixLists(ipv6PrefixLists);
  device.bgp.routingPolicy.setCommunityLists(communityLists as readonly CommunityList[]);
  device.bgp.routingPolicy.setAsPathLists(asPathLists as readonly AsPathList[]);
  device.bgp.routingPolicy.setRouteMaps(routeMaps);
  if (bgp) device.bgp.configure(bgp);
}

// --- serialize -------------------------------------------------------------

export function serializeSpanningTreeConfiguration(device: L2Switch): SpanningTreeConfig {
  const timers = device.spanningTree.currentTimers();
  return {
    mode: device.spanningTreeMode,
    helloTimeSeconds: toSeconds(timers.helloTimeNs),
    maxAgeSeconds: toSeconds(timers.maxAgeNs),
    forwardDelaySeconds: toSeconds(timers.forwardDelayNs),
    vlans: device.spanningTree.configuredVlanPriorities().map((entry) => ({
      vlanId: entry.vlanId,
      priority: entry.priority,
    })),
    ports: device.spanningTree.configuredPorts().map((entry) => ({
      interfaceId: entry.port,
      cost: entry.configuration.cost,
      priority: entry.configuration.priority ?? DEFAULT_STP_PORT_PRIORITY_VALUE,
      portFast: entry.configuration.portFast,
      bpduGuard: entry.configuration.bpduGuard,
    })),
  };
}

export function serializeEtherChannelConfiguration(device: L2Switch): EtherChannelConfig[] {
  return device.etherChannelConfigurations().map((channel): EtherChannelConfig => {
    const logical = portChannelName(channel.channelId);
    const switchport = device.rawPortConfigOf(logical);
    const configured = device.etherChannelSwitchportConfigured(logical);
    return {
      channelId: channel.channelId,
      mode: channel.mode,
      members: [...channel.members],
      minimumLinks: channel.minimumLinks,
      description: channel.description,
      switchport: configured
        ? {
            mode: switchport.mode,
            accessVlan: switchport.accessVlan,
            nativeVlan: switchport.nativeVlan,
            allowedVlans: switchport.allowedVlans ? [...switchport.allowedVlans].sort((a, b) => a - b) : undefined,
          }
        : undefined,
    };
  });
}

export function serializeDiscoveryConfiguration(
  device: { discovery: L2Switch["discovery"] },
): NeighborDiscoveryConfig {
  const configuration = device.discovery.configuration();
  return {
    cdpEnabled: configuration.cdpEnabled,
    lldpEnabled: configuration.lldpEnabled,
    cdpIntervalSeconds: toSeconds(configuration.cdpIntervalNs),
    cdpHoldTimeSeconds: toSeconds(configuration.cdpHoldTimeNs),
    lldpIntervalSeconds: toSeconds(configuration.lldpIntervalNs),
    lldpHoldTimeSeconds: toSeconds(configuration.lldpHoldTimeNs),
    interfaces: configuration.interfaces.map((iface) => ({
      interfaceId: iface.id,
      cdpEnabled: iface.configuration.cdpEnabled,
      lldpTransmit: iface.configuration.lldpTransmit,
      lldpReceive: iface.configuration.lldpReceive,
    })),
  };
}

export function serializeLoopbackConfiguration(device: Router | Layer3Switch): LoopbackInterfaceConfig[] {
  const summaries = new Map(device.loopbackSummaries().map((row) => [row.name, row]));
  const ipv6 = new Map(device.ipv6InterfaceSummaries().map((row) => [row.name, row.addresses]));
  return device.loopbackNumbers().map((id): LoopbackInterfaceConfig => {
    const row = summaries.get(loopbackName(id));
    const configuredIpv6 = ipv6.get(loopbackName(id))
      ?.filter((address) => address.source === "static")
      .map((address) => ({ address: address.address, prefixLength: address.prefixLength }));
    return {
      id,
      description: row?.description,
      shutdown: row ? !row.adminUp : false,
      ipv4: row?.ip === undefined ? undefined : { address: row.ip, prefixLength: prefixLength(row.maskInt) },
      ipv6: configuredIpv6 && configuredIpv6.length > 0 ? configuredIpv6 : undefined,
    };
  });
}

export function serializeOspfConfiguration(device: Router | Layer3Switch): OspfProcessConfig | undefined {
  if (!device.ospf.enabled) return undefined;
  const configuration = device.ospf.configuration();
  return {
    processId: configuration.processId,
    routerId: configuration.routerId,
    networks: configuration.networks.map((statement) => ({
      network: statement.network,
      wildcard: statement.wildcard,
      area: 0 as const,
    })),
    passiveInterfaces: [...configuration.passiveInterfaces],
    interfaces: configuration.interfaces.map((iface) => ({
      interfaceId: iface.id,
      area: iface.configuration.area === undefined ? undefined : (0 as const),
      cost: iface.configuration.cost,
      priority: iface.configuration.priority,
      networkType: iface.configuration.networkType,
      helloIntervalSeconds: iface.configuration.helloIntervalNs === undefined
        ? undefined
        : toSeconds(iface.configuration.helloIntervalNs),
      deadIntervalSeconds: iface.configuration.deadIntervalNs === undefined
        ? undefined
        : toSeconds(iface.configuration.deadIntervalNs),
      enabled: iface.configuration.enabled,
    })),
  };
}

export function serializeOspfv3Configuration(device: Router | Layer3Switch): Ospfv3ProcessConfig | undefined {
  if (!device.ospfv3.enabled) return undefined;
  const configuration = device.ospfv3.configuration();
  return {
    processId: configuration.processId,
    routerId: configuration.routerId,
    passiveInterfaces: [...configuration.passiveInterfaces],
    interfaces: configuration.interfaces.map((iface) => ({
      interfaceId: iface.id,
      area: iface.configuration.area === undefined ? undefined : (0 as const),
      cost: iface.configuration.cost,
      priority: iface.configuration.priority,
      networkType: iface.configuration.networkType,
      helloIntervalSeconds: iface.configuration.helloIntervalNs === undefined
        ? undefined
        : toSeconds(iface.configuration.helloIntervalNs),
      deadIntervalSeconds: iface.configuration.deadIntervalNs === undefined
        ? undefined
        : toSeconds(iface.configuration.deadIntervalNs),
      enabled: iface.configuration.enabled,
    })),
  };
}

export function serializeBgpConfiguration(device: Router | Layer3Switch): BgpProcessConfig | undefined {
  return device.bgp.configurationSnapshot() as BgpProcessConfig | undefined;
}

export function serializePrefixLists(device: Router | Layer3Switch): PrefixListConfig[] | undefined {
  const lists = device.bgp.routingPolicy.prefixListConfigurations() as PrefixListConfig[];
  return lists.length ? lists : undefined;
}

export function serializeIpv6PrefixLists(device: Router | Layer3Switch): Ipv6PrefixListConfig[] | undefined {
  const lists = device.bgp.routingPolicy.ipv6PrefixListConfigurations() as Ipv6PrefixListConfig[];
  return lists.length ? lists : undefined;
}

export function serializeRouteMaps(device: Router | Layer3Switch): RouteMapConfig[] | undefined {
  const maps = device.bgp.routingPolicy.routeMapConfigurations() as RouteMapConfig[];
  return maps.length ? maps : undefined;
}

export function serializeCommunityLists(device: Router | Layer3Switch): CommunityListConfig[] | undefined {
  const lists = device.bgp.routingPolicy.communityListConfigurations() as CommunityListConfig[];
  return lists.length ? lists : undefined;
}

export function serializeAsPathLists(device: Router | Layer3Switch): AsPathListConfig[] | undefined {
  const lists = device.bgp.routingPolicy.asPathListConfigurations() as AsPathListConfig[];
  return lists.length ? lists : undefined;
}

function prefixLength(maskInt: number): number {
  let value = maskInt >>> 0;
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}

import type {
  EtherChannelConfig,
  LoopbackInterfaceConfig,
  NeighborDiscoveryConfig,
  OspfProcessConfig,
  SpanningTreeConfig,
} from "@sim/contracts";
import {
  DEFAULT_STP_PORT_PRIORITY_VALUE,
} from "@sim/contracts";
import {
  type L2Switch,
  type Layer3Switch,
  loopbackName,
  NS_PER_S,
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
  }
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
  return device.loopbackNumbers().map((id): LoopbackInterfaceConfig => {
    const row = summaries.get(loopbackName(id));
    return {
      id,
      description: row?.description,
      shutdown: row ? !row.adminUp : false,
      ipv4: row?.ip === undefined ? undefined : { address: row.ip, prefixLength: prefixLength(row.maskInt) },
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

function prefixLength(maskInt: number): number {
  let value = maskInt >>> 0;
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}

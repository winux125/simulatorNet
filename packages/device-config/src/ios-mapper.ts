/**
 * Turn parsed IOS/VPCS config into a structured DeviceConfig for the mapped
 * device. Only settings that cannot fail SimulatorNet's semantic validation are
 * applied (hostname, interface addressing, VLANs, switchports, and static routes
 * whose next hop is directly connected). Anything else is left for the caller to
 * preserve as an unparsed artifact, so an import can never produce a lab that
 * refuses to open.
 */
import type {
  DeviceConfig,
  DeviceType,
  EtherChannelConfig,
  LoopbackInterfaceConfig,
  NeighborDiscoveryConfig,
  OspfProcessConfig,
  Ospfv3ProcessConfig,
  BgpProcessConfig,
  QosConfiguration,
  SpanningTreeConfig,
  VpnConfiguration,
} from "@sim/contracts";
import {
  DEFAULT_BRIDGE_AGING_TIME_NS,
  isDefaultQosConfiguration,
  isDefaultVpnConfiguration,
  DEFAULT_TUNNEL_MTU_VALUE,
  DEFAULT_TUNNEL_TTL_VALUE,
  DEFAULT_VPN_LIFETIME_SECONDS,
  DEFAULT_CDP_HOLD_SECONDS,
  DEFAULT_CDP_INTERVAL_SECONDS,
  DEFAULT_LLDP_HOLD_SECONDS,
  DEFAULT_LLDP_INTERVAL_SECONDS,
  DEFAULT_STP_FORWARD_DELAY_SECONDS,
  DEFAULT_STP_HELLO_SECONDS,
  DEFAULT_STP_MAX_AGE_SECONDS,
  DEFAULT_STP_PORT_PRIORITY_VALUE,
} from "@sim/contracts";
import type { ImportedDeviceConfiguration } from "./ios-parser";

/** Discovery defaults for a device whose config never mentioned CDP or LLDP. */
function discoveryFrom(applied: ImportedDeviceConfiguration): NeighborDiscoveryConfig {
  const interfaces = applied.interfaces
    .filter((iface) => iface.cdpEnabled !== undefined
      || iface.lldpTransmit !== undefined
      || iface.lldpReceive !== undefined)
    .map((iface) => ({
      interfaceId: iface.id,
      cdpEnabled: iface.cdpEnabled ?? true,
      lldpTransmit: iface.lldpTransmit ?? true,
      lldpReceive: iface.lldpReceive ?? true,
    }))
    .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId));
  return {
    cdpEnabled: applied.cdpEnabled ?? false,
    lldpEnabled: applied.lldpEnabled ?? false,
    cdpIntervalSeconds: DEFAULT_CDP_INTERVAL_SECONDS,
    cdpHoldTimeSeconds: DEFAULT_CDP_HOLD_SECONDS,
    lldpIntervalSeconds: DEFAULT_LLDP_INTERVAL_SECONDS,
    lldpHoldTimeSeconds: DEFAULT_LLDP_HOLD_SECONDS,
    interfaces,
  };
}

function spanningTreeFrom(
  applied: ImportedDeviceConfiguration,
  knownVlans: ReadonlySet<number>,
): SpanningTreeConfig {
  const ports = applied.interfaces
    .filter((iface) => iface.portFast !== undefined
      || iface.bpduGuard !== undefined
      || iface.spanningTreeCost !== undefined
      || iface.spanningTreePriority !== undefined)
    .map((iface) => ({
      interfaceId: iface.id,
      cost: iface.spanningTreeCost,
      priority: iface.spanningTreePriority ?? DEFAULT_STP_PORT_PRIORITY_VALUE,
      portFast: iface.portFast ?? false,
      // BPDU Guard only protects an edge port, so it needs PortFast alongside.
      bpduGuard: (iface.bpduGuard ?? false) && (iface.portFast ?? false),
    }))
    .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId));
  return {
    mode: applied.spanningTreeMode ?? "disabled",
    helloTimeSeconds: DEFAULT_STP_HELLO_SECONDS,
    maxAgeSeconds: DEFAULT_STP_MAX_AGE_SECONDS,
    forwardDelaySeconds: DEFAULT_STP_FORWARD_DELAY_SECONDS,
    vlans: applied.spanningTreeVlanPriorities
      .filter((entry) => knownVlans.has(entry.vlanId))
      .sort((a, b) => a.vlanId - b.vlanId),
    ports,
  };
}

function etherChannelsFrom(applied: ImportedDeviceConfiguration): EtherChannelConfig[] {
  const groups = new Map<number, EtherChannelConfig>();
  for (const iface of applied.interfaces) {
    const group = iface.channelGroup;
    if (!group) continue;
    const existing = groups.get(group.id);
    if (existing) {
      // A group can only negotiate one way; a conflicting mode is ignored.
      if (existing.mode !== group.mode) continue;
      groups.set(group.id, { ...existing, members: [...existing.members, iface.id].sort() });
      continue;
    }
    groups.set(group.id, { channelId: group.id, mode: group.mode, members: [iface.id] });
  }
  return [...groups.values()].sort((a, b) => a.channelId - b.channelId);
}

function loopbacksFrom(applied: ImportedDeviceConfiguration): LoopbackInterfaceConfig[] {
  return applied.loopbacks.map((loopback) => ({
    id: loopback.id,
    description: loopback.description,
    shutdown: loopback.shutdown,
    ipv4: loopback.ipv4,
    ipv6: loopback.ipv6,
  }));
}

/**
 * Map the recognised site-to-site VPN subset onto a device configuration.
 *
 * A vendor pre-shared key is never decrypted and never carried over, so an
 * imported peer has no `preSharedKeyVerifier` and is flagged
 * `credentialResetRequired`. A tunnel whose source interface does not exist on
 * the mapped device, or whose destination is missing, is dropped rather than
 * invented — the source lines stay in the import report.
 */
function vpnFrom(
  applied: ImportedDeviceConfiguration,
  interfaceNames: readonly string[],
): VpnConfiguration | undefined {
  const interfaceIds = new Set(interfaceNames);
  const proposals = applied.vpn.proposals.map((proposal) => ({
    id: proposal.id,
    encryption: proposal.encryption ?? "sim-aes256" as const,
    integrity: "sim-sha256" as const,
  }));
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));
  const ikePeers = applied.vpn.ikePeers
    .filter((peer) => peer.address !== undefined)
    .map((peer) => ({
      id: peer.id,
      address: peer.address!,
      localIdentity: peer.localIdentity,
      remoteIdentity: peer.remoteIdentity,
      // Never imported: the learner must set a key before the tunnel protects.
      preSharedKeyVerifier: undefined,
      proposalId: peer.proposalId !== undefined && proposalIds.has(peer.proposalId)
        ? peer.proposalId
        : proposals[0]?.id ?? "",
      lifetimeSeconds: peer.lifetimeSeconds ?? DEFAULT_VPN_LIFETIME_SECONDS,
      credentialResetRequired: peer.credentialResetRequired,
    }))
    .filter((peer) => peer.proposalId !== "");
  const peerIds = new Set(ikePeers.map((peer) => peer.id));
  const ipsecProfiles = applied.vpn.ipsecProfiles
    .filter((profile) => profile.ikePeerId !== undefined && peerIds.has(profile.ikePeerId))
    .map((profile) => ({
      id: profile.id,
      ikePeerId: profile.ikePeerId!,
      proposalId: profile.proposalId !== undefined && proposalIds.has(profile.proposalId)
        ? profile.proposalId
        : proposals[0]?.id ?? "",
      lifetimeSeconds: profile.lifetimeSeconds ?? DEFAULT_VPN_LIFETIME_SECONDS,
    }))
    .filter((profile) => profile.proposalId !== "");
  const profileIds = new Set(ipsecProfiles.map((profile) => profile.id));
  const tunnels = applied.vpn.tunnels
    .filter((tunnel) => tunnel.destinationAddress !== undefined)
    .filter((tunnel) => tunnel.sourceAddress !== undefined
      || (tunnel.sourceInterface !== undefined && interfaceIds.has(tunnel.sourceInterface)))
    .map((tunnel) => ({
      id: tunnel.id,
      description: tunnel.description,
      shutdown: tunnel.shutdown,
      source: tunnel.sourceInterface !== undefined && interfaceIds.has(tunnel.sourceInterface)
        ? { type: "interface" as const, interfaceId: tunnel.sourceInterface }
        : { type: "address" as const, address: tunnel.sourceAddress! },
      destinationAddress: tunnel.destinationAddress!,
      mode: "gre-ipv4" as const,
      ipv4: tunnel.ipv4,
      ipv6: tunnel.ipv6,
      mtu: tunnel.mtu ?? DEFAULT_TUNNEL_MTU_VALUE,
      ttl: tunnel.ttl ?? DEFAULT_TUNNEL_TTL_VALUE,
      ipsecProfileId: tunnel.ipsecProfileId !== undefined && profileIds.has(tunnel.ipsecProfileId)
        ? tunnel.ipsecProfileId
        : undefined,
    }));
  const configuration: VpnConfiguration = { tunnels, proposals, ikePeers, ipsecProfiles };
  return isDefaultVpnConfiguration(configuration) ? undefined : configuration;
}

function ospfFrom(applied: ImportedDeviceConfiguration): OspfProcessConfig | undefined {
  if (!applied.ospf) return undefined;
  const interfaces = applied.interfaces
    .filter((iface) => iface.ospf !== undefined)
    .map((iface) => ({
      interfaceId: iface.id,
      area: iface.ospf?.enabled ? (0 as const) : undefined,
      cost: iface.ospf?.cost,
      priority: iface.ospf?.priority,
      networkType: iface.ospf?.networkType,
      helloIntervalSeconds: iface.ospf?.helloIntervalSeconds,
      deadIntervalSeconds: iface.ospf?.deadIntervalSeconds,
      enabled: iface.ospf?.enabled,
    }))
    .sort((a, b) => a.interfaceId.localeCompare(b.interfaceId));
  return {
    processId: applied.ospf.processId,
    routerId: applied.ospf.routerId,
    networks: applied.ospf.networks.map((statement) => ({
      network: statement.network,
      wildcard: statement.wildcard,
      area: 0 as const,
    })),
    passiveInterfaces: [...applied.ospf.passiveInterfaces].sort(),
    interfaces,
  };
}

function ospfv3From(applied: ImportedDeviceConfiguration): Ospfv3ProcessConfig | undefined {
  if (!applied.ospfv3) return undefined;
  return {
    processId: applied.ospfv3.processId,
    routerId: applied.ospfv3.routerId,
    passiveInterfaces: [...applied.ospfv3.passiveInterfaces].sort(),
    interfaces: applied.interfaces
      .filter((iface) => iface.ospfv3 !== undefined)
      .map((iface) => ({
        interfaceId: iface.id,
        area: iface.ospfv3?.enabled ? (0 as const) : undefined,
        cost: iface.ospfv3?.cost,
        enabled: iface.ospfv3?.enabled,
      }))
      .sort((left, right) => left.interfaceId.localeCompare(right.interfaceId)),
  };
}

function bgpFrom(applied: ImportedDeviceConfiguration): BgpProcessConfig | undefined {
  if (!applied.bgp) return undefined;
  return {
    ...applied.bgp,
    neighbors: [...applied.bgp.neighbors].sort((left, right) => left.address.localeCompare(right.address)),
    networks: [...applied.bgp.networks].sort((left, right) => left.network.localeCompare(right.network) || left.prefixLength - right.prefixLength),
  };
}

function ipv6BindingsFrom(applied: ImportedDeviceConfiguration) {
  return applied.interfaces.flatMap((iface) =>
    (iface.ipv6TrafficFilters ?? []).map((binding) => ({
      interfaceName: iface.id,
      direction: binding.direction,
      aclId: binding.aclId,
    })));
}

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
const maskToInt = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
const inSubnet = (ip: string, networkIp: string, prefix: number): boolean =>
  ((ipToInt(ip) & maskToInt(prefix)) >>> 0) === ((ipToInt(networkIp) & maskToInt(prefix)) >>> 0);
const isNetworkAddress = (network: string, prefix: number): boolean =>
  ((ipToInt(network) & maskToInt(prefix)) >>> 0) === ipToInt(network);

export interface BuiltConfig {
  readonly config?: DeviceConfig;
  /** Static routes recognised but not applied (unreachable next hop). */
  readonly droppedRoutes: number;
}

/**
 * The imported MQC subset, kept only when it is internally consistent: a
 * service policy that names a policy map the file never defined, or a policy
 * class that names a missing class map, is dropped rather than imported broken.
 */
function qosFrom(
  applied: ImportedDeviceConfiguration,
  interfaceIds: readonly string[],
): QosConfiguration | undefined {
  const classMapIds = new Set(applied.qos.classMaps.map((map) => map.id));
  const policyMaps = applied.qos.policyMaps.map((map) => ({
    id: map.id,
    classes: map.classes.filter((entry) =>
      entry.className === "class-default" || classMapIds.has(entry.className)),
  }));
  const policyMapIds = new Set(policyMaps.map((map) => map.id));
  const configuration: QosConfiguration = {
    classMaps: applied.qos.classMaps,
    policyMaps,
    servicePolicies: applied.qos.servicePolicies.filter((binding) =>
      policyMapIds.has(binding.policyMapId) && interfaceIds.includes(binding.interfaceName)),
  };
  return isDefaultQosConfiguration(configuration) ? undefined : configuration;
}

export function buildDeviceConfigFromIos(
  deviceType: DeviceType,
  applied: ImportedDeviceConfiguration,
  interfaceIds: readonly string[],
  fallbackHostname: string,
): BuiltConfig {
  const hostname = applied.hostname ?? fallbackHostname;
  const byId = new Map(applied.interfaces.map((iface) => [iface.id, iface]));
  const connected = interfaceIds
    .map((id) => byId.get(id)?.ipv4)
    .filter((ipv4): ipv4 is NonNullable<typeof ipv4> => ipv4 !== undefined);
  const safeRoutes = applied.staticRoutes.filter((route) =>
    isNetworkAddress(route.network, route.prefixLength)
    && connected.some((iface) => inSubnet(route.nextHop, iface.address, iface.prefixLength)));
  const droppedRoutes = applied.staticRoutes.length - safeRoutes.length;

  if (deviceType === "pc") {
    const primary = interfaceIds.map((id) => byId.get(id)).find((iface) => iface?.ipv4);
    const gateway = applied.staticRoutes.find((route) => route.network === "0.0.0.0" && route.prefixLength === 0)?.nextHop;
    return {
      droppedRoutes: 0,
      config: {
        kind: "pc",
        hostname,
        interfaces: interfaceIds.map((id) => ({ id, shutdown: byId.get(id)?.shutdown ?? false, description: byId.get(id)?.description })),
        ipv4: primary?.ipv4
          ? {
              address: primary.ipv4.address,
              prefixLength: primary.ipv4.prefixLength,
              defaultGateway: gateway && inSubnet(gateway, primary.ipv4.address, primary.ipv4.prefixLength) ? gateway : undefined,
            }
          : undefined,
        ipv6: primary?.ipv6?.[0]
          ? {
              mode: "static",
              address: primary.ipv6[0].address,
              prefixLength: primary.ipv6[0].prefixLength,
            }
          : undefined,
        dhcpEnabled: false,
      },
    };
  }

  if (deviceType === "server") {
    const primary = interfaceIds.map((id) => byId.get(id)).find((iface) => iface?.ipv4);
    const gateway = applied.staticRoutes.find((route) => route.network === "0.0.0.0" && route.prefixLength === 0)?.nextHop;
    return {
      droppedRoutes: 0,
      config: {
        kind: "server",
        hostname,
        interfaces: interfaceIds.map((id) => {
          const iface = byId.get(id);
          const isPrimary = iface === primary && iface?.ipv4 !== undefined;
          return { id, shutdown: iface?.shutdown ?? false, description: iface?.description, ipv4: isPrimary && iface?.ipv4 ? { address: iface.ipv4.address, prefixLength: iface.ipv4.prefixLength } : undefined };
        }),
        defaultGateway: gateway && primary?.ipv4 && inSubnet(gateway, primary.ipv4.address, primary.ipv4.prefixLength) ? gateway : undefined,
        ipv6: primary?.ipv6?.[0]
          ? {
              mode: "static",
              address: primary.ipv6[0].address,
              prefixLength: primary.ipv6[0].prefixLength,
            }
          : undefined,
        dhcpClientEnabled: false,
        enabledServices: [],
        // A server is a vendor-neutral station: never CDP, LLDP only.
        discovery: { ...discoveryFrom(applied), cdpEnabled: false },
      },
    };
  }

  if (deviceType === "router" || deviceType === "firewall") {
    const routed = {
      hostname,
      interfaces: interfaceIds.map((id) => {
        const iface = byId.get(id);
        return {
          id,
          shutdown: iface?.shutdown ?? false,
          description: iface?.description,
          routed: iface?.ipv4 !== undefined || (iface?.ipv6?.length ?? 0) > 0,
          ipv4: iface?.ipv4,
          ipv6: iface?.ipv6,
          ...(deviceType === "router" ? { mplsEnabled: iface?.mplsEnabled, vrfId: iface?.vrfId } : {}),
        };
      }),
      subinterfaces: [],
      staticRoutes: safeRoutes.map((route) => ({ network: route.network, prefixLength: route.prefixLength, nextHop: route.nextHop })),
      dhcpPools: [],
      acls: [],
      aclBindings: [],
      ipv6UnicastRoutingEnabled: applied.ipv6UnicastRoutingEnabled,
      ipv6StaticRoutes: applied.ipv6StaticRoutes,
      ipv6Acls: applied.ipv6Acls,
      ipv6AclBindings: ipv6BindingsFrom(applied),
      qos: qosFrom(applied, interfaceIds),
      vpn: vpnFrom(applied, interfaceIds),
      natPools: [],
      natRules: [],
      natInterfaceRoles: [],
      discovery: discoveryFrom(applied),
      loopbacks: loopbacksFrom(applied),
      prefixLists: applied.prefixLists,
      routeMaps: applied.routeMaps,
    };
    if (deviceType === "firewall") {
      // A firewall is not an OSPF speaker in this release; the process lines
      // stay in the unparsed report rather than being silently applied.
      return {
        droppedRoutes,
        config: { kind: "firewall", ...routed, ospf: undefined, zones: [], firewallPolicies: [], defaultPolicy: "deny" },
      };
    }
    return {
      droppedRoutes,
      config: {
        kind: "router",
        ...routed,
        ospf: ospfFrom(applied),
        ospfv3: ospfv3From(applied),
        bgp: bgpFrom(applied),
        ldp: applied.ldp,
        vrfs: applied.vrfs,
      },
    };
  }

  if (deviceType === "l3-switch") {
    const vlans = applied.vlans;
    const knownVlans = new Set<number>([1, ...vlans.map((vlan) => vlan.id)]);
    for (const iface of applied.interfaces) {
      if (iface.accessVlan !== undefined) knownVlans.add(iface.accessVlan);
    }
    return {
      droppedRoutes,
      config: {
        kind: "l3-switch",
        hostname,
        vlans: [...knownVlans].sort((left, right) => left - right).map((id) => ({
          id,
          name: vlans.find((vlan) => vlan.id === id)?.name ?? (id === 1 ? "default" : `VLAN${String(id).padStart(4, "0")}`),
        })),
        interfaces: interfaceIds.map((id) => {
          const iface = byId.get(id);
          if (iface && (iface.ipv4 !== undefined || (iface.ipv6?.length ?? 0) > 0)) {
            return {
              id,
              shutdown: iface.shutdown,
              description: iface.description,
              mode: "routed" as const,
              ipv4: iface.ipv4,
              ipv6: iface.ipv6,
            };
          }
          return {
            id,
            shutdown: iface?.shutdown ?? false,
            description: iface?.description,
            mode: iface?.switchportMode ?? "access",
            accessVlan: iface?.accessVlan ?? 1,
            nativeVlan: 1,
          };
        }),
        svis: [],
        staticRoutes: safeRoutes,
        ipRoutingEnabled: safeRoutes.length > 0 || connected.length > 0,
        ipv6UnicastRoutingEnabled: applied.ipv6UnicastRoutingEnabled,
        ipv6StaticRoutes: applied.ipv6StaticRoutes,
        ipv6Acls: applied.ipv6Acls,
        ipv6AclBindings: ipv6BindingsFrom(applied),
        qos: qosFrom(applied, interfaceIds),
        spanningTree: spanningTreeFrom(applied, knownVlans),
        etherChannels: etherChannelsFrom(applied),
        discovery: discoveryFrom(applied),
        loopbacks: loopbacksFrom(applied),
        ospf: ospfFrom(applied),
        ospfv3: ospfv3From(applied),
        bgp: bgpFrom(applied),
        prefixLists: applied.prefixLists,
        routeMaps: applied.routeMaps,
        acls: [],
        aclBindings: [],
      },
    };
  }

  if (deviceType === "bridge") {
    return {
      droppedRoutes: 0,
      config: {
        kind: "bridge",
        hostname,
        interfaces: interfaceIds.map((id) => ({
          id,
          shutdown: byId.get(id)?.shutdown ?? false,
          description: byId.get(id)?.description,
        })),
        agingTimeNs: (applied.bridgeAgingTimeSeconds ?? DEFAULT_BRIDGE_AGING_TIME_NS / 1_000_000_000) * 1_000_000_000,
      },
    };
  }

  if (deviceType === "l2-switch") {
    const vlans = applied.vlans.length > 0 ? applied.vlans : [];
    const knownVlans = new Set<number>([1, ...vlans.map((vlan) => vlan.id)]);
    for (const iface of applied.interfaces) {
      if (iface.accessVlan !== undefined) knownVlans.add(iface.accessVlan);
    }
    const channels = etherChannelsFrom(applied)
      // Members must exist on the mapped device, or the lab would not open.
      .map((channel) => ({ ...channel, members: channel.members.filter((member) => interfaceIds.includes(member)) }))
      .filter((channel) => channel.members.length > 0);
    return {
      droppedRoutes: 0,
      config: {
        kind: "l2-switch",
        hostname,
        vlans: [...knownVlans].sort((a, b) => a - b).map((id) => ({
          id,
          name: vlans.find((vlan) => vlan.id === id)?.name ?? (id === 1 ? "default" : `VLAN${String(id).padStart(4, "0")}`),
        })),
        interfaces: interfaceIds.map((id) => {
          const iface = byId.get(id);
          return { id, shutdown: iface?.shutdown ?? false, description: iface?.description, mode: iface?.switchportMode ?? "access", accessVlan: iface?.accessVlan ?? 1, nativeVlan: 1 };
        }),
        spanningTree: spanningTreeFrom(applied, knownVlans),
        etherChannels: channels,
        discovery: discoveryFrom(applied),
      },
    };
  }

  return { droppedRoutes: 0, config: undefined };
}

export interface VpcsConfig {
  readonly address?: string;
  readonly prefixLength?: number;
  readonly gateway?: string;
}

/** Parse a VPCS `ip <addr>[/prefix|mask] [gateway]` line. */
export function parseVpcsConfig(text: string): VpcsConfig {
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const tokens = raw.trim().split(/\s+/u);
    if (tokens[0]?.toLowerCase() !== "ip" || !tokens[1]) continue;
    let address = tokens[1];
    let prefixLength = 24;
    if (address.includes("/")) {
      const [addr, prefix] = address.split("/");
      address = addr!;
      prefixLength = Number(prefix);
    } else if (tokens[2] && tokens[2].includes(".")) {
      prefixLength = maskToPrefixLocal(tokens[2]) ?? 24;
    }
    const gateway = tokens.find((token, index) => index >= 2 && /^\d+\.\d+\.\d+\.\d+$/u.test(token) && token !== address);
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(address)) return { address, prefixLength, gateway };
  }
  return {};
}

function maskToPrefixLocal(mask: string): number | undefined {
  const octets = mask.split(".");
  if (octets.length !== 4) return undefined;
  let bits = 0;
  for (const octet of octets) {
    const value = Number(octet);
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
    for (let bit = 7; bit >= 0; bit--) bits += (value >> bit) & 1;
  }
  return bits;
}

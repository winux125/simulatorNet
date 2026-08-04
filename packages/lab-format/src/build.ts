import {
  asDeviceId,
  DEFAULT_NEIGHBOR_DISCOVERY_CONFIG,
  DEFAULT_SPANNING_TREE_CONFIG,
  type DeviceConfig,
  type DeviceId,
  type DeviceStartupConfiguration,
  type LabDocument,
  type LabMetadata,
  type LabStartupConfigurations,
  type Ipv4AclConfig,
  type Ipv6AclConfig,
  type Ipv6InterfaceAddress,
  type HostIpv6Config,
  type NodeSpec,
  type PhysicalInterfaceConfig,
  type AaaConfiguration,
  type Layer3SwitchDeviceConfig,
  type RemoteAccessConfiguration,
  type SnmpAgentConfiguration,
  type SwitchDeviceConfig,
  type Topology,
  resolveDeviceInterfaceTemplates,
  isDefaultQosConfiguration,
  type QosConfiguration,
  type WirelessRadioSettings,
} from "@sim/contracts";
import {
  createSimulationEngine,
  ExternalAppliance,
  Firewall,
  isDefaultAaaConfiguration,
  isDefaultRemoteAccess,
  isDefaultSnmpAgentConfiguration,
  EthernetBridge,
  Hub,
  IspCloud,
  Layer3Switch,
  type Device,
  L2Switch,
  type Mac,
  Pc,
  Router,
  Server,
  TrafficGenerator,
  AccessPoint,
  Laptop,
  Smartphone,
  WirelessRouter,
  WirelessEndHost,
  EndHost,
  type SimulationEngine,
  NS_PER_S,
} from "@sim/sim-core";
import { ManagementPlane } from "@sim/remote-management";
import { canonicalizeLabDocument } from "./canonical";
import { LabSemanticError } from "./errors";
import {
  applyDiscoveryConfiguration,
  applyEtherChannelConfiguration,
  applyLoopbackConfiguration,
  applyOspfConfiguration,
  applyOspfv3Configuration,
  applyBgpConfiguration,
  applySpanningTreeConfiguration,
  applyVpnConfiguration,
  serializeDiscoveryConfiguration,
  serializeEtherChannelConfiguration,
  serializeLoopbackConfiguration,
  serializeOspfConfiguration,
  serializeOspfv3Configuration,
  serializeBgpConfiguration,
  serializePrefixLists,
  serializeIpv6PrefixLists,
  serializeRouteMaps,
  serializeCommunityLists,
  serializeAsPathLists,
  serializeSpanningTreeConfiguration,
  serializeVpnConfiguration,
} from "./protocol-config";

export interface BuiltLab {
  readonly engine: SimulationEngine;
  readonly devices: ReadonlyMap<DeviceId, Device>;
  readonly topology: Topology;
  readonly seed: number;
  /** The topology node behind a device, for its canonical interfaces and MACs. */
  getNode(id: DeviceId | string): NodeSpec | undefined;
  /**
   * The device's saved startup configuration, or `undefined` when it has none
   * stored — the *implicit* state, in which startup equals running.
   */
  startupConfigurationOf(id: DeviceId | string): DeviceStartupConfiguration | undefined;
  /**
   * Replace one device's startup snapshot. This is configuration, never
   * runtime: `copy running-config startup-config` and `erase startup-config`
   * are the only things that call it.
   */
  setStartupConfiguration(id: DeviceId | string, entry: DeviceStartupConfiguration | undefined): void;
  /** Every stored startup snapshot, or `undefined` when none exists. */
  startupConfigurations(): LabStartupConfigurations | undefined;
  /**
   * Swap in a freshly built instance for one device id. Used only by a
   * single-device reload, which rebuilds that device and nothing else; the map
   * is shared with the management plane, so both see the new instance.
   */
  replaceDevice(id: DeviceId | string, device: Device): void;
  /**
   * Telnet/SSH listeners, VTY lines and remote sessions for this lab. Built
   * identically in the browser worker and the verifier so a management result
   * is deterministic in both trust domains.
   */
  readonly management: ManagementPlane;
  getDevice(id: DeviceId | string): Device | undefined;
  getPc(id: DeviceId | string): Pc | undefined;
  getServer(id: DeviceId | string): Server | undefined;
  getHub(id: DeviceId | string): Hub | undefined;
  getBridge(id: DeviceId | string): EthernetBridge | undefined;
  getSwitch(id: DeviceId | string): L2Switch | undefined;
  getLayer3Switch(id: DeviceId | string): Layer3Switch | undefined;
  getRouter(id: DeviceId | string): Router | undefined;
  getFirewall(id: DeviceId | string): Firewall | undefined;
  getCloud(id: DeviceId | string): IspCloud | undefined;
  getTrafficGenerator(id: DeviceId | string): TrafficGenerator | undefined;
  getExternalAppliance(id: DeviceId | string): ExternalAppliance | undefined;
  getAccessPoint(id: DeviceId | string): AccessPoint | undefined;
  getLaptop(id: DeviceId | string): Laptop | undefined;
  getSmartphone(id: DeviceId | string): Smartphone | undefined;
  getWirelessRouter(id: DeviceId | string): WirelessRouter | undefined;
}

class BuiltLabImpl implements BuiltLab {
  private readonly startup = new Map<DeviceId, DeviceStartupConfiguration>();

  constructor(
    readonly engine: SimulationEngine,
    readonly devices: ReadonlyMap<DeviceId, Device>,
    readonly topology: Topology,
    readonly seed: number,
    readonly management: ManagementPlane,
    startup: LabStartupConfigurations | undefined,
  ) {
    for (const node of topology.nodes) {
      const entry = startup?.[node.id];
      if (entry) this.startup.set(asDeviceId(node.id), entry);
    }
  }

  getDevice(id: DeviceId | string): Device | undefined {
    return this.devices.get(asDeviceId(id));
  }

  getNode(id: DeviceId | string): NodeSpec | undefined {
    return this.topology.nodes.find((node) => node.id === id);
  }

  startupConfigurationOf(id: DeviceId | string): DeviceStartupConfiguration | undefined {
    return this.startup.get(asDeviceId(id));
  }

  setStartupConfiguration(id: DeviceId | string, entry: DeviceStartupConfiguration | undefined): void {
    if (entry) this.startup.set(asDeviceId(id), entry);
    else this.startup.delete(asDeviceId(id));
  }

  replaceDevice(id: DeviceId | string, device: Device): void {
    (this.devices as Map<DeviceId, Device>).set(asDeviceId(id), device);
  }

  startupConfigurations(): LabStartupConfigurations | undefined {
    if (this.startup.size === 0) return undefined;
    const result: LabStartupConfigurations = {};
    // Node order, not insertion order, so the serialized record is canonical.
    for (const node of this.topology.nodes) {
      const entry = this.startup.get(asDeviceId(node.id));
      if (entry) result[node.id] = entry;
    }
    return result;
  }

  getPc(id: DeviceId | string): Pc | undefined {
    const device = this.getDevice(id);
    return device instanceof Pc ? device : undefined;
  }

  getServer(id: DeviceId | string): Server | undefined {
    const device = this.getDevice(id);
    return device instanceof Server ? device : undefined;
  }

  getHub(id: DeviceId | string): Hub | undefined {
    const device = this.getDevice(id);
    return device instanceof Hub ? device : undefined;
  }

  getBridge(id: DeviceId | string): EthernetBridge | undefined {
    const device = this.getDevice(id);
    return device instanceof EthernetBridge ? device : undefined;
  }

  getSwitch(id: DeviceId | string): L2Switch | undefined {
    const device = this.getDevice(id);
    return device instanceof L2Switch ? device : undefined;
  }

  getLayer3Switch(id: DeviceId | string): Layer3Switch | undefined {
    const device = this.getDevice(id);
    return device instanceof Layer3Switch ? device : undefined;
  }

  getRouter(id: DeviceId | string): Router | undefined {
    const device = this.getDevice(id);
    return device instanceof Router ? device : undefined;
  }

  getFirewall(id: DeviceId | string): Firewall | undefined {
    const device = this.getDevice(id);
    return device instanceof Firewall ? device : undefined;
  }

  getCloud(id: DeviceId | string): IspCloud | undefined {
    const device = this.getDevice(id);
    return device instanceof IspCloud ? device : undefined;
  }

  getTrafficGenerator(id: DeviceId | string): TrafficGenerator | undefined {
    const device = this.getDevice(id);
    return device instanceof TrafficGenerator ? device : undefined;
  }

  getExternalAppliance(id: DeviceId | string): ExternalAppliance | undefined {
    const device = this.getDevice(id);
    return device instanceof ExternalAppliance ? device : undefined;
  }

  getAccessPoint(id: DeviceId | string): AccessPoint | undefined {
    const device = this.getDevice(id);
    return device instanceof AccessPoint ? device : undefined;
  }

  getLaptop(id: DeviceId | string): Laptop | undefined {
    const device = this.getDevice(id);
    return device instanceof Laptop ? device : undefined;
  }

  getSmartphone(id: DeviceId | string): Smartphone | undefined {
    const device = this.getDevice(id);
    return device instanceof Smartphone ? device : undefined;
  }

  getWirelessRouter(id: DeviceId | string): WirelessRouter | undefined {
    const device = this.getDevice(id);
    return device instanceof WirelessRouter ? device : undefined;
  }
}

function createDevice(node: NodeSpec, config: DeviceConfig, engine: SimulationEngine): Device {
  const hostname = config.hostname ?? node.name ?? node.id;
  if (node.kind === "pc") return engine.add(new Pc(node.id, hostname));
  if (node.kind === "server") return engine.add(new Server(node.id, hostname));
  if (node.kind === "hub") return engine.add(new Hub(node.id, hostname));
  if (node.kind === "bridge") return engine.add(new EthernetBridge(node.id, hostname));
  if (node.kind === "l2-switch") return engine.add(new L2Switch(node.id, hostname));
  if (node.kind === "l3-switch") return engine.add(new Layer3Switch(node.id, hostname));
  if (node.kind === "firewall") return engine.add(new Firewall(node.id, hostname));
  if (node.kind === "cloud") return engine.add(new IspCloud(node.id, hostname));
  if (node.kind === "traffic-generator") return engine.add(new TrafficGenerator(node.id, hostname));
  if (node.kind === "external-appliance") return engine.add(new ExternalAppliance(node.id, hostname));
  if (node.kind === "access-point") return engine.add(new AccessPoint(node.id, hostname));
  if (node.kind === "laptop") return engine.add(new Laptop(node.id, hostname));
  if (node.kind === "smartphone") return engine.add(new Smartphone(node.id, hostname));
  if (node.kind === "wireless-router") return engine.add(new WirelessRouter(node.id, hostname));
  return engine.add(new Router(node.id, hostname));
}

function wirelessInterfaceConfiguration(node: NodeSpec, radio: WirelessRadioSettings) {
  const template = resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId).find(
    (entry) => entry.media === "wireless",
  );
  if (!template) {
    throw new LabSemanticError(
      "unknown-interface",
      `topology.nodes.${node.id}`,
      `Device '${node.id}' has no wireless interface template.`,
    );
  }
  const iface = node.interfaces.find((entry) => entry.id === template.id);
  if (!iface?.mac) {
    throw new LabSemanticError(
      "unknown-interface",
      `topology.nodes.${node.id}.interfaces.${template.id}`,
      `Wireless interface '${template.id}' has no canonical MAC address.`,
    );
  }
  return {
    id: template.id,
    name: template.id,
    macAddress: iface.mac,
    ...radio,
    supportedChannels: [...radio.supportedChannels],
  };
}

function applyPhysical(device: Device, config: PhysicalInterfaceConfig): void {
  const iface = device.getInterface(config.id);
  if (!iface) throw new LabSemanticError("unknown-interface", `configurations.${device.id}`, `Unknown interface '${config.id}'`);
  if (config.description !== undefined) iface.setDescription(config.description);
  if (config.shutdown) iface.shutdown();
  else iface.noShutdown();
}

function applyAclConfiguration(
  device: Pick<Router, "defineAcl" | "applyAcl"> | Pick<Layer3Switch, "defineAcl" | "applyAcl">,
  config: Pick<Layer3SwitchDeviceConfig, "acls" | "aclBindings">,
): void {
  for (const acl of config.acls) device.defineAcl(acl);
  for (const binding of config.aclBindings) {
    device.applyAcl(binding.interfaceName, binding.direction, binding.aclId);
  }
}

/**
 * QoS configuration is persistent: class maps, policy maps, marking, policers,
 * shapers and service-policy bindings. Queues, tokens, counters and drops are
 * runtime and never rebuilt from a document.
 */
function applyQosConfiguration(
  device: Pick<Router, "defineQosClassMap" | "defineQosPolicyMap" | "applyServicePolicy">,
  configuration: QosConfiguration | undefined,
): void {
  if (!configuration) return;
  for (const classMap of configuration.classMaps) device.defineQosClassMap(classMap);
  for (const policyMap of configuration.policyMaps) device.defineQosPolicyMap(policyMap);
  for (const binding of configuration.servicePolicies) {
    device.applyServicePolicy(binding.interfaceName, binding.direction, binding.policyMapId);
  }
}

function serializeQos(
  device: Pick<Router, "qosClassMapConfigurations" | "qosPolicyMapConfigurations" | "qosServicePolicies">,
): QosConfiguration | undefined {
  const configuration: QosConfiguration = {
    classMaps: device.qosClassMapConfigurations().map((map) => ({
      id: map.id,
      matchType: map.matchType,
      matches: map.matches.map((rule) =>
        "values" in rule ? { ...rule, values: [...rule.values] } : { ...rule }),
    })) as QosConfiguration["classMaps"],
    policyMaps: device.qosPolicyMapConfigurations().map((map) => ({
      id: map.id,
      classes: map.classes.map((entry) => ({
        ...entry,
        marking: entry.marking ? { ...entry.marking } : undefined,
        priority: entry.priority ? { ...entry.priority } : undefined,
        police: entry.police ? { ...entry.police } : undefined,
        shape: entry.shape ? { ...entry.shape } : undefined,
      })),
    })) as QosConfiguration["policyMaps"],
    servicePolicies: device.qosServicePolicies().map((binding) => ({ ...binding })),
  };
  return isDefaultQosConfiguration(configuration) ? undefined : configuration;
}

function applyIpv6AclConfiguration(
  device: Pick<Router, "defineIpv6Acl" | "applyIpv6Acl"> | Pick<Layer3Switch, "defineIpv6Acl" | "applyIpv6Acl">,
  config: Pick<Layer3SwitchDeviceConfig, "ipv6Acls" | "ipv6AclBindings">,
): void {
  for (const acl of config.ipv6Acls ?? []) device.defineIpv6Acl(acl);
  for (const binding of config.ipv6AclBindings ?? []) {
    device.applyIpv6Acl(binding.interfaceName, binding.direction, binding.aclId);
  }
}

function applyHostIpv6(device: EndHost, config: DeviceConfig & { ipv6?: {
  mode: "static" | "slaac" | "dhcpv6";
  address?: string;
  prefixLength?: number;
  defaultRouter?: string;
  dnsServer?: string;
} }): void {
  if (!config.ipv6) return;
  if (config.ipv6.mode === "static") {
    if (config.ipv6.address !== undefined && config.ipv6.prefixLength !== undefined) {
      device.configureIpv6Static(
        config.ipv6.address,
        config.ipv6.prefixLength,
        config.ipv6.defaultRouter,
        config.ipv6.dnsServer,
      );
    }
    return;
  }
  device.setIpv6Mode(config.ipv6.mode);
}

function applyConfiguration(device: Device, config: DeviceConfig, node: NodeSpec, deferBgp = false): void {
  device.rename(config.hostname ?? device.name);
  if (device instanceof Laptop && config.kind === "laptop") {
    device.configureWirelessInterface(
      wirelessInterfaceConfiguration(node, config.wireless.radio),
      config.wireless,
    );
    applyWirelessHostConfiguration(device, config);
    return;
  }
  if (device instanceof Smartphone && config.kind === "smartphone") {
    device.configureWirelessInterface(
      wirelessInterfaceConfiguration(node, config.wireless.radio),
      config.wireless,
    );
    applyWirelessHostConfiguration(device, config);
    return;
  }
  if (device instanceof AccessPoint && config.kind === "access-point") {
    device.configureWireless(
      wirelessInterfaceConfiguration(node, config.radio),
      config.accessPoint,
    );
    for (const iface of config.interfaces) applyPhysical(device, iface);
    return;
  }
  if (device instanceof WirelessRouter && config.kind === "wireless-router") {
    device.configureHomeNetwork(
      wirelessInterfaceConfiguration(node, config.radio),
      config,
    );
    for (const iface of config.interfaces) applyPhysical(device, iface);
    return;
  }
  if (device instanceof Pc && config.kind === "pc") {
    for (const iface of config.interfaces) applyPhysical(device, iface);
    if (config.ipv4) {
      device.configure({
        ip: config.ipv4.address,
        mask: config.ipv4.prefixLength,
        gateway: config.ipv4.defaultGateway,
        dnsServer: config.dnsServer,
      });
    }
    if (config.dnsServer !== undefined) device.applications.setDnsServer(config.dnsServer);
    if (config.dhcpEnabled) device.setDhcpEnabled(true);
    applyHostIpv6(device, config);
    return;
  }
  if (device instanceof Server && config.kind === "server") {
    for (const iface of config.interfaces) applyPhysical(device, iface);
    const configured = config.interfaces.find((iface) => iface.ipv4 !== undefined);
    if (configured?.ipv4) {
      device.selectPrimaryInterface(configured.id);
      device.configure({
        ip: configured.ipv4.address,
        mask: configured.ipv4.prefixLength,
        gateway: config.defaultGateway,
        dnsServer: config.dnsServer,
      });
    }
    if (config.dnsServer !== undefined) device.applications.setDnsServer(config.dnsServer);
    if (config.dhcpClientEnabled) device.setDhcpEnabled(true);
    applyHostIpv6(device, config);
    for (const pool of config.dhcpv6Pools ?? []) {
      device.addDhcpv6Pool({
        ...pool,
        preferredLifetimeNs: pool.preferredLifetimeSeconds * NS_PER_S,
        validLifetimeNs: pool.validLifetimeSeconds * NS_PER_S,
      });
    }
    device.consoleAccess.configure(config.consoleAccess);
    device.configureServices(config.enabledServices);
    // A server is a vendor-neutral station: LLDP only, never CDP.
    applyDiscoveryConfiguration(device, config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG);
    return;
  }
  if (device instanceof TrafficGenerator && config.kind === "traffic-generator") {
    for (const iface of config.interfaces) applyPhysical(device, iface);
    if (config.ipv4) {
      device.configure({
        ip: config.ipv4.address,
        mask: config.ipv4.prefixLength,
        gateway: config.ipv4.defaultGateway,
        dnsServer: config.dnsServer,
      });
    }
    if (config.dhcpEnabled) device.setDhcpEnabled(true);
    for (const flow of config.flows) device.configureFlow(flow);
    return;
  }
  if (device instanceof Hub && config.kind === "hub") {
    for (const iface of config.interfaces) applyPhysical(device, iface);
    return;
  }
  if (device instanceof EthernetBridge && config.kind === "bridge") {
    for (const iface of config.interfaces) applyPhysical(device, iface);
    device.setAgingTimeNs(config.agingTimeNs);
    device.consoleAccess.configure(config.consoleAccess);
    return;
  }
  if (device instanceof ExternalAppliance && config.kind === "external-appliance") {
    for (const iface of config.interfaces) applyPhysical(device, iface);
    device.source = {
      platform: config.sourcePlatform,
      vendor: config.sourceVendor,
      nodeKind: config.sourceNodeKind,
      template: config.sourceTemplate,
      iconHint: config.sourceIconHint,
      unparsedConfig: config.unparsedConfig,
      warnings: [...config.importWarnings],
      authHint: config.authHint,
    };
    return;
  }
  if (device instanceof Layer3Switch && config.kind === "l3-switch") {
    applyLayer3SwitchConfiguration(device, config, deferBgp);
    return;
  }
  if (device instanceof L2Switch && config.kind === "l2-switch") {
    device.remoteAccess.configure(config.remoteAccess);
    device.aaa.configure(config.aaa);
    device.consoleAccess.configure(config.consoleAccess);
    for (const vlan of config.vlans) device.setVlanName(vlan.id, vlan.name);
    // Bundles first: spanning tree must see the logical ports, not the members,
    // and a member inherits the Port-channel's switchport configuration.
    applyEtherChannelConfiguration(device, config.etherChannels ?? []);
    for (const iface of config.interfaces) {
      applyPhysical(device, iface);
      if (device.etherChannel.channelOf(iface.id) !== undefined) continue;
      if (iface.mode === "access") device.setAccess(iface.id, iface.accessVlan);
      else device.setTrunk(iface.id, { nativeVlan: iface.nativeVlan, allowedVlans: iface.allowedVlans });
    }
    applySpanningTreeConfiguration(device, config.spanningTree ?? DEFAULT_SPANNING_TREE_CONFIG);
    applyDiscoveryConfiguration(device, config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG);
    // The SVI first: addressing the management interface resets its sockets, so
    // the SNMP agent must bind afterwards or it would lose its listener.
    applyManagementSvi(device, config);
    device.snmp.configure(config.snmp);
    return;
  }
  if (device instanceof Router
    && (config.kind === "router" || config.kind === "firewall" || config.kind === "cloud")) {
    if (config.kind !== "cloud") {
      device.remoteAccess.configure(config.remoteAccess);
      device.aaa.configure(config.aaa);
      device.snmp.configure(config.snmp);
      device.consoleAccess.configure(config.consoleAccess);
    }
    if (config.kind === "router") {
      for (const vrf of config.vrfs ?? []) device.defineVrf(vrf);
    }
    for (const iface of config.interfaces) {
      applyPhysical(device, iface);
      if (iface.routed || iface.ipv4 || (config.kind === "router" && (iface.vrfId !== undefined || iface.mplsEnabled))) {
        device.getOrCreateInterface(iface.id);
        if (config.kind === "router" && iface.vrfId !== undefined) device.assignInterfaceVrf(iface.id, iface.vrfId);
        if (iface.ipv4) device.setInterfaceIp(iface.id, iface.ipv4.address, iface.ipv4.prefixLength);
        if (config.kind === "router" && iface.mplsEnabled) device.setMplsEnabled(iface.id, true);
      }
      if (iface.ipv6 && iface.ipv6.length > 0) {
        device.getOrCreateInterface(iface.id);
        for (const address of iface.ipv6) device.setInterfaceIpv6(iface.id, address.address, address.prefixLength);
      }
    }
    for (const iface of config.subinterfaces) {
      device.getOrCreateSubinterface(iface.parentInterface, iface.vlan, iface.native);
      if (config.kind === "router" && iface.vrfId !== undefined) device.assignInterfaceVrf(iface.id, iface.vrfId);
      if (iface.ipv4) device.setInterfaceIp(iface.id, iface.ipv4.address, iface.ipv4.prefixLength);
      for (const address of iface.ipv6 ?? []) {
        device.setInterfaceIpv6(iface.id, address.address, address.prefixLength);
      }
    }
    for (const route of config.staticRoutes) {
      device.addStaticRoute(route.network, route.prefixLength, route.nextHop);
    }
    if (config.kind === "router") {
      for (const vrf of config.vrfs ?? []) {
        for (const route of vrf.staticRoutes) device.addVrfStaticRoute(vrf.id, route.network, route.prefixLength, route.nextHop);
        for (const route of vrf.ipv6StaticRoutes ?? []) {
          device.addVrfIpv6StaticRoute(vrf.id, route.network, route.prefixLength, route.nextHop);
        }
      }
    }
    device.setIpv6ForwardingEnabled(config.ipv6UnicastRoutingEnabled ?? false);
    for (const route of config.ipv6StaticRoutes ?? []) {
      device.addIpv6StaticRoute(route.network, route.prefixLength, route.nextHop);
    }
    for (const advertisement of config.routerAdvertisements ?? []) {
      device.configureRouterAdvertisement(advertisement.interfaceName, {
        managed: advertisement.managed,
        otherConfiguration: advertisement.otherConfiguration,
        routerLifetimeNs: advertisement.routerLifetimeSeconds * NS_PER_S,
        dnsServers: advertisement.dnsServers,
        prefixes: advertisement.prefixes.map((prefix) => ({
          prefix: prefix.prefix,
          prefixLength: prefix.prefixLength,
          autonomous: prefix.autonomous,
          onLink: prefix.onLink,
          validLifetimeNs: prefix.validLifetimeSeconds * NS_PER_S,
          preferredLifetimeNs: prefix.preferredLifetimeSeconds * NS_PER_S,
        })),
      });
    }
    for (const pool of config.dhcpv6Pools ?? []) {
      device.addDhcpv6Pool({
        ...pool,
        preferredLifetimeNs: pool.preferredLifetimeSeconds * NS_PER_S,
        validLifetimeNs: pool.validLifetimeSeconds * NS_PER_S,
      });
    }
    for (const pool of config.dhcpPools) {
      device.addDhcpPool({
        id: pool.id,
        network: pool.network,
        mask: pool.prefixLength,
        gateway: pool.defaultGateway,
        rangeStart: pool.rangeStart,
        rangeEnd: pool.rangeEnd,
        leaseSeconds: pool.leaseSeconds,
      });
    }
    applyAclConfiguration(device, config);
    applyIpv6AclConfiguration(device, config);
    applyQosConfiguration(device, config.qos);
    for (const pool of config.natPools) device.defineNatPool(pool);
    for (const role of config.natInterfaceRoles) device.setNatRole(role.interfaceName, role.role);
    for (const rule of config.natRules) device.defineNatRule(rule);
    if (device instanceof Firewall && config.kind === "firewall") {
      for (const zone of config.zones) device.setZone(zone.interfaceName, zone.zone);
      for (const policy of config.firewallPolicies) device.definePolicy(policy);
      device.setDefaultPolicy(config.defaultPolicy);
    }
    if (device instanceof IspCloud && config.kind === "cloud") {
      for (const impairment of config.impairments) device.configureImpairment(impairment);
      device.validateInterfaceCount();
    }
    applyLoopbackConfiguration(device, config.loopbacks ?? []);
    if (config.kind === "router" && config.ldp?.routerIdInterface !== undefined) {
      device.configureLdpRouterId(config.ldp.routerIdInterface);
    }
    // Tunnels need their underlay source addresses, so the VPN is applied after
    // interface addressing and before the routing protocols that may run over it.
    applyVpnConfiguration(device, config.vpn);
    applyDiscoveryConfiguration(device, config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG);
    if (config.ospf) applyOspfConfiguration(device, config.ospf);
    if (config.ospfv3) applyOspfv3Configuration(device, config.ospfv3);
    if (!deferBgp && config.kind === "router") {
      applyBgpConfiguration(device, config.bgp, config.prefixLists, config.routeMaps, config.communityLists, config.asPathLists, config.ipv6PrefixLists);
    }
  }
}

function applyWirelessHostConfiguration(
  device: WirelessEndHost,
  config: Extract<DeviceConfig, { kind: "laptop" | "smartphone" }>,
): void {
  for (const iface of config.interfaces) applyPhysical(device, iface);
  if (config.ipv4) {
    device.configure({
      ip: config.ipv4.address,
      mask: config.ipv4.prefixLength,
      gateway: config.ipv4.defaultGateway,
      dnsServer: config.dnsServer,
    });
  }
  if (config.dnsServer !== undefined) device.applications.setDnsServer(config.dnsServer);
  if (config.dhcpEnabled) device.setDhcpEnabled(true);
  applyHostIpv6(device, config);
}

/**
 * The L2 management interface: one addressable VLAN plus an optional default
 * gateway. It never enables routing, so the switch stays a layer-2 device.
 */
function applyManagementSvi(device: L2Switch, config: SwitchDeviceConfig): void {
  const svi = config.managementSvi;
  if (svi) {
    device.defineManagementSvi(svi.vlanId);
    if (svi.ipAddress !== undefined && svi.prefixLength !== undefined) {
      device.setManagementSviIp(svi.vlanId, svi.ipAddress, svi.prefixLength);
    }
    device.setManagementSviAdminState(svi.vlanId, svi.adminUp);
    if (svi.description) device.setManagementSviDescription(svi.vlanId, svi.description);
  }
  if (config.managementDefaultGateway !== undefined) {
    device.setManagementDefaultGateway(config.managementDefaultGateway);
  }
}

function applyLayer3SwitchConfiguration(device: Layer3Switch, config: Layer3SwitchDeviceConfig, deferBgp = false): void {
  device.remoteAccess.configure(config.remoteAccess);
  device.aaa.configure(config.aaa);
  device.snmp.configure(config.snmp);
  device.consoleAccess.configure(config.consoleAccess);
  for (const vlan of config.vlans) device.setVlanName(vlan.id, vlan.name);
  applyEtherChannelConfiguration(device, config.etherChannels ?? []);
  for (const iface of config.interfaces) {
    applyPhysical(device, iface);
    if (device.etherChannel.channelOf(iface.id) !== undefined) continue;
    if (iface.mode === "routed") {
      device.setPortRouted(iface.id, true);
      if (iface.ipv4) device.configureRoutedInterface(iface.id, iface.ipv4.address, iface.ipv4.prefixLength);
      for (const address of iface.ipv6 ?? []) {
        device.setInterfaceIpv6(iface.id, address.address, address.prefixLength);
      }
    } else if (iface.mode === "access") {
      device.setAccess(iface.id, iface.accessVlan);
    } else {
      device.setTrunk(iface.id, { nativeVlan: iface.nativeVlan, allowedVlans: iface.allowedVlans });
    }
  }
  for (const svi of config.svis) {
    device.defineSvi(svi.vlanId);
    if (svi.ipAddress !== undefined && svi.prefixLength !== undefined) {
      device.setSviIp(svi.vlanId, svi.ipAddress, svi.prefixLength);
    }
    for (const address of svi.ipv6 ?? []) device.setSviIpv6(svi.vlanId, address.address, address.prefixLength);
    device.setSviAdminState(svi.vlanId, svi.adminUp);
    if (svi.description) device.setSviDescription(svi.vlanId, svi.description);
  }
  for (const route of config.staticRoutes) device.addStaticRoute(route.network, route.prefixLength, route.nextHop);
  device.setIpRouting(config.ipRoutingEnabled);
  device.setIpv6Routing(config.ipv6UnicastRoutingEnabled ?? false);
  for (const route of config.ipv6StaticRoutes ?? []) {
    device.addIpv6StaticRoute(route.network, route.prefixLength, route.nextHop);
  }
  for (const advertisement of config.routerAdvertisements ?? []) {
    device.configureRouterAdvertisement(advertisement.interfaceName, {
      managed: advertisement.managed,
      otherConfiguration: advertisement.otherConfiguration,
      routerLifetimeNs: advertisement.routerLifetimeSeconds * NS_PER_S,
      dnsServers: advertisement.dnsServers,
      prefixes: advertisement.prefixes.map((prefix) => ({
        prefix: prefix.prefix,
        prefixLength: prefix.prefixLength,
        autonomous: prefix.autonomous,
        onLink: prefix.onLink,
        validLifetimeNs: prefix.validLifetimeSeconds * NS_PER_S,
        preferredLifetimeNs: prefix.preferredLifetimeSeconds * NS_PER_S,
      })),
    });
  }
  for (const pool of config.dhcpv6Pools ?? []) {
    device.addDhcpv6Pool({
      ...pool,
      preferredLifetimeNs: pool.preferredLifetimeSeconds * NS_PER_S,
      validLifetimeNs: pool.validLifetimeSeconds * NS_PER_S,
    });
  }
  applyAclConfiguration(device, config);
  applyIpv6AclConfiguration(device, config);
  applyQosConfiguration(device, config.qos);
  applySpanningTreeConfiguration(device, config.spanningTree ?? DEFAULT_SPANNING_TREE_CONFIG);
  applyDiscoveryConfiguration(device, config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG);
  applyLoopbackConfiguration(device, config.loopbacks ?? []);
  if (config.ospf) applyOspfConfiguration(device, config.ospf);
  if (config.ospfv3) applyOspfv3Configuration(device, config.ospfv3);
  if (!deferBgp) applyBgpConfiguration(device, config.bgp, config.prefixLists, config.routeMaps, config.communityLists, config.asPathLists, config.ipv6PrefixLists);
}

/** Apply the TCP-based routing process only after the complete underlay exists. */
export function applyPostLinkRoutingConfiguration(device: Device, config: DeviceConfig): void {
  if (device instanceof Layer3Switch && config.kind === "l3-switch") {
    applyBgpConfiguration(device, config.bgp, config.prefixLists, config.routeMaps, config.communityLists, config.asPathLists, config.ipv6PrefixLists);
  } else if (device instanceof Router && config.kind === "router") {
    applyBgpConfiguration(device, config.bgp, config.prefixLists, config.routeMaps, config.communityLists, config.asPathLists, config.ipv6PrefixLists);
  }
}

/**
 * Instantiate one device: create it, give it the topology's canonical
 * interfaces and MAC addresses, and apply its structured configuration.
 *
 * `buildLabFromDocument` does this for the whole lab in three passes because
 * cabling needs every device to exist first. A single-device reload needs the
 * same three steps for exactly one device, so they live here rather than being
 * duplicated by the lifecycle module.
 */
export function createDeviceInstance(
  node: NodeSpec,
  config: DeviceConfig,
  engine: SimulationEngine,
  deferBgp = false,
): Device {
  const device = createDevice(node, config, engine);
  const interfaceTemplates = resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId);
  for (const iface of node.interfaces) {
    const template = interfaceTemplates.find((entry) => entry.id === iface.id);
    // A wireless interface is created by the radio configuration, not cabled on.
    if (template?.media === "wireless") continue;
    device.addInterface(iface.id, iface.mac as Mac);
  }
  applyConfiguration(device, config, node, deferBgp);
  return device;
}

export function buildLabFromDocument(document: LabDocument): BuiltLab {
  const canonical = canonicalizeLabDocument(document);
  const engine = createSimulationEngine({ seed: canonical.simulation.seed });
  const devices = new Map<DeviceId, Device>();

  for (const node of canonical.topology.nodes) {
    const config = canonical.configurations[node.id]!;
    const device = createDevice(node, config, engine);
    devices.set(asDeviceId(node.id), device);
  }
  for (const node of canonical.topology.nodes) {
    const device = devices.get(asDeviceId(node.id))!;
    const interfaceTemplates = resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId);
    for (const iface of node.interfaces) {
      const template = interfaceTemplates.find((entry) => entry.id === iface.id);
      if (template?.media === "wireless") continue;
      device.addInterface(iface.id, iface.mac as Mac);
    }
  }
  for (const node of canonical.topology.nodes) {
    applyConfiguration(
      devices.get(asDeviceId(node.id))!,
      canonical.configurations[node.id]!,
      node,
      true,
    );
  }
  for (const link of canonical.topology.links) {
    engine.connect(link.a.node, link.a.iface, link.b.node, link.b.iface, {
      propagationDelayNs: link.propagationDelayNs,
      capacityBps: link.capacityBps,
      queueLimitPackets: link.queueLimitPackets,
    });
  }
  // BGP owns a real simulated TCP session. Restore it only after every cable is
  // attached so the first SYN and its ARP resolution use the complete underlay.
  for (const node of canonical.topology.nodes) {
    applyPostLinkRoutingConfiguration(
      devices.get(asDeviceId(node.id))!,
      canonical.configurations[node.id]!,
    );
  }
  // Queue structure needs the cabled capacity, so output policies are installed
  // once the links exist rather than while configuration is still being applied.
  for (const device of devices.values()) {
    if (device instanceof Router) device.refreshEgressQueues();
    else if (device instanceof Layer3Switch) device.refreshEgressQueues();
  }

  // The management plane is armed last: its listeners need addressed interfaces
  // and the shared local-user database that `applyConfiguration` just applied.
  const management = new ManagementPlane(devices, engine);
  for (const node of canonical.topology.nodes) {
    const config = canonical.configurations[node.id]!;
    if (!("remoteAccess" in config) && !("consoleAccess" in config)) continue;
    const remote = "remoteAccess" in config ? config.remoteAccess : undefined;
    const access = "consoleAccess" in config ? config.consoleAccess : undefined;
    management.configureDevice(node.id, remote, access);
  }

  return new BuiltLabImpl(
    engine,
    devices,
    canonical.topology,
    canonical.simulation.seed,
    management,
    canonical.startupConfigurations,
  );
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

function physicalConfiguration(device: Device, id: string): PhysicalInterfaceConfig {
  const iface = device.getInterface(id)!;
  return {
    id,
    description: iface.description,
    shutdown: !iface.adminUp,
  };
}

function serializeAcls(
  device: Pick<Router, "aclConfigurations"> | Pick<Layer3Switch, "aclConfigurations">,
): Ipv4AclConfig[] {
  return device.aclConfigurations().map((acl) => acl.type === "standard"
    ? {
        ...acl,
        rules: acl.rules.map((rule) => ({ ...rule, source: { ...rule.source } })),
      }
    : {
        ...acl,
        rules: acl.rules.map((rule) => ({
          ...rule,
          source: { ...rule.source },
          destination: { ...rule.destination },
          sourcePort: rule.sourcePort ? { ...rule.sourcePort } : undefined,
          destinationPort: rule.destinationPort ? { ...rule.destinationPort } : undefined,
        })),
      });
}

function serializeIpv6Acls(
  device: Pick<Router, "ipv6AclConfigurations"> | Pick<Layer3Switch, "ipv6AclConfigurations">,
): Ipv6AclConfig[] {
  return device.ipv6AclConfigurations().map((acl) => ({
    ...acl,
    rules: acl.rules.map((rule) => ({
      ...rule,
      source: { ...rule.source },
      destination: { ...rule.destination },
      sourcePort: rule.sourcePort ? { ...rule.sourcePort } : undefined,
      destinationPort: rule.destinationPort ? { ...rule.destinationPort } : undefined,
    })),
  }));
}

function serializeDhcpv6Pools(
  pools: ReturnType<Router["dhcpv6"]["configurations"]>,
) {
  return pools.map((pool) => ({
    id: pool.id,
    prefix: pool.prefix,
    prefixLength: pool.prefixLength,
    rangeStart: pool.rangeStart,
    rangeEnd: pool.rangeEnd,
    dnsServers: [...(pool.dnsServers ?? [])],
    preferredLifetimeSeconds: Math.round((pool.preferredLifetimeNs ?? 0) / NS_PER_S),
    validLifetimeSeconds: Math.round((pool.validLifetimeNs ?? 0) / NS_PER_S),
  }));
}

function serializeRouterAdvertisements(
  configurations: ReturnType<Router["routerAdvertisementConfigurations"]>,
) {
  return configurations.map(({ interfaceName, configuration }) => ({
    interfaceName,
    managed: configuration.managed ?? false,
    otherConfiguration: configuration.otherConfiguration ?? false,
    routerLifetimeSeconds: Math.round((configuration.routerLifetimeNs ?? 0) / NS_PER_S),
    dnsServers: [...(configuration.dnsServers ?? [])],
    prefixes: configuration.prefixes.map((prefix) => ({
      prefix: prefix.prefix,
      prefixLength: prefix.prefixLength,
      autonomous: prefix.autonomous,
      onLink: prefix.onLink,
      validLifetimeSeconds: Math.round(prefix.validLifetimeNs / NS_PER_S),
      preferredLifetimeSeconds: Math.round(prefix.preferredLifetimeNs / NS_PER_S),
    })),
  }));
}

function serializeHostIpv6Configuration(
  ipv6: ReturnType<Pc["ipv6ConfigurationSnapshot"]>,
): HostIpv6Config | undefined {
  if (
    ipv6.mode === "static"
    && ipv6.staticAddress === undefined
    && ipv6.defaultRouter === undefined
    && ipv6.dnsServer === undefined
  ) return undefined;
  return {
    mode: ipv6.mode,
    address: ipv6.staticAddress,
    prefixLength: ipv6.prefixLength,
    defaultRouter: ipv6.defaultRouter,
    dnsServer: ipv6.dnsServer,
  };
}

function serializeStaticIpv6Addresses(
  addresses: readonly { address: string; prefixLength: number; source: string }[] | undefined,
): Ipv6InterfaceAddress[] | undefined {
  const configured = addresses
    ?.filter((address) => address.source === "static")
    .map((address) => ({ address: address.address, prefixLength: address.prefixLength }));
  return configured && configured.length > 0 ? configured : undefined;
}

/** Absent when nothing was configured, so an untouched lab round-trips byte-identically. */
function serializeRemoteAccess(state: { snapshot(): RemoteAccessConfiguration }): RemoteAccessConfiguration | undefined {
  const snapshot = state.snapshot();
  return isDefaultRemoteAccess(snapshot) ? undefined : snapshot;
}

function serializeAaa(state: { snapshot(): AaaConfiguration }): AaaConfiguration | undefined {
  const snapshot = state.snapshot();
  return isDefaultAaaConfiguration(snapshot) ? undefined : snapshot;
}

function serializeSnmp(agent: { snapshot(): SnmpAgentConfiguration }): SnmpAgentConfiguration | undefined {
  const snapshot = agent.snapshot();
  return isDefaultSnmpAgentConfiguration(snapshot) ? undefined : snapshot;
}

/**
 * Read one device's live configuration back as structured data.
 *
 * This is the bridge from the engine to the canonical model: the running
 * configuration a CLI command just changed, a `.cfg` projection and a startup
 * snapshot all come from here, so they cannot disagree.
 */
export function serializeDeviceConfiguration(device: Device, node: NodeSpec): DeviceConfig {
  return serializeConfiguration(device, node);
}

function serializeConfiguration(device: Device, node: NodeSpec): DeviceConfig {
  if (device instanceof AccessPoint) {
    const wireless = device.configurationSnapshot();
    return {
      kind: "access-point",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      radio: wireless.radio,
      accessPoint: wireless.accessPoint,
    };
  }
  if (device instanceof Laptop || device instanceof Smartphone) {
    const state = device.configurationSnapshot();
    const ipv6 = device.ipv6ConfigurationSnapshot();
    const common = {
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      ipv4: state.ip === undefined
        ? undefined
        : { address: state.ip, prefixLength: prefixLength(state.maskInt), defaultGateway: state.gateway },
      dhcpEnabled: state.dhcpEnabled,
      dnsServer: state.dnsServer,
      ipv6: serializeHostIpv6Configuration(ipv6),
      wireless: device.wirelessConfigurationSnapshot(),
    };
    return device instanceof Laptop
      ? { kind: "laptop", ...common }
      : { kind: "smartphone", ...common };
  }
  if (device instanceof WirelessRouter) {
    const configuration = device.configurationSnapshot();
    return {
      ...configuration,
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
    };
  }
  if (device instanceof Server) {
    const state = device.configurationSnapshot();
    const ipv6 = device.ipv6ConfigurationSnapshot();
    return {
      kind: "server",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => ({
        ...physicalConfiguration(device, iface.id),
        ipv4: iface.id === device.primary.name && state.ip !== undefined
          ? { address: state.ip, prefixLength: prefixLength(state.maskInt) }
          : undefined,
      })),
      defaultGateway: state.gateway,
      dhcpClientEnabled: state.dhcpEnabled,
      dnsServer: state.dnsServer,
      ipv6: serializeHostIpv6Configuration(ipv6),
      dhcpv6Pools: serializeDhcpv6Pools(device.dhcpv6PoolConfigurations()),
      enabledServices: device.services.configurations(),
      discovery: serializeDiscoveryConfiguration(device),
      consoleAccess: device.consoleAccess.snapshot(),
    };
  }
  if (device instanceof Pc) {
    const state = device.configurationSnapshot();
    const ipv6 = device.ipv6ConfigurationSnapshot();
    return {
      kind: "pc",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      ipv4: state.ip === undefined
        ? undefined
        : { address: state.ip, prefixLength: prefixLength(state.maskInt), defaultGateway: state.gateway },
      dhcpEnabled: state.dhcpEnabled,
      dnsServer: state.dnsServer,
      ipv6: serializeHostIpv6Configuration(ipv6),
    };
  }
  if (device instanceof TrafficGenerator) {
    const state = device.configurationSnapshot();
    const ipv6 = device.ipv6ConfigurationSnapshot();
    return {
      kind: "traffic-generator",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      ipv4: state.ip === undefined
        ? undefined
        : { address: state.ip, prefixLength: prefixLength(state.maskInt), defaultGateway: state.gateway },
      dhcpEnabled: state.dhcpEnabled,
      dnsServer: state.dnsServer,
      ipv6: serializeHostIpv6Configuration(ipv6),
      flows: device.flowConfigurations(),
    };
  }
  if (device instanceof Hub) {
    return {
      kind: "hub",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
    };
  }
  if (device instanceof EthernetBridge) {
    return {
      kind: "bridge",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      agingTimeNs: device.agingTimeNs,
      consoleAccess: device.consoleAccess.snapshot(),
    };
  }
  if (device instanceof Layer3Switch) {
    const ports = new Map(device.portSummaries().map((row) => [row.name, row]));
    const routed = new Map(device.routedInterfaceSummaries().map((row) => [row.name, row]));
    const ipv6 = new Map(device.ipv6InterfaceSummaries().map((row) => [row.name, row.addresses]));
    return {
      kind: "l3-switch",
      hostname: device.name,
      vlans: device.vlanDefinitions(),
      interfaces: node.interfaces.map((iface) => {
        const common = physicalConfiguration(device, iface.id);
        const l3 = routed.get(iface.id);
        if (device.isRoutedPort(iface.id)) {
          return {
            ...common,
            mode: "routed" as const,
            ipv4: l3?.ip === undefined ? undefined : { address: l3.ip, prefixLength: prefixLength(l3.maskInt) },
            ipv6: serializeStaticIpv6Addresses(ipv6.get(iface.id)),
          };
        }
        const port = ports.get(iface.id)!;
        return {
          ...common,
          mode: port.mode,
          accessVlan: port.accessVlan,
          nativeVlan: port.nativeVlan,
          allowedVlans: port.allowedVlans === "all" ? undefined : port.allowedVlans,
        };
      }),
      svis: device.sviSummaries().map((svi) => ({
        vlanId: svi.vlanId,
        ipAddress: svi.ip,
        prefixLength: svi.ip === undefined ? undefined : prefixLength(svi.maskInt),
        adminUp: svi.adminUp,
        description: svi.description,
        ipv6: serializeStaticIpv6Addresses(ipv6.get(svi.name)),
      })),
      staticRoutes: device.staticRouteConfigurations().map((route) => ({
        network: route.network,
        prefixLength: prefixLength(route.maskInt),
        nextHop: route.nextHop,
      })),
      ipRoutingEnabled: device.ipRoutingEnabled,
      ipv6UnicastRoutingEnabled: device.ipv6UnicastRoutingEnabled,
      ipv6StaticRoutes: device.ipv6StaticRouteConfigurations(),
      routerAdvertisements: serializeRouterAdvertisements(device.routerAdvertisementConfigurations()),
      dhcpv6Pools: serializeDhcpv6Pools(device.dhcpv6PoolConfigurations()),
      acls: serializeAcls(device),
      aclBindings: device.aclBindings(),
      ipv6Acls: serializeIpv6Acls(device),
      ipv6AclBindings: device.ipv6AclBindings(),
      qos: serializeQos(device),
      spanningTree: serializeSpanningTreeConfiguration(device),
      etherChannels: serializeEtherChannelConfiguration(device),
      discovery: serializeDiscoveryConfiguration(device),
      loopbacks: serializeLoopbackConfiguration(device),
      ospf: serializeOspfConfiguration(device),
      ospfv3: serializeOspfv3Configuration(device),
      bgp: serializeBgpConfiguration(device),
      prefixLists: serializePrefixLists(device),
      ipv6PrefixLists: serializeIpv6PrefixLists(device),
      routeMaps: serializeRouteMaps(device),
      communityLists: serializeCommunityLists(device),
      asPathLists: serializeAsPathLists(device),
      consoleAccess: device.consoleAccess.snapshot(),
      remoteAccess: serializeRemoteAccess(device.remoteAccess),
      aaa: serializeAaa(device.aaa),
      snmp: serializeSnmp(device.snmp),
    };
  }
  if (device instanceof L2Switch) {
    const summaries = new Map(device.portSummaries().map((summary) => [summary.name, summary]));
    const managementSvi = device.managementSviSummary();
    return {
      kind: "l2-switch",
      hostname: device.name,
      vlans: device.vlanDefinitions(),
      interfaces: node.interfaces.map((iface) => {
        const summary = summaries.get(iface.id)!;
        return {
          ...physicalConfiguration(device, iface.id),
          mode: summary.mode,
          accessVlan: summary.accessVlan,
          nativeVlan: summary.nativeVlan,
          allowedVlans: summary.allowedVlans === "all" ? undefined : summary.allowedVlans,
        };
      }),
      spanningTree: serializeSpanningTreeConfiguration(device),
      etherChannels: serializeEtherChannelConfiguration(device),
      discovery: serializeDiscoveryConfiguration(device),
      managementSvi: managementSvi
        ? {
            vlanId: managementSvi.vlanId,
            ipAddress: managementSvi.ip,
            prefixLength: managementSvi.ip === undefined ? undefined : prefixLength(managementSvi.maskInt),
            adminUp: managementSvi.adminUp,
            description: managementSvi.description,
          }
        : undefined,
      managementDefaultGateway: device.managementDefaultGateway,
      consoleAccess: device.consoleAccess.snapshot(),
      remoteAccess: serializeRemoteAccess(device.remoteAccess),
      aaa: serializeAaa(device.aaa),
      snmp: serializeSnmp(device.snmp),
    };
  }

  if (device instanceof ExternalAppliance) {
    const source = device.source;
    return {
      kind: "external-appliance",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      sourcePlatform: source.platform,
      sourceVendor: source.vendor,
      sourceNodeKind: source.nodeKind,
      sourceTemplate: source.template,
      sourceIconHint: source.iconHint,
      unparsedConfig: source.unparsedConfig,
      importWarnings: [...source.warnings],
      authHint: source.authHint,
    };
  }
  if (!(device instanceof Router)) {
    throw new LabSemanticError("configuration-type-mismatch", `configurations.${node.id}`, "Unsupported device type");
  }
  const summaries = device.interfaceSummaries();
  const ipv6Summaries = new Map(device.ipv6InterfaceSummaries().map((row) => [row.name, row.addresses]));
  const physical = new Map(summaries.filter((iface) => iface.vlan === undefined).map((iface) => [iface.name, iface]));
  const routed = {
    hostname: device.name,
    interfaces: node.interfaces.map((iface) => {
      const l3 = physical.get(iface.id);
      return {
        ...physicalConfiguration(device, iface.id),
        routed: l3 !== undefined,
        ipv4: l3?.ip === undefined ? undefined : { address: l3.ip, prefixLength: prefixLength(l3.maskInt) },
        ipv6: serializeStaticIpv6Addresses(ipv6Summaries.get(iface.id)),
        mplsEnabled: device.deviceType === "router" ? device.mpls.interfaceEnabled(iface.id) || undefined : undefined,
        vrfId: device.deviceType === "router" ? device.interfaceVrf(iface.id) : undefined,
      };
    }),
    subinterfaces: summaries
      .filter((iface) => iface.vlan !== undefined)
      .map((iface) => ({
        id: iface.name,
        parentInterface: iface.name.slice(0, iface.name.lastIndexOf(".")),
        vlan: iface.vlan!,
        native: iface.native,
        ipv4: iface.ip === undefined ? undefined : { address: iface.ip, prefixLength: prefixLength(iface.maskInt) },
        ipv6: serializeStaticIpv6Addresses(ipv6Summaries.get(iface.name)),
        vrfId: device.deviceType === "router" ? device.interfaceVrf(iface.name) : undefined,
      })),
    staticRoutes: device.staticRouteConfigurations().map((route) => ({
      network: route.network,
      prefixLength: prefixLength(route.maskInt),
      nextHop: route.nextHop,
    })),
    dhcpPools: device.dhcpPoolConfigurations().map((pool) => ({
      id: pool.id,
      network: pool.network,
      prefixLength: prefixLength(pool.maskInt),
      defaultGateway: pool.gateway,
      rangeStart: pool.rangeStart,
      rangeEnd: pool.rangeEnd,
      leaseSeconds: pool.leaseSeconds,
    })),
    ipv6UnicastRoutingEnabled: device.ipv6UnicastRoutingEnabled,
    ipv6StaticRoutes: device.ipv6StaticRouteConfigurations(),
    routerAdvertisements: serializeRouterAdvertisements(device.routerAdvertisementConfigurations()),
    dhcpv6Pools: serializeDhcpv6Pools(device.dhcpv6.configurations()),
    acls: serializeAcls(device),
    aclBindings: device.aclBindings(),
    ipv6Acls: serializeIpv6Acls(device),
    ipv6AclBindings: device.ipv6AclBindings(),
    qos: serializeQos(device),
    natPools: device.natPoolConfigurations(),
    natRules: device.natRuleConfigurations(),
    natInterfaceRoles: device.interfaceSummaries()
      .flatMap((iface) => {
        const role = device.natRole(iface.name);
        return role ? [{ interfaceName: iface.name, role }] : [];
      }),
    ldp: device.deviceType === "router" && device.ldp.configuredRouterIdSource() !== undefined
      ? { routerIdInterface: device.ldp.configuredRouterIdSource() }
      : undefined,
    vrfs: device.deviceType === "router"
      ? device.vrfConfigurations().map((vrf) => {
          const ipv6StaticRoutes = vrf.addressFamilyIpv6
            ? device.vrfIpv6StaticRouteConfigurations(vrf.id).map((route) => ({
                network: route.network,
                prefixLength: route.prefixLength,
                nextHop: route.nextHop!,
              }))
            : [];
          return {
            ...vrf,
            importRouteTargets: [...vrf.importRouteTargets],
            exportRouteTargets: [...vrf.exportRouteTargets],
            staticRoutes: device.vrfStaticRouteConfigurations(vrf.id).map((route) => ({
              network: route.network,
              prefixLength: route.prefixLength,
              nextHop: route.nextHop!,
            })),
            // An IPv4-only VRF keeps its pre-M10.13 shape exactly.
            ...(vrf.addressFamilyIpv6 ? { addressFamilyIpv6: true, ipv6StaticRoutes } : {}),
          };
        })
      : undefined,
    vpn: serializeVpnConfiguration(device),
    discovery: serializeDiscoveryConfiguration(device),
    loopbacks: serializeLoopbackConfiguration(device),
    ospf: serializeOspfConfiguration(device),
    ospfv3: serializeOspfv3Configuration(device),
    bgp: serializeBgpConfiguration(device),
    prefixLists: serializePrefixLists(device),
    ipv6PrefixLists: serializeIpv6PrefixLists(device),
    routeMaps: serializeRouteMaps(device),
    communityLists: serializeCommunityLists(device),
    asPathLists: serializeAsPathLists(device),
    consoleAccess: device instanceof IspCloud ? undefined : device.consoleAccess.snapshot(),
    remoteAccess: device instanceof IspCloud ? undefined : serializeRemoteAccess(device.remoteAccess),
    aaa: device instanceof IspCloud ? undefined : serializeAaa(device.aaa),
    snmp: device instanceof IspCloud ? undefined : serializeSnmp(device.snmp),
  };
  if (device instanceof Firewall) {
    return {
      kind: "firewall",
      ...routed,
      zones: device.zoneConfigurations(),
      firewallPolicies: device.policyConfigurations().map((policy) => ({
        ...policy,
        source: policy.source ? { ...policy.source } : undefined,
        destination: policy.destination ? { ...policy.destination } : undefined,
        sourcePort: policy.sourcePort ? { ...policy.sourcePort } : undefined,
        destinationPort: policy.destinationPort ? { ...policy.destinationPort } : undefined,
        states: policy.states ? [...policy.states] : undefined,
      })),
      defaultPolicy: device.defaultPolicy,
    };
  }
  if (device instanceof IspCloud) {
    return {
      kind: "cloud",
      ...routed,
      impairments: device.impairmentConfigurations().map((impairment) => ({ ...impairment })),
    };
  }
  return { kind: "router", ...routed };
}

export function serializeLabDocument(builtLab: BuiltLab, metadata: LabMetadata): LabDocument {
  const nodes = builtLab.topology.nodes.map((node) => {
    const device = builtLab.getDevice(node.id)!;
    return {
      ...node,
      interfaces: node.interfaces.map((iface) => ({
        ...iface,
        mac: device.getInterface(iface.id)!.mac,
      })),
    };
  });
  const configurations: Record<string, DeviceConfig> = {};
  for (const node of nodes) configurations[node.id] = serializeConfiguration(builtLab.getDevice(node.id)!, node);
  return canonicalizeLabDocument({
    schemaVersion: 1,
    ...metadata,
    simulation: { seed: builtLab.seed },
    topology: { ...builtLab.topology, nodes },
    configurations,
    // Startup snapshots are configuration, so they survive serialization exactly
    // like the running configuration does. Runtime state never joins them.
    startupConfigurations: builtLab.startupConfigurations(),
  });
}

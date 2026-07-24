import {
  asDeviceId,
  type DeviceConfig,
  type DeviceId,
  type LabDocument,
  type LabMetadata,
  type Ipv4AclConfig,
  type NodeSpec,
  type PhysicalInterfaceConfig,
  type Layer3SwitchDeviceConfig,
  type Topology,
} from "@sim/contracts";
import {
  createSimulationEngine,
  Firewall,
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
  type SimulationEngine,
} from "@sim/sim-core";
import { canonicalizeLabDocument } from "./canonical";
import { LabSemanticError } from "./errors";

export interface BuiltLab {
  readonly engine: SimulationEngine;
  readonly devices: ReadonlyMap<DeviceId, Device>;
  readonly topology: Topology;
  readonly seed: number;
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
}

class BuiltLabImpl implements BuiltLab {
  constructor(
    readonly engine: SimulationEngine,
    readonly devices: ReadonlyMap<DeviceId, Device>,
    readonly topology: Topology,
    readonly seed: number,
  ) {}

  getDevice(id: DeviceId | string): Device | undefined {
    return this.devices.get(asDeviceId(id));
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
  return engine.add(new Router(node.id, hostname));
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

function applyConfiguration(device: Device, config: DeviceConfig): void {
  device.rename(config.hostname ?? device.name);
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
    device.configureServices(config.enabledServices);
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
    return;
  }
  if (device instanceof Layer3Switch && config.kind === "l3-switch") {
    applyLayer3SwitchConfiguration(device, config);
    return;
  }
  if (device instanceof L2Switch && config.kind === "l2-switch") {
    for (const vlan of config.vlans) device.setVlanName(vlan.id, vlan.name);
    for (const iface of config.interfaces) {
      applyPhysical(device, iface);
      if (iface.mode === "access") device.setAccess(iface.id, iface.accessVlan);
      else device.setTrunk(iface.id, { nativeVlan: iface.nativeVlan, allowedVlans: iface.allowedVlans });
    }
    return;
  }
  if (device instanceof Router
    && (config.kind === "router" || config.kind === "firewall" || config.kind === "cloud")) {
    for (const iface of config.interfaces) {
      applyPhysical(device, iface);
      if (iface.routed || iface.ipv4) {
        device.getOrCreateInterface(iface.id);
        if (iface.ipv4) device.setInterfaceIp(iface.id, iface.ipv4.address, iface.ipv4.prefixLength);
      }
    }
    for (const iface of config.subinterfaces) {
      device.getOrCreateSubinterface(iface.parentInterface, iface.vlan, iface.native);
      if (iface.ipv4) device.setInterfaceIp(iface.id, iface.ipv4.address, iface.ipv4.prefixLength);
    }
    for (const route of config.staticRoutes) {
      device.addStaticRoute(route.network, route.prefixLength, route.nextHop);
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
  }
}

function applyLayer3SwitchConfiguration(device: Layer3Switch, config: Layer3SwitchDeviceConfig): void {
  for (const vlan of config.vlans) device.setVlanName(vlan.id, vlan.name);
  for (const iface of config.interfaces) {
    applyPhysical(device, iface);
    if (iface.mode === "routed") {
      device.setPortRouted(iface.id, true);
      if (iface.ipv4) device.configureRoutedInterface(iface.id, iface.ipv4.address, iface.ipv4.prefixLength);
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
    device.setSviAdminState(svi.vlanId, svi.adminUp);
    if (svi.description) device.setSviDescription(svi.vlanId, svi.description);
  }
  for (const route of config.staticRoutes) device.addStaticRoute(route.network, route.prefixLength, route.nextHop);
  device.setIpRouting(config.ipRoutingEnabled);
  applyAclConfiguration(device, config);
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
    for (const iface of node.interfaces) device.addInterface(iface.id, iface.mac as Mac);
  }
  for (const node of canonical.topology.nodes) {
    applyConfiguration(devices.get(asDeviceId(node.id))!, canonical.configurations[node.id]!);
  }
  for (const link of canonical.topology.links) {
    engine.connect(link.a.node, link.a.iface, link.b.node, link.b.iface, link.propagationDelayNs);
  }

  return new BuiltLabImpl(engine, devices, canonical.topology, canonical.simulation.seed);
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

function serializeConfiguration(device: Device, node: NodeSpec): DeviceConfig {
  if (device instanceof Server) {
    const state = device.configurationSnapshot();
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
      enabledServices: device.services.configurations(),
    };
  }
  if (device instanceof Pc) {
    const state = device.configurationSnapshot();
    return {
      kind: "pc",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      ipv4: state.ip === undefined
        ? undefined
        : { address: state.ip, prefixLength: prefixLength(state.maskInt), defaultGateway: state.gateway },
      dhcpEnabled: state.dhcpEnabled,
      dnsServer: state.dnsServer,
    };
  }
  if (device instanceof TrafficGenerator) {
    const state = device.configurationSnapshot();
    return {
      kind: "traffic-generator",
      hostname: device.name,
      interfaces: node.interfaces.map((iface) => physicalConfiguration(device, iface.id)),
      ipv4: state.ip === undefined
        ? undefined
        : { address: state.ip, prefixLength: prefixLength(state.maskInt), defaultGateway: state.gateway },
      dhcpEnabled: state.dhcpEnabled,
      dnsServer: state.dnsServer,
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
    };
  }
  if (device instanceof Layer3Switch) {
    const ports = new Map(device.portSummaries().map((row) => [row.name, row]));
    const routed = new Map(device.routedInterfaceSummaries().map((row) => [row.name, row]));
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
      })),
      staticRoutes: device.staticRouteConfigurations().map((route) => ({
        network: route.network,
        prefixLength: prefixLength(route.maskInt),
        nextHop: route.nextHop,
      })),
      ipRoutingEnabled: device.ipRoutingEnabled,
      acls: serializeAcls(device),
      aclBindings: device.aclBindings(),
    };
  }
  if (device instanceof L2Switch) {
    const summaries = new Map(device.portSummaries().map((summary) => [summary.name, summary]));
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
    };
  }

  if (!(device instanceof Router)) {
    throw new LabSemanticError("configuration-type-mismatch", `configurations.${node.id}`, "Unsupported device type");
  }
  const summaries = device.interfaceSummaries();
  const physical = new Map(summaries.filter((iface) => iface.vlan === undefined).map((iface) => [iface.name, iface]));
  const routed = {
    hostname: device.name,
    interfaces: node.interfaces.map((iface) => {
      const l3 = physical.get(iface.id);
      return {
        ...physicalConfiguration(device, iface.id),
        routed: l3 !== undefined,
        ipv4: l3?.ip === undefined ? undefined : { address: l3.ip, prefixLength: prefixLength(l3.maskInt) },
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
    acls: serializeAcls(device),
    aclBindings: device.aclBindings(),
    natPools: device.natPoolConfigurations(),
    natRules: device.natRuleConfigurations(),
    natInterfaceRoles: device.interfaceSummaries()
      .flatMap((iface) => {
        const role = device.natRole(iface.name);
        return role ? [{ interfaceName: iface.name, role }] : [];
      }),
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
  });
}

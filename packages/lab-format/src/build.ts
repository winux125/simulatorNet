import {
  asDeviceId,
  type DeviceConfig,
  type DeviceId,
  type LabDocument,
  type LabMetadata,
  type NodeSpec,
  type PhysicalInterfaceConfig,
  type Topology,
} from "@sim/contracts";
import {
  createSimulationEngine,
  type Device,
  L2Switch,
  type Mac,
  Pc,
  Router,
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
  getSwitch(id: DeviceId | string): L2Switch | undefined;
  getRouter(id: DeviceId | string): Router | undefined;
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

  getSwitch(id: DeviceId | string): L2Switch | undefined {
    const device = this.getDevice(id);
    return device instanceof L2Switch ? device : undefined;
  }

  getRouter(id: DeviceId | string): Router | undefined {
    const device = this.getDevice(id);
    return device instanceof Router ? device : undefined;
  }
}

function createDevice(node: NodeSpec, config: DeviceConfig, engine: SimulationEngine): Device {
  const hostname = config.hostname ?? node.name ?? node.id;
  if (node.kind === "pc") return engine.add(new Pc(node.id, hostname));
  if (node.kind === "l2-switch") return engine.add(new L2Switch(node.id, hostname));
  return engine.add(new Router(node.id, hostname));
}

function applyPhysical(device: Device, config: PhysicalInterfaceConfig): void {
  const iface = device.getInterface(config.id);
  if (!iface) throw new LabSemanticError("unknown-interface", `configurations.${device.id}`, `Unknown interface '${config.id}'`);
  if (config.description !== undefined) iface.setDescription(config.description);
  if (config.shutdown) iface.shutdown();
  else iface.noShutdown();
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
      });
    }
    if (config.dhcpEnabled) device.setDhcpEnabled(true);
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
  if (device instanceof Router && config.kind === "router") {
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
  }
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

function serializeConfiguration(device: Device, node: NodeSpec): DeviceConfig {
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
  return {
    kind: "router",
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
  };
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

import type {
  DeviceConfig,
  Layer3SwitchDeviceConfig,
  LabDocument,
  NodeSpec,
  RouterDeviceConfig,
  SwitchDeviceConfig,
  ServerDeviceConfig,
} from "@sim/contracts";
import { ipToInt, maskToInt } from "@sim/sim-core";
import { LabSemanticError } from "./errors";

function fail(code: string, path: string, message: string, context: Record<string, unknown> = {}): never {
  throw new LabSemanticError(code, path, message, context);
}

function requireUnique(values: readonly string[], path: string, label: string): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) fail("duplicate-id", `${path}[${index}]`, `Duplicate ${label} '${value}'`, { value });
    seen.add(value);
  });
}

function inSubnet(ip: string, network: string, prefixLength: number): boolean {
  const mask = maskToInt(prefixLength);
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(network) & mask) >>> 0);
}

function validateSwitch(config: SwitchDeviceConfig, node: NodeSpec, path: string): void {
  requireUnique(config.interfaces.map((iface) => iface.id), `${path}.interfaces`, "interface id");
  requireUnique(config.vlans.map((vlan) => String(vlan.id)), `${path}.vlans`, "VLAN id");
  const physical = new Set(node.interfaces.map((iface) => iface.id));
  config.interfaces.forEach((iface, index) => {
    if (!physical.has(iface.id)) {
      fail("unknown-interface", `${path}.interfaces[${index}].id`, `Unknown interface '${iface.id}'`, {
        deviceId: node.id,
      });
    }
    if (iface.allowedVlans) {
      requireUnique(iface.allowedVlans.map(String), `${path}.interfaces[${index}].allowedVlans`, "VLAN id");
    }
  });
}

function validatePhysicalInterfaces(
  interfaces: readonly { id: string }[],
  node: NodeSpec,
  path: string,
): void {
  requireUnique(interfaces.map((iface) => iface.id), `${path}.interfaces`, "interface id");
  const physical = new Set(node.interfaces.map((iface) => iface.id));
  interfaces.forEach((iface, index) => {
    if (!physical.has(iface.id)) fail("unknown-interface", `${path}.interfaces[${index}].id`, `Unknown interface '${iface.id}'`);
  });
}

function validateServer(config: ServerDeviceConfig, node: NodeSpec, path: string): void {
  validatePhysicalInterfaces(config.interfaces, node, path);
  const addressed = config.interfaces.filter((iface) => iface.ipv4 !== undefined);
  if (addressed.length > 1) {
    fail("server-multiple-l3-interfaces", `${path}.interfaces`, "M10.1 supports one active server IPv4 interface");
  }
  if (config.dhcpClientEnabled && addressed.length > 0) {
    fail("server-address-mode-conflict", path, "A server cannot use static IPv4 and DHCP at the same time");
  }
  if (config.defaultGateway && !addressed.some((iface) =>
    iface.ipv4 && inSubnet(config.defaultGateway!, iface.ipv4.address, iface.ipv4.prefixLength))) {
    fail("server-unreachable-default-gateway", `${path}.defaultGateway`, "Server default gateway is not on its connected subnet");
  }
}

function validateLayer3Switch(config: Layer3SwitchDeviceConfig, node: NodeSpec, path: string): void {
  validatePhysicalInterfaces(config.interfaces, node, path);
  requireUnique(config.vlans.map((vlan) => String(vlan.id)), `${path}.vlans`, "VLAN id");
  requireUnique(config.svis.map((svi) => String(svi.vlanId)), `${path}.svis`, "SVI VLAN id");
  const vlans = new Set(config.vlans.map((vlan) => vlan.id));
  config.svis.forEach((svi, index) => {
    if (!vlans.has(svi.vlanId)) {
      fail("unknown-svi-vlan", `${path}.svis[${index}].vlanId`, `SVI references undefined VLAN ${svi.vlanId}`);
    }
    if ((svi.ipAddress === undefined) !== (svi.prefixLength === undefined)) {
      fail("incomplete-svi-address", `${path}.svis[${index}]`, "SVI address and prefix length must be configured together");
    }
  });

  const connected = [
    ...config.interfaces.flatMap((iface) => iface.mode === "routed" && iface.ipv4 ? [iface.ipv4] : []),
    ...config.svis.flatMap((svi) => svi.ipAddress !== undefined && svi.prefixLength !== undefined
      ? [{ address: svi.ipAddress, prefixLength: svi.prefixLength }]
      : []),
  ];
  const routes = new Set<string>();
  config.staticRoutes.forEach((route, index) => {
    const key = `${route.network}/${route.prefixLength}`;
    if (routes.has(key)) fail("duplicate-static-route", `${path}.staticRoutes[${index}]`, `Duplicate static route '${key}'`);
    routes.add(key);
    const mask = maskToInt(route.prefixLength);
    if (((ipToInt(route.network) & mask) >>> 0) !== ipToInt(route.network)) {
      fail("invalid-route-network", `${path}.staticRoutes[${index}].network`, "Static route must use a network address");
    }
    if (!connected.some((iface) => inSubnet(route.nextHop, iface.address, iface.prefixLength))) {
      fail("unreachable-static-next-hop", `${path}.staticRoutes[${index}].nextHop`, `Next hop '${route.nextHop}' is not directly connected`);
    }
  });
}

function validateRouter(config: RouterDeviceConfig, node: NodeSpec, path: string): void {
  requireUnique(config.interfaces.map((iface) => iface.id), `${path}.interfaces`, "interface id");
  requireUnique(config.subinterfaces.map((iface) => iface.id), `${path}.subinterfaces`, "subinterface id");
  requireUnique(config.dhcpPools.map((pool) => pool.id), `${path}.dhcpPools`, "DHCP pool id");

  const physical = new Set(node.interfaces.map((iface) => iface.id));
  config.interfaces.forEach((iface, index) => {
    if (!physical.has(iface.id)) {
      fail("unknown-interface", `${path}.interfaces[${index}].id`, `Unknown interface '${iface.id}'`, {
        deviceId: node.id,
      });
    }
  });

  const parentVlans = new Set<string>();
  config.subinterfaces.forEach((iface, index) => {
    const ifacePath = `${path}.subinterfaces[${index}]`;
    if (!physical.has(iface.parentInterface)) {
      fail("invalid-subinterface-parent", `${ifacePath}.parentInterface`, `Unknown physical interface '${iface.parentInterface}'`);
    }
    const pair = `${iface.parentInterface}\u0000${iface.vlan}`;
    if (parentVlans.has(pair)) {
      fail("duplicate-subinterface-vlan", `${ifacePath}.vlan`, `VLAN ${iface.vlan} is already configured on '${iface.parentInterface}'`);
    }
    parentVlans.add(pair);
    const expectedId = `${iface.parentInterface}.${iface.vlan}`;
    if (iface.id !== expectedId) {
      fail("invalid-subinterface-id", `${ifacePath}.id`, `Subinterface id must be '${expectedId}'`);
    }
  });

  const connected = [
    ...config.interfaces.flatMap((iface) => (iface.ipv4 ? [iface.ipv4] : [])),
    ...config.subinterfaces.flatMap((iface) => (iface.ipv4 ? [iface.ipv4] : [])),
  ];
  config.staticRoutes.forEach((route, index) => {
    const mask = maskToInt(route.prefixLength);
    if (((ipToInt(route.network) & mask) >>> 0) !== ipToInt(route.network)) {
      fail("invalid-route-network", `${path}.staticRoutes[${index}].network`, "Static route must use a network address");
    }
    if (!connected.some((iface) => inSubnet(route.nextHop, iface.address, iface.prefixLength))) {
      fail("unreachable-static-next-hop", `${path}.staticRoutes[${index}].nextHop`, `Next hop '${route.nextHop}' is not directly connected`);
    }
  });

  const ranges: Array<{ start: number; end: number; id: string; index: number }> = [];
  config.dhcpPools.forEach((pool, index) => {
    const poolPath = `${path}.dhcpPools[${index}]`;
    const mask = maskToInt(pool.prefixLength);
    if (((ipToInt(pool.network) & mask) >>> 0) !== ipToInt(pool.network)) {
      fail("invalid-dhcp-network", `${poolPath}.network`, "DHCP pool must use a network address");
    }
    const start = ipToInt(pool.rangeStart);
    const end = ipToInt(pool.rangeEnd);
    if (start > end) fail("invalid-dhcp-range", `${poolPath}.rangeStart`, "DHCP range start is after range end");
    for (const [field, value] of [
      ["rangeStart", pool.rangeStart],
      ["rangeEnd", pool.rangeEnd],
      ["defaultGateway", pool.defaultGateway],
    ] as const) {
      if (value !== undefined && !inSubnet(value, pool.network, pool.prefixLength)) {
        fail("invalid-dhcp-subnet", `${poolPath}.${field}`, `'${value}' is outside the DHCP pool subnet`);
      }
    }
    const overlap = ranges.find((other) => start <= other.end && other.start <= end);
    if (overlap) {
      fail("overlapping-dhcp-pools", poolPath, `DHCP pool '${pool.id}' overlaps '${overlap.id}'`, {
        otherIndex: overlap.index,
      });
    }
    ranges.push({ start, end, id: pool.id, index });
  });
}

function validateConfiguration(config: DeviceConfig, node: NodeSpec, path: string): void {
  if (config.kind !== node.kind) {
    fail("configuration-type-mismatch", `${path}.kind`, `Configuration kind '${config.kind}' does not match device kind '${node.kind}'`);
  }
  if (config.kind === "l2-switch") validateSwitch(config, node, path);
  if (config.kind === "l3-switch") validateLayer3Switch(config, node, path);
  if (config.kind === "router") validateRouter(config, node, path);
  if (config.kind === "server") validateServer(config, node, path);
  if (config.kind === "hub") validatePhysicalInterfaces(config.interfaces, node, path);
  if (config.kind === "bridge") {
    validatePhysicalInterfaces(config.interfaces, node, path);
    if (node.interfaces.length !== 2) fail("invalid-bridge-interface-count", `${path}.interfaces`, "A bridge must have exactly two interfaces");
  }
  if (config.kind === "pc") {
    requireUnique(config.interfaces.map((iface) => iface.id), `${path}.interfaces`, "interface id");
    const physical = new Set(node.interfaces.map((iface) => iface.id));
    config.interfaces.forEach((iface, index) => {
      if (!physical.has(iface.id)) fail("unknown-interface", `${path}.interfaces[${index}].id`, `Unknown interface '${iface.id}'`);
    });
    if (config.dhcpEnabled && config.ipv4) {
      fail("pc-address-mode-conflict", path, "A PC cannot have static IPv4 and DHCP enabled at the same time");
    }
  }
}

export function validateLabSemantics(document: LabDocument): void {
  requireUnique(document.topology.nodes.map((node) => node.id), "topology.nodes", "node id");
  requireUnique(document.topology.links.map((link) => link.id), "topology.links", "link id");

  const nodes = new Map<string, NodeSpec>();
  for (const [index, node] of document.topology.nodes.entries()) {
    nodes.set(node.id, node);
    requireUnique(node.interfaces.map((iface) => iface.id), `topology.nodes[${index}].interfaces`, "interface id");
    node.interfaces.forEach((iface, ifaceIndex) => {
      if (iface.mac !== undefined && !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(iface.mac)) {
        fail("invalid-mac", `topology.nodes[${index}].interfaces[${ifaceIndex}].mac`, `Invalid MAC address '${iface.mac}'`);
      }
    });
  }

  const connected = new Set<string>();
  document.topology.links.forEach((link, index) => {
    const endpoints = [link.a, link.b] as const;
    if (link.a.node === link.b.node && link.a.iface === link.b.iface) {
      fail("self-link", `topology.links[${index}]`, "A link cannot connect an interface to itself");
    }
    endpoints.forEach((endpoint, endpointIndex) => {
      const endpointPath = `topology.links[${index}].${endpointIndex === 0 ? "a" : "b"}`;
      const node = nodes.get(endpoint.node);
      if (!node) fail("unknown-node", `${endpointPath}.node`, `Unknown node '${endpoint.node}'`);
      if (!node.interfaces.some((iface) => iface.id === endpoint.iface)) {
        fail("unknown-interface", `${endpointPath}.iface`, `Unknown interface '${endpoint.node}/${endpoint.iface}'`);
      }
      const key = `${endpoint.node}\u0000${endpoint.iface}`;
      if (connected.has(key)) fail("interface-already-connected", endpointPath, `Interface '${endpoint.node}/${endpoint.iface}' is connected more than once`);
      connected.add(key);
    });
  });

  for (const [deviceId, config] of Object.entries(document.configurations)) {
    const node = nodes.get(deviceId);
    if (!node) fail("unknown-configuration-device", `configurations.${deviceId}`, `Configuration references unknown device '${deviceId}'`);
    validateConfiguration(config, node, `configurations.${deviceId}`);
  }
}

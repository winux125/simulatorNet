import type {
  DeviceConfig,
  DiagramAsset,
  DiagramAssetMime,
  Layer3SwitchDeviceConfig,
  LabDocument,
  NeighborDiscoveryConfig,
  NodeSpec,
  RouterDeviceConfig,
  SwitchDeviceConfig,
  ServerDeviceConfig,
} from "@sim/contracts";
import {
  MAX_DIAGRAM_ASSET_BYTES,
  MAX_DIAGRAM_ASSET_TOTAL_BYTES,
  MAX_DIAGRAM_ASSETS,
} from "@sim/contracts";
import { DEFAULT_NEIGHBOR_DISCOVERY_CONFIG, DEFAULT_SPANNING_TREE_CONFIG } from "@sim/contracts";
import { ipToInt, maskToInt, normalizeDnsName, normalizeHttpPath, normalizeTftpFilename } from "@sim/sim-core";
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

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(value[index]!);
    const b = BASE64_ALPHABET.indexOf(value[index + 1]!);
    const c = value[index + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[index + 2]!);
    const d = value[index + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[index + 3]!);
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < output.length) output[offset++] = (bits >>> 16) & 0xff;
    if (offset < output.length) output[offset++] = (bits >>> 8) & 0xff;
    if (offset < output.length) output[offset++] = bits & 0xff;
  }
  return output;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset]! << 24) >>> 0)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!) >>> 0;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)
    || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return undefined;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame && length >= 7) {
      return { width: u16be(bytes, offset + 5), height: u16be(bytes, offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return undefined;
  const kind = ascii(bytes, 12, 16);
  if (kind === "VP8X") {
    return {
      width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
      height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
    };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
      height: 1 + (bytes[22]! >>> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
    };
  }
  if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
      height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
    };
  }
  return undefined;
}

function inspectImage(bytes: Uint8Array, mime: DiagramAssetMime): { width: number; height: number } | undefined {
  if (mime === "image/png") return pngDimensions(bytes);
  if (mime === "image/jpeg") return jpegDimensions(bytes);
  return webpDimensions(bytes);
}

function validateDiagram(document: LabDocument): void {
  const diagram = document.diagram;
  if (!diagram) return;
  const assets = diagram.assets ?? [];
  if (assets.length > MAX_DIAGRAM_ASSETS) {
    fail("diagram-asset-count-limit", "diagram.assets", `A lab may contain at most ${MAX_DIAGRAM_ASSETS} image assets`);
  }
  requireUnique(assets.map((asset) => asset.id), "diagram.assets", "diagram asset id");
  requireUnique(diagram.annotations.map((annotation) => annotation.id), "diagram.annotations", "diagram annotation id");
  requireUnique(diagram.linkLabels.map((label) => label.linkId), "diagram.linkLabels", "diagram link label");
  requireUnique(diagram.linkStyles.map((style) => style.linkId), "diagram.linkStyles", "diagram link style");
  const topologyLinkIds = new Set(document.topology.links.map((link) => link.id));
  diagram.linkLabels.forEach((label, index) => {
    if (!topologyLinkIds.has(label.linkId)) {
      fail("unknown-diagram-link", `diagram.linkLabels[${index}].linkId`, `Unknown topology link '${label.linkId}'`);
    }
  });
  diagram.linkStyles.forEach((style, index) => {
    if (!topologyLinkIds.has(style.linkId)) {
      fail("unknown-diagram-link", `diagram.linkStyles[${index}].linkId`, `Unknown topology link '${style.linkId}'`);
    }
  });
  const assetIds = new Set(assets.map((asset) => asset.id));
  let totalBytes = 0;
  assets.forEach((asset: DiagramAsset, index) => {
    const path = `diagram.assets[${index}]`;
    const bytes = decodeBase64(asset.dataBase64);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_DIAGRAM_ASSET_BYTES) {
      fail("diagram-asset-size-limit", `${path}.dataBase64`, `Image asset exceeds ${MAX_DIAGRAM_ASSET_BYTES} bytes`);
    }
    const dimensions = inspectImage(bytes, asset.mime);
    if (!dimensions) {
      fail("diagram-asset-type-mismatch", `${path}.dataBase64`, `Image data does not match declared MIME type '${asset.mime}'`);
    }
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
      fail("diagram-asset-dimension-mismatch", path, "Declared image dimensions do not match the decoded image", {
        declared: { width: asset.width, height: asset.height },
        decoded: dimensions,
      });
    }
  });
  if (totalBytes > MAX_DIAGRAM_ASSET_TOTAL_BYTES) {
    fail("diagram-assets-total-size-limit", "diagram.assets", `Embedded images exceed ${MAX_DIAGRAM_ASSET_TOTAL_BYTES} bytes`);
  }
  diagram.annotations.forEach((annotation, index) => {
    if (annotation.type === "image" && !assetIds.has(annotation.assetId)) {
      fail("unknown-diagram-asset", `diagram.annotations[${index}].assetId`, `Unknown diagram asset '${annotation.assetId}'`);
    }
  });
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
  validateSwitchProtocols(config, node, path, true);
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
  validateDiscovery(config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG, node, `${path}.discovery`, false);
  requireUnique(config.enabledServices.map((service) => service.id), `${path}.enabledServices`, "service id");
  config.enabledServices.forEach((service, index) => {
    const servicePath = `${path}.enabledServices[${index}]`;
    if (service.type === "dns") {
      requireUnique(service.records.map((record) => normalizeDnsName(record.name)), `${servicePath}.records`, "DNS name");
    } else if (service.type === "http") {
      requireUnique(service.resources.map((resource) => normalizeHttpPath(resource.path)), `${servicePath}.resources`, "HTTP path");
    } else if (service.type === "tftp") {
      requireUnique(service.files.map((file) => normalizeTftpFilename(file.filename)), `${servicePath}.files`, "TFTP filename");
    }
  });
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
  const l3Interfaces = new Set([
    ...config.interfaces.filter((iface) => iface.mode === "routed").map((iface) => iface.id),
    ...config.svis.map((svi) => `Vlan${svi.vlanId}`),
  ]);
  validateAclConfiguration(config, l3Interfaces, path);
  validateSwitchProtocols(config, node, path, true);
  validateRoutedProtocols(config, node, path, l3Interfaces, true);
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

  const l3Interfaces = new Set([
    ...config.interfaces.filter((iface) => iface.routed || iface.ipv4 !== undefined).map((iface) => iface.id),
    ...config.subinterfaces.map((iface) => iface.id),
  ]);
  validateAclConfiguration(config, l3Interfaces, path);
  requireUnique(config.natPools.map((pool) => pool.id), `${path}.natPools`, "NAT pool id");
  requireUnique(config.natRules.map((rule) => rule.id), `${path}.natRules`, "NAT rule id");
  requireUnique(config.natRules.map((rule) => String(rule.sequence)), `${path}.natRules`, "NAT sequence");
  requireUnique(config.natInterfaceRoles.map((role) => role.interfaceName), `${path}.natInterfaceRoles`, "NAT interface role");
  const poolIds = new Set(config.natPools.map((pool) => pool.id));
  const aclIds = new Set(config.acls.map((acl) => acl.id));
  config.natPools.forEach((pool, index) => {
    if (ipToInt(pool.startAddress) > ipToInt(pool.endAddress)) {
      fail("invalid-nat-pool", `${path}.natPools[${index}]`, `NAT pool '${pool.id}' start exceeds its end`);
    }
    if (ipToInt(pool.endAddress) - ipToInt(pool.startAddress) + 1 > 256) {
      fail("nat-pool-limit", `${path}.natPools[${index}]`, `NAT pool '${pool.id}' exceeds 256 addresses`);
    }
  });
  config.natRules.forEach((rule, index) => {
    if (rule.kind === "dynamic" && !poolIds.has(rule.poolId)) {
      fail("unknown-nat-pool", `${path}.natRules[${index}].poolId`, `Unknown NAT pool '${rule.poolId}'`);
    }
    if (rule.kind !== "static" && rule.source.kind === "acl" && !aclIds.has(rule.source.aclId)) {
      fail("unknown-nat-acl", `${path}.natRules[${index}].source.aclId`, `Unknown NAT ACL '${rule.source.aclId}'`);
    }
  });
  config.natInterfaceRoles.forEach((role, index) => {
    if (!l3Interfaces.has(role.interfaceName)) {
      fail("unknown-nat-interface", `${path}.natInterfaceRoles[${index}].interfaceName`, `Unknown L3 interface '${role.interfaceName}'`);
    }
  });
  if (config.natRules.length > 0) {
    const roles = new Set(config.natInterfaceRoles.map((role) => role.role));
    if (!roles.has("inside") || !roles.has("outside")) {
      fail("missing-nat-role", `${path}.natInterfaceRoles`, "NAT requires inside and outside interface roles");
    }
  }
  validateDiscovery(config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG, node, `${path}.discovery`, true);
  // OSPF runs on the router itself; the firewall and cloud reuse this shape but
  // are not OSPF speakers in this release.
  validateRoutedProtocols(config, node, path, l3Interfaces, node.kind === "router");
}

/**
 * Layer-2 control protocols: spanning tree and EtherChannel. Every reference
 * must resolve to a real interface or VLAN, a member may belong to exactly one
 * channel, and the negotiation mode must match the channel's protocol.
 */
function validateSwitchProtocols(
  config: Pick<SwitchDeviceConfig, "spanningTree" | "etherChannels" | "discovery" | "vlans">,
  node: NodeSpec,
  path: string,
  spanningTreeCapable: boolean,
): void {
  const physical = new Set(node.interfaces.map((iface) => iface.id));
  const vlans = new Set(config.vlans.map((vlan) => vlan.id));
  vlans.add(1);

  const tree = config.spanningTree ?? DEFAULT_SPANNING_TREE_CONFIG;
  const etherChannels = config.etherChannels ?? [];
  if (tree.mode !== "disabled" && !spanningTreeCapable) {
    fail("spanning-tree-unsupported", `${path}.spanningTree.mode`, `${node.kind} does not support spanning tree`);
  }
  if (tree.maxAgeSeconds < 2 * (tree.helloTimeSeconds + 1)) {
    fail("invalid-spanning-tree-timers", `${path}.spanningTree.maxAgeSeconds`,
      "Max age must be at least 2 x (hello time + 1)");
  }
  if (2 * (tree.forwardDelaySeconds - 1) < tree.maxAgeSeconds) {
    fail("invalid-spanning-tree-timers", `${path}.spanningTree.forwardDelaySeconds`,
      "2 x (forward delay - 1) must be at least max age");
  }
  requireUnique(tree.vlans.map((vlan) => String(vlan.vlanId)), `${path}.spanningTree.vlans`, "VLAN id");
  tree.vlans.forEach((vlan, index) => {
    if (!vlans.has(vlan.vlanId)) {
      fail("unknown-spanning-tree-vlan", `${path}.spanningTree.vlans[${index}].vlanId`,
        `Spanning tree references undefined VLAN ${vlan.vlanId}`);
    }
  });
  requireUnique(tree.ports.map((port) => port.interfaceId), `${path}.spanningTree.ports`, "interface id");
  tree.ports.forEach((port, index) => {
    if (!physical.has(port.interfaceId) && parsePortChannelId(port.interfaceId) === undefined) {
      fail("unknown-spanning-tree-interface", `${path}.spanningTree.ports[${index}].interfaceId`,
        `Unknown interface '${port.interfaceId}'`);
    }
    if (port.bpduGuard && !port.portFast) {
      fail("bpdu-guard-requires-portfast", `${path}.spanningTree.ports[${index}].bpduGuard`,
        "BPDU Guard protects an edge port; enable PortFast on the same interface");
    }
  });

  requireUnique(etherChannels.map((channel) => String(channel.channelId)), `${path}.etherChannels`, "channel id");
  const claimed = new Map<string, number>();
  etherChannels.forEach((channel, index) => {
    const channelPath = `${path}.etherChannels[${index}]`;
    requireUnique(channel.members, `${channelPath}.members`, "member interface");
    for (const member of channel.members) {
      if (!physical.has(member)) {
        fail("unknown-channel-member", `${channelPath}.members`, `Unknown interface '${member}'`);
      }
      const owner = claimed.get(member);
      if (owner !== undefined) {
        fail("duplicate-channel-member", `${channelPath}.members`,
          `Interface '${member}' already belongs to Port-channel${owner}`);
      }
      claimed.set(member, channel.channelId);
    }
    if (channel.minimumLinks !== undefined && channel.minimumLinks > channel.members.length) {
      fail("invalid-minimum-links", `${channelPath}.minimumLinks`,
        "Minimum links cannot exceed the number of members");
    }
    const switchport = channel.switchport;
    if (switchport?.mode === "access" && !vlans.has(switchport.accessVlan)) {
      fail("unknown-channel-vlan", `${channelPath}.switchport.accessVlan`,
        `Port-channel${channel.channelId} references undefined VLAN ${switchport.accessVlan}`);
    }
    for (const vlan of switchport?.allowedVlans ?? []) {
      if (!vlans.has(vlan)) {
        fail("unknown-channel-vlan", `${channelPath}.switchport.allowedVlans`,
          `Port-channel${channel.channelId} allows undefined VLAN ${vlan}`);
      }
    }
  });

  validateDiscovery(config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG, node, `${path}.discovery`, node.kind !== "server");
}

function validateDiscovery(
  config: NeighborDiscoveryConfig,
  node: NodeSpec,
  path: string,
  cdpCapable: boolean,
): void {
  if (config.cdpEnabled && !cdpCapable) {
    fail("cdp-unsupported", `${path}.cdpEnabled`, `${node.kind} does not speak CDP; use LLDP instead`);
  }
  if (config.cdpHoldTimeSeconds <= config.cdpIntervalSeconds) {
    fail("invalid-discovery-timers", `${path}.cdpHoldTimeSeconds`, "CDP hold time must exceed the interval");
  }
  if (config.lldpHoldTimeSeconds <= config.lldpIntervalSeconds) {
    fail("invalid-discovery-timers", `${path}.lldpHoldTimeSeconds`, "LLDP hold time must exceed the interval");
  }
  requireUnique(config.interfaces.map((iface) => iface.interfaceId), `${path}.interfaces`, "interface id");
  const physical = new Set(node.interfaces.map((iface) => iface.id));
  config.interfaces.forEach((iface, index) => {
    if (!physical.has(iface.interfaceId)) {
      fail("unknown-discovery-interface", `${path}.interfaces[${index}].interfaceId`,
        `Unknown interface '${iface.interfaceId}'`);
    }
  });
}

/** Loopback interfaces and the single area-0 OSPF process. */
function validateRoutedProtocols(
  config: Pick<RouterDeviceConfig, "loopbacks" | "ospf">,
  node: NodeSpec,
  path: string,
  l3Interfaces: ReadonlySet<string>,
  ospfCapable: boolean,
): void {
  const loopbacks = config.loopbacks ?? [];
  requireUnique(loopbacks.map((loopback) => String(loopback.id)), `${path}.loopbacks`, "loopback id");
  const loopbackNames = new Set(loopbacks.map((loopback) => `Loopback${loopback.id}`));

  const ospf = config.ospf;
  if (ospf === undefined) return;
  if (!ospfCapable) {
    fail("ospf-unsupported", `${path}.ospf`, `${node.kind} does not support OSPF in this release`);
  }
  const ospfInterfaces = new Set([...l3Interfaces, ...loopbackNames]);
  ospf.networks.forEach((statement, index) => {
    if (statement.area !== 0) {
      fail("unsupported-ospf-area", `${path}.ospf.networks[${index}].area`, "Only OSPF area 0 is supported");
    }
    // A wildcard is the inverse of a mask: its set bits form a contiguous run
    // of low bits, so adding one must clear every one of them.
    const wildcard = ipToInt(statement.wildcard);
    if ((((wildcard + 1) & wildcard) >>> 0) !== 0) {
      fail("invalid-ospf-wildcard", `${path}.ospf.networks[${index}].wildcard`,
        `'${statement.wildcard}' is not a contiguous wildcard mask`);
    }
    if ((ipToInt(statement.network) & wildcard) !== 0) {
      fail("invalid-ospf-network", `${path}.ospf.networks[${index}].network`,
        "OSPF network statement must use a network address for its wildcard");
    }
  });
  requireUnique(
    ospf.networks.map((statement) => `${statement.network} ${statement.wildcard}`),
    `${path}.ospf.networks`,
    "network statement",
  );
  requireUnique(ospf.passiveInterfaces, `${path}.ospf.passiveInterfaces`, "passive interface");
  ospf.passiveInterfaces.forEach((interfaceId, index) => {
    if (!ospfInterfaces.has(interfaceId)) {
      fail("unknown-ospf-interface", `${path}.ospf.passiveInterfaces[${index}]`,
        `Unknown L3 interface '${interfaceId}'`);
    }
  });
  requireUnique(ospf.interfaces.map((iface) => iface.interfaceId), `${path}.ospf.interfaces`, "interface id");
  ospf.interfaces.forEach((iface, index) => {
    const ifacePath = `${path}.ospf.interfaces[${index}]`;
    if (!ospfInterfaces.has(iface.interfaceId)) {
      fail("unknown-ospf-interface", `${ifacePath}.interfaceId`, `Unknown L3 interface '${iface.interfaceId}'`);
    }
    if (iface.area !== undefined && iface.area !== 0) {
      fail("unsupported-ospf-area", `${ifacePath}.area`, "Only OSPF area 0 is supported");
    }
    if (iface.cost !== undefined && iface.cost < 1) {
      fail("invalid-ospf-cost", `${ifacePath}.cost`, "OSPF interface cost must be positive");
    }
    if (iface.helloIntervalSeconds !== undefined
      && iface.deadIntervalSeconds !== undefined
      && iface.deadIntervalSeconds <= iface.helloIntervalSeconds) {
      fail("invalid-ospf-timers", `${ifacePath}.deadIntervalSeconds`,
        "OSPF dead interval must exceed the hello interval");
    }
  });
}

function parsePortChannelId(name: string): number | undefined {
  const match = /^Port-channel(\d+)$/i.exec(name);
  return match ? Number(match[1]) : undefined;
}

function validateAclConfiguration(
  config: Pick<RouterDeviceConfig, "acls" | "aclBindings">,
  l3Interfaces: ReadonlySet<string>,
  path: string,
): void {
  requireUnique(config.acls.map((acl) => acl.id), `${path}.acls`, "ACL id");
  const aclIds = new Set(config.acls.map((acl) => acl.id));
  config.acls.forEach((acl, index) => {
    requireUnique(acl.rules.map((rule) => String(rule.sequence)), `${path}.acls[${index}].rules`, "ACL sequence");
    if (acl.type === "extended") {
      acl.rules.forEach((rule, ruleIndex) => {
        [rule.sourcePort, rule.destinationPort].forEach((matcher) => {
          if (matcher?.kind === "range" && matcher.start > matcher.end) {
            fail("invalid-acl-port-range", `${path}.acls[${index}].rules[${ruleIndex}]`, "ACL port range start exceeds end");
          }
        });
      });
    }
  });
  requireUnique(
    config.aclBindings.map((binding) => `${binding.interfaceName}\u0000${binding.direction}`),
    `${path}.aclBindings`,
    "ACL binding",
  );
  config.aclBindings.forEach((binding, index) => {
    if (!aclIds.has(binding.aclId)) {
      fail("unknown-acl", `${path}.aclBindings[${index}].aclId`, `Unknown ACL '${binding.aclId}'`);
    }
    if (!l3Interfaces.has(binding.interfaceName)) {
      fail("unknown-acl-interface", `${path}.aclBindings[${index}].interfaceName`, `Unknown L3 interface '${binding.interfaceName}'`);
    }
  });
}

function validateConfiguration(config: DeviceConfig, node: NodeSpec, path: string): void {
  if (config.kind !== node.kind) {
    fail("configuration-type-mismatch", `${path}.kind`, `Configuration kind '${config.kind}' does not match device kind '${node.kind}'`);
  }
  if (config.kind === "l2-switch") validateSwitch(config, node, path);
  if (config.kind === "l3-switch") validateLayer3Switch(config, node, path);
  if (config.kind === "router") validateRouter(config, node, path);
  if (config.kind === "firewall" || config.kind === "cloud") {
    validateRouter({ ...config, kind: "router" }, node, path);
  }
  if (config.kind === "firewall") {
    requireUnique(config.zones.map((zone) => zone.interfaceName), `${path}.zones`, "firewall zone interface");
    requireUnique(config.firewallPolicies.map((policy) => policy.id), `${path}.firewallPolicies`, "firewall policy id");
    requireUnique(
      config.firewallPolicies.map((policy) => String(policy.sequence)),
      `${path}.firewallPolicies`,
      "firewall policy sequence",
    );
    const l3Interfaces = new Set([
      ...config.interfaces.filter((iface) => iface.routed || iface.ipv4 !== undefined).map((iface) => iface.id),
      ...config.subinterfaces.map((iface) => iface.id),
    ]);
    const zones = new Set(config.zones.map((zone) => zone.zone.toLowerCase()));
    config.zones.forEach((zone, index) => {
      if (!l3Interfaces.has(zone.interfaceName)) {
        fail("unknown-firewall-interface", `${path}.zones[${index}].interfaceName`, `Unknown L3 interface '${zone.interfaceName}'`);
      }
    });
    config.firewallPolicies.forEach((policy, index) => {
      for (const [field, zone] of [["sourceZone", policy.sourceZone], ["destinationZone", policy.destinationZone]] as const) {
        if (zone !== "*" && !zones.has(zone.toLowerCase())) {
          fail("unknown-firewall-zone", `${path}.firewallPolicies[${index}].${field}`, `Unknown firewall zone '${zone}'`);
        }
      }
      for (const matcher of [policy.sourcePort, policy.destinationPort]) {
        if (matcher?.kind === "range" && matcher.start > matcher.end) {
          fail("invalid-firewall-port-range", `${path}.firewallPolicies[${index}]`, "Firewall port range start exceeds end");
        }
      }
    });
  }
  if (config.kind === "cloud" && (node.interfaces.length < 2 || node.interfaces.length > 8)) {
    fail("invalid-cloud-interface-count", `${path}.interfaces`, "Cloud / ISP requires 2-8 Ethernet interfaces");
  }
  if (config.kind === "cloud") {
    requireUnique(config.impairments.map((entry) => entry.interfaceName), `${path}.impairments`, "cloud impairment interface");
    const physical = new Set(node.interfaces.map((iface) => iface.id));
    config.impairments.forEach((entry, index) => {
      if (!physical.has(entry.interfaceName)) {
        fail("unknown-cloud-interface", `${path}.impairments[${index}].interfaceName`, `Unknown cloud interface '${entry.interfaceName}'`);
      }
    });
  }
  if (config.kind === "server") validateServer(config, node, path);
  if (config.kind === "external-appliance") validatePhysicalInterfaces(config.interfaces, node, path);
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
  if (config.kind === "traffic-generator") {
    requireUnique(config.interfaces.map((iface) => iface.id), `${path}.interfaces`, "interface id");
    validatePhysicalInterfaces(config.interfaces, node, path);
    if (config.dhcpEnabled && config.ipv4) {
      fail("traffic-address-mode-conflict", path, "A Traffic Generator cannot have static IPv4 and DHCP enabled together");
    }
    requireUnique(config.flows.map((flow) => flow.id), `${path}.flows`, "traffic flow id");
  }
}

export function validateLabSemantics(document: LabDocument): void {
  requireUnique(document.topology.nodes.map((node) => node.id), "topology.nodes", "node id");
  requireUnique(document.topology.links.map((link) => link.id), "topology.links", "link id");
  validateDiagram(document);

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

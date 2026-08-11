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
  isDefaultVpnConfiguration,
  MAX_DIAGRAM_ASSET_BYTES,
  MAX_DIAGRAM_ASSET_TOTAL_BYTES,
  MAX_DIAGRAM_ASSETS,
  placementLastRackUnit,
} from "@sim/contracts";
import {
  DEFAULT_NEIGHBOR_DISCOVERY_CONFIG,
  DEFAULT_SPANNING_TREE_CONFIG,
  getDeviceHardwareProfile,
  getDeviceProfile,
  resolveDeviceInterfaceTemplates,
} from "@sim/contracts";
import {
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  ipToInt,
  ipv6InPrefix,
  ipv6Network,
  MAXIMUM_AS_PATH_MATCH_LENGTH,
  maskToInt,
  normalizeDnsName,
  normalizeHttpPath,
  normalizeIpv6,
  normalizeTftpFilename,
} from "@sim/sim-core";
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

/**
 * Physical placement is presentation-only, but it must still be *coherent*:
 * every reference resolves, one device is drawn once, and two devices never
 * claim the same rack unit. A background image reuses the diagram asset pool,
 * so it inherits the validated PNG/JPEG/WebP rules rather than adding a second
 * image path.
 */
function validatePhysical(document: LabDocument): void {
  const physical = document.physical;
  if (!physical) return;
  requireUnique(physical.sites.map((site) => site.id), "physical.sites", "site id");
  const assetIds = new Set((document.diagram?.assets ?? []).map((asset) => asset.id));
  const rooms = new Map<string, { siteId: string; racks: Map<string, number> }>();
  physical.sites.forEach((site, siteIndex) => {
    const sitePath = `physical.sites[${siteIndex}]`;
    requireUnique(site.rooms.map((room) => room.id), `${sitePath}.rooms`, "room id");
    site.rooms.forEach((room, roomIndex) => {
      const roomPath = `${sitePath}.rooms[${roomIndex}]`;
      if (rooms.has(room.id)) {
        fail("duplicate-id", `${roomPath}.id`, `Duplicate room id '${room.id}'`, { value: room.id });
      }
      if (room.backgroundAssetId !== undefined && !assetIds.has(room.backgroundAssetId)) {
        fail("unknown-diagram-asset", `${roomPath}.backgroundAssetId`,
          `Unknown diagram asset '${room.backgroundAssetId}'`);
      }
      requireUnique(room.racks.map((rack) => rack.id), `${roomPath}.racks`, "rack id");
      rooms.set(room.id, {
        siteId: site.id,
        racks: new Map(room.racks.map((rack) => [rack.id, rack.rackUnits])),
      });
    });
  });

  const deviceIds = new Set(document.topology.nodes.map((node) => node.id));
  requireUnique(
    physical.devicePlacements.map((placement) => placement.deviceId),
    "physical.devicePlacements",
    "device placement",
  );
  const claimedUnits = new Map<string, Map<number, string>>();
  physical.devicePlacements.forEach((placement, index) => {
    const path = `physical.devicePlacements[${index}]`;
    if (!deviceIds.has(placement.deviceId)) {
      fail("unknown-placement-device", `${path}.deviceId`, `Unknown device '${placement.deviceId}'`);
    }
    const room = rooms.get(placement.roomId);
    if (!room) fail("unknown-physical-room", `${path}.roomId`, `Unknown room '${placement.roomId}'`);
    if (room.siteId !== placement.siteId) {
      fail("physical-room-site-mismatch", `${path}.siteId`,
        `Room '${placement.roomId}' belongs to site '${room.siteId}'`);
    }
    if (placement.rackId === undefined) {
      if (placement.rackUnit !== undefined) {
        fail("physical-rack-unit-without-rack", `${path}.rackUnit`,
          "A rack unit requires a rack; a free-placed device uses x/y instead");
      }
      return;
    }
    const rackUnits = room.racks.get(placement.rackId);
    if (rackUnits === undefined) {
      fail("unknown-physical-rack", `${path}.rackId`,
        `Unknown rack '${placement.rackId}' in room '${placement.roomId}'`);
    }
    if (placement.rackUnit === undefined) {
      fail("physical-rack-unit-required", `${path}.rackUnit`, "A rack-mounted device requires a rack unit");
    }
    const last = placementLastRackUnit(placement);
    if (last > rackUnits) {
      fail("physical-rack-unit-overflow", `${path}.rackUnit`,
        `Rack '${placement.rackId}' has ${rackUnits} units; this device would end at U${last}`);
    }
    const claimed = claimedUnits.get(placement.rackId) ?? new Map<number, string>();
    for (let unit = placement.rackUnit; unit <= last; unit++) {
      const owner = claimed.get(unit);
      if (owner !== undefined) {
        fail("physical-rack-unit-occupied", `${path}.rackUnit`,
          `Rack unit U${unit} of '${placement.rackId}' is already occupied by '${owner}'`);
      }
      claimed.set(unit, placement.deviceId);
    }
    claimedUnits.set(placement.rackId, claimed);
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
  if (config.bgp && !config.ipRoutingEnabled) {
    fail("bgp-requires-ip-routing", `${path}.bgp`, "BGP on an L3 Switch requires 'ip routing'");
  }
  validateRoutedProtocols(config, node, path, l3Interfaces, true);
  const vrfIds = validateVtepVrfs(config, path);
  validateAnycastGateway(config, path);
  validateVxlan(config, path, vlans, connected);
  validateL3Vnis(config, path, vrfIds);
}

/**
 * Tenant VRFs on a VTEP.
 *
 * Since M10.15 an L3 Switch carries plain tenant VRFs, because an EVPN tenant
 * is the isolation boundary an L3VNI transports. MPLS, LDP and VPN labels stay
 * Router-only: what the switch gains is the routing context, not L3VPN — so a
 * VRF here is validated for identity, route targets and its own static routes
 * and nothing else.
 */
function validateVtepVrfs(config: Layer3SwitchDeviceConfig, path: string): ReadonlySet<string> {
  const vrfs = config.vrfs ?? [];
  requireUnique(vrfs.map((vrf) => vrf.id), `${path}.vrfs`, "VRF id");
  requireUnique(vrfs.map((vrf) => vrf.name.toLowerCase()), `${path}.vrfs`, "VRF name");
  requireUnique(vrfs.map((vrf) => vrf.routeDistinguisher), `${path}.vrfs`, "route distinguisher");
  const vrfIds = new Set(vrfs.map((vrf) => vrf.id));
  config.svis.forEach((svi, index) => {
    if (svi.vrfId !== undefined && !vrfIds.has(svi.vrfId)) {
      fail("unknown-vrf", `${path}.svis[${index}].vrfId`, `Unknown VRF '${svi.vrfId}'`);
    }
  });
  for (const [vrfIndex, vrf] of vrfs.entries()) {
    const vrfPath = `${path}.vrfs[${vrfIndex}]`;
    requireUnique(vrf.importRouteTargets, `${vrfPath}.importRouteTargets`, "import route target");
    requireUnique(vrf.exportRouteTargets, `${vrfPath}.exportRouteTargets`, "export route target");
    // An L3 Switch VRF is reached through its SVIs, so a VRF static route's next
    // hop has to sit in a prefix that same VRF actually carries.
    const vrfConnected = config.svis.flatMap((svi) => (svi.vrfId === vrf.id
      && svi.ipAddress !== undefined && svi.prefixLength !== undefined
      ? [{ address: svi.ipAddress, prefixLength: svi.prefixLength }]
      : []));
    requireUnique(
      vrf.staticRoutes.map((route) => `${route.network}/${route.prefixLength}`),
      `${vrfPath}.staticRoutes`,
      "VRF static route",
    );
    vrf.staticRoutes.forEach((route, routeIndex) => {
      if (((ipToInt(route.network) & maskToInt(route.prefixLength)) >>> 0) !== ipToInt(route.network)) {
        fail("invalid-vrf-route-network", `${vrfPath}.staticRoutes[${routeIndex}].network`,
          "VRF static route must use a canonical network address");
      }
      if (!vrfConnected.some((iface) => inSubnet(route.nextHop, iface.address, iface.prefixLength))) {
        fail("unreachable-vrf-next-hop", `${vrfPath}.staticRoutes[${routeIndex}].nextHop`,
          `VRF next hop '${route.nextHop}' is not reachable in VRF '${vrf.id}'`);
      }
    });
    // MPLS L3VPN stays Router-only, so an L3 Switch tenant is IPv4 only.
    if (vrf.addressFamilyIpv6 === true || (vrf.ipv6StaticRoutes?.length ?? 0) > 0) {
      fail("vrf-ipv6-unsupported", `${vrfPath}.addressFamilyIpv6`,
        `VRF '${vrf.id}' on an L3 Switch is IPv4 only: EVPN Type 5 and the L3VNI are IPv4 in this release`);
    }
  }
  return vrfIds;
}

/**
 * VXLAN and BGP EVPN semantics.
 *
 * Only an L3 Switch reaches this function, which is the VTEP boundary itself:
 * `Layer3SwitchDeviceConfig` is the one device configuration that carries `nve`,
 * so a Router or an L2 Switch can never declare one.
 */
function validateVxlan(
  config: Layer3SwitchDeviceConfig,
  path: string,
  vlans: ReadonlySet<number>,
  connected: ReadonlyArray<{ address: string; prefixLength: number }>,
): void {
  const evpnVnis = new Map((config.evpn?.vnis ?? []).map((vni) => [vni.vni, vni]));
  (config.evpn?.vnis ?? []).forEach((vni, index) => {
    const vniPath = `${path}.evpn.vnis[${index}]`;
    if ((config.evpn?.vnis ?? []).filter((entry) => entry.vni === vni.vni).length > 1) {
      fail("duplicate-evpn-vni", `${vniPath}.vni`, `Duplicate 'evpn vni ${vni.vni} l2' block`);
    }
    if (vni.importRouteTargets.length === 0 && vni.exportRouteTargets.length === 0) {
      fail("evpn-vni-without-route-target", vniPath, `EVPN VNI ${vni.vni} has no import or export route target`);
    }
  });

  validateEthernetSegments(config, path, evpnVnis);

  const nve = config.nve;
  if (!nve) return;
  const nvePath = `${path}.nve`;
  const loopbacks = new Set((config.loopbacks ?? []).map((loopback) => `Loopback${loopback.id}`));
  if (!loopbacks.has(nve.sourceInterfaceId)) {
    // A VTEP sources from a Loopback so the tunnel endpoint survives any single
    // physical port going down; a routed port or an SVI is not a valid source.
    fail("invalid-nve-source", `${nvePath}.sourceInterfaceId`,
      `NVE source '${nve.sourceInterfaceId}' must be a configured Loopback interface`);
  }
  const localAddresses = new Set([
    ...(config.loopbacks ?? []).flatMap((loopback) => (loopback.ipv4 ? [loopback.ipv4.address] : [])),
    ...connected.map((entry) => entry.address),
  ]);
  const seenVnis = new Set<number>();
  const seenVlans = new Set<number>();
  nve.members.forEach((member, index) => {
    const memberPath = `${nvePath}.members[${index}]`;
    // One VLAN maps to at most one VNI, and one VNI to at most one VLAN.
    if (seenVnis.has(member.vni)) fail("duplicate-vni-mapping", `${memberPath}.vni`, `VNI ${member.vni} is already mapped`);
    if (seenVlans.has(member.vlanId)) {
      fail("duplicate-vlan-vni-mapping", `${memberPath}.vlanId`, `VLAN ${member.vlanId} is already mapped to a VNI`);
    }
    seenVnis.add(member.vni);
    seenVlans.add(member.vlanId);
    if (!vlans.has(member.vlanId)) {
      fail("unknown-vni-vlan", `${memberPath}.vlanId`, `VNI ${member.vni} maps undefined VLAN ${member.vlanId}`);
    }
    if (member.replication.type === "static") {
      // A repeated peer address is deduplicated by canonicalization and by the
      // engine alike, so only a peer that is *this* switch is an error.
      member.replication.peerAddresses.forEach((peer, peerIndex) => {
        if (localAddresses.has(peer)) {
          fail("local-vtep-peer", `${memberPath}.replication.peerAddresses[${peerIndex}]`,
            `Remote VTEP '${peer}' is a local address of this switch`);
        }
      });
      return;
    }
    // BGP EVPN ingress replication needs the control plane that carries it.
    if (!evpnVnis.has(member.vni)) {
      fail("evpn-vni-not-defined", `${memberPath}.vni`,
        `VNI ${member.vni} uses BGP EVPN ingress replication but has no 'evpn vni ${member.vni} l2' block`);
    }
    const evpnNeighbors = (config.bgp?.neighbors ?? []).filter((neighbor) => neighbor.evpnActivated);
    if (evpnNeighbors.length === 0) {
      fail("evpn-address-family-inactive", `${memberPath}.replication`,
        `VNI ${member.vni} uses BGP EVPN ingress replication but no neighbor activates 'address-family l2vpn evpn'`);
    }
    const withoutExtended = evpnNeighbors.find((neighbor) => !neighbor.sendCommunityExtended);
    if (withoutExtended) {
      // Without extended communities no route target crosses the session, so
      // every EVPN route would be advertised and then silently rejected.
      fail("evpn-extended-community-required", `${path}.bgp.neighbors`,
        `EVPN neighbor ${withoutExtended.address} needs 'send-community extended' to carry route targets`);
    }
  });
}

/**
 * EVPN Ethernet Segments.
 *
 * What is checked here is what makes a document *loadable*: a well-formed ESI,
 * a supported redundancy mode, an attachment that exists and belongs to only one
 * segment. Whether the other leaf actually shares the ESI, whether its route
 * targets match and who wins the Designated Forwarder election are runtime
 * questions — a document that gets those wrong still opens, and says so in
 * Problems rather than refusing to load at all.
 */
function validateEthernetSegments(
  config: Layer3SwitchDeviceConfig,
  path: string,
  evpnVnis: ReadonlyMap<number, unknown>,
): void {
  const segments = config.evpn?.ethernetSegments ?? [];
  if (segments.length === 0) return;
  const mappedVlans = new Map((config.nve?.members ?? []).map((member) => [member.vlanId, member.vni]));
  const attachments = new Map<string, string>();
  const seenIds = new Set<string>();
  const seenEsis = new Set<string>();
  segments.forEach((segment, index) => {
    const segmentPath = `${path}.evpn.ethernetSegments[${index}]`;
    if (seenIds.has(segment.id)) {
      fail("duplicate-ethernet-segment", `${segmentPath}.id`, `Duplicate Ethernet Segment '${segment.id}'`);
    }
    if (seenEsis.has(segment.esi)) {
      fail("duplicate-esi", `${segmentPath}.esi`, `ESI ${segment.esi} is already used on this device`);
    }
    seenIds.add(segment.id);
    seenEsis.add(segment.esi);
    if (segment.interfaces.length === 0) {
      fail("ethernet-segment-without-attachment", `${segmentPath}.interfaces`,
        `Ethernet Segment '${segment.id}' has no attachment`);
    }
    segment.interfaces.forEach((name, attachmentIndex) => {
      const attachmentPath = `${segmentPath}.interfaces[${attachmentIndex}]`;
      const owner = attachments.get(name);
      if (owner !== undefined) {
        fail("ethernet-segment-attachment-reused", attachmentPath,
          `Interface '${name}' already belongs to Ethernet Segment '${owner}'`);
      }
      attachments.set(name, segment.id);
      const iface = config.interfaces.find((entry) => entry.id === name);
      if (!iface) {
        // A Port-channel lands here too: an L3 Switch has no Port-channel
        // configuration block, so a binding on one could never be saved.
        fail("unknown-ethernet-segment-attachment", attachmentPath,
          `Ethernet Segment '${segment.id}' names interface '${name}', which is not an access switchport on this device`);
      }
      // A segment attaches a CE, so it lives on an access switchport or a
      // Port-channel — never a routed core port, a Loopback, an SVI or nve1.
      if (iface && iface.mode !== "access") {
        fail("invalid-ethernet-segment-attachment", attachmentPath,
          `Interface '${name}' must be an access switchport to carry an Ethernet Segment`);
      }
      if (iface && iface.mode === "access" && !mappedVlans.has(iface.accessVlan)) {
        fail("ethernet-segment-vlan-not-mapped", attachmentPath,
          `Ethernet Segment '${segment.id}' attaches VLAN ${iface.accessVlan}, which maps to no VNI`);
      }
      if (iface && iface.mode === "access") {
        const vni = mappedVlans.get(iface.accessVlan);
        if (vni !== undefined && !evpnVnis.has(vni)) {
          fail("ethernet-segment-vni-not-defined", attachmentPath,
            `Ethernet Segment '${segment.id}' serves VNI ${vni}, which has no 'evpn vni ${vni} l2' block`);
        }
      }
    });
  });
}

/**
 * The distributed anycast gateway.
 *
 * Two leaves presenting the same gateway IP and the same MAC is the *point* of
 * a distributed gateway, so it is deliberately never reported as a duplicate:
 * the only errors here are an SVI that adopts a fabric MAC nobody declared, and
 * a gateway with no address to answer for.
 */
function validateAnycastGateway(config: Layer3SwitchDeviceConfig, path: string): void {
  const fabricMac = config.evpn?.anycastGatewayMac;
  config.svis.forEach((svi, index) => {
    if (svi.anycastGateway !== true) return;
    if (fabricMac === undefined) {
      fail("anycast-gateway-mac-missing", `${path}.svis[${index}].anycastGateway`,
        `SVI Vlan${svi.vlanId} runs in anycast-gateway mode but no 'fabric forwarding anycast-gateway-mac' is configured`);
    }
    if (svi.ipAddress === undefined) {
      fail("anycast-gateway-without-address", `${path}.svis[${index}]`,
        `SVI Vlan${svi.vlanId} is an anycast gateway but has no IPv4 address to answer for`);
    }
  });
}

/**
 * L3VNIs: `member vni <n> associate-vrf <name>`.
 *
 * A VNI is either bridged or routed, never both; one L3VNI belongs to at most
 * one VRF per VTEP and a VRF carries at most one. An L3VNI has no VLAN and no
 * broadcast domain, so it never gets a `vlan configuration` block either.
 */
function validateL3Vnis(
  config: Layer3SwitchDeviceConfig,
  path: string,
  vrfIds: ReadonlySet<string>,
): void {
  const nve = config.nve;
  const vrfMembers = nve?.vrfMembers ?? [];
  const nvePath = `${path}.nve`;
  if (vrfMembers.length > DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumL3VnisPerVtep) {
    fail("too-many-l3vnis", `${nvePath}.vrfMembers`,
      `A VTEP carries at most ${DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumL3VnisPerVtep} L3VNIs`);
  }
  const bridgedVnis = new Set((nve?.members ?? []).map((member) => member.vni));
  const seenVnis = new Set<number>();
  const seenVrfs = new Set<string>();
  vrfMembers.forEach((member, index) => {
    const memberPath = `${nvePath}.vrfMembers[${index}]`;
    // A routed transit segment has no VLAN and no broadcast domain, so a VNI is
    // either bridged or routed — never both.
    if (bridgedVnis.has(member.vni)) {
      fail("vni-bridged-and-routed", `${memberPath}.vni`,
        `VNI ${member.vni} already maps a VLAN and cannot also be an L3VNI`);
    }
    if (seenVnis.has(member.vni)) {
      fail("duplicate-l3vni", `${memberPath}.vni`, `L3VNI ${member.vni} is already mapped`);
    }
    if (seenVrfs.has(member.vrfId)) {
      fail("duplicate-vrf-l3vni", `${memberPath}.vrfId`, `VRF '${member.vrfId}' already has an L3VNI`);
    }
    seenVnis.add(member.vni);
    seenVrfs.add(member.vrfId);
    if (!vrfIds.has(member.vrfId)) {
      fail("unknown-vrf", `${memberPath}.vrfId`, `L3VNI ${member.vni} names undefined VRF '${member.vrfId}'`);
    }
  });

  // Origination into EVPN is never implicit: `advertise l2vpn evpn` needs the
  // tenant, the transit segment and the export policy that carry it.
  (config.vrfs ?? []).forEach((vrf, index) => {
    if (vrf.advertiseEvpn !== true) return;
    const vrfPath = `${path}.vrfs[${index}]`;
    if (!seenVrfs.has(vrf.id)) {
      fail("advertise-evpn-without-l3vni", `${vrfPath}.advertiseEvpn`,
        `VRF '${vrf.id}' advertises into EVPN but has no 'member vni <n> associate-vrf ${vrf.id}' L3VNI`);
    }
    if (vrf.exportRouteTargets.length === 0) {
      fail("advertise-evpn-without-route-target", `${vrfPath}.exportRouteTargets`,
        `VRF '${vrf.id}' advertises into EVPN but exports no route target`);
    }
    if (!(config.bgp?.neighbors ?? []).some((neighbor) => neighbor.evpnActivated)) {
      fail("evpn-address-family-inactive", `${vrfPath}.advertiseEvpn`,
        `VRF '${vrf.id}' advertises into EVPN but no neighbor activates 'address-family l2vpn evpn'`);
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

  // Every subnet this device is directly attached to. A logical interface
  // counts: a loopback and a GRE tunnel overlay each produce a connected route,
  // so a static route through an overlay next hop is legitimate.
  const connected = [
    ...config.interfaces.flatMap((iface) => (iface.ipv4 && iface.vrfId === undefined ? [iface.ipv4] : [])),
    ...config.subinterfaces.flatMap((iface) => (iface.ipv4 && iface.vrfId === undefined ? [iface.ipv4] : [])),
    ...(config.loopbacks ?? []).flatMap((loopback) => (loopback.ipv4 ? [loopback.ipv4] : [])),
    ...(config.vpn?.tunnels ?? []).flatMap((tunnel) => (tunnel.ipv4 ? [tunnel.ipv4] : [])),
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
  const vrfs = config.vrfs ?? [];
  if (node.kind !== "router" && (
    vrfs.length > 0
    || config.ldp !== undefined
    || config.interfaces.some((iface) => iface.mplsEnabled || iface.vrfId !== undefined)
    || config.subinterfaces.some((iface) => iface.vrfId !== undefined)
  )) {
    fail("mpls-vrf-unsupported", path, "MPLS, LDP and VRF configuration is supported only on Router devices");
  }
  requireUnique(vrfs.map((vrf) => vrf.id), `${path}.vrfs`, "VRF id");
  requireUnique(vrfs.map((vrf) => vrf.name.toLowerCase()), `${path}.vrfs`, "VRF name");
  requireUnique(vrfs.map((vrf) => vrf.routeDistinguisher), `${path}.vrfs`, "route distinguisher");
  const vrfIds = new Set(vrfs.map((vrf) => vrf.id));
  config.interfaces.forEach((iface, index) => {
    if (iface.vrfId !== undefined && !vrfIds.has(iface.vrfId)) {
      fail("unknown-vrf", `${path}.interfaces[${index}].vrfId`, `Unknown VRF '${iface.vrfId}'`);
    }
    if (iface.vrfId !== undefined && iface.mplsEnabled) {
      fail("mpls-vrf-interface-conflict", `${path}.interfaces[${index}]`, "A customer VRF interface cannot also be an MPLS core interface");
    }
  });
  config.subinterfaces.forEach((iface, index) => {
    if (iface.vrfId !== undefined && !vrfIds.has(iface.vrfId)) {
      fail("unknown-vrf", `${path}.subinterfaces[${index}].vrfId`, `Unknown VRF '${iface.vrfId}'`);
    }
  });
  const loopbackNames = new Set((config.loopbacks ?? []).map((entry) => `Loopback${entry.id}`));
  if (config.ldp?.routerIdInterface !== undefined
    && !l3Interfaces.has(config.ldp.routerIdInterface)
    && !loopbackNames.has(config.ldp.routerIdInterface)) {
    fail("unknown-ldp-router-id", `${path}.ldp.routerIdInterface`, `Unknown LDP router-id source '${config.ldp.routerIdInterface}'`);
  }
  for (const [vrfIndex, vrf] of vrfs.entries()) {
    requireUnique(vrf.importRouteTargets, `${path}.vrfs[${vrfIndex}].importRouteTargets`, "import route target");
    requireUnique(vrf.exportRouteTargets, `${path}.vrfs[${vrfIndex}].exportRouteTargets`, "export route target");
    const vrfConnected = [
      ...config.interfaces.flatMap((iface) => iface.vrfId === vrf.id && iface.ipv4 ? [iface.ipv4] : []),
      ...config.subinterfaces.flatMap((iface) => iface.vrfId === vrf.id && iface.ipv4 ? [iface.ipv4] : []),
    ];
    requireUnique(vrf.staticRoutes.map((route) => `${route.network}/${route.prefixLength}`), `${path}.vrfs[${vrfIndex}].staticRoutes`, "VRF static route");
    vrf.staticRoutes.forEach((route, routeIndex) => {
      if (((ipToInt(route.network) & maskToInt(route.prefixLength)) >>> 0) !== ipToInt(route.network)) {
        fail("invalid-vrf-route-network", `${path}.vrfs[${vrfIndex}].staticRoutes[${routeIndex}].network`, "VRF static route must use a canonical network address");
      }
      if (!vrfConnected.some((iface) => inSubnet(route.nextHop, iface.address, iface.prefixLength))) {
        fail("unreachable-vrf-next-hop", `${path}.vrfs[${vrfIndex}].staticRoutes[${routeIndex}].nextHop`, `VRF next hop '${route.nextHop}' is not reachable in VRF '${vrf.id}'`);
      }
    });
    // An IPv6 route inside a VRF needs that VRF's IPv6 address family, and its
    // next hop has to sit in a prefix the same VRF actually carries.
    const vrfIpv6Routes = vrf.ipv6StaticRoutes ?? [];
    if (vrfIpv6Routes.length > 0 && !vrf.addressFamilyIpv6) {
      fail("vrf-ipv6-family-missing", `${path}.vrfs[${vrfIndex}].ipv6StaticRoutes`, `VRF '${vrf.id}' has IPv6 routes without 'address-family ipv6'`);
    }
    requireUnique(vrfIpv6Routes.map((route) => `${route.network}/${route.prefixLength}`), `${path}.vrfs[${vrfIndex}].ipv6StaticRoutes`, "VRF IPv6 static route");
    const vrfIpv6Connected = [
      ...config.interfaces.flatMap((iface) => (iface.vrfId === vrf.id ? iface.ipv6 ?? [] : [])),
      ...config.subinterfaces.flatMap((iface) => (iface.vrfId === vrf.id ? iface.ipv6 ?? [] : [])),
    ];
    vrfIpv6Routes.forEach((route, routeIndex) => {
      if (ipv6Network(route.network, route.prefixLength) !== normalizeIpv6(route.network)) {
        fail("invalid-vrf-route-network", `${path}.vrfs[${vrfIndex}].ipv6StaticRoutes[${routeIndex}].network`, "VRF IPv6 static route must use a canonical network address");
      }
      if (!vrfIpv6Connected.some((iface) => ipv6InPrefix(route.nextHop, iface.address, iface.prefixLength))) {
        fail("unreachable-vrf-next-hop", `${path}.vrfs[${vrfIndex}].ipv6StaticRoutes[${routeIndex}].nextHop`, `VRF next hop '${route.nextHop}' is not reachable in VRF '${vrf.id}'`);
      }
    });
  }
  for (const [index, family] of (config.bgp?.vrfAddressFamilies ?? []).entries()) {
    if (!vrfIds.has(family.vrfId)) {
      fail("unknown-bgp-vrf", `${path}.bgp.vrfAddressFamilies[${index}].vrfId`, `Unknown BGP VRF '${family.vrfId}'`);
    }
  }
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
  validateVpn(config, node, path, l3Interfaces);
  validateDiscovery(config.discovery ?? DEFAULT_NEIGHBOR_DISCOVERY_CONFIG, node, `${path}.discovery`, true);
  // OSPF runs on the router itself; the firewall and cloud reuse this shape but
  // are not OSPF speakers in this release.
  validateRoutedProtocols(config, node, path, l3Interfaces, node.kind === "router");
}

/**
 * Site-to-site VPN: every tunnel, peer, proposal and profile reference must
 * resolve, the device must actually terminate tunnels, and a configuration that
 * is statically guaranteed to recurse is rejected before the lab is built.
 *
 * Only configuration is validated. IKE state, security associations, SPIs,
 * sequence numbers and counters never appear in a document, so there is nothing
 * runtime-shaped here to check.
 */
function validateVpn(
  config: RouterDeviceConfig,
  node: NodeSpec,
  path: string,
  l3Interfaces: ReadonlySet<string>,
): void {
  const vpn = config.vpn;
  if (!vpn || isDefaultVpnConfiguration(vpn)) return;
  const vpnPath = `${path}.vpn`;
  if (!getDeviceProfile(node.kind).capabilities.includes("vpn-tunnel")) {
    fail(
      "unsupported-vpn-device",
      vpnPath,
      `Device type '${node.kind}' does not terminate GRE tunnels or IPsec profiles`,
      { deviceId: node.id },
    );
  }

  requireUnique(vpn.tunnels.map((tunnel) => String(tunnel.id)), `${vpnPath}.tunnels`, "tunnel id");
  requireUnique(vpn.proposals.map((entry) => entry.id), `${vpnPath}.proposals`, "IKEv2 proposal id");
  requireUnique(vpn.ikePeers.map((entry) => entry.id), `${vpnPath}.ikePeers`, "IKEv2 peer id");
  requireUnique(vpn.ipsecProfiles.map((entry) => entry.id), `${vpnPath}.ipsecProfiles`, "IPsec profile id");

  const proposalIds = new Set(vpn.proposals.map((entry) => entry.id));
  const peerIds = new Set(vpn.ikePeers.map((entry) => entry.id));
  const profileIds = new Set(vpn.ipsecProfiles.map((entry) => entry.id));

  vpn.ikePeers.forEach((peer, index) => {
    if (!proposalIds.has(peer.proposalId)) {
      fail("unknown-ike-proposal", `${vpnPath}.ikePeers[${index}].proposalId`, `Unknown IKEv2 proposal '${peer.proposalId}'`);
    }
  });
  vpn.ipsecProfiles.forEach((profile, index) => {
    const profilePath = `${vpnPath}.ipsecProfiles[${index}]`;
    if (!peerIds.has(profile.ikePeerId)) {
      fail("unknown-ike-peer", `${profilePath}.ikePeerId`, `Unknown IKEv2 peer '${profile.ikePeerId}'`);
    }
    if (!proposalIds.has(profile.proposalId)) {
      fail("unknown-ike-proposal", `${profilePath}.proposalId`, `Unknown IKEv2 proposal '${profile.proposalId}'`);
    }
  });

  const physical = new Set(node.interfaces.map((iface) => iface.id));
  vpn.tunnels.forEach((tunnel, index) => {
    const tunnelPath = `${vpnPath}.tunnels[${index}]`;
    if (tunnel.source.type === "interface") {
      const sourceId = tunnel.source.interfaceId;
      if (!physical.has(sourceId) && !l3Interfaces.has(sourceId)) {
        fail("unknown-tunnel-source", `${tunnelPath}.source.interfaceId`, `Unknown tunnel source interface '${sourceId}'`);
      }
    } else if (!ownsTunnelSourceAddress(config, tunnel.source.address)) {
      fail(
        "unknown-tunnel-source",
        `${tunnelPath}.source.address`,
        `Tunnel source address '${tunnel.source.address}' is not configured on this device`,
      );
    }
    // A destination inside the tunnel's own overlay subnet always recurses, and
    // that is decidable from the document alone.
    if (tunnel.ipv4 && inSubnet(tunnel.destinationAddress, tunnel.ipv4.address, tunnel.ipv4.prefixLength)) {
      fail(
        "recursive-tunnel-route",
        `${tunnelPath}.destinationAddress`,
        `Tunnel${tunnel.id} destination '${tunnel.destinationAddress}' is inside its own overlay subnet`,
      );
    }
    if (tunnel.ipsecProfileId !== undefined && !profileIds.has(tunnel.ipsecProfileId)) {
      fail("unknown-ipsec-profile", `${tunnelPath}.ipsecProfileId`, `Unknown IPsec profile '${tunnel.ipsecProfileId}'`);
    }
  });
}

/** True when a tunnel source address is one this device actually owns. */
function ownsTunnelSourceAddress(config: RouterDeviceConfig, address: string): boolean {
  const owned = [
    ...config.interfaces.flatMap((iface) => (iface.ipv4 ? [iface.ipv4.address] : [])),
    ...config.subinterfaces.flatMap((iface) => (iface.ipv4 ? [iface.ipv4.address] : [])),
    ...(config.loopbacks ?? []).flatMap((loopback) => (loopback.ipv4 ? [loopback.ipv4.address] : [])),
  ];
  return owned.includes(address);
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

function validateBgpConfiguration(
  config: Pick<RouterDeviceConfig, "bgp" | "prefixLists" | "ipv6PrefixLists" | "routeMaps" | "communityLists" | "asPathLists" | "vrfs">,
  node: NodeSpec,
  path: string,
  interfaceNames: ReadonlySet<string>,
  bgpCapable: boolean,
): void {
  const prefixLists = config.prefixLists ?? [];
  const ipv6PrefixLists = config.ipv6PrefixLists ?? [];
  const routeMaps = config.routeMaps ?? [];
  const communityLists = config.communityLists ?? [];
  const asPathLists = config.asPathLists ?? [];
  requireUnique(prefixLists.map((list) => list.id), `${path}.prefixLists`, "prefix-list name");
  requireUnique(ipv6PrefixLists.map((list) => list.id), `${path}.ipv6PrefixLists`, "IPv6 prefix-list name");
  requireUnique(routeMaps.map((map) => map.id), `${path}.routeMaps`, "route-map name");
  requireUnique(communityLists.map((list) => list.id), `${path}.communityLists`, "community-list name");
  requireUnique(asPathLists.map((list) => list.id), `${path}.asPathLists`, "AS-path list name");
  const ipv6PrefixListIds = new Set(ipv6PrefixLists.map((list) => list.id));
  ipv6PrefixLists.forEach((list, listIndex) => {
    requireUnique(list.entries.map((entry) => String(entry.sequence)), `${path}.ipv6PrefixLists[${listIndex}].entries`, "prefix-list sequence");
    list.entries.forEach((entry, entryIndex) => {
      const entryPath = `${path}.ipv6PrefixLists[${listIndex}].entries[${entryIndex}]`;
      if (ipv6Network(entry.prefix, entry.prefixLength) !== normalizeIpv6(entry.prefix)) {
        fail("invalid-prefix-list-network", `${entryPath}.prefix`, "Prefix-list entry must use a canonical network address");
      }
      if (entry.ge !== undefined && entry.ge < entry.prefixLength) {
        fail("invalid-prefix-list-range", `${entryPath}.ge`, "Prefix-list ge cannot be shorter than its prefix length");
      }
      if (entry.le !== undefined && entry.le < (entry.ge ?? entry.prefixLength)) {
        fail("invalid-prefix-list-range", `${entryPath}.le`, "Prefix-list le cannot be shorter than ge or the prefix length");
      }
    });
  });
  const prefixListIds = new Set(prefixLists.map((list) => list.id));
  const routeMapIds = new Set(routeMaps.map((map) => map.id));
  const communityListIds = new Set(communityLists.map((list) => list.id));
  const asPathListIds = new Set(asPathLists.map((list) => list.id));
  communityLists.forEach((list, listIndex) => {
    requireUnique(list.entries.map((entry) => String(entry.sequence)), `${path}.communityLists[${listIndex}].entries`, "community-list sequence");
    list.entries.forEach((entry, entryIndex) => {
      for (const [communityIndex, community] of entry.communities.entries()) {
        if (!isCanonicalCommunity(community)) {
          fail(
            "invalid-bgp-community",
            `${path}.communityLists[${listIndex}].entries[${entryIndex}].communities[${communityIndex}]`,
            `Community '${community}' must be <0-65535>:<0-65535>, 'internet', 'no-export' or 'no-advertise'`,
          );
        }
      }
    });
  });
  asPathLists.forEach((list, listIndex) => {
    requireUnique(list.entries.map((entry) => String(entry.sequence)), `${path}.asPathLists[${listIndex}].entries`, "AS-path list sequence");
    list.entries.forEach((entry, entryIndex) => {
      if (entry.matcher.kind === "exact" && entry.matcher.asPath.length > MAXIMUM_AS_PATH_MATCH_LENGTH) {
        fail(
          "invalid-as-path-matcher",
          `${path}.asPathLists[${listIndex}].entries[${entryIndex}].matcher`,
          `An exact AS-path match holds at most ${MAXIMUM_AS_PATH_MATCH_LENGTH} AS numbers`,
        );
      }
    });
  });
  prefixLists.forEach((list, listIndex) => {
    requireUnique(list.entries.map((entry) => String(entry.sequence)), `${path}.prefixLists[${listIndex}].entries`, "prefix-list sequence");
    list.entries.forEach((entry, entryIndex) => {
      const entryPath = `${path}.prefixLists[${listIndex}].entries[${entryIndex}]`;
      if (((ipToInt(entry.prefix) & maskToInt(entry.prefixLength)) >>> 0) !== ipToInt(entry.prefix)) {
        fail("invalid-prefix-list-network", `${entryPath}.prefix`, "Prefix-list entry must use a canonical network address");
      }
      if (entry.ge !== undefined && entry.ge < entry.prefixLength) {
        fail("invalid-prefix-list-range", `${entryPath}.ge`, "Prefix-list ge cannot be shorter than its prefix length");
      }
      if (entry.le !== undefined && entry.le < (entry.ge ?? entry.prefixLength)) {
        fail("invalid-prefix-list-range", `${entryPath}.le`, "Prefix-list le cannot be shorter than ge or the prefix length");
      }
    });
  });
  routeMaps.forEach((map, mapIndex) => {
    requireUnique(map.sequences.map((sequence) => String(sequence.sequence)), `${path}.routeMaps[${mapIndex}].sequences`, "route-map sequence");
    map.sequences.forEach((sequence, sequenceIndex) => {
      const sequencePath = `${path}.routeMaps[${mapIndex}].sequences[${sequenceIndex}]`;
      sequence.match?.prefixListIds?.forEach((id, idIndex) => {
        if (!prefixListIds.has(id)) {
          fail("unknown-prefix-list", `${sequencePath}.match.prefixListIds[${idIndex}]`, `Unknown prefix-list '${id}'`);
        }
      });
      sequence.match?.communityListIds?.forEach((id, idIndex) => {
        if (!communityListIds.has(id)) {
          fail("unknown-community-list", `${sequencePath}.match.communityListIds[${idIndex}]`, `Unknown community-list '${id}'`);
        }
      });
      sequence.match?.asPathListIds?.forEach((id, idIndex) => {
        if (!asPathListIds.has(id)) {
          fail("unknown-as-path-list", `${sequencePath}.match.asPathListIds[${idIndex}]`, `Unknown AS-path list '${id}'`);
        }
      });
      sequence.set?.communities?.forEach((community, communityIndex) => {
        if (!isCanonicalCommunity(community)) {
          fail("invalid-bgp-community", `${sequencePath}.set.communities[${communityIndex}]`, `Community '${community}' is not supported`);
        }
      });
      if (sequence.set?.communityNone && sequence.set.communities?.length) {
        fail("invalid-bgp-community", `${sequencePath}.set.communityNone`, "'set community none' cannot be combined with community values");
      }
      sequence.set?.prependAsns?.forEach((asn, asnIndex) => {
        if (!Number.isInteger(asn) || asn < 1) {
          fail("invalid-as-path-prepend", `${sequencePath}.set.prependAsns[${asnIndex}]`, "An AS-path prepend cannot use AS 0");
        }
      });
    });
  });
  const bgp = config.bgp;
  if (!bgp) return;
  if (!bgpCapable) fail("bgp-unsupported", `${path}.bgp`, `${node.kind} does not support BGP in this release`);
  if (bgp.holdTimeSeconds !== undefined && bgp.holdTimeSeconds !== 0
    && (bgp.keepaliveSeconds ?? 60) * 3 > bgp.holdTimeSeconds) {
    fail("invalid-bgp-timers", `${path}.bgp.holdTimeSeconds`, "BGP hold time must be zero or at least three times the keepalive time");
  }
  requireUnique(bgp.neighbors.map((neighbor) => neighbor.address), `${path}.bgp.neighbors`, "BGP neighbor");
  requireUnique(bgp.networks.map((network) => `${network.network}/${network.prefixLength}`), `${path}.bgp.networks`, "BGP network statement");
  bgp.networks.forEach((network, index) => {
    if (((ipToInt(network.network) & maskToInt(network.prefixLength)) >>> 0) !== ipToInt(network.network)) {
      fail("invalid-bgp-network", `${path}.bgp.networks[${index}].network`, "BGP network statement must use a canonical network address");
    }
  });
  const ipv6Networks = bgp.ipv6Networks ?? [];
  requireUnique(
    ipv6Networks.map((network) => `${normalizeIpv6(network.network)}/${network.prefixLength}`),
    `${path}.bgp.ipv6Networks`,
    "BGP network statement",
  );
  ipv6Networks.forEach((network, index) => {
    if (ipv6Network(network.network, network.prefixLength) !== normalizeIpv6(network.network)) {
      fail("invalid-bgp-network", `${path}.bgp.ipv6Networks[${index}].network`, "BGP network statement must use a canonical network address");
    }
  });
  // A VRF may only redistribute into VPNv6 when it actually carries IPv6.
  const ipv6Vrfs = new Set((config.vrfs ?? []).filter((vrf) => vrf.addressFamilyIpv6).map((vrf) => vrf.id));
  bgp.vrfAddressFamilies.forEach((family, index) => {
    if ((family.redistributeConnectedIpv6 || family.redistributeStaticIpv6) && !ipv6Vrfs.has(family.vrfId)) {
      fail(
        "vrf-ipv6-family-missing",
        `${path}.bgp.vrfAddressFamilies[${index}]`,
        `VRF '${family.vrfId}' redistributes into VPNv6 without 'address-family ipv6'`,
      );
    }
  });
  const aggregates = bgp.aggregates ?? [];
  requireUnique(aggregates.map((aggregate) => `${aggregate.prefix}/${aggregate.prefixLength}`), `${path}.bgp.aggregates`, "BGP aggregate");
  aggregates.forEach((aggregate, index) => {
    if (((ipToInt(aggregate.prefix) & maskToInt(aggregate.prefixLength)) >>> 0) !== ipToInt(aggregate.prefix)) {
      fail("invalid-bgp-aggregate", `${path}.bgp.aggregates[${index}].prefix`, "A BGP aggregate must use a canonical network address");
    }
  });
  bgp.neighbors.forEach((neighbor, index) => {
    const neighborPath = `${path}.bgp.neighbors[${index}]`;
    if (neighbor.updateSource !== undefined && !interfaceNames.has(neighbor.updateSource)) {
      fail("unknown-bgp-update-source", `${neighborPath}.updateSource`, `Unknown BGP update-source interface '${neighbor.updateSource}'`);
    }
    // Reflection is an intra-AS relationship; an eBGP peer already receives
    // every path this device selects.
    if ((neighbor.routeReflectorClient || neighbor.ipv6?.routeReflectorClient) && neighbor.remoteAs !== bgp.localAs) {
      fail(
        "route-reflector-client-on-ebgp",
        `${neighborPath}.routeReflectorClient`,
        `Route-reflector-client requires an iBGP neighbor; ${neighbor.address} is in AS ${neighbor.remoteAs}`,
      );
    }
    // A VPN family without `send-community extended` is a *runtime* problem,
    // not an invalid document: a lab that teaches the missing-route-target
    // failure has to stay loadable, so it is reported in Problems instead.
    for (const [field, id, known] of [
      ["ipv6.prefixListIn", neighbor.ipv6?.prefixListIn, ipv6PrefixListIds],
      ["ipv6.prefixListOut", neighbor.ipv6?.prefixListOut, ipv6PrefixListIds],
      ["ipv6.routeMapIn", neighbor.ipv6?.routeMapIn, routeMapIds],
      ["ipv6.routeMapOut", neighbor.ipv6?.routeMapOut, routeMapIds],
      ["ipv6.defaultOriginateRouteMap", neighbor.ipv6?.defaultOriginateRouteMap, routeMapIds],
      ["prefixListIn", neighbor.prefixListIn, prefixListIds],
      ["prefixListOut", neighbor.prefixListOut, prefixListIds],
      ["routeMapIn", neighbor.routeMapIn, routeMapIds],
      ["routeMapOut", neighbor.routeMapOut, routeMapIds],
      ["defaultOriginateRouteMap", neighbor.defaultOriginateRouteMap, routeMapIds],
    ] as const) {
      if (id !== undefined && !known.has(id)) fail("unknown-bgp-policy", `${neighborPath}.${field}`, `Unknown BGP policy '${id}'`);
    }
  });
}

/** Mirrors the engine's canonical community grammar without importing it. */
function isCanonicalCommunity(value: string): boolean {
  if (value === "internet" || value === "no-export" || value === "no-advertise") return true;
  const match = /^(\d{1,5}):(\d{1,5})$/u.exec(value);
  return match !== null && Number(match[1]) <= 65_535 && Number(match[2]) <= 65_535;
}

/** Loopback interfaces and the single area-0 OSPF/BGP process. */
function validateRoutedProtocols(
  config: Pick<
    RouterDeviceConfig,
    "loopbacks" | "ospf" | "bgp" | "prefixLists" | "ipv6PrefixLists" | "routeMaps" | "communityLists" | "asPathLists" | "vrfs"
  >,
  node: NodeSpec,
  path: string,
  l3Interfaces: ReadonlySet<string>,
  ospfCapable: boolean,
): void {
  const loopbacks = config.loopbacks ?? [];
  requireUnique(loopbacks.map((loopback) => String(loopback.id)), `${path}.loopbacks`, "loopback id");
  const loopbackNames = new Set(loopbacks.map((loopback) => `Loopback${loopback.id}`));

  validateBgpConfiguration(config, node, path, new Set([...l3Interfaces, ...loopbackNames]), ospfCapable);

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
  if (config.kind === "laptop" || config.kind === "smartphone") {
    validatePhysicalInterfaces(config.interfaces, node, path);
    if (config.dhcpEnabled && config.ipv4) {
      fail("host-address-mode-conflict", path, "A wireless host cannot use static IPv4 and DHCP at the same time");
    }
    const wireless = resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId)
      .find((iface) => iface.media === "wireless");
    if (!wireless || !node.interfaces.some((iface) => iface.id === wireless.id)) {
      fail("wireless-interface-missing", `${path}.wireless`, "A wireless host requires its wlan0 topology interface");
    }
  }
  if (config.kind === "access-point") {
    validatePhysicalInterfaces(config.interfaces, node, path);
    if (
      config.radio.band !== config.accessPoint.band
      || config.radio.radioDomainId !== config.accessPoint.radioDomainId
      || !config.radio.supportedChannels.includes(config.accessPoint.channel)
    ) {
      fail("wireless-radio-mismatch", `${path}.accessPoint`, "Access point settings do not match its radio");
    }
  }
  if (config.kind === "wireless-router") {
    validatePhysicalInterfaces(config.interfaces, node, path);
    if (
      config.radio.band !== config.accessPoint.band
      || config.radio.radioDomainId !== config.accessPoint.radioDomainId
      || !config.radio.supportedChannels.includes(config.accessPoint.channel)
    ) {
      fail("wireless-radio-mismatch", `${path}.accessPoint`, "Wireless router access point settings do not match its radio");
    }
    for (const [field, address] of [
      ["dhcpRangeStart", config.lan.dhcpRangeStart],
      ["dhcpRangeEnd", config.lan.dhcpRangeEnd],
    ] as const) {
      if (!inSubnet(address, config.lan.address, config.lan.prefixLength)) {
        fail("wireless-router-dhcp-subnet", `${path}.lan.${field}`, "DHCP range must be inside the LAN subnet");
      }
    }
    if (ipToInt(config.lan.dhcpRangeStart) > ipToInt(config.lan.dhcpRangeEnd)) {
      fail("wireless-router-dhcp-range", `${path}.lan`, "DHCP range start exceeds its end");
    }
    if (
      config.wan.mode === "static"
      && (config.wan.address === undefined || config.wan.prefixLength === undefined)
    ) {
      fail("wireless-router-wan-static", `${path}.wan`, "Static WAN mode requires an address and prefix length");
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
  validatePhysical(document);

  const nodes = new Map<string, NodeSpec>();
  for (const [index, node] of document.topology.nodes.entries()) {
    nodes.set(node.id, node);
    if (node.hardwareProfileId && getDeviceHardwareProfile(node.hardwareProfileId).deviceType !== node.kind) {
      fail(
        "hardware-profile-kind-mismatch",
        `topology.nodes[${index}].hardwareProfileId`,
        `Hardware profile '${node.hardwareProfileId}' is not compatible with '${node.kind}'.`,
      );
    }
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
      const template = resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId).find(
        (iface) => iface.id === endpoint.iface,
      );
      if (template?.media === "wireless") {
        fail(
          "wireless-interface-cabled",
          `${endpointPath}.iface`,
          `Wireless interface '${endpoint.node}/${endpoint.iface}' connects through its radio configuration, not a cable`,
        );
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

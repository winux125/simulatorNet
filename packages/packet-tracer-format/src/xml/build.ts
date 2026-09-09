/**
 * Assembles a `PacketTracerDocument` from a parsed XML tree.
 *
 * The tree is injected (see `tree.ts`), so this package holds the format
 * knowledge while `@sim/importers` supplies the one hardened parser. Nothing
 * below this point knows about SimulatorNet, and nothing above it sees an XML
 * node.
 */
import { DEFAULT_PACKET_TRACER_LIMITS, type PacketTracerLimits } from "../config/limits";
import { ACTIVITY_ROOT, NETWORK_ROOT } from "../container/detect";
import { locateActivityNetworks, readActivityMetadata, type LocatedNetwork } from "./activities";
import { findDevicesContainer, parseDevices } from "./devices";
import { findLinksContainer, parseLinks } from "./links";
import type {
  PacketTracerDevice,
  PacketTracerDocument,
  PacketTracerDocumentFormat,
  PacketTracerInterface,
  PacketTracerNetwork,
  PacketTracerParseWarning,
} from "./packet-tracer-document";
import { childNamed, descendantsNamed, type XmlLike } from "./tree";

const upperName = (node: XmlLike): string => {
  const colon = node.name.lastIndexOf(":");
  return (colon >= 0 ? node.name.slice(colon + 1) : node.name).toUpperCase();
};

/**
 * Attach interface names to devices from the links that reference them. A
 * `<PORT>` carries no name, so a cable endpoint is the file's only
 * authoritative statement of an interface's name — see `devices.ts`.
 */
function attachInterfaces(
  devices: readonly PacketTracerDevice[],
  links: PacketTracerNetwork["links"],
): { devices: PacketTracerDevice[]; warnings: PacketTracerParseWarning[] } {
  const warnings: PacketTracerParseWarning[] = [];
  const byDevice = new Map<string, string[]>();
  const record = (deviceId: string, name: string | undefined): void => {
    if (name === undefined) return;
    const list = byDevice.get(deviceId) ?? [];
    if (!list.includes(name)) list.push(name);
    byDevice.set(deviceId, list);
  };
  for (const link of links) {
    record(link.sourceDeviceId, link.sourceInterface);
    record(link.targetDeviceId, link.targetInterface);
  }

  const withInterfaces = devices.map((device): PacketTracerDevice => {
    const names = byDevice.get(device.id) ?? [];
    // A cable can never name more interfaces than the chassis has ports; if it
    // does, the file disagrees with itself and the user should know.
    if (device.portCount > 0 && names.length > device.portCount) {
      warnings.push({
        code: "device-port-overflow",
        message: `${device.hostname ?? device.id} has ${device.portCount} port(s) but ${names.length} cabled interface(s).`,
        deviceId: device.id,
      });
    }
    const interfaces: PacketTracerInterface[] = names.map((name) => ({ name, derivedFromCable: true }));
    return { ...device, interfaces };
  });

  return { devices: withInterfaces, warnings };
}

function buildNetwork(
  node: XmlLike,
  id: string,
  name: string | undefined,
  limits: PacketTracerLimits,
): { network: PacketTracerNetwork; warnings: PacketTracerParseWarning[] } {
  const warnings: PacketTracerParseWarning[] = [];
  // A `<PACKETTRACER5>` wraps its topology in `<NETWORK>`; an inner network node
  // may already be that container.
  const container = upperName(node) === "NETWORK" ? node : (childNamed(node, "NETWORK") ?? node);

  const devicesNode = findDevicesContainer(container);
  const parsedDevices = devicesNode
    ? parseDevices(devicesNode, limits)
    : { devices: [], warnings: [{ code: "no-devices", message: "This network declares no DEVICES container." }] };
  warnings.push(...parsedDevices.warnings);

  const deviceIds = new Set(parsedDevices.devices.map((device) => device.id));
  const linksNode = findLinksContainer(container);
  const parsedLinks = linksNode
    ? parseLinks(linksNode, deviceIds, limits)
    : { links: [], warnings: [] };
  warnings.push(...parsedLinks.warnings);

  const attached = attachInterfaces(parsedDevices.devices, parsedLinks.links);
  warnings.push(...attached.warnings);

  return {
    network: { id, name, devices: attached.devices, links: parsedLinks.links },
    warnings,
  };
}

export interface BuildPacketTracerDocumentOptions {
  readonly format: PacketTracerDocumentFormat;
  readonly version?: string;
  readonly limits?: PacketTracerLimits;
}

/** Build the normalized document from a parsed `PACKETTRACER5[_ACTIVITY]` tree. */
export function buildPacketTracerDocument(
  root: XmlLike,
  options: BuildPacketTracerDocumentOptions,
): PacketTracerDocument {
  const limits = options.limits ?? DEFAULT_PACKET_TRACER_LIMITS;
  const warnings: PacketTracerParseWarning[] = [];
  const rootName = upperName(root);

  if (rootName === ACTIVITY_ROOT) {
    const located = locateActivityNetworks(root, limits);
    warnings.push(...located.warnings);

    let candidates: readonly LocatedNetwork[] = located.networks;
    if (candidates.length === 0) {
      // An activity with no wrapped network still has a topology of its own.
      const bare = descendantsNamed(root, "NETWORK", 1)[0];
      if (bare) candidates = [{ node: bare, role: "unknown", name: "Network" }];
    }

    const networks: PacketTracerNetwork[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const built = buildNetwork(candidate.node, `pt-network-${index + 1}`, candidate.name, limits);
      warnings.push(...built.warnings);
      networks.push(built.network);
    }

    const activity = readActivityMetadata(
      root,
      networks.map((network, index) => ({
        kind: candidates[index]!.role,
        name: candidates[index]!.name,
        networkId: network.id,
      })),
    );

    return { format: options.format, version: options.version, networks, activity, warnings };
  }

  if (rootName !== NETWORK_ROOT && rootName !== "NETWORK") {
    warnings.push({
      code: "unexpected-root",
      message: `Read <${root.name}> as a Packet Tracer network document.`,
    });
  }

  const built = buildNetwork(root, "pt-network-1", undefined, limits);
  warnings.push(...built.warnings);
  return { format: options.format, version: options.version, networks: [built.network], warnings };
}

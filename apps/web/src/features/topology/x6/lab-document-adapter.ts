import { resolveDeviceInterfaceTemplates, type LabDocument, type NodeSpec, type Topology } from "@sim/contracts";
import { allocateId } from "../../lab/document";
import type { ConnectionValidation, GraphLinkModel, GraphNodeModel, TopologyDraftLink } from "./types";

// Pure translation between the canonical LabDocument topology and the plain
// view models X6 renders. No X6 imports here so this is unit-testable in Node.

function endpointKey(node: string, iface: string): string {
  return `${node}␟${iface}`;
}

function occupancy(topology: Topology, ignoreLinkId?: string): Set<string> {
  const used = new Set<string>();
  for (const link of topology.links) {
    if (link.id === ignoreLinkId) continue;
    used.add(endpointKey(link.a.node, link.a.iface));
    used.add(endpointKey(link.b.node, link.b.iface));
  }
  return used;
}

/** Project every LabDocument node into a structural graph node (stable IDs). */
export function toGraphNodes(document: LabDocument): GraphNodeModel[] {
  const used = occupancy(document.topology);
  return document.topology.nodes.map((node) => {
    const interfaces = ethernetInterfaceIds(node);
    return {
      id: node.id,
      position: node.position ?? { x: 0, y: 0 },
      interfaces,
      occupiedInterfaces: interfaces
      .filter((iface) => used.has(endpointKey(node.id, iface))),
    };
  });
}

/** Project every LabDocument link, preserving domain node + interface IDs. */
export function toGraphLinks(document: LabDocument): GraphLinkModel[] {
  return document.topology.links.map((link) => {
    const presentation = document.diagram?.linkStyles.find((style) => style.linkId === link.id);
    return {
      id: link.id,
      source: link.a.node,
      sourcePort: link.a.iface,
      target: link.b.node,
      targetPort: link.b.iface,
      route: presentation?.route ?? "straight",
      vertices: presentation?.vertices.map((vertex) => ({ ...vertex })) ?? [],
    };
  });
}

function findInterface(topology: Topology, nodeId: string, ifaceId: string): boolean {
  return Boolean(topology.nodes.find((node) => node.id === nodeId)?.interfaces.some((iface) => iface.id === ifaceId));
}

function ethernetInterfaceIds(node: NodeSpec): string[] {
  const media = new Map(
    resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId).map((iface) => [iface.id, iface.media]),
  );
  return node.interfaces
    .map((iface) => iface.id)
    .filter((id) => media.get(id) !== "wireless");
}

function isEthernetInterface(topology: Topology, nodeId: string, ifaceId: string): boolean {
  const node = topology.nodes.find((entry) => entry.id === nodeId);
  return node ? ethernetInterfaceIds(node).includes(ifaceId) : false;
}

/** Validate a device-to-device drag before asking the user to choose interfaces. */
export function validateDeviceConnection(
  document: LabDocument,
  source: string,
  target: string,
  options: { locked?: boolean; ignoreLinkId?: string } = {},
): ConnectionValidation {
  if (options.locked) {
    return { ok: false, code: "TOPOLOGY_LOCKED", message: "Stop the lab before changing links." };
  }
  const topology = document.topology;
  const sourceNode = topology.nodes.find((node) => node.id === source);
  const targetNode = topology.nodes.find((node) => node.id === target);
  if (!sourceNode) {
    return { ok: false, code: "SOURCE_MISSING", message: `Unknown source device '${source}'.` };
  }
  if (!targetNode) {
    return { ok: false, code: "TARGET_MISSING", message: `Unknown target device '${target}'.` };
  }
  if (source === target) {
    return { ok: false, code: "SELF_LINK", message: "A device cannot be connected to itself." };
  }
  const used = occupancy(topology, options.ignoreLinkId);
  if (!ethernetInterfaceIds(sourceNode).some((iface) => !used.has(endpointKey(source, iface)))) {
    return { ok: false, code: "SOURCE_OCCUPIED", message: `All interfaces on '${source}' are already connected.` };
  }
  if (!ethernetInterfaceIds(targetNode).some((iface) => !used.has(endpointKey(target, iface)))) {
    return { ok: false, code: "TARGET_OCCUPIED", message: `All interfaces on '${target}' are already connected.` };
  }
  return { ok: true };
}

/**
 * Validate a proposed link before it is ever created, so invalid edges never
 * flash on the canvas. All simulator interfaces are Ethernet, so compatibility
 * reduces to "both endpoints exist and are distinct, free interfaces".
 */
export function validateConnection(
  document: LabDocument,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
  options: { locked?: boolean; ignoreLinkId?: string } = {},
): ConnectionValidation {
  if (options.locked) {
    return { ok: false, code: "TOPOLOGY_LOCKED", message: "Stop the lab before changing links." };
  }
  const topology = document.topology;
  if (!topology.nodes.some((node) => node.id === source)) {
    return { ok: false, code: "SOURCE_MISSING", message: `Unknown source device '${source}'.` };
  }
  if (!topology.nodes.some((node) => node.id === target)) {
    return { ok: false, code: "TARGET_MISSING", message: `Unknown target device '${target}'.` };
  }
  if (!findInterface(topology, source, sourcePort)) {
    return { ok: false, code: "SOURCE_PORT_MISSING", message: `Unknown interface '${sourcePort}' on '${source}'.` };
  }
  if (!findInterface(topology, target, targetPort)) {
    return { ok: false, code: "TARGET_PORT_MISSING", message: `Unknown interface '${targetPort}' on '${target}'.` };
  }
  if (!isEthernetInterface(topology, source, sourcePort)) {
    return {
      ok: false,
      code: "SOURCE_WIRELESS_INTERFACE",
      message: `${sourcePort} connects through the Wireless panel and cannot use a cable.`,
    };
  }
  if (!isEthernetInterface(topology, target, targetPort)) {
    return {
      ok: false,
      code: "TARGET_WIRELESS_INTERFACE",
      message: `${targetPort} connects through the Wireless panel and cannot use a cable.`,
    };
  }
  if (source === target && sourcePort === targetPort) {
    return { ok: false, code: "SELF_LINK", message: "An interface cannot be connected to itself." };
  }
  const used = occupancy(topology, options.ignoreLinkId);
  if (used.has(endpointKey(source, sourcePort))) {
    return { ok: false, code: "SOURCE_OCCUPIED", message: `${sourcePort} on ${source} is already connected.` };
  }
  if (used.has(endpointKey(target, targetPort))) {
    return { ok: false, code: "TARGET_OCCUPIED", message: `${targetPort} on ${target} is already connected.` };
  }
  const duplicate = topology.links.some((link) => link.id !== options.ignoreLinkId && (
    (link.a.node === source && link.a.iface === sourcePort && link.b.node === target && link.b.iface === targetPort)
    || (link.a.node === target && link.a.iface === targetPort && link.b.node === source && link.b.iface === sourcePort)
  ));
  if (duplicate) {
    return { ok: false, code: "DUPLICATE_LINK", message: "That link already exists." };
  }
  return { ok: true };
}

/** Append a validated draft link, returning the updated document and new link. */
export function createLink(
  document: LabDocument,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
): { document: LabDocument; link: TopologyDraftLink } {
  const id = allocateId("link", document.topology.links.map((link) => link.id));
  const link: TopologyDraftLink = { id, a: { node: source, iface: sourcePort }, b: { node: target, iface: targetPort } };
  return {
    document: {
      ...document,
      topology: { ...document.topology, links: [...document.topology.links, link] },
    },
    link,
  };
}

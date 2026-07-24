import type { LabDocument, Topology } from "@sim/contracts";
import { allocateId } from "../../lab/document";
import type { ConnectionValidation, GraphLinkModel, GraphNodeModel, TopologyDraftLink } from "./types";

// Pure translation between the canonical LabDocument topology and the plain
// view models X6 renders. No X6 imports here so this is unit-testable in Node.

function endpointKey(node: string, iface: string): string {
  return `${node}␟${iface}`;
}

function occupancy(topology: Topology): Set<string> {
  const used = new Set<string>();
  for (const link of topology.links) {
    used.add(endpointKey(link.a.node, link.a.iface));
    used.add(endpointKey(link.b.node, link.b.iface));
  }
  return used;
}

/** Project every LabDocument node into a structural graph node (stable IDs). */
export function toGraphNodes(document: LabDocument): GraphNodeModel[] {
  const used = occupancy(document.topology);
  return document.topology.nodes.map((node) => ({
    id: node.id,
    position: node.position ?? { x: 0, y: 0 },
    interfaces: node.interfaces.map((iface) => iface.id),
    occupiedInterfaces: node.interfaces
      .map((iface) => iface.id)
      .filter((iface) => used.has(endpointKey(node.id, iface))),
  }));
}

/** Project every LabDocument link, preserving domain node + interface IDs. */
export function toGraphLinks(document: LabDocument): GraphLinkModel[] {
  return document.topology.links.map((link) => ({
    id: link.id,
    source: link.a.node,
    sourcePort: link.a.iface,
    target: link.b.node,
    targetPort: link.b.iface,
  }));
}

function findInterface(topology: Topology, nodeId: string, ifaceId: string): boolean {
  return Boolean(topology.nodes.find((node) => node.id === nodeId)?.interfaces.some((iface) => iface.id === ifaceId));
}

/** Validate a device-to-device drag before asking the user to choose interfaces. */
export function validateDeviceConnection(
  document: LabDocument,
  source: string,
  target: string,
  options: { locked?: boolean } = {},
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
  const used = occupancy(topology);
  if (!sourceNode.interfaces.some((iface) => !used.has(endpointKey(source, iface.id)))) {
    return { ok: false, code: "SOURCE_OCCUPIED", message: `All interfaces on '${source}' are already connected.` };
  }
  if (!targetNode.interfaces.some((iface) => !used.has(endpointKey(target, iface.id)))) {
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
  options: { locked?: boolean } = {},
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
  if (source === target && sourcePort === targetPort) {
    return { ok: false, code: "SELF_LINK", message: "An interface cannot be connected to itself." };
  }
  const used = occupancy(topology);
  if (used.has(endpointKey(source, sourcePort))) {
    return { ok: false, code: "SOURCE_OCCUPIED", message: `${sourcePort} on ${source} is already connected.` };
  }
  if (used.has(endpointKey(target, targetPort))) {
    return { ok: false, code: "TARGET_OCCUPIED", message: `${targetPort} on ${target} is already connected.` };
  }
  const duplicate = topology.links.some((link) =>
    (link.a.node === source && link.a.iface === sourcePort && link.b.node === target && link.b.iface === targetPort)
    || (link.a.node === target && link.a.iface === targetPort && link.b.node === source && link.b.iface === sourcePort));
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

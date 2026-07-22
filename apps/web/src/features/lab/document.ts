import type { DeviceConfig, LabDocument, NodeSpec } from "@sim/contracts";
import { canonicalizeLabDocument, parseLabDocument } from "@sim/lab-format";

export function loadLabDocumentText(text: string): LabDocument {
  return canonicalizeLabDocument(parseLabDocument(text));
}

export function allocateId(prefix: string, existing: Iterable<string>): string {
  const ids = new Set(existing);
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}

function defaultNode(kind: NodeSpec["kind"], id: string, index: number): NodeSpec {
  const interfaces = kind === "pc"
    ? [{ id: "eth0" }]
    : kind === "l2-switch"
      ? Array.from({ length: 8 }, (_, port) => ({ id: `Gi0/${port + 1}` }))
      : [{ id: "Gi0/0" }, { id: "Gi0/1" }];
  const label = kind === "pc" ? "PC" : kind === "l2-switch" ? "SW" : "R";
  return {
    id,
    kind,
    name: `${label}${index}`,
    position: { x: 120 + ((index - 1) % 3) * 240, y: 100 + Math.floor((index - 1) / 3) * 180 },
    interfaces,
  };
}

function defaultConfiguration(node: NodeSpec): DeviceConfig {
  const hostname = node.name ?? node.id;
  if (node.kind === "pc") return { kind: "pc", hostname, interfaces: [], dhcpEnabled: false };
  if (node.kind === "l2-switch") return { kind: "l2-switch", hostname, interfaces: [], vlans: [] };
  return { kind: "router", hostname, interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [] };
}

export function addDraftDevice(document: LabDocument, kind: NodeSpec["kind"]): LabDocument {
  const prefix = kind === "pc" ? "pc" : kind === "l2-switch" ? "switch" : "router";
  const id = allocateId(prefix, document.topology.nodes.map((node) => node.id));
  const index = Number(id.slice(id.lastIndexOf("-") + 1));
  const node = defaultNode(kind, id, index);
  return {
    ...document,
    topology: { ...document.topology, nodes: [...document.topology.nodes, node] },
    configurations: { ...document.configurations, [id]: defaultConfiguration(node) },
  };
}

export function removeDraftDevice(document: LabDocument, nodeId: string): LabDocument {
  const configurations = { ...document.configurations };
  delete configurations[nodeId];
  return {
    ...document,
    topology: {
      ...document.topology,
      nodes: document.topology.nodes.filter((node) => node.id !== nodeId),
      links: document.topology.links.filter((link) => link.a.node !== nodeId && link.b.node !== nodeId),
    },
    configurations,
  };
}

export function mergeRunningConfiguration(running: LabDocument, draft: LabDocument): LabDocument {
  const configurations: Record<string, DeviceConfig> = {};
  for (const node of draft.topology.nodes) {
    const current = running.configurations[node.id];
    const fallback = draft.configurations[node.id];
    configurations[node.id] = current?.kind === node.kind
      ? current
      : fallback?.kind === node.kind
        ? fallback
        : defaultConfiguration(node);
  }
  return canonicalizeLabDocument({
    ...draft,
    topology: draft.topology,
    configurations,
  });
}

export function withNodePosition(document: LabDocument, nodeId: string, position: { x: number; y: number }): LabDocument {
  return {
    ...document,
    topology: {
      ...document.topology,
      nodes: document.topology.nodes.map((node) => node.id === nodeId ? { ...node, position } : node),
    },
  };
}

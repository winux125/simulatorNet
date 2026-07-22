import { getDeviceProfile, type DeviceConfig, type DeviceType, type LabDocument, type NodeSpec } from "@sim/contracts";
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

function defaultNode(kind: NodeSpec["kind"], id: string, index: number, position?: { x: number; y: number }): NodeSpec {
  const profile = getDeviceProfile(kind);
  const interfaces = profile.interfaceTemplates.map((template) => ({ id: template.id }));
  const label: Record<DeviceType, string> = {
    pc: "PC",
    server: "SRV",
    hub: "HUB",
    bridge: "BR",
    "l2-switch": "SW",
    "l3-switch": "DSW",
    router: "R",
  };
  return {
    id,
    kind,
    name: `${label[kind]}${index}`,
    position: position ?? { x: 120 + ((index - 1) % 3) * 240, y: 100 + Math.floor((index - 1) / 3) * 180 },
    interfaces,
  };
}

function defaultConfiguration(node: NodeSpec): DeviceConfig {
  const hostname = node.name ?? node.id;
  switch (node.kind) {
    case "pc": return { kind: "pc", hostname, interfaces: [], dhcpEnabled: false };
    case "server": return { kind: "server", hostname, interfaces: [], dhcpClientEnabled: false, enabledServices: [] };
    case "hub": return { kind: "hub", hostname, interfaces: [] };
    case "bridge": return { kind: "bridge", hostname, interfaces: [], agingTimeNs: 300_000_000_000 };
    case "l2-switch": return { kind: "l2-switch", hostname, interfaces: [], vlans: [] };
    case "l3-switch": return { kind: "l3-switch", hostname, interfaces: [], vlans: [], svis: [], staticRoutes: [], ipRoutingEnabled: false };
    case "router": return { kind: "router", hostname, interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [] };
  }
}

function idPrefix(kind: DeviceType): string {
  return {
    pc: "pc",
    server: "server",
    hub: "hub",
    bridge: "bridge",
    "l2-switch": "switch",
    "l3-switch": "l3-switch",
    router: "router",
  }[kind];
}

export function addDraftDevice(
  document: LabDocument,
  kind: NodeSpec["kind"],
  position?: { x: number; y: number },
): LabDocument {
  const prefix = idPrefix(kind);
  const id = allocateId(prefix, document.topology.nodes.map((node) => node.id));
  const index = Number(id.slice(id.lastIndexOf("-") + 1));
  const node = defaultNode(kind, id, index, position);
  return {
    ...document,
    topology: { ...document.topology, nodes: [...document.topology.nodes, node] },
    configurations: { ...document.configurations, [id]: defaultConfiguration(node) },
  };
}

export function renameDraftDevice(document: LabDocument, nodeId: string, hostname: string): LabDocument {
  const name = hostname.trim();
  if (!name) return document;
  const current = document.configurations[nodeId];
  return {
    ...document,
    topology: {
      ...document.topology,
      nodes: document.topology.nodes.map((node) => node.id === nodeId ? { ...node, name } : node),
    },
    configurations: current
      ? { ...document.configurations, [nodeId]: { ...current, hostname: name } }
      : document.configurations,
  };
}

export function duplicateDraftDevice(document: LabDocument, nodeId: string): LabDocument {
  const source = document.topology.nodes.find((node) => node.id === nodeId);
  if (!source) return document;
  const prefix = idPrefix(source.kind);
  const id = allocateId(prefix, document.topology.nodes.map((node) => node.id));
  const sourcePosition = source.position ?? { x: 0, y: 0 };
  const name = `${source.name ?? source.id} copy`;
  const duplicate = {
    ...source,
    id,
    name,
    position: { x: sourcePosition.x + 48, y: sourcePosition.y + 48 },
    interfaces: source.interfaces.map((iface) => ({ ...iface })),
  };
  const configuration = document.configurations[nodeId];
  return {
    ...document,
    topology: { ...document.topology, nodes: [...document.topology.nodes, duplicate] },
    configurations: {
      ...document.configurations,
      [id]: configuration ? { ...structuredClone(configuration), hostname: name } : defaultConfiguration(duplicate),
    },
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

export function removeDraftLink(document: LabDocument, linkId: string): LabDocument {
  return {
    ...document,
    topology: {
      ...document.topology,
      links: document.topology.links.filter((link) => link.id !== linkId),
    },
  };
}

export function autoArrangeDocument(document: LabDocument): LabDocument {
  const byKind = new Map<NodeSpec["kind"], number>();
  const columns: Record<NodeSpec["kind"], number> = {
    pc: 80,
    server: 80,
    hub: 320,
    bridge: 320,
    "l2-switch": 400,
    "l3-switch": 520,
    router: 720,
  };
  return {
    ...document,
    topology: {
      ...document.topology,
      nodes: document.topology.nodes.map((node) => {
        const index = byKind.get(node.kind) ?? 0;
        byKind.set(node.kind, index + 1);
        return { ...node, position: { x: columns[node.kind], y: 90 + index * 210 } };
      }),
    },
  };
}

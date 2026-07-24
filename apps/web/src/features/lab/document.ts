import {
  getDeviceProfile,
  type DeviceConfig,
  type DeviceType,
  type DiagramAnnotation,
  type DiagramAsset,
  type DiagramLinkLabel,
  type HostIpConfiguration,
  type HostStaticConfiguration,
  type LabDocument,
  type NodeSpec,
} from "@sim/contracts";
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
    firewall: "FW",
    cloud: "ISP",
    "traffic-generator": "TG",
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
    case "firewall": return { kind: "firewall", hostname, interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [] };
    case "cloud": return { kind: "cloud", hostname, interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [] };
    case "traffic-generator": return { kind: "traffic-generator", hostname, interfaces: [], dhcpEnabled: false };
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
    firewall: "firewall",
    cloud: "cloud",
    "traffic-generator": "traffic-generator",
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
  const removedLinkIds = new Set(document.topology.links
    .filter((link) => link.a.node === nodeId || link.b.node === nodeId)
    .map((link) => link.id));
  return {
    ...document,
    topology: {
      ...document.topology,
      nodes: document.topology.nodes.filter((node) => node.id !== nodeId),
      links: document.topology.links.filter((link) => link.a.node !== nodeId && link.b.node !== nodeId),
    },
    configurations,
    diagram: document.diagram === undefined
      ? undefined
      : {
          ...document.diagram,
          linkLabels: document.diagram.linkLabels.filter((label) => !removedLinkIds.has(label.linkId)),
        },
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

export function hostIpConfigurationFromDocument(document: LabDocument, nodeId: string): HostIpConfiguration | undefined {
  const configuration = document.configurations[nodeId];
  if (configuration?.kind === "pc") {
    return {
      mode: configuration.dhcpEnabled ? "dhcp" : "static",
      address: configuration.ipv4?.address,
      prefixLength: configuration.ipv4?.prefixLength ?? 24,
      defaultGateway: configuration.ipv4?.defaultGateway,
      dnsServer: configuration.dnsServer,
    };
  }
  if (configuration?.kind === "server") {
    const address = configuration.interfaces.find((iface) => iface.ipv4)?.ipv4;
    return {
      mode: configuration.dhcpClientEnabled ? "dhcp" : "static",
      address: address?.address,
      prefixLength: address?.prefixLength ?? 24,
      defaultGateway: configuration.defaultGateway,
      dnsServer: configuration.dnsServer,
    };
  }
  return undefined;
}

export function withHostStaticConfiguration(
  document: LabDocument,
  nodeId: string,
  next: HostStaticConfiguration,
): LabDocument {
  const configuration = document.configurations[nodeId];
  if (configuration?.kind === "pc") {
    return {
      ...document,
      configurations: {
        ...document.configurations,
        [nodeId]: {
          ...configuration,
          ipv4: {
            address: next.address,
            prefixLength: next.prefixLength,
            defaultGateway: next.defaultGateway,
          },
          dhcpEnabled: false,
          dnsServer: next.dnsServer,
        },
      },
    };
  }
  if (configuration?.kind === "server") {
    const node = document.topology.nodes.find((candidate) => candidate.id === nodeId);
    const primaryId = configuration.interfaces.find((iface) => iface.ipv4)?.id
      ?? node?.interfaces[0]?.id
      ?? configuration.interfaces[0]?.id;
    if (!primaryId) return document;
    const existing = new Map(configuration.interfaces.map((iface) => [iface.id, iface]));
    const interfaces = (node?.interfaces ?? configuration.interfaces).map((iface) => {
      const current = existing.get(iface.id);
      return iface.id === primaryId
        ? {
            id: iface.id,
            description: current?.description,
            shutdown: current?.shutdown ?? false,
            ipv4: { address: next.address, prefixLength: next.prefixLength },
          }
        : {
            id: iface.id,
            description: current?.description,
            shutdown: current?.shutdown ?? false,
          };
    });
    return {
      ...document,
      configurations: {
        ...document.configurations,
        [nodeId]: {
          ...configuration,
          interfaces,
          defaultGateway: next.defaultGateway,
          dhcpClientEnabled: false,
          dnsServer: next.dnsServer,
        },
      },
    };
  }
  return document;
}

export function withHostDhcpMode(document: LabDocument, nodeId: string): LabDocument {
  const configuration = document.configurations[nodeId];
  if (configuration?.kind === "pc") {
    return {
      ...document,
      configurations: {
        ...document.configurations,
        [nodeId]: { ...configuration, ipv4: undefined, dhcpEnabled: true },
      },
    };
  }
  if (configuration?.kind === "server") {
    return {
      ...document,
      configurations: {
        ...document.configurations,
        [nodeId]: {
          ...configuration,
          interfaces: configuration.interfaces.map((iface) => ({ ...iface, ipv4: undefined })),
          defaultGateway: undefined,
          dhcpClientEnabled: true,
        },
      },
    };
  }
  return document;
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

function diagram(document: LabDocument) {
  return document.diagram ?? { assets: [], annotations: [], linkLabels: [] };
}

export function addDiagramImage(
  document: LabDocument,
  asset: DiagramAsset,
  annotation: Extract<DiagramAnnotation, { type: "image" }>,
): LabDocument {
  const current = diagram(document);
  return {
    ...document,
    diagram: {
      ...current,
      assets: [...(current.assets ?? []).filter((item) => item.id !== asset.id), asset],
      annotations: [...current.annotations.filter((item) => item.id !== annotation.id), annotation],
    },
  };
}

export function addDiagramAnnotation(
  document: LabDocument,
  annotation: DiagramAnnotation,
): LabDocument {
  const current = diagram(document);
  return {
    ...document,
    diagram: {
      ...current,
      annotations: [...current.annotations.filter((item) => item.id !== annotation.id), annotation],
    },
  };
}

export function updateDiagramAnnotation(
  document: LabDocument,
  annotation: DiagramAnnotation,
): LabDocument {
  const current = diagram(document);
  return {
    ...document,
    diagram: {
      ...current,
      annotations: current.annotations.map((item) => item.id === annotation.id ? annotation : item),
    },
  };
}

export function removeDiagramAnnotation(document: LabDocument, annotationId: string): LabDocument {
  const current = diagram(document);
  const removed = current.annotations.find((annotation) => annotation.id === annotationId);
  const annotations = current.annotations.filter((annotation) => annotation.id !== annotationId);
  const referencedAssets = new Set(annotations.flatMap((annotation) => annotation.type === "image" ? [annotation.assetId] : []));
  return {
    ...document,
    diagram: {
      ...current,
      assets: removed?.type === "image"
        ? (current.assets ?? []).filter((asset) => referencedAssets.has(asset.id))
        : current.assets,
      annotations,
    },
  };
}

export function moveDiagramAnnotation(
  document: LabDocument,
  annotationId: string,
  position: { x: number; y: number },
): LabDocument {
  const annotation = document.diagram?.annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation || annotation.locked || annotation.type === "line" || annotation.type === "arrow") return document;
  return updateDiagramAnnotation(document, { ...annotation, position });
}

export function duplicateDiagramAnnotation(document: LabDocument, annotationId: string): LabDocument {
  const source = document.diagram?.annotations.find((annotation) => annotation.id === annotationId);
  if (!source) return document;
  const id = allocateId("annotation", document.diagram?.annotations.map((annotation) => annotation.id) ?? []);
  const zIndex = Math.max(0, ...(document.diagram?.annotations.map((annotation) => annotation.zIndex) ?? [])) + 1;
  const duplicate: DiagramAnnotation = "position" in source
    ? { ...source, id, position: { x: source.position.x + 24, y: source.position.y + 24 }, zIndex, locked: false }
    : {
        ...source,
        id,
        start: { x: source.start.x + 24, y: source.start.y + 24 },
        end: { x: source.end.x + 24, y: source.end.y + 24 },
        zIndex,
        locked: false,
      };
  return addDiagramAnnotation(document, duplicate);
}

export function changeDiagramAnnotationZOrder(
  document: LabDocument,
  annotationId: string,
  direction: "forward" | "backward",
): LabDocument {
  const annotations = document.diagram?.annotations ?? [];
  const annotation = annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation) return document;
  const bounds = annotations.map((candidate) => candidate.zIndex);
  const zIndex = direction === "forward"
    ? Math.max(0, ...bounds) + 1
    : Math.min(0, ...bounds) - 1;
  return updateDiagramAnnotation(document, { ...annotation, zIndex });
}

export function withDiagramLinkLabel(
  document: LabDocument,
  linkId: string,
  patch: Partial<Omit<DiagramLinkLabel, "linkId">>,
): LabDocument {
  if (!document.topology.links.some((link) => link.id === linkId)) return document;
  const current = diagram(document);
  const existing = current.linkLabels.find((label) => label.linkId === linkId);
  const next: DiagramLinkLabel = {
    linkId,
    text: existing?.text ?? "",
    position: existing?.position ?? 0.5,
    followLink: existing?.followLink ?? true,
    offset: existing?.offset ?? -12,
    visible: existing?.visible ?? true,
    ...patch,
  };
  return {
    ...document,
    diagram: {
      ...current,
      linkLabels: [...current.linkLabels.filter((label) => label.linkId !== linkId), next],
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
    diagram: document.diagram === undefined
      ? undefined
      : {
          ...document.diagram,
          linkLabels: document.diagram.linkLabels.filter((label) => label.linkId !== linkId),
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
    firewall: 640,
    cloud: 880,
    "traffic-generator": 160,
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

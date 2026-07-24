/**
 * GNS3 adapter for .gns3 project JSON and .gns3project archives. It reads
 * topology (nodes, ports, links, coordinates), text drawings, and — for
 * portable archives — startup-config text associated with a node by its id in
 * the file path. Appliance images, project runtime binaries and QEMU disks are
 * never opened or executed.
 */
import { parseXml } from "../xml/xml";
import { isZipArchive } from "../archive/zip";
import { readArchive } from "../archive/read";
import { buildDiagramImages, classifyVendorImage, parseCoordinate } from "./shared";
import type { ImportLimits } from "../config/limits";
import { ImportError } from "../errors/errors";
import type { LabImportAdapter } from "./adapter";
import type {
  ConfigFamily,
  DiagramAnnotation,
  ImportReportEntry,
  ImportSource,
  ImportSourceLink,
  ImportSourceNode,
  ParsedSourceTopology,
} from "../types";

interface Gns3Port { name?: string; adapter_number?: number; port_number?: number }
interface Gns3Node {
  node_id?: string;
  name?: string;
  node_type?: string;
  x?: number;
  y?: number;
  symbol?: string;
  ports?: Gns3Port[];
  properties?: Record<string, unknown>;
}
interface Gns3LinkNode { node_id?: string; adapter_number?: number; port_number?: number }
interface Gns3Link { link_id?: string; nodes?: Gns3LinkNode[] }
interface Gns3Drawing { drawing_id?: string; svg?: string; x?: number; y?: number }
interface Gns3Project {
  name?: string;
  version?: string;
  topology?: { nodes?: Gns3Node[]; links?: Gns3Link[]; drawings?: Gns3Drawing[] };
}

function classifyGns3(node: Gns3Node): { sourceKind: string; configFamily: ConfigFamily } {
  const type = (node.node_type ?? "").toLowerCase();
  if (type === "vpcs") return { sourceKind: "vpcs", configFamily: "vpcs" };
  if (type === "ethernet_switch") return { sourceKind: "ethernet-switch", configFamily: "unknown" };
  if (type === "ethernet_hub") return { sourceKind: "ethernet-hub", configFamily: "unknown" };
  if (type === "nat") return { sourceKind: "nat-cloud", configFamily: "unknown" };
  if (type === "cloud") return { sourceKind: "cloud", configFamily: "unknown" };
  const properties = node.properties ?? {};
  const hay = `${node.name ?? ""} ${node.symbol ?? ""} ${String(properties.platform ?? "")} ${String(properties.hda_disk_image ?? "")} ${String(properties.image ?? "")}`;
  const classified = classifyVendorImage(hay);
  if (classified) return classified;
  if (type === "docker") return { sourceKind: "linux", configFamily: "unknown" };
  return { sourceKind: node.node_type ?? "unknown-appliance", configFamily: "unknown" };
}

function textAnnotationsFromDrawings(drawings: readonly Gns3Drawing[], limits: ImportLimits, notes: ImportReportEntry[]): DiagramAnnotation[] {
  const annotations: DiagramAnnotation[] = [];
  drawings.forEach((drawing, index) => {
    if (!drawing.svg || !drawing.svg.includes("<text")) return;
    try {
      const root = parseXml(drawing.svg, limits);
      const stack = [root];
      while (stack.length > 0) {
        const el = stack.pop()!;
        if (el.name.toLowerCase() === "text" && el.text) {
          annotations.push({
            type: "text",
            id: `drawing-${index}`,
            position: { x: parseCoordinate(String(drawing.x)), y: parseCoordinate(String(drawing.y)) },
            width: 200,
            content: el.text.slice(0, 4_096),
            fontSize: 16,
            bold: false,
            italic: false,
            alignment: "left",
            foreground: "#203247",
            zIndex: 0,
            rotation: 0,
          });
          break;
        }
        for (const child of el.children) stack.push(child);
      }
    } catch {
      notes.push({ level: "info", code: "drawing-skipped", message: `A GNS3 drawing could not be parsed and was skipped` });
    }
  });
  return annotations;
}

function parseGns3(project: Gns3Project, limits: ImportLimits, configs: Map<string, string>, archive?: { rasters: Array<{ name: string; bytes: Uint8Array }>; ignoredFiles: string[]; ignoredVendorImages: string[] }): ParsedSourceTopology {
  if (!project.topology) throw new ImportError("adapter-error", "GNS3 project has no topology");
  const notes: ImportReportEntry[] = [];
  const portName = new Map<string, Map<string, string>>();
  const nodes: ImportSourceNode[] = [];

  for (const node of project.topology.nodes ?? []) {
    const id = node.node_id ?? `node-${nodes.length + 1}`;
    const { sourceKind, configFamily } = classifyGns3(node);
    const ports = node.ports ?? [];
    const interfaces = ports.map((port) => port.name ?? `e${port.adapter_number ?? 0}/${port.port_number ?? 0}`);
    const portLookup = new Map<string, string>();
    ports.forEach((port, index) => portLookup.set(`${port.adapter_number ?? 0}/${port.port_number ?? 0}`, interfaces[index]!));
    portName.set(id, portLookup);
    nodes.push({
      id,
      label: node.name ?? id,
      sourceKind,
      sourceTemplate: node.node_type,
      iconHint: node.symbol,
      position: { x: parseCoordinate(String(node.x)), y: parseCoordinate(String(node.y)) },
      interfaces,
      startupConfig: configs.get(id),
      configFamily,
      authLikelyRequired: sourceKind !== "vpcs" && sourceKind !== "ethernet-switch" && sourceKind !== "ethernet-hub",
    });
  }

  const links: ImportSourceLink[] = [];
  (project.topology.links ?? []).forEach((link, index) => {
    const endpoints = link.nodes ?? [];
    if (endpoints.length !== 2) return;
    const resolve = (endpoint: Gns3LinkNode) => {
      const lookup = portName.get(endpoint.node_id ?? "");
      const iface = lookup?.get(`${endpoint.adapter_number ?? 0}/${endpoint.port_number ?? 0}`);
      return iface ? { node: endpoint.node_id!, iface } : undefined;
    };
    const a = resolve(endpoints[0]!);
    const b = resolve(endpoints[1]!);
    if (a && b) links.push({ id: link.link_id ?? `link-${index}`, a, b });
    else notes.push({ level: "info", code: "link-skipped", message: `A GNS3 link referenced an unknown port and was skipped` });
  });

  const images = archive ? buildDiagramImages(archive.rasters, notes) : { assets: [], annotations: [] };
  const annotations = [...textAnnotationsFromDrawings(project.topology.drawings ?? [], limits, notes), ...images.annotations];
  return {
    platform: "gns3",
    format: archive ? "gns3-portable" : "gns3-project",
    sourceVersion: project.version,
    labTitle: project.name,
    nodes,
    links,
    annotations,
    assets: images.assets,
    ignoredFiles: archive?.ignoredFiles ?? [],
    ignoredVendorImages: archive?.ignoredVendorImages ?? [],
    notes,
  };
}

/** Associate config text files to nodes by matching the node id in their path. */
function collectConfigs(textFiles: Map<string, string>, nodeIds: readonly string[]): Map<string, string> {
  const configs = new Map<string, string>();
  for (const [path, text] of textFiles) {
    const lower = path.toLowerCase();
    if (!lower.includes("config") && !lower.endsWith(".vpc") && !lower.endsWith(".cfg")) continue;
    const owner = nodeIds.find((id) => path.includes(id));
    if (owner) configs.set(owner, text);
  }
  return configs;
}

export const gns3ProjectAdapter: LabImportAdapter = {
  format: "gns3-project",
  platform: "gns3",
  async parse(source: ImportSource, limits: ImportLimits): Promise<ParsedSourceTopology> {
    const project = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(source.bytes)) as Gns3Project;
    return parseGns3(project, limits, new Map());
  },
};

export const gns3PortableAdapter: LabImportAdapter = {
  format: "gns3-portable",
  platform: "gns3",
  async parse(source: ImportSource, limits: ImportLimits): Promise<ParsedSourceTopology> {
    if (!isZipArchive(source.bytes)) throw new ImportError("adapter-error", "GNS3 portable import expects a .gns3project archive");
    const archive = await readArchive(source.bytes, limits);
    const projectEntry = [...archive.textFiles.entries()].find(([name]) => name.toLowerCase().endsWith("project.gns3") || name.toLowerCase().endsWith(".gns3"));
    if (!projectEntry) throw new ImportError("adapter-error", "Archive does not contain a project.gns3 file");
    const project = JSON.parse(projectEntry[1]) as Gns3Project;
    const nodeIds = (project.topology?.nodes ?? []).map((node, index) => node.node_id ?? `node-${index + 1}`);
    const configs = collectConfigs(archive.textFiles, nodeIds);
    return parseGns3(project, limits, configs, archive);
  },
};

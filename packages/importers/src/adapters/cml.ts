/**
 * Cisco Modeling Labs adapter: CML 2.x YAML and VIRL 1.x .virl XML. Both map
 * node definitions to generic SimulatorNet devices, import interfaces, links,
 * positions, annotations and startup config, and keep any unsupported node
 * definition as an external-appliance placeholder. Image definitions are never
 * imported or executed.
 */
import { parseYaml } from "../yaml/yaml";
import { findElements, localNameOf, parseXml } from "../xml/xml";
import { asArray, asRecord, asString, buildDiagramImages, classifyVendorImage, parseCoordinate } from "./shared";
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

function classifyCml(nodeDefinition: string): { sourceKind: string; configFamily: ConfigFamily } {
  const value = nodeDefinition.toLowerCase();
  if (value === "iosvl2" || value === "ios-l2") return { sourceKind: "iol-l2", configFamily: "ios-like" };
  if (value === "iosv") return { sourceKind: "iosv", configFamily: "ios-like" };
  if (value.includes("csr")) return { sourceKind: "csr1000v", configFamily: "ios-like" };
  if (value.includes("xrv")) return { sourceKind: "iosxr", configFamily: "unknown" };
  if (value.includes("nxos")) return { sourceKind: "nxos", configFamily: "unknown" };
  if (value.includes("asav") || value.includes("asa")) return { sourceKind: "asa", configFamily: "unknown" };
  if (value === "unmanaged_switch") return { sourceKind: "ethernet-switch", configFamily: "unknown" };
  if (value === "external_connector") return { sourceKind: "cloud", configFamily: "unknown" };
  if (value.includes("server")) return { sourceKind: "server", configFamily: "unknown" };
  if (value.includes("alpine") || value.includes("ubuntu") || value.includes("desktop") || value.includes("coreos")) return { sourceKind: "linux", configFamily: "unknown" };
  const classified = classifyVendorImage(nodeDefinition);
  return classified ?? { sourceKind: nodeDefinition || "unknown-appliance", configFamily: "unknown" };
}

function cmlAnnotations(rawAnnotations: unknown[]): DiagramAnnotation[] {
  const annotations: DiagramAnnotation[] = [];
  rawAnnotations.forEach((raw, index) => {
    const annotation = asRecord(raw);
    if (!annotation) return;
    const type = (asString(annotation.type) ?? "").toLowerCase();
    const x1 = parseCoordinate(asString(annotation.x1));
    const y1 = parseCoordinate(asString(annotation.y1));
    if (type === "text") {
      const content = asString(annotation.text_content);
      if (content) annotations.push({ type: "text", id: `annotation-${index}`, position: { x: x1, y: y1 }, width: 200, content: content.slice(0, 4_096), fontSize: 16, bold: false, italic: false, alignment: "left", foreground: "#203247", zIndex: 0, rotation: 0 });
    } else if (type === "rectangle" || type === "ellipse") {
      const x2 = parseCoordinate(asString(annotation.x2));
      const y2 = parseCoordinate(asString(annotation.y2));
      annotations.push({ type, id: `annotation-${index}`, position: { x: Math.min(x1, x2), y: Math.min(y1, y2) }, width: Math.max(8, Math.abs(x2 - x1)), height: Math.max(8, Math.abs(y2 - y1)), stroke: "#4d7fa9", strokeWidth: 1.5, zIndex: 0, rotation: 0 });
    }
  });
  return annotations;
}

export const cmlAdapter: LabImportAdapter = {
  format: "cml-yaml",
  platform: "cml",
  async parse(source: ImportSource, limits: ImportLimits): Promise<ParsedSourceTopology> {
    const doc = asRecord(parseYaml(new TextDecoder("utf-8", { fatal: false }).decode(source.bytes), limits));
    if (!doc) throw new ImportError("adapter-error", "CML file is not a mapping");
    const notes: ImportReportEntry[] = [];
    const interfaceLabels = new Map<string, Map<string, string>>();
    const nodes: ImportSourceNode[] = asArray(doc.nodes).map((raw, index) => {
      const node = asRecord(raw) ?? {};
      const id = asString(node.id) ?? `node-${index}`;
      const nodeDefinition = asString(node.node_definition) ?? "";
      const { sourceKind, configFamily } = classifyCml(nodeDefinition);
      const labels = new Map<string, string>();
      const interfaces = asArray(node.interfaces).map((rawIface, ifaceIndex) => {
        const iface = asRecord(rawIface) ?? {};
        const ifaceId = asString(iface.id) ?? `i${ifaceIndex}`;
        const label = asString(iface.label) ?? `eth${ifaceIndex}`;
        labels.set(ifaceId, label);
        return label;
      });
      interfaceLabels.set(id, labels);
      return {
        id,
        label: asString(node.label) ?? id,
        sourceKind,
        sourceTemplate: nodeDefinition,
        position: { x: parseCoordinate(asString(node.x)), y: parseCoordinate(asString(node.y)) },
        interfaces,
        startupConfig: asString(node.configuration),
        configFamily,
        authLikelyRequired: sourceKind !== "ethernet-switch",
      };
    });

    const links: ImportSourceLink[] = [];
    asArray(doc.links).forEach((raw, index) => {
      const link = asRecord(raw) ?? {};
      const n1 = asString(link.n1);
      const n2 = asString(link.n2);
      const i1 = interfaceLabels.get(n1 ?? "")?.get(asString(link.i1) ?? "");
      const i2 = interfaceLabels.get(n2 ?? "")?.get(asString(link.i2) ?? "");
      if (n1 && n2 && i1 && i2) links.push({ id: asString(link.id) ?? `link-${index}`, a: { node: n1, iface: i1 }, b: { node: n2, iface: i2 } });
      else notes.push({ level: "info", code: "link-skipped", message: `A CML link referenced an unknown interface and was skipped` });
    });

    const images = buildDiagramImages([], notes);
    return {
      platform: "cml",
      format: "cml-yaml",
      labTitle: asString(asRecord(doc.lab)?.title) ?? asString(doc.title),
      nodes,
      links,
      annotations: [...cmlAnnotations(asArray(doc.annotations)), ...images.annotations],
      assets: images.assets,
      ignoredFiles: [],
      ignoredVendorImages: [],
      notes,
    };
  },
};

function parseVirlEndpoint(xpath: string, nodeOrder: readonly string[], interfaceOrder: Map<string, readonly string[]>): { node: string; iface: string } | undefined {
  const nameMatch = /@name='([^']+)'/u.exec(xpath);
  const idMatch = /@id='([^']+)'/u.exec(xpath);
  let node: string | undefined;
  if (nameMatch) node = nameMatch[1];
  else {
    const positional = /node\[(\d+)\]/u.exec(xpath);
    if (positional) node = nodeOrder[Number(positional[1]) - 1];
  }
  if (!node) return undefined;
  const ifaceList = interfaceOrder.get(node) ?? [];
  let iface: string | undefined;
  if (idMatch) iface = idMatch[1];
  else {
    const positional = /interface\[(\d+)\]/u.exec(xpath);
    if (positional) iface = ifaceList[Number(positional[1]) - 1];
  }
  return iface ? { node, iface } : undefined;
}

export const virlAdapter: LabImportAdapter = {
  format: "virl-xml",
  platform: "virl",
  async parse(source: ImportSource, limits: ImportLimits): Promise<ParsedSourceTopology> {
    const root = parseXml(new TextDecoder("utf-8", { fatal: false }).decode(source.bytes), limits);
    if (localNameOf(root.name) !== "topology") throw new ImportError("adapter-error", "VIRL file has no <topology> root");
    const notes: ImportReportEntry[] = [];
    const nodes: ImportSourceNode[] = [];
    const nodeOrder: string[] = [];
    const interfaceOrder = new Map<string, string[]>();

    for (const el of root.children.filter((child) => localNameOf(child.name) === "node")) {
      const name = el.attributes.name ?? `node-${nodes.length}`;
      const subtype = el.attributes.subtype ?? el.attributes.type ?? "";
      const { sourceKind, configFamily } = classifyCml(subtype);
      const interfaces = findElements(el, "interface").map((iface, index) => iface.attributes.name ?? `GigabitEthernet0/${index}`);
      const [x, y] = (el.attributes.location ?? "0,0").split(",");
      const configEntry = findElements(el, "entry").find((entry) => (entry.attributes.key ?? "").toLowerCase().includes("config"));
      nodeOrder.push(name);
      interfaceOrder.set(name, interfaces);
      nodes.push({
        id: name,
        label: name,
        sourceKind,
        sourceTemplate: subtype || undefined,
        position: { x: parseCoordinate(x), y: parseCoordinate(y) },
        interfaces,
        startupConfig: configEntry?.text || undefined,
        configFamily,
        authLikelyRequired: sourceKind !== "ethernet-switch",
      });
    }

    const links: ImportSourceLink[] = [];
    findElements(root, "connection").forEach((connection, index) => {
      const a = parseVirlEndpoint(connection.attributes.src ?? "", nodeOrder, interfaceOrder);
      const b = parseVirlEndpoint(connection.attributes.dst ?? "", nodeOrder, interfaceOrder);
      if (a && b) links.push({ id: `connection-${index}`, a, b });
      else notes.push({ level: "info", code: "link-skipped", message: `A VIRL connection could not be resolved and was skipped` });
    });

    return {
      platform: "virl",
      format: "virl-xml",
      labTitle: root.attributes.name,
      nodes,
      links,
      annotations: [],
      assets: [],
      ignoredFiles: [],
      ignoredVendorImages: [],
      notes,
    };
  },
};

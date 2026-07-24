/**
 * PNETLab / EVE-NG (.unl) adapter. UNL is an XML lab file where interfaces
 * attach to numbered "networks"; a 2-member network becomes a direct link and a
 * larger one becomes an intermediate switch/hub. Vendor images referenced by
 * nodes are never read — only metadata, topology and any embedded startup
 * config are imported. Accepts a raw .unl or a .zip containing one.
 */
import { findElements, localNameOf, parseXml } from "../xml/xml";
import { isZipArchive } from "../archive/zip";
import { readArchive } from "../archive/read";
import { buildDiagramImages, parseCoordinate } from "./shared";
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
  LabImportFormat,
  ParsedSourceTopology,
} from "../types";

function classifyUnlNode(type: string, template: string, image: string): { sourceKind: string; configFamily: ConfigFamily } {
  const hay = `${type} ${template} ${image}`.toLowerCase();
  const has = (...tokens: string[]): boolean => tokens.some((token) => hay.includes(token));
  if (has("iol", "iou")) return has("l2", "switch") ? { sourceKind: "iol-l2", configFamily: "ios-like" } : { sourceKind: "iol-l3", configFamily: "ios-like" };
  if (has("iosv") || has("vios")) return has("l2") ? { sourceKind: "iol-l2", configFamily: "ios-like" } : { sourceKind: "iosv", configFamily: "ios-like" };
  if (has("csr", "c8000v")) return { sourceKind: "csr1000v", configFamily: "ios-like" };
  if (has("xrv", "iosxr")) return { sourceKind: "iosxr", configFamily: "unknown" };
  if (has("nxos", "nexus", "n9k")) return { sourceKind: "nxos", configFamily: "unknown" };
  if (has("asa", "ftd", "firepower")) return { sourceKind: "asa", configFamily: "unknown" };
  if (has("forti")) return { sourceKind: "fortigate", configFamily: "fortios" };
  if (has("palo", "pan")) return { sourceKind: "paloalto", configFamily: "panos" };
  if (has("vsrx", "srx", "juniper", "vmx")) return { sourceKind: "vsrx", configFamily: "junos" };
  if (has("vpcs")) return { sourceKind: "vpcs", configFamily: "vpcs" };
  if (has("linux", "docker", "alpine", "ubuntu")) return { sourceKind: "linux", configFamily: "unknown" };
  if (has("server")) return { sourceKind: "server", configFamily: "unknown" };
  return { sourceKind: type || "unknown-appliance", configFamily: "unknown" };
}

const authLikely = (sourceKind: string): boolean => sourceKind !== "vpcs";

function parseUnl(
  xml: string,
  platform: string,
  format: LabImportFormat,
  limits: ImportLimits,
  archive?: { rasters: Array<{ name: string; bytes: Uint8Array }>; ignoredFiles: string[]; ignoredVendorImages: string[] },
): ParsedSourceTopology {
  const root = parseXml(xml, limits);
  if (localNameOf(root.name) !== "lab") throw new ImportError("adapter-error", "UNL file has no <lab> root element");
  const notes: ImportReportEntry[] = [];
  const nodes: ImportSourceNode[] = [];
  const links: ImportSourceLink[] = [];
  const networkMembers = new Map<string, Array<{ node: string; iface: string }>>();

  for (const el of findElements(root, "node")) {
    const rawId = el.attributes.id ?? String(nodes.length + 1);
    const id = `n${rawId}`;
    const type = (el.attributes.type ?? "").toLowerCase();
    const template = (el.attributes.template ?? "").toLowerCase();
    const image = (el.attributes.image ?? "").toLowerCase();
    const { sourceKind, configFamily } = classifyUnlNode(type, template, image);
    const interfaces: string[] = [];
    for (const ifEl of findElements(el, "interface")) {
      const name = ifEl.attributes.name ?? `e0/${ifEl.attributes.id ?? "0"}`;
      interfaces.push(name);
      const netId = ifEl.attributes.network_id ?? ifEl.attributes.network ?? "";
      if (netId && netId !== "0") {
        const members = networkMembers.get(netId) ?? [];
        members.push({ node: id, iface: name });
        networkMembers.set(netId, members);
      }
    }
    const configEl = el.children.find((child) => localNameOf(child.name) === "config");
    nodes.push({
      id,
      label: el.attributes.name ?? id,
      sourceKind,
      sourceTemplate: template || image || undefined,
      iconHint: el.attributes.icon,
      position: { x: parseCoordinate(el.attributes.left), y: parseCoordinate(el.attributes.top) },
      interfaces,
      startupConfig: configEl?.text ? configEl.text : undefined,
      configFamily,
      authLikelyRequired: authLikely(sourceKind),
    });
  }

  const networkEls = new Map(findElements(root, "network").map((network) => [network.attributes.id ?? "", network]));
  for (const [netId, members] of networkMembers) {
    if (members.length === 2) {
      links.push({ id: `l-${netId}`, a: members[0]!, b: members[1]! });
    } else if (members.length > 2) {
      const network = networkEls.get(netId);
      const type = (network?.attributes.type ?? "").toLowerCase();
      const swId = `net-${netId}`;
      nodes.push({
        id: swId,
        label: network?.attributes.name ?? `Segment ${netId}`,
        sourceKind: type.includes("hub") ? "ethernet-hub" : "ethernet-switch",
        position: { x: parseCoordinate(network?.attributes.left), y: parseCoordinate(network?.attributes.top) },
        interfaces: members.map((_, index) => `e${index}`),
      });
      members.forEach((member, index) => links.push({ id: `l-${netId}-${index}`, a: member, b: { node: swId, iface: `e${index}` } }));
    } else {
      notes.push({ level: "info", code: "dangling-network", message: `Network ${netId} has fewer than two endpoints and was skipped` });
    }
  }

  const images = archive ? buildDiagramImages(archive.rasters, notes) : { assets: [], annotations: [] };
  const annotations: DiagramAnnotation[] = [...images.annotations];
  findElements(root, "textobject").forEach((obj, index) => {
    const content = obj.children.find((child) => localNameOf(child.name) === "data")?.text || obj.text;
    if (content) {
      annotations.push({
        type: "text",
        id: `text-${index}`,
        position: { x: parseCoordinate(obj.attributes.x), y: parseCoordinate(obj.attributes.y) },
        width: 200,
        content: content.slice(0, 4_096),
        fontSize: 16,
        bold: false,
        italic: false,
        alignment: "left",
        foreground: "#203247",
        zIndex: 0,
        rotation: 0,
      });
    }
  });
  return {
    platform,
    format,
    sourceVersion: root.attributes.version,
    labTitle: root.attributes.name,
    nodes,
    links,
    annotations,
    assets: images.assets,
    ignoredFiles: archive?.ignoredFiles ?? [],
    ignoredVendorImages: archive?.ignoredVendorImages ?? [],
    notes,
  };
}

function makeUnlAdapter(format: LabImportFormat, platform: string): LabImportAdapter {
  return {
    format,
    platform,
    async parse(source: ImportSource, limits: ImportLimits): Promise<ParsedSourceTopology> {
      if (isZipArchive(source.bytes)) {
        const archive = await readArchive(source.bytes, limits);
        const unlEntry = [...archive.textFiles.entries()].find(([name]) => name.toLowerCase().endsWith(".unl"));
        if (!unlEntry) throw new ImportError("adapter-error", "Archive does not contain a .unl lab file");
        return parseUnl(unlEntry[1], platform, format, limits, archive);
      }
      return parseUnl(new TextDecoder("utf-8", { fatal: false }).decode(source.bytes), platform, format, limits);
    },
  };
}

export const pnetlabAdapter: LabImportAdapter = makeUnlAdapter("pnetlab-unl", "pnetlab");
export const eveAdapter: LabImportAdapter = makeUnlAdapter("eve-ng-unl", "eve-ng");

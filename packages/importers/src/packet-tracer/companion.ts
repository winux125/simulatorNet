import type { DiagramAnnotation } from "@sim/contracts";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { ImportError } from "../errors/errors";
import { planFromParsed, slugify } from "../plan/plan";
import { rasterAsset } from "../security/image";
import { boundText, decodeSafeText, looksBinary } from "../security/text";
import type { ImportPlan, ImportReportEntry, ImportSourceAsset, ImportSourceLink, ImportSourceNode } from "../types";

export interface PacketTracerCompanionFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface PacketTracerCompanionInput {
  /** Metadata only. The referenced PKT/PKA bytes are deliberately not accepted. */
  readonly referenceFilename: string;
  readonly files: readonly PacketTracerCompanionFile[];
}

interface CsvRow { readonly [column: string]: string }
interface MutableNode {
  id: string;
  label: string;
  sourceKind: string;
  position?: { x: number; y: number };
  interfaces: string[];
  configText?: string;
}

const column = (row: CsvRow, name: string): string => row[name] ?? "";

const MAX_COMPANION_FILES = 100;
const CONFIG_EXTENSION = /\.(?:cfg|txt)$/iu;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/iu;

function safeName(value: string): string {
  return value.split(/[\\/]/u).at(-1)?.replace(/[\u0000-\u001f]/gu, "").slice(0, 255) || "companion";
}

function csvRecords(file: PacketTracerCompanionFile, required: readonly string[], limits: ImportLimits): CsvRow[] {
  if (file.bytes.length > limits.maxTopologyFileBytes || looksBinary(file.bytes)) {
    throw new ImportError("unsafe-companion-csv", `${safeName(file.name)} is not a safe bounded text file`);
  }
  const text = boundText(decodeSafeText(file.bytes), limits.maxTopologyFileBytes, limits.maxNodes + limits.maxLinks + 2);
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map((header) => header.trim());
  for (const column of required) {
    if (!headers.includes(column)) throw new ImportError("companion-csv-header", `${safeName(file.name)} must contain the ${column} column`);
  }
  return rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== "")).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index]?.trim() ?? ""])),
  );
}

/** Small RFC-4180-style parser with quoted cells; bounded by the caller. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell); cell = "";
    } else if (character === "\n" && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = "";
    } else {
      cell += character;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function sourceKind(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
  if (["pc", "desktop", "host"].includes(normalized)) return "vpcs";
  if (["switch", "l2switch", "layer-2-switch"].includes(normalized)) return "l2-switch";
  if (["multilayer-switch", "l3switch", "layer-3-switch"].includes(normalized)) return "l3-switch";
  return normalized || "external-appliance";
}

function finiteCoordinate(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 100_000 ? parsed : undefined;
}

function addInterface(node: MutableNode, interfaceId: string): void {
  const id = interfaceId.trim();
  if (id && !node.interfaces.includes(id)) node.interfaces.push(id);
}

function maskPrefix(mask: string): number {
  const octets = mask.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return 24;
  const bits = octets.map((octet) => octet.toString(2).padStart(8, "0")).join("");
  return /^1*0*$/u.test(bits) ? bits.indexOf("0") < 0 ? 32 : bits.indexOf("0") : 24;
}

function addressingConfig(node: MutableNode, rows: readonly CsvRow[]): string | undefined {
  const configured = rows.filter((row) => column(row, "device").toLowerCase() === node.label.toLowerCase() && column(row, "address"));
  if (configured.length === 0) return node.configText;
  if (node.sourceKind === "vpcs") {
    const row = configured[0]!;
    const address = `${column(row, "address")}/${maskPrefix(column(row, "mask") || "255.255.255.0")}`;
    return [node.configText, `ip ${address}${column(row, "gateway") ? ` ${column(row, "gateway")}` : ""}`].filter(Boolean).join("\n");
  }
  const generated = configured.flatMap((row) => [
    `interface ${column(row, "interface")}`,
    ` ip address ${column(row, "address")} ${column(row, "mask") || "255.255.255.0"}`,
    " no shutdown",
  ]);
  return [node.configText, ...generated].filter(Boolean).join("\n");
}

/**
 * Builds a normal ImportPlan exclusively from user-provided companion data.
 * Screenshots are reference annotations; links exist only when connections.csv
 * names both endpoints. No OCR, upload, shell, remote service or PKT parsing.
 */
export function inspectPacketTracerCompanions(
  input: PacketTracerCompanionInput,
  options: { readonly limits?: ImportLimits } = {},
): ImportPlan {
  const limits = options.limits ?? DEFAULT_IMPORT_LIMITS;
  if (input.files.length === 0) throw new ImportError("empty-companion-set", "Select at least one companion file");
  if (input.files.length > MAX_COMPANION_FILES) throw new ImportError("too-many-companion-files", `At most ${MAX_COMPANION_FILES} companion files are allowed`);
  const totalBytes = input.files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > limits.maxInputBytes) throw new ImportError("companion-input-too-large", `Companion data exceeds ${limits.maxInputBytes} bytes`);

  const notes: ImportReportEntry[] = [{
    level: "info",
    code: "packet-tracer-companion-reconstruction",
    message: "Reconstructed from user-provided companion data; PKT content was not parsed.",
  }];
  const byName = new Map<string, MutableNode>();
  const usedNodeIds = new Set<string>();
  const fileByName = new Map(input.files.map((file) => [safeName(file.name).toLowerCase(), file]));
  const devicesFile = fileByName.get("devices.csv");
  const interfacesFile = fileByName.get("interfaces.csv");
  const connectionsFile = fileByName.get("connections.csv");
  const deviceRows = devicesFile ? csvRecords(devicesFile, ["hostname", "type", "x", "y"], limits) : [];
  const interfaceRows = interfacesFile ? csvRecords(interfacesFile, ["device", "interface", "address", "mask", "gateway"], limits) : [];

  const ensureNode = (hostname: string, kind = "external-appliance"): MutableNode => {
    const label = boundText(hostname.trim(), 128, 1) || `Device${byName.size + 1}`;
    const key = label.toLowerCase();
    let node = byName.get(key);
    if (!node) {
      const index = byName.size;
      const baseId = slugify(label, `device-${index + 1}`);
      let id = baseId;
      for (let suffix = 2; usedNodeIds.has(id); suffix++) id = `${baseId}-${suffix}`;
      usedNodeIds.add(id);
      node = { id, label, sourceKind: sourceKind(kind), position: { x: 120 + (index % 6) * 150, y: 120 + Math.floor(index / 6) * 120 }, interfaces: [] };
      byName.set(key, node);
    }
    return node;
  };

  for (const row of deviceRows.slice(0, limits.maxNodes)) {
    const node = ensureNode(column(row, "hostname"), column(row, "type"));
    node.sourceKind = sourceKind(column(row, "type"));
    const x = finiteCoordinate(column(row, "x"));
    const y = finiteCoordinate(column(row, "y"));
    if (x !== undefined && y !== undefined) node.position = { x, y };
  }
  for (const row of interfaceRows) addInterface(ensureNode(column(row, "device"), "pc"), column(row, "interface"));

  for (const file of input.files.filter((candidate) => CONFIG_EXTENSION.test(safeName(candidate.name)))) {
    if (file.bytes.length > limits.maxTopologyFileBytes || looksBinary(file.bytes)) {
      notes.push({ level: "warning", code: "companion-config-ignored", message: `${safeName(file.name)} was ignored because it is not safe bounded text.` });
      continue;
    }
    const hostname = safeName(file.name).replace(CONFIG_EXTENSION, "");
    const configText = boundText(decodeSafeText(file.bytes), limits.maxUnparsedArtifactChars, limits.maxConfigLinesPerDevice);
    const inferredKind = /(^|\n)\s*(?:switchport|vlan\s+\d+)/iu.test(configText)
      ? "l2-switch"
      : /(^|\n)\s*(?:interface|router\s+|ip\s+route)/iu.test(configText)
        ? "router"
        : /(^|\n)\s*ip\s+\d+\.\d+\.\d+\.\d+/iu.test(configText)
          ? "vpcs"
          : "external-appliance";
    const node = ensureNode(hostname, inferredKind);
    node.configText = configText;
  }

  if (byName.size > limits.maxNodes) throw new ImportError("companion-node-limit", `Companion data exceeds ${limits.maxNodes} nodes`);
  const nodes: ImportSourceNode[] = [...byName.values()].sort((a, b) => a.id.localeCompare(b.id)).map((node) => ({
    id: node.id,
    label: node.label,
    sourceKind: node.sourceKind,
    position: node.position,
    interfaces: node.interfaces,
    startupConfig: addressingConfig(node, interfaceRows),
    configFamily: node.sourceKind === "vpcs" ? "vpcs" : "ios-like",
  }));

  const links: ImportSourceLink[] = [];
  if (connectionsFile) {
    const rows = csvRecords(connectionsFile, ["deviceA", "interfaceA", "deviceB", "interfaceB"], limits);
    for (const [index, row] of rows.slice(0, limits.maxLinks).entries()) {
      const a = byName.get(column(row, "deviceA").toLowerCase());
      const b = byName.get(column(row, "deviceB").toLowerCase());
      if (!a || !b || !column(row, "interfaceA") || !column(row, "interfaceB")) {
        notes.push({ level: "warning", code: "companion-connection-unresolved", message: `connections.csv row ${index + 2} was ignored because an endpoint is missing.` });
        continue;
      }
      addInterface(a, column(row, "interfaceA")); addInterface(b, column(row, "interfaceB"));
      links.push({ id: `link-${index + 1}`, a: { node: a.id, iface: column(row, "interfaceA") }, b: { node: b.id, iface: column(row, "interfaceB") } });
    }
  } else {
    notes.push({ level: "warning", code: "companion-connections-not-provided", message: "No connections.csv was provided; connectivity was not inferred from screenshots." });
  }

  const assets: ImportSourceAsset[] = [];
  const annotations: DiagramAnnotation[] = [];
  let imageBytes = 0;
  for (const file of input.files.filter((candidate) => IMAGE_EXTENSION.test(safeName(candidate.name)))) {
    imageBytes += file.bytes.length;
    if (imageBytes > limits.maxDiagramAssetBytes) { notes.push({ level: "warning", code: "companion-image-limit", message: "Additional screenshots were ignored after the diagram asset limit." }); break; }
    const asset = rasterAsset(`pt-reference-${assets.length + 1}`, safeName(file.name), file.bytes);
    if (!asset) { notes.push({ level: "warning", code: "companion-image-invalid", message: `${safeName(file.name)} is not a supported bounded PNG, JPEG or WebP image.` }); continue; }
    assets.push(asset);
    const width = Math.min(640, asset.width);
    const height = Math.max(8, Math.round(width * asset.height / asset.width));
    annotations.push({ id: `pt-reference-image-${assets.length}`, type: "image", assetId: asset.id, position: { x: 40, y: 40 + (assets.length - 1) * (height + 24) }, width, height, opacity: 1, preserveAspectRatio: true, alt: `Packet Tracer migration reference: ${asset.originalName}`, zIndex: -100 + assets.length, rotation: 0, locked: true });
  }

  return planFromParsed({
    platform: "packet-tracer-companion",
    format: "packet-tracer-companion",
    labTitle: safeName(input.referenceFilename).replace(/\.(?:pkt|pka)$/iu, "") || "Packet Tracer reconstruction",
    nodes,
    links,
    annotations,
    assets,
    ignoredFiles: input.files.filter((file) => !CONFIG_EXTENSION.test(safeName(file.name)) && !IMAGE_EXTENSION.test(safeName(file.name)) && !/^(?:devices|interfaces|connections)\.csv$/iu.test(safeName(file.name))).map((file) => safeName(file.name)),
    ignoredVendorImages: [],
    notes,
  }, safeName(input.referenceFilename));
}

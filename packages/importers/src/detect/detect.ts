/**
 * Content-first format detection. Detection never trusts the file extension
 * alone: it inspects magic bytes, archive entries and root document structure,
 * and only uses the extension to disambiguate. Packet Tracer files and anything
 * unrecognised are reported as such rather than mis-parsed.
 */
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { isZipArchive, readZipCentralDirectory } from "../archive/zip";
import { extensionOf } from "../security/binary";
import { looksBinary } from "../security/text";
import type { DetectionConfidence, ImportDetectionResult, ImportSource, LabImportFormat } from "../types";

const SUPPORTED: ReadonlySet<LabImportFormat> = new Set<LabImportFormat>([
  "simulatornet", "pnetlab-unl", "eve-ng-unl", "gns3-project", "gns3-portable",
  "containerlab-yaml", "cml-yaml", "virl-xml",
]);

function result(
  format: LabImportFormat,
  confidence: DetectionConfidence,
  isArchive: boolean,
  detail?: string,
): ImportDetectionResult {
  return { format, confidence, supported: SUPPORTED.has(format), isArchive, detail };
}

function decodePrefix(bytes: Uint8Array, max = 65_536): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, max)));
}

/** Local name of the first real element, skipping decl/comments/doctype. */
function firstElementName(text: string): string | undefined {
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open < 0) return undefined;
    if (text.startsWith("<?", open)) { index = text.indexOf("?>", open) + 2; continue; }
    if (text.startsWith("<!--", open)) { index = text.indexOf("-->", open) + 3; continue; }
    if (text.startsWith("<!", open)) { index = text.indexOf(">", open) + 1; continue; }
    const match = /^<\s*([A-Za-z0-9_:.-]+)/.exec(text.slice(open));
    if (!match) return undefined;
    const name = match[1]!;
    const colon = name.lastIndexOf(":");
    return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
  }
  return undefined;
}

function detectArchive(bytes: Uint8Array, limits: ImportLimits): ImportDetectionResult {
  let names: string[];
  try {
    names = readZipCentralDirectory(bytes, limits).map((entry) => entry.name.toLowerCase());
  } catch {
    return result("unknown", "structure", true, "Unreadable or unsafe ZIP archive");
  }
  if (names.some((name) => name.endsWith("project.gns3") || name.endsWith(".gns3"))) {
    return result("gns3-portable", "structure", true);
  }
  if (names.some((name) => name.endsWith(".unl"))) return result("pnetlab-unl", "structure", true);
  if (names.some((name) => name.endsWith(".clab.yml") || name.endsWith(".clab.yaml"))) {
    return result("containerlab-yaml", "structure", true);
  }
  if (names.some((name) => name.endsWith(".virl"))) return result("virl-xml", "structure", true);
  return result("unknown", "structure", true, "ZIP archive with no recognised lab document");
}

function detectJson(text: string): LabImportFormat {
  if (text.includes('"schemaVersion"') && text.includes('"topology"') && text.includes('"simulation"')) {
    return "simulatornet";
  }
  if (text.includes('"topology"') && (text.includes('"node_id"') || text.includes('"project_id"') || text.includes('"revision"'))) {
    return "gns3-project";
  }
  return "unknown";
}

function detectXml(text: string, extension: string): LabImportFormat {
  const root = firstElementName(text);
  const hasVirlMarker = text.includes("cisco.com/VIRL") || text.includes("virl") || extension === "virl";
  if (root === "topology" && hasVirlMarker) return "virl-xml";
  if (root === "lab") {
    if (text.toLowerCase().includes("pnetlab")) return "pnetlab-unl";
    if (text.toLowerCase().includes("eve-ng") || text.toLowerCase().includes("unetlab")) return "eve-ng-unl";
    return extension === "virl" ? "virl-xml" : "pnetlab-unl";
  }
  if (root === "topology") return "virl-xml";
  return "unknown";
}

function detectYaml(text: string): LabImportFormat {
  const compact = text.toLowerCase();
  if (compact.includes("node_definition") || (compact.includes("lab:") && compact.includes("nodes:") && compact.includes("smart_annotations"))) {
    return "cml-yaml";
  }
  if (compact.includes("topology:") && (compact.includes("kinds:") || compact.includes("nodes:"))) {
    return "containerlab-yaml";
  }
  if (compact.includes("lab:") && compact.includes("nodes:") && compact.includes("links:")) return "cml-yaml";
  return "unknown";
}

export function detectLabImportFormat(
  source: ImportSource,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): ImportDetectionResult {
  const { bytes, filename } = source;
  if (bytes.length === 0) return result("unknown", "none", false, "Empty input");
  const extension = extensionOf(filename);

  if (extension === "pkt") return result("packet-tracer-pkt", "extension", false);
  if (extension === "pka") return result("packet-tracer-pka", "extension", false);

  if (isZipArchive(bytes)) {
    const archive = detectArchive(bytes, limits);
    if (archive.format !== "unknown") return archive;
    if (extension === "gns3project") return result("gns3-portable", "extension", true);
    return archive;
  }

  if (looksBinary(bytes)) {
    return result("unknown", extension ? "extension" : "none", false, "Unrecognised binary content");
  }

  const text = decodePrefix(bytes).trimStart();
  let format: LabImportFormat = "unknown";
  let confidence: DetectionConfidence = "content";
  if (text.startsWith("{")) {
    format = detectJson(text);
  } else if (text.startsWith("<")) {
    format = detectXml(text, extension);
  } else {
    format = detectYaml(text);
  }

  if (format === "unknown") {
    confidence = "extension";
    if (extension === "gns3") format = "gns3-project";
    else if (extension === "virl") format = "virl-xml";
    else if (extension === "clab" || filename?.endsWith(".clab.yml") || filename?.endsWith(".clab.yaml")) format = "containerlab-yaml";
    else if (extension === "unl") format = "pnetlab-unl";
    else confidence = "none";
  }

  return result(format, confidence, false);
}

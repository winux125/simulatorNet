/**
 * Import pipeline: detect -> parse (adapter) -> plan (mapping) -> execute
 * (LabDocument). Inspection is pure data and never reaches sim-core; execution
 * produces a canonical LabDocument via lab-format. Output is deterministic and
 * timestamp-free, so the same source yields byte-identical canonical JSON.
 */
import {
  canonicalizeLabDocument,
  parseLabDocument,
} from "@sim/lab-format";
import {
  MAX_DIAGRAM_ASSETS,
  MAX_EXTERNAL_APPLIANCE_UNPARSED_CONFIG_CHARS,
  MAX_EXTERNAL_APPLIANCE_WARNINGS,
  MAX_LAB_SOURCE_IMPORT_WARNINGS,
  type DeviceConfig,
  type DiagramAsset,
  type ExternalApplianceDeviceConfig,
  type LabDiagram,
  type LabDocument,
  type NodeSpec,
} from "@sim/contracts";
import { getImportAdapter } from "../adapters/adapter";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { detectLabImportFormat } from "../detect/detect";
import { ImportError, UnsupportedImportFormatError } from "../errors/errors";
import {
  interfaceCompatibilityWarning,
  resolveDeviceMapping,
} from "../mapping/registry";
import { ImportReportBuilder } from "../reports/report";
import { boundText } from "../security/text";
import { parseIosConfig } from "../config/ios-config";
import { buildDeviceConfigFromIos, parseVpcsConfig } from "../config/apply";
import { readSimulatorNetLabPackage } from "../native/simlab";
import type {
  ImportedSourceArtifact,
  ImportMappingDecision,
  ImportMappingProposal,
  ImportMappingSelection,
  ImportPlan,
  ImportResult,
  ImportSource,
  ParsedSourceTopology,
} from "../types";

const PACKET_TRACER_NOTICE =
  "Packet Tracer files were recognised, but this format has no supported public conversion contract in SimulatorNet. "
  + "Direct conversion is unavailable — keep the file unchanged and use a supported intermediate topology format.";

export function slugify(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : fallback;
}

function decisionFor(proposal: ImportMappingProposal): ImportMappingDecision {
  return proposal.suggestedDeviceType
    ? { kind: "device", deviceType: proposal.suggestedDeviceType }
    : { kind: "placeholder" };
}

function buildProposals(parsed: ParsedSourceTopology): ImportMappingProposal[] {
  return parsed.nodes.map((node): ImportMappingProposal => {
    // Match on the adapter-normalized sourceKind token, not the raw platform
    // template string (e.g. "ethernet_switch"/"IOSvL2"), which is display-only.
    const mapping = resolveDeviceMapping(parsed.platform, node.sourceKind);
    const target = mapping.targetDeviceType;
    return {
      sourceNodeId: node.id,
      label: node.label,
      sourceKind: node.sourceKind,
      suggestedDeviceType: target,
      supportLevel: mapping.supportLevel,
      interfaceWarning: target ? interfaceCompatibilityWarning(target, node.interfaces.length) : undefined,
      notes: mapping.notes,
    };
  });
}

/** Build the immutable plan from an adapter's parsed topology. */
export function planFromParsed(
  parsed: ParsedSourceTopology,
  originalFilename?: string,
): ImportPlan {
  const proposals = buildProposals(parsed);
  const selection: ImportMappingSelection = {};
  const { report } = assemble(parsed, proposals, selection, originalFilename);
  return {
    format: parsed.format,
    platform: parsed.platform,
    sourceVersion: parsed.sourceVersion,
    originalFilename,
    labTitle: parsed.labTitle,
    parsed,
    proposals,
    report,
    importable: report.errorCount === 0,
  };
}

interface Resolved {
  readonly document: LabDocument;
  readonly report: ImportPlan["report"];
  readonly sourceArtifacts: ImportedSourceArtifact[];
}

/** Core: turn parsed topology + decisions into a canonical LabDocument + report. */
function assemble(
  parsed: ParsedSourceTopology,
  proposals: readonly ImportMappingProposal[],
  selection: ImportMappingSelection,
  originalFilename: string | undefined,
): Resolved {
  const proposalById = new Map(proposals.map((proposal) => [proposal.sourceNodeId, proposal]));
  const builder = new ImportReportBuilder().addEntries(parsed.notes);
  for (const file of parsed.ignoredFiles) builder.ignoreFile(file);
  for (const image of parsed.ignoredVendorImages) builder.ignoreVendorImage(image);

  const included = new Map<string, { deviceType: NodeSpec["kind"]; placeholder: boolean }>();
  const mappedTypes: Record<string, number> = {};
  const unparsedArtifacts: ImportedSourceArtifact[] = [];
  let importedStartupConfigs = 0;
  let unparsedConfigLines = 0;

  for (const node of parsed.nodes) {
    const proposal = proposalById.get(node.id);
    const decision = selection[node.id] ?? (proposal ? decisionFor(proposal) : { kind: "placeholder" as const });
    if (decision.kind === "exclude") {
      builder.info("node-excluded", `Excluded source node ${node.label}`, node.id);
      continue;
    }
    const placeholder = decision.kind === "placeholder";
    const deviceType: NodeSpec["kind"] = placeholder ? "external-appliance" : decision.deviceType;
    included.set(node.id, { deviceType, placeholder });
    mappedTypes[deviceType] = (mappedTypes[deviceType] ?? 0) + 1;
    if (placeholder) {
      builder.markUnsupportedType(node.sourceTemplate ?? node.sourceKind);
      builder.warning("node-placeholder", `${node.label} (${node.sourceKind}) kept as an external-appliance placeholder`, node.id);
    } else if (proposal?.interfaceWarning) {
      builder.warning("interface-mismatch", proposal.interfaceWarning, node.id);
    }
  }

  // Keep only links whose endpoints survived, without connecting an interface twice.
  const linkInterfaces = new Map<string, Set<string>>();
  const usedEndpoints = new Set<string>();
  const keptLinks: ParsedSourceTopology["links"][number][] = [];
  const seenLinkIds = new Set<string>();
  for (const link of parsed.links) {
    if (!included.has(link.a.node) || !included.has(link.b.node)) continue;
    if (seenLinkIds.has(link.id)) continue;
    const aKey = `${link.a.node}\u0000${link.a.iface}`;
    const bKey = `${link.b.node}\u0000${link.b.iface}`;
    if (usedEndpoints.has(aKey) || usedEndpoints.has(bKey)) {
      builder.warning("link-endpoint-reused", `Dropped link ${link.id}: an interface is already connected`);
      continue;
    }
    usedEndpoints.add(aKey);
    usedEndpoints.add(bKey);
    seenLinkIds.add(link.id);
    keptLinks.push(link);
    for (const endpoint of [link.a, link.b]) {
      const set = linkInterfaces.get(endpoint.node) ?? new Set<string>();
      set.add(endpoint.iface);
      linkInterfaces.set(endpoint.node, set);
    }
  }

  const configurations: Record<string, DeviceConfig> = {};
  const nodes: NodeSpec[] = [];
  for (const node of parsed.nodes) {
    const entry = included.get(node.id);
    if (!entry) continue;
    const interfaceIds = dedupe([...node.interfaces, ...(linkInterfaces.get(node.id) ?? [])]);
    nodes.push({
      id: node.id,
      kind: entry.deviceType,
      name: node.label,
      position: node.position ? { x: node.position.x, y: node.position.y } : undefined,
      interfaces: interfaceIds.map((id) => ({ id })),
    });

    if (entry.placeholder) {
      configurations[node.id] = externalApplianceConfig(node, interfaceIds, parsed.platform);
      if (node.startupConfig) {
        importedStartupConfigs++;
        unparsedConfigLines += node.startupConfig.split("\n").length;
        unparsedArtifacts.push({ nodeId: node.id, kind: "startup-config", text: boundStartup(node.startupConfig) });
      }
      continue;
    }

    if (!node.startupConfig) continue;
    importedStartupConfigs++;
    unparsedArtifacts.push({ nodeId: node.id, kind: "startup-config", text: boundStartup(node.startupConfig) });

    if (node.configFamily === "ios-like") {
      const parsedConfig = parseIosConfig(node.startupConfig, interfaceIds);
      const built = buildDeviceConfigFromIos(entry.deviceType, parsedConfig, interfaceIds, node.label);
      if (built.config) configurations[node.id] = built.config;
      unparsedConfigLines += parsedConfig.unparsedLines.length;
      if (parsedConfig.appliedLines.length > 0) {
        builder.info("config-applied", `Applied ${parsedConfig.appliedLines.length} configuration line(s) on ${node.label}`, node.id);
      }
      if (parsedConfig.unparsedLines.length > 0) {
        builder.warning("config-unparsed", `${parsedConfig.unparsedLines.length} configuration line(s) on ${node.label} were preserved but not applied`, node.id);
      }
      if (built.droppedRoutes > 0) {
        builder.warning("config-route-unreachable", `${built.droppedRoutes} static route(s) on ${node.label} were not applied (next hop is not directly connected)`, node.id);
      }
    } else if (node.configFamily === "vpcs" && entry.deviceType === "pc") {
      const vpcs = parseVpcsConfig(node.startupConfig);
      if (vpcs.address) {
        configurations[node.id] = {
          kind: "pc",
          hostname: node.label,
          interfaces: interfaceIds.map((id) => ({ id, shutdown: false })),
          ipv4: { address: vpcs.address, prefixLength: vpcs.prefixLength ?? 24, defaultGateway: vpcs.gateway },
          dhcpEnabled: false,
        };
        builder.info("config-applied", `Applied VPCS addressing on ${node.label}`, node.id);
      }
    } else {
      unparsedConfigLines += node.startupConfig.split("\n").length;
      builder.warning("config-preserved", `Source configuration for ${node.label} (${node.configFamily ?? "unknown"}) was preserved but not applied`, node.id);
    }
  }

  const annotations = parsed.annotations.slice(0, DEFAULT_IMPORT_LIMITS.maxAnnotations);
  const assets = parsed.assets.slice(0, MAX_DIAGRAM_ASSETS).map((asset): DiagramAsset => ({
    id: asset.id,
    mime: asset.mime,
    originalName: asset.originalName,
    dataBase64: asset.dataBase64,
    width: asset.width,
    height: asset.height,
  }));
  const diagram: LabDiagram | undefined = annotations.length > 0 || assets.length > 0
    ? {
        assets: assets.length > 0 ? assets : undefined,
        annotations: [...annotations],
        linkLabels: [],
        linkStyles: [],
      }
    : undefined;

  const report = builder.build({
    format: parsed.format,
    platform: parsed.platform,
    sourceVersion: parsed.sourceVersion,
    importedNodeCount: nodes.length,
    importedLinkCount: keptLinks.length,
    importedAnnotationCount: annotations.length,
    importedStartupConfigs,
    mappedDeviceTypes: mappedTypes,
    unparsedConfigLines,
    credentialsDetected: 0,
    credentialsRequiringReset: 0,
  });

  const warnings = report.entries
    .filter((entry) => entry.level !== "info")
    .map((entry) => entry.message.slice(0, 512))
    .slice(0, MAX_LAB_SOURCE_IMPORT_WARNINGS);

  const document: LabDocument = canonicalizeLabDocument({
    schemaVersion: 1,
    id: slugify(parsed.labTitle ?? `${parsed.platform}-import`, `${parsed.platform}-import`),
    title: parsed.labTitle ?? `${parsed.platform} import`,
    sourceImport: {
      platform: parsed.platform,
      originalFilename,
      sourceVersion: parsed.sourceVersion,
      warnings,
    },
    simulation: { seed: 1 },
    topology: { schemaVersion: 1, nodes, links: keptLinks.map((link) => ({ id: link.id, a: { ...link.a }, b: { ...link.b }, propagationDelayNs: link.propagationDelayNs })) },
    configurations,
    diagram,
  });

  return { document, report, sourceArtifacts: unparsedArtifacts };
}

function externalApplianceConfig(
  node: ParsedSourceTopology["nodes"][number],
  interfaceIds: readonly string[],
  platform: string,
): ExternalApplianceDeviceConfig {
  const warnings = node.startupConfig
    ? [`Source startup configuration preserved but not applied (${node.sourceKind}).`]
    : [];
  return {
    kind: "external-appliance",
    hostname: node.label,
    interfaces: interfaceIds.map((id) => ({ id, shutdown: false })),
    sourcePlatform: platform,
    sourceVendor: node.vendor,
    sourceNodeKind: node.sourceKind,
    sourceTemplate: node.sourceTemplate,
    sourceIconHint: node.iconHint,
    unparsedConfig: node.startupConfig
      ? boundText(node.startupConfig, MAX_EXTERNAL_APPLIANCE_UNPARSED_CONFIG_CHARS, DEFAULT_IMPORT_LIMITS.maxConfigLinesPerDevice)
      : undefined,
    importWarnings: warnings.slice(0, MAX_EXTERNAL_APPLIANCE_WARNINGS),
    authHint: node.authLikelyRequired ? "likely-required" : "unknown",
  };
}

function boundStartup(text: string): string {
  return boundText(text, MAX_EXTERNAL_APPLIANCE_UNPARSED_CONFIG_CHARS, DEFAULT_IMPORT_LIMITS.maxConfigLinesPerDevice);
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) { seen.add(value); out.push(value); }
  }
  return out;
}

/** Inspect a source file and produce an immutable plan. Never builds a lab. */
export async function inspectLabImport(
  source: ImportSource,
  options: { readonly limits?: ImportLimits } = {},
): Promise<ImportPlan> {
  const limits = options.limits ?? DEFAULT_IMPORT_LIMITS;
  if (source.bytes.length === 0) throw new ImportError("empty-input", "The selected file is empty");
  if (source.bytes.length > limits.maxInputBytes) {
    throw new ImportError("input-too-large", `Input exceeds ${limits.maxInputBytes} bytes`);
  }
  const detection = detectLabImportFormat(source, limits);

  if (detection.format === "packet-tracer-pkt" || detection.format === "packet-tracer-pka") {
    throw new UnsupportedImportFormatError(PACKET_TRACER_NOTICE, { format: detection.format });
  }
  if (detection.format === "unknown" || !detection.supported) {
    throw new ImportError("unsupported-format", `Unrecognised or unsupported lab format (${detection.format})`, { detection });
  }
  if (detection.format === "simulatornet") return nativePlan(source, detection.detail);
  if (detection.format === "simulatornet-package") {
    // A `.simlab` is native, not an import: `lab.json` is already canonical, so
    // there is nothing to map. Projection mismatches surface as warnings.
    const read = await readSimulatorNetLabPackage(source.bytes, limits);
    return nativePlan(source, detection.detail, read.document, read.warnings);
  }

  const adapter = getImportAdapter(detection.format);
  if (!adapter) {
    throw new ImportError("no-adapter", `No importer is registered for ${detection.format}`, { format: detection.format });
  }
  const parsed = await adapter.parse(source, limits);
  return planFromParsed(parsed, source.filename);
}

function nativePlan(
  source: ImportSource,
  _detail?: string,
  nativeDocument?: LabDocument,
  warnings: readonly string[] = [],
): ImportPlan {
  const document = nativeDocument ?? canonicalizeLabDocument(parseLabDocument(
    JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(source.bytes)),
  ));
  const builder = new ImportReportBuilder()
    .info("native-import", "SimulatorNet lab imported with full fidelity");
  for (const warning of warnings) builder.warning("package-projection-differs", warning);
  const report = builder
    .build({
      format: "simulatornet",
      platform: "simulatornet",
      importedNodeCount: document.topology.nodes.length,
      importedLinkCount: document.topology.links.length,
      importedAnnotationCount: document.diagram?.annotations.length ?? 0,
      importedStartupConfigs: 0,
      mappedDeviceTypes: tallyKinds(document.topology.nodes),
      unparsedConfigLines: 0,
      credentialsDetected: 0,
      credentialsRequiringReset: 0,
    });
  return {
    format: "simulatornet",
    platform: "simulatornet",
    originalFilename: source.filename,
    labTitle: document.title,
    parsed: nativeParsed(document),
    proposals: document.topology.nodes.map((node) => ({
      sourceNodeId: node.id,
      label: node.name ?? node.id,
      sourceKind: node.kind,
      suggestedDeviceType: node.kind,
      supportLevel: "full" as const,
    })),
    report,
    importable: true,
    nativeDocument: document,
  };
}

function nativeParsed(document: LabDocument): ParsedSourceTopology {
  return {
    platform: "simulatornet",
    format: "simulatornet",
    labTitle: document.title,
    nodes: document.topology.nodes.map((node) => ({
      id: node.id,
      label: node.name ?? node.id,
      sourceKind: node.kind,
      interfaces: node.interfaces.map((iface) => iface.id),
    })),
    links: document.topology.links.map((link) => ({ id: link.id, a: { ...link.a }, b: { ...link.b } })),
    annotations: [...(document.diagram?.annotations ?? [])],
    assets: [],
    ignoredFiles: [],
    ignoredVendorImages: [],
    notes: [],
  };
}

function tallyKinds(nodes: readonly NodeSpec[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const node of nodes) tally[node.kind] = (tally[node.kind] ?? 0) + 1;
  return tally;
}

/** Execute a plan against the user's mapping decisions to produce a lab. */
export function executeLabImport(plan: ImportPlan, selection: ImportMappingSelection = {}): ImportResult {
  if (plan.nativeDocument) {
    return { document: canonicalizeLabDocument(plan.nativeDocument), report: plan.report, sourceArtifacts: [] };
  }
  const { document, report, sourceArtifacts } = assemble(plan.parsed, plan.proposals, selection, plan.originalFilename);
  return { document, report, sourceArtifacts };
}

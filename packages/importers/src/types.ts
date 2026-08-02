import type { DeviceType, LabDocument, NodeSpec, LinkSpec, DiagramAnnotation } from "@sim/contracts";

/** Every foreign lab container SimulatorNet can recognise (supported or not). */
export type LabImportFormat =
  /** The canonical `LabDocument` JSON. */
  | "simulatornet"
  /** The native `.simlab` package: the same document plus `.cfg` projections. */
  | "simulatornet-package"
  | "pnetlab-unl"
  | "eve-ng-unl"
  | "gns3-project"
  | "gns3-portable"
  | "containerlab-yaml"
  | "cml-yaml"
  | "virl-xml"
  | "packet-tracer-pkt"
  | "packet-tracer-pka"
  | "unknown";

/** How faithfully a single source node survives conversion. Never hidden. */
export type ImportSupportLevel =
  | "full"
  | "configuration-partial"
  | "topology-only"
  | "visual-placeholder"
  | "unsupported";

export type ImportReportLevel = "info" | "warning" | "error";

/** Runtime-agnostic input: raw bytes plus an advisory (never trusted) filename. */
export interface ImportSource {
  readonly filename?: string;
  readonly bytes: Uint8Array;
}

export type DetectionConfidence = "content" | "structure" | "extension" | "none";

export interface ImportDetectionResult {
  readonly format: LabImportFormat;
  readonly confidence: DetectionConfidence;
  /** False for Packet Tracer and unknown formats: recognised, not convertible. */
  readonly supported: boolean;
  readonly isArchive: boolean;
  readonly detail?: string;
}

/**
 * A single imported node before it becomes a SimulatorNet node. Adapters emit
 * these; the mapping wizard resolves each to a target device type (or keeps it
 * as an external-appliance placeholder). Plain data only — no behaviour.
 */
export interface ImportSourceNode {
  readonly id: string;
  readonly label: string;
  /** Source-platform node kind/template, e.g. "iol", "vpcs", "linux". */
  readonly sourceKind: string;
  readonly sourceTemplate?: string;
  readonly vendor?: string;
  readonly iconHint?: string;
  readonly position?: { readonly x: number; readonly y: number };
  /** Interface names as named by the source platform. */
  readonly interfaces: readonly string[];
  /** Preserved, never-executed startup configuration text. */
  readonly startupConfig?: string;
  /** Config dialect of `startupConfig`, controlling whether a subset is applied. */
  readonly configFamily?: ConfigFamily;
  /** True when the source family usually needs an interactive console login. */
  readonly authLikelyRequired?: boolean;
}

export type ConfigFamily = "ios-like" | "vpcs" | "junos" | "eos" | "panos" | "fortios" | "unknown";

export interface ImportSourceLink {
  readonly id: string;
  readonly a: { readonly node: string; readonly iface: string };
  readonly b: { readonly node: string; readonly iface: string };
  readonly propagationDelayNs?: number;
}

/** Raster diagram asset already validated as a safe PNG/JPEG/WebP. */
export interface ImportSourceAsset {
  readonly id: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly originalName: string;
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
}

/** What an adapter produces from a source file before mapping is applied. */
export interface ParsedSourceTopology {
  readonly platform: string;
  readonly format: LabImportFormat;
  readonly sourceVersion?: string;
  readonly labTitle?: string;
  readonly nodes: readonly ImportSourceNode[];
  readonly links: readonly ImportSourceLink[];
  readonly annotations: readonly DiagramAnnotation[];
  readonly assets: readonly ImportSourceAsset[];
  /** Non-vendor files present in the source that were not imported. */
  readonly ignoredFiles: readonly string[];
  /** Vendor appliance images/binaries skipped without decoding. */
  readonly ignoredVendorImages: readonly string[];
  /** Report entries the adapter accumulated while parsing. */
  readonly notes: readonly ImportReportEntry[];
}

export interface ImportReportEntry {
  readonly level: ImportReportLevel;
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly detail?: Record<string, unknown>;
}

/** Immutable, canonical summary of everything an import will or did do. */
export interface ImportReport {
  readonly format: LabImportFormat;
  readonly platform: string;
  readonly sourceVersion?: string;
  readonly importedNodeCount: number;
  readonly importedLinkCount: number;
  readonly importedAnnotationCount: number;
  readonly importedStartupConfigs: number;
  readonly mappedDeviceTypes: Readonly<Record<string, number>>;
  readonly unsupportedDeviceTypes: readonly string[];
  readonly ignoredFiles: readonly string[];
  readonly ignoredVendorImages: readonly string[];
  readonly unparsedConfigLines: number;
  readonly credentialsDetected: number;
  readonly credentialsRequiringReset: number;
  readonly entries: readonly ImportReportEntry[];
  readonly warningCount: number;
  readonly errorCount: number;
}

/**
 * A per-source-node suggestion the mapping wizard shows the user. `chosen`
 * carries the accepted decision (target type or placeholder / exclude).
 */
export interface ImportMappingProposal {
  readonly sourceNodeId: string;
  readonly label: string;
  readonly sourceKind: string;
  readonly suggestedDeviceType?: DeviceType;
  readonly supportLevel: ImportSupportLevel;
  /** Interface-count/shape mismatch warning, shown before allowing the mapping. */
  readonly interfaceWarning?: string;
  readonly notes?: string;
}

/** Immutable plan produced by inspection; contains no runtime/sim state. */
export interface ImportPlan {
  readonly format: LabImportFormat;
  readonly platform: string;
  readonly sourceVersion?: string;
  readonly originalFilename?: string;
  readonly labTitle?: string;
  readonly parsed: ParsedSourceTopology;
  readonly proposals: readonly ImportMappingProposal[];
  readonly report: ImportReport;
  /** True when nothing blocks producing a document (may still have warnings). */
  readonly importable: boolean;
  /** Present only for native SimulatorNet imports: returned verbatim on execute. */
  readonly nativeDocument?: LabDocument;
}

/** User decision for one source node during mapping. */
export type ImportMappingDecision =
  | { readonly kind: "device"; readonly deviceType: DeviceType }
  | { readonly kind: "placeholder" }
  | { readonly kind: "exclude" };

/** sourceNodeId -> decision. Missing entries fall back to the suggestion. */
export type ImportMappingSelection = Readonly<Record<string, ImportMappingDecision>>;

export interface ImportedSourceArtifact {
  readonly nodeId: string;
  readonly kind: "startup-config" | "notes";
  readonly text: string;
}

export interface ImportResult {
  readonly document: LabDocument;
  readonly report: ImportReport;
  readonly sourceArtifacts: readonly ImportedSourceArtifact[];
}

/** Convenience aliases so downstream code need not reach into @sim/contracts. */
export type { LabDocument, NodeSpec, LinkSpec, DiagramAnnotation, DeviceType };

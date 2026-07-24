/**
 * Deterministic import report. The builder accumulates entries and derived
 * sets, and `build` produces a canonical, immutable ImportReport: derived arrays
 * are sorted and the mapped-type record is rebuilt from sorted keys so the same
 * import always yields byte-identical report JSON. No timestamps are recorded.
 */
import type {
  ImportReport,
  ImportReportEntry,
  ImportReportLevel,
  LabImportFormat,
} from "../types";

export interface ImportReportTotals {
  readonly format: LabImportFormat;
  readonly platform: string;
  readonly sourceVersion?: string;
  readonly importedNodeCount: number;
  readonly importedLinkCount: number;
  readonly importedAnnotationCount: number;
  readonly importedStartupConfigs: number;
  readonly mappedDeviceTypes: Readonly<Record<string, number>>;
  readonly unparsedConfigLines: number;
  readonly credentialsDetected: number;
  readonly credentialsRequiringReset: number;
}

export class ImportReportBuilder {
  private readonly entries: ImportReportEntry[] = [];
  private readonly unsupportedDeviceTypes = new Set<string>();
  private readonly ignoredFiles = new Set<string>();
  private readonly ignoredVendorImages = new Set<string>();

  add(entry: ImportReportEntry): this {
    this.entries.push(entry);
    return this;
  }

  note(level: ImportReportLevel, code: string, message: string, nodeId?: string, detail?: Record<string, unknown>): this {
    return this.add({ level, code, message, nodeId, detail });
  }

  info(code: string, message: string, nodeId?: string): this { return this.note("info", code, message, nodeId); }
  warning(code: string, message: string, nodeId?: string): this { return this.note("warning", code, message, nodeId); }
  error(code: string, message: string, nodeId?: string): this { return this.note("error", code, message, nodeId); }

  markUnsupportedType(sourceKind: string): this { this.unsupportedDeviceTypes.add(sourceKind); return this; }
  ignoreFile(name: string): this { this.ignoredFiles.add(name); return this; }
  ignoreVendorImage(name: string): this { this.ignoredVendorImages.add(name); return this; }

  addEntries(entries: readonly ImportReportEntry[]): this {
    for (const entry of entries) this.add(entry);
    return this;
  }

  build(totals: ImportReportTotals): ImportReport {
    const sortedMapped: Record<string, number> = {};
    for (const key of Object.keys(totals.mappedDeviceTypes).sort()) {
      sortedMapped[key] = totals.mappedDeviceTypes[key]!;
    }
    const entries = [...this.entries];
    return {
      format: totals.format,
      platform: totals.platform,
      sourceVersion: totals.sourceVersion,
      importedNodeCount: totals.importedNodeCount,
      importedLinkCount: totals.importedLinkCount,
      importedAnnotationCount: totals.importedAnnotationCount,
      importedStartupConfigs: totals.importedStartupConfigs,
      mappedDeviceTypes: sortedMapped,
      unsupportedDeviceTypes: [...this.unsupportedDeviceTypes].sort(),
      ignoredFiles: [...this.ignoredFiles].sort(),
      ignoredVendorImages: [...this.ignoredVendorImages].sort(),
      unparsedConfigLines: totals.unparsedConfigLines,
      credentialsDetected: totals.credentialsDetected,
      credentialsRequiringReset: totals.credentialsRequiringReset,
      entries,
      warningCount: entries.filter((entry) => entry.level === "warning").length,
      errorCount: entries.filter((entry) => entry.level === "error").length,
    };
  }
}

/**
 * Centralized, conservative limits for every untrusted import. These are the
 * single source of truth for archive, parser, topology and artifact bounds so a
 * malicious or accidental file can never exhaust memory, expand without bound,
 * or smuggle in an executable payload. All values are byte/count integers.
 */
export interface ImportLimits {
  /** Largest source archive (or single file) accepted at the door. */
  readonly maxInputBytes: number;
  /** Entries permitted in one archive. */
  readonly maxArchiveEntries: number;
  /** Total decompressed bytes across all kept entries. */
  readonly maxUncompressedBytes: number;
  /** Largest single topology/config text file we will parse. */
  readonly maxTopologyFileBytes: number;
  /** Total raster diagram assets kept from an import. */
  readonly maxDiagramAssetBytes: number;
  /** Reject a single entry whose declared/observed expansion exceeds this. */
  readonly maxCompressionRatio: number;
  readonly maxNodes: number;
  readonly maxLinks: number;
  readonly maxAnnotations: number;
  /** Preserved configuration lines kept per device. */
  readonly maxConfigLinesPerDevice: number;
  /** Preserved unparsed source-artifact characters per device. */
  readonly maxUnparsedArtifactChars: number;
  readonly maxXmlDepth: number;
  readonly maxXmlNodes: number;
  readonly maxYamlDepth: number;
  readonly maxYamlNodes: number;
  /** Aliases are disabled entirely (0) to defeat alias-expansion bombs. */
  readonly maxYamlAliases: number;
  /** Archives nested inside archives are never opened. */
  readonly allowNestedArchives: boolean;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxInputBytes: 100 * 1_024 * 1_024,
  maxArchiveEntries: 500,
  maxUncompressedBytes: 200 * 1_024 * 1_024,
  maxTopologyFileBytes: 10 * 1_024 * 1_024,
  maxDiagramAssetBytes: 20 * 1_024 * 1_024,
  maxCompressionRatio: 100,
  maxNodes: 500,
  maxLinks: 2_000,
  maxAnnotations: 5_000,
  maxConfigLinesPerDevice: 5_000,
  maxUnparsedArtifactChars: 20_000,
  maxXmlDepth: 100,
  maxXmlNodes: 100_000,
  maxYamlDepth: 50,
  maxYamlNodes: 100_000,
  maxYamlAliases: 0,
  allowNestedArchives: false,
};

/**
 * Declarative source-node -> SimulatorNet device mapping. This is data, not a
 * switch statement: adapters and future platforms extend the table, and the
 * resolver picks the most specific match deterministically. An unmatched node
 * always resolves to an external-appliance placeholder — never a random router.
 */
import { getDeviceProfile, type DeviceType } from "@sim/contracts";
import type { ImportSupportLevel } from "../types";

export interface ImportDeviceMapping {
  /** Lowercase source platform id, or "*" for any platform. */
  readonly sourcePlatform: string;
  /** Lowercase source kind/template tokens; matched by equality or substring. */
  readonly sourceKinds: readonly string[];
  /** Undefined target means "keep as external-appliance placeholder". */
  readonly targetDeviceType?: DeviceType;
  readonly supportLevel: ImportSupportLevel;
  /** "preserve" keeps the source interface names on the mapped node. */
  readonly interfaceNaming: "preserve";
  readonly authLikelyRequired?: boolean;
  readonly notes?: string;
}

/**
 * Baseline, platform-neutral mappings. Platform-specific entries (added by the
 * format adapters) take precedence over these "*" rows during resolution.
 */
export const IMPORT_DEVICE_MAPPINGS: ImportDeviceMapping[] = [
  { sourcePlatform: "*", sourceKinds: ["vpcs", "desktop-host", "docker-host"], targetDeviceType: "pc", supportLevel: "configuration-partial", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["linux-server", "server"], targetDeviceType: "server", supportLevel: "topology-only", interfaceNaming: "preserve", authLikelyRequired: true },
  { sourcePlatform: "*", sourceKinds: ["ethernet-switch", "l2-switch", "unmanaged-switch"], targetDeviceType: "l2-switch", supportLevel: "topology-only", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["ethernet-hub", "hub"], targetDeviceType: "hub", supportLevel: "topology-only", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["generic-router", "router"], targetDeviceType: "router", supportLevel: "topology-only", interfaceNaming: "preserve", authLikelyRequired: true },
];

const FALLBACK: ImportDeviceMapping = {
  sourcePlatform: "*",
  sourceKinds: [],
  targetDeviceType: undefined,
  supportLevel: "visual-placeholder",
  interfaceNaming: "preserve",
  notes: "Unmapped source node kept as an external-appliance placeholder.",
};

function matchStrength(kind: string, mapping: ImportDeviceMapping): number {
  const token = mapping.sourceKinds.find((entry) => kind === entry || kind.includes(entry));
  if (token === undefined) return -1;
  const platformScore = mapping.sourcePlatform === "*" ? 0 : 10;
  const kindScore = kind === token ? 2 : 1;
  return platformScore + kindScore;
}

/**
 * Resolve one source node deterministically. Ties break by the registry order,
 * so the same input always yields the same mapping.
 */
export function resolveDeviceMapping(
  platform: string,
  sourceKind: string,
  registry: readonly ImportDeviceMapping[] = IMPORT_DEVICE_MAPPINGS,
): ImportDeviceMapping {
  const kind = sourceKind.toLowerCase();
  let best: ImportDeviceMapping = FALLBACK;
  let bestScore = -1;
  registry.forEach((mapping) => {
    if (mapping.sourcePlatform !== "*" && mapping.sourcePlatform !== platform.toLowerCase()) return;
    const score = matchStrength(kind, mapping);
    if (score > bestScore) { bestScore = score; best = mapping; }
  });
  return best;
}

/** Hard interface-count constraints per device type, if any. */
export function interfaceCompatibilityWarning(
  targetDeviceType: DeviceType,
  interfaceCount: number,
): string | undefined {
  if (targetDeviceType === "bridge" && interfaceCount !== 2) {
    return `A Bridge must have exactly 2 interfaces; the source node has ${interfaceCount}.`;
  }
  if (targetDeviceType === "cloud" && (interfaceCount < 2 || interfaceCount > 8)) {
    return `A Cloud/ISP requires 2-8 interfaces; the source node has ${interfaceCount}.`;
  }
  if (interfaceCount === 0 && targetDeviceType !== "external-appliance") {
    return `The source node exposes no interfaces to map onto a ${getDeviceProfile(targetDeviceType).displayName}.`;
  }
  return undefined;
}

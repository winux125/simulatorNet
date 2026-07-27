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
  // Deterministic educational WLAN devices. Radio interfaces are configuration
  // endpoints, never synthesized as Ethernet cable ports by the importer.
  { sourcePlatform: "*", sourceKinds: ["wireless-access-point", "wifi-access-point", "access-point", "wifi-ap"], targetDeviceType: "access-point", supportLevel: "topology-only", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["wireless-router", "wifi-router", "home-router"], targetDeviceType: "wireless-router", supportLevel: "topology-only", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["laptop", "notebook"], targetDeviceType: "laptop", supportLevel: "topology-only", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["smartphone", "mobile-phone", "mobile-device", "tablet"], targetDeviceType: "smartphone", supportLevel: "topology-only", interfaceNaming: "preserve" },
  // Layer-2 switching appliances.
  { sourcePlatform: "*", sourceKinds: ["iol-l2", "iou-l2", "unmanaged-switch", "ethernet-switch", "l2-switch", "veos-l2"], targetDeviceType: "l2-switch", supportLevel: "configuration-partial", interfaceNaming: "preserve", authLikelyRequired: true },
  // Routers (IOS-like families get a partial config apply; others topology-only).
  { sourcePlatform: "*", sourceKinds: ["iol-l3", "iou-l3", "iosv", "iosxe", "csr1000v", "csr", "c8000v", "dynamips", "generic-router", "router"], targetDeviceType: "router", supportLevel: "configuration-partial", interfaceNaming: "preserve", authLikelyRequired: true },
  { sourcePlatform: "*", sourceKinds: ["iosxr", "xrv"], targetDeviceType: "router", supportLevel: "topology-only", interfaceNaming: "preserve", authLikelyRequired: true },
  // Multilayer switching.
  { sourcePlatform: "*", sourceKinds: ["nxos", "nexus", "n9kv", "multilayer-switch", "l3-switch"], targetDeviceType: "l3-switch", supportLevel: "topology-only", interfaceNaming: "preserve", authLikelyRequired: true },
  // Firewall-like security appliances.
  { sourcePlatform: "*", sourceKinds: ["asav", "asa", "ftdv", "ftd", "firepower", "fortigate", "fortios", "paloalto", "panos", "vsrx", "srx", "firewall"], targetDeviceType: "firewall", supportLevel: "topology-only", interfaceNaming: "preserve", authLikelyRequired: true },
  // Lightweight hosts and servers.
  { sourcePlatform: "*", sourceKinds: ["vpcs"], targetDeviceType: "pc", supportLevel: "configuration-partial", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["desktop-host", "docker-host", "alpine", "ubuntu-host", "linux-host", "linux"], targetDeviceType: "pc", supportLevel: "topology-only", interfaceNaming: "preserve", authLikelyRequired: true },
  { sourcePlatform: "*", sourceKinds: ["linux-server", "server"], targetDeviceType: "server", supportLevel: "topology-only", interfaceNaming: "preserve", authLikelyRequired: true },
  // Infrastructure.
  { sourcePlatform: "*", sourceKinds: ["ethernet-hub", "hub"], targetDeviceType: "hub", supportLevel: "topology-only", interfaceNaming: "preserve" },
  { sourcePlatform: "*", sourceKinds: ["cloud", "nat-cloud", "internet"], targetDeviceType: "cloud", supportLevel: "topology-only", interfaceNaming: "preserve" },
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

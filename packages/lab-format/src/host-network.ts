import type { DeviceConfig, LabDocument } from "@sim/contracts";

export interface HostAddressRecord {
  readonly deviceId: string;
  readonly address: string;
}

export interface DuplicateHostAddressWarning {
  readonly code: "duplicate-ip";
  readonly address: string;
  readonly deviceIds: readonly [string, string];
  readonly message: string;
}

type WireVlan = number | undefined;
type SwitchPortState =
  | { mode: "access"; accessVlan: number; nativeVlan: number; allowedVlans?: number[] }
  | { mode: "trunk"; accessVlan: number; nativeVlan: number; allowedVlans?: number[] }
  | { mode: "routed"; accessVlan: number; nativeVlan: number; allowedVlans?: number[] };

function endpoint(node: string, iface: string): string {
  return `${node}\u0000${iface}`;
}

function switchPort(config: DeviceConfig, interfaceId: string): SwitchPortState | undefined {
  if (config.kind !== "l2-switch" && config.kind !== "l3-switch") return undefined;
  const port = config.interfaces.find((candidate) => candidate.id === interfaceId);
  if (!port) return { mode: "access", accessVlan: 1, nativeVlan: 1 };
  if (port.mode === "routed") return { mode: "routed", accessVlan: 1, nativeVlan: 1 };
  return port;
}

function vlanAllowed(port: SwitchPortState, vlan: number): boolean {
  if (port.mode === "routed") return false;
  if (port.mode === "access") return port.accessVlan === vlan;
  return port.allowedVlans === undefined || port.allowedVlans.includes(vlan);
}

/**
 * Determine L2 reachability without running the engine. VLAN tags are carried
 * only across trunk links; access/native links are represented as untagged.
 */
export function hostsShareBroadcastDomain(document: LabDocument, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  const nodes = new Map(document.topology.nodes.map((node) => [node.id, node]));
  const links = new Map<string, { node: string; iface: string }>();
  for (const link of document.topology.links) {
    links.set(endpoint(link.a.node, link.a.iface), link.b);
    links.set(endpoint(link.b.node, link.b.iface), link.a);
  }
  const source = nodes.get(sourceId);
  if (!source || !nodes.has(targetId)) return false;
  const queue: Array<{ node: string; iface: string; vlan: WireVlan }> = [];
  for (const iface of source.interfaces) {
    const peer = links.get(endpoint(source.id, iface.id));
    if (peer) queue.push({ ...peer, vlan: undefined });
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `${endpoint(current.node, current.iface)}\u0000${current.vlan ?? "untagged"}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (current.node === targetId) return true;
    const node = nodes.get(current.node);
    const config = document.configurations[current.node];
    if (!node || !config) continue;

    const egress: Array<{ iface: string; vlan: WireVlan }> = [];
    if (config.kind === "hub" || config.kind === "bridge") {
      for (const iface of node.interfaces) if (iface.id !== current.iface) egress.push({ iface: iface.id, vlan: current.vlan });
    } else if (config.kind === "l2-switch" || config.kind === "l3-switch") {
      const ingress = switchPort(config, current.iface);
      if (!ingress || ingress.mode === "routed") continue;
      const internalVlan = ingress.mode === "access"
        ? ingress.accessVlan
        : current.vlan ?? ingress.nativeVlan;
      for (const iface of node.interfaces) {
        if (iface.id === current.iface) continue;
        const port = switchPort(config, iface.id);
        if (!port || !vlanAllowed(port, internalVlan)) continue;
        egress.push({
          iface: iface.id,
          vlan: port.mode === "trunk" && port.nativeVlan !== internalVlan ? internalVlan : undefined,
        });
      }
    }

    for (const next of egress) {
      const peer = links.get(endpoint(current.node, next.iface));
      if (peer) queue.push({ ...peer, vlan: next.vlan });
    }
  }
  return false;
}

/** Stable, pairwise duplicate warnings for live host address records. */
export function findDuplicateHostAddresses(
  document: LabDocument,
  records: readonly HostAddressRecord[],
): DuplicateHostAddressWarning[] {
  const sorted = [...records].sort((a, b) => a.address.localeCompare(b.address) || a.deviceId.localeCompare(b.deviceId));
  const warnings: DuplicateHostAddressWarning[] = [];
  for (let left = 0; left < sorted.length; left++) {
    for (let right = left + 1; right < sorted.length; right++) {
      const a = sorted[left]!;
      const b = sorted[right]!;
      if (a.address !== b.address) break;
      if (!hostsShareBroadcastDomain(document, a.deviceId, b.deviceId)) continue;
      warnings.push({
        code: "duplicate-ip",
        address: a.address,
        deviceIds: [a.deviceId, b.deviceId],
        message: `Duplicate IPv4 address detected: ${a.address}`,
      });
    }
  }
  return warnings;
}

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  PORT_GROUP_ADAPTIVE,
  portBodyAttrs,
} from "./styles";
import type { GraphNodeModel } from "./types";

// One X6 port per physical interface. Links attach to a specific interface, so
// ports carry the interface id verbatim. Their absolute positions are updated
// by adaptive-link-anchor geometry; the circles remain invisible/non-magnetic.

export interface PortDefinition {
  // X6 port metadata is heterogeneous; keep it loose at this boundary.
  groups: Record<string, any>;
  items: Array<{ id: string; group: string; args: { x: number; y: number }; attrs: Record<string, any> }>;
}

function portGroups(): Record<string, any> {
  return {
    [PORT_GROUP_ADAPTIVE]: {
      position: "absolute",
      attrs: { circle: portBodyAttrs(false, false) },
    },
  };
}

export function buildPorts(node: GraphNodeModel, upInterfaces: ReadonlySet<string> = new Set()): PortDefinition {
  const occupied = new Set(node.occupiedInterfaces);
  return {
    groups: portGroups(),
    items: node.interfaces.map((iface) => ({
      id: iface,
      group: PORT_GROUP_ADAPTIVE,
      // Unused ports share a harmless invisible default. Incident links move
      // their exact interface port to the selected node boundary.
      args: { x: NODE_WIDTH, y: NODE_HEIGHT / 2 },
      attrs: {
        circle: {
          ...portBodyAttrs(occupied.has(iface), upInterfaces.has(iface)),
          "data-interface": iface,
        },
      },
    })),
  };
}

/** True when the port set on a node matches the desired interface list/order. */
export function portsMatch(current: readonly (string | undefined)[], wanted: readonly string[]): boolean {
  const ids = current.filter((id): id is string => Boolean(id));
  return ids.length === wanted.length && wanted.every((id, index) => ids[index] === id);
}

import { PORT_GROUP, portBodyAttrs } from "./styles";
import type { GraphNodeModel } from "./types";

// One X6 port per physical interface. Links attach to a specific interface, so
// ports carry the interface id verbatim and expose free/occupied/up styling.

export interface PortDefinition {
  // X6 port metadata is heterogeneous; keep it loose at this boundary.
  groups: Record<string, any>;
  items: Array<{ id: string; group: string; attrs: Record<string, any> }>;
}

function portGroups(): Record<string, any> {
  return {
    [PORT_GROUP]: {
      position: "right",
      label: { position: { name: "right", args: { x: 6 } } },
      attrs: {
        circle: portBodyAttrs(false, false),
      },
    },
  };
}

export function buildPorts(node: GraphNodeModel, upInterfaces: ReadonlySet<string> = new Set()): PortDefinition {
  const occupied = new Set(node.occupiedInterfaces);
  return {
    groups: portGroups(),
    items: node.interfaces.map((iface) => ({
      id: iface,
      group: PORT_GROUP,
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

import { PORT_GROUP_LEFT, PORT_GROUP_RIGHT, portBodyAttrs } from "./styles";
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
    [PORT_GROUP_LEFT]: {
      position: "left",
      label: { position: { name: "left", args: { x: -6 } } },
      attrs: { circle: portBodyAttrs(false, false) },
    },
    [PORT_GROUP_RIGHT]: {
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
    items: node.interfaces.map((iface, index) => ({
      id: iface,
      group: index % 2 === 0 ? PORT_GROUP_RIGHT : PORT_GROUP_LEFT,
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

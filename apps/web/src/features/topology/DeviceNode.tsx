import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Monitor, Network, Router as RouterIcon, TerminalSquare } from "lucide-react";
import type { MouseEvent } from "react";
import { StatusIndicator } from "../../ui";

export type DeviceNodeData = Record<string, unknown> & {
  hostname: string;
  deviceType: "pc" | "l2-switch" | "router";
  status: "up" | "down";
  subtitle: string;
  interfaces: Array<{ id: string; operationalUp: boolean }>;
  terminalOpen: boolean;
  configurationChanged: boolean;
  connectable: boolean;
  onActivate(id: string): void;
  onContextMenu(id: string, event: MouseEvent): void;
};

export type DeviceFlowNode = Node<DeviceNodeData, "device">;

const icons = { pc: Monitor, "l2-switch": Network, router: RouterIcon } as const;
const labels = { pc: "PC", "l2-switch": "L2 switch", router: "Router" } as const;

export function DeviceNode({ id, data, selected }: NodeProps<DeviceFlowNode>) {
  const DeviceIcon = icons[data.deviceType];
  const nodeClass = [
    "device-node",
    selected ? "is-selected" : "",
    data.terminalOpen ? "has-terminal" : "",
    data.configurationChanged ? "is-changed" : "",
    data.status === "down" ? "is-down" : "",
  ].filter(Boolean).join(" ");
  const handleTop = (index: number) => `${22 + (index / Math.max(1, data.interfaces.length - 1)) * 56}%`;

  return (
    <div className={nodeClass} data-device-id={id} onContextMenu={(event) => data.onContextMenu(id, event)}>
      {data.interfaces.map((iface, index) => (
        <Handle
          key={`target-${iface.id}`}
          type="target"
          position={Position.Left}
          id={`target:${iface.id}`}
          title={`${iface.id} input`}
          className={iface.operationalUp ? "is-up" : ""}
          style={{ top: handleTop(index) }}
          isConnectable={data.connectable}
        />
      ))}
      <button type="button" aria-label={`Select ${data.hostname}`} aria-pressed={selected} onClick={() => data.onActivate(id)}>
        <span className="device-node__icon" aria-hidden="true"><DeviceIcon size={23} strokeWidth={1.55} /></span>
        <span className="device-node__copy">
          <span><strong>{data.hostname}</strong>{data.terminalOpen && <TerminalSquare size={11} aria-label="CLI open" />}</span>
          <small>{data.subtitle}</small>
        </span>
        <StatusIndicator status={data.status} compact />
      </button>
      <span className="device-node__type">{labels[data.deviceType]}</span>
      {data.configurationChanged && <span className="device-node__changed" title="Configuration changed">●</span>}
      {data.interfaces.map((iface, index) => (
        <Handle
          key={`source-${iface.id}`}
          type="source"
          position={Position.Right}
          id={iface.id}
          title={`${iface.id} output`}
          className={iface.operationalUp ? "is-up" : ""}
          style={{ top: handleTop(index) }}
          isConnectable={data.connectable}
        />
      ))}
    </div>
  );
}

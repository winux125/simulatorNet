import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type DeviceNodeData = Record<string, unknown> & {
  hostname: string;
  deviceType: "pc" | "l2-switch" | "router";
  status: "up" | "down";
  interfaces: string[];
  onActivate(id: string): void;
};

export type DeviceFlowNode = Node<DeviceNodeData, "device">;

const icons = { pc: "▣", "l2-switch": "⇄", router: "◇" } as const;
const labels = { pc: "PC", "l2-switch": "L2 SWITCH", router: "ROUTER" } as const;

export function DeviceNode({ id, data, selected }: NodeProps<DeviceFlowNode>) {
  return (
    <div className={`device-node ${selected ? "selected" : ""}`} data-device-id={id}>
      {data.interfaces.map((iface, index) => (
        <Handle
          key={`target-${iface}`}
          type="target"
          position={Position.Left}
          id={`target:${iface}`}
          title={`${iface} target`}
          style={{ top: 50 + index * 12 }}
        />
      ))}
      <button type="button" aria-label={`Select ${data.hostname}`} aria-pressed={selected} onClick={() => data.onActivate(id)}>
        <span className="device-icon" aria-hidden="true">{icons[data.deviceType]}</span>
        <span className="device-copy"><small>{labels[data.deviceType]}</small><strong>{data.hostname}</strong></span>
        <span className={`status-dot ${data.status}`} aria-label={`Status ${data.status}`} />
      </button>
      <div className="port-strip" aria-label={`${data.interfaces.length} interfaces`}>
        {data.interfaces.slice(0, 8).map((iface) => <span key={iface} title={iface} />)}
      </div>
      {data.interfaces.map((iface, index) => (
        <Handle
          key={`source-${iface}`}
          type="source"
          position={Position.Right}
          id={iface}
          title={`${iface} source`}
          style={{ top: 50 + index * 12 }}
        />
      ))}
    </div>
  );
}

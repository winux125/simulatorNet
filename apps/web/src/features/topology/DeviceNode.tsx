import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { getDeviceProfile, type DeviceType } from "@sim/contracts";
import { GitMerge, Monitor, Network, Router as RouterIcon, Server, Share2, TerminalSquare, Waypoints, type LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { StatusIndicator } from "../../ui";

export type DeviceNodeData = Record<string, unknown> & {
  hostname: string;
  deviceType: DeviceType;
  status: "up" | "down";
  subtitle: string;
  interfaces: Array<{ id: string; operationalUp: boolean }>;
  serviceBadges?: string[];
  terminalOpen: boolean;
  configurationChanged: boolean;
  connectable: boolean;
  onActivate(id: string): void;
  onOpen(id: string): void;
  onContextMenu(id: string, event: MouseEvent): void;
};

export type DeviceFlowNode = Node<DeviceNodeData, "device">;

const icons: Record<DeviceType, LucideIcon> = {
  pc: Monitor,
  server: Server,
  hub: Share2,
  bridge: GitMerge,
  "l2-switch": Network,
  "l3-switch": Waypoints,
  router: RouterIcon,
};

export function DeviceNode({ id, data, selected }: NodeProps<DeviceFlowNode>) {
  const DeviceIcon = icons[data.deviceType];
  const profile = getDeviceProfile(data.deviceType);
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
      <button
        type="button"
        aria-label={`Select ${data.hostname}`}
        aria-pressed={selected}
        onClick={() => data.onActivate(id)}
        onDoubleClick={() => data.onOpen(id)}
      >
        <span className="device-node__icon" aria-hidden="true"><DeviceIcon size={23} strokeWidth={1.55} /></span>
        <span className="device-node__copy">
          <span><strong>{data.hostname}</strong>{data.terminalOpen && <TerminalSquare size={11} aria-label="CLI open" />}</span>
          <small>{data.subtitle}</small>
        </span>
        <StatusIndicator status={data.status} compact />
      </button>
      <span className="device-node__type" title={profile.description}>{profile.displayName}</span>
      {data.serviceBadges && data.serviceBadges.length > 0 && <span className="device-node__services" aria-label={`Enabled services: ${data.serviceBadges.join(", ")}`}>{data.serviceBadges.slice(0, 3).map((service) => <b key={service}>{service}</b>)}</span>}
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

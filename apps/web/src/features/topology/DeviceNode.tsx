import type { DeviceType } from "@sim/contracts";
import type { MouseEvent } from "react";
import { DeviceIcon } from "../../components/DeviceIcon";

export interface DeviceNodeData {
  hostname: string;
  deviceType: DeviceType;
  status: "up" | "down";
  subtitle: string;
  interfaces: Array<{ id: string; operationalUp: boolean }>;
  serviceBadges?: string[];
  terminalOpen: boolean;
  configurationChanged: boolean;
  onActivate(id: string): void;
  onOpen(id: string): void;
  onContextMenu(id: string, event: MouseEvent): void;
}

/** Compact equipment symbol rendered inside the X6 React node. */
export function DeviceNode({ id, data, selected }: { id: string; data: DeviceNodeData; selected: boolean }) {
  const nodeClass = [
    "device-node",
    selected ? "is-selected" : "",
    data.terminalOpen ? "has-terminal" : "",
    data.configurationChanged ? "is-changed" : "",
    data.status === "down" ? "is-down" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={nodeClass} data-device-id={id} onContextMenu={(event) => data.onContextMenu(id, event)}>
      <button
        type="button"
        aria-label={`Select ${data.hostname}`}
        aria-pressed={selected}
        onClick={() => data.onActivate(id)}
        onDoubleClick={() => data.onOpen(id)}
      >
        <span className="device-node__icon" aria-hidden="true">
          <DeviceIcon type={data.deviceType} size={48} state={data.status === "up" ? "running" : "stopped"} />
        </span>
        <span className="device-node__name">
          <i aria-hidden="true" />
          <strong>{data.hostname}</strong>
        </span>
        <small>{data.subtitle}</small>
      </button>
      {data.terminalOpen && <span className="device-node__terminal" title="CLI open">CLI</span>}
      {data.serviceBadges && data.serviceBadges.length > 0 && (
        <span className="visually-hidden" aria-label={`Enabled services: ${data.serviceBadges.join(", ")}`} />
      )}
      {data.configurationChanged && <span className="device-node__changed" title="Pending rebuild">!</span>}
    </div>
  );
}

import type { DeviceType } from "@sim/contracts";
import { Cable } from "lucide-react";
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
  /** Running differs from startup. A small marker only — never a large badge. */
  unsavedConfiguration: boolean;
  connectable: boolean;
  onActivate(id: string): void;
  onOpen(id: string): void;
  onConnectStart(id: string): void;
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
        className="device-node__surface"
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
      {/*
        The single cable handle is the only visual connection control on a
        device. Interface ports exist but are invisible anchors, so there are
        never port dots to drag.
      */}
      {data.connectable && (
        <button
          type="button"
          className="device-node__connect"
          aria-label={`Connect ${data.hostname} to another device`}
          title="Connect"
          data-connection-handle="true"
          {...({ magnet: "true" } as Record<string, string>)}
          onClick={(event) => {
            event.stopPropagation();
            // X6 emits a click after a completed mouse drag. Treat only a
            // keyboard activation as the button-style fallback; pointer users
            // create the connection by dragging the magnet.
            if (event.detail === 0) data.onConnectStart(id);
          }}
        >
          <Cable size={12} aria-hidden="true" />
        </button>
      )}
      {data.terminalOpen && <span className="device-node__terminal" title="CLI open">CLI</span>}
      {data.serviceBadges && data.serviceBadges.length > 0 && (
        <span className="visually-hidden" aria-label={`Enabled services: ${data.serviceBadges.join(", ")}`} />
      )}
      {data.configurationChanged && <span className="device-node__changed" title="Pending rebuild">!</span>}
      {data.unsavedConfiguration && (
        <span className="device-node__unsaved" title="Configuration: Modified" aria-label="Configuration modified" />
      )}
    </div>
  );
}

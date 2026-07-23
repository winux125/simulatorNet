import { getDeviceProfile, type DeviceType } from "@sim/contracts";
import { TerminalSquare } from "lucide-react";
import type { MouseEvent } from "react";
import { DeviceIcon } from "../../components/DeviceIcon";
import { StatusIndicator } from "../../ui";

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

/**
 * A single topology device. Rendered both by the X6 graph (via
 * `@antv/x6-react-shape`) in the browser and directly by the test harness, so
 * it stays framework-agnostic: no canvas-library imports, and interaction is a
 * plain accessible button. X6 owns dragging and edge routing; this button owns
 * select / open / context-menu so the same affordances work under jsdom.
 */
export function DeviceNode({ id, data, selected }: { id: string; data: DeviceNodeData; selected: boolean }) {
  const profile = getDeviceProfile(data.deviceType);
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
        <span className="device-node__icon" aria-hidden="true"><DeviceIcon type={data.deviceType} size={22} state={data.status === "up" ? "running" : "stopped"} /></span>
        <span className="device-node__copy">
          <span><strong>{data.hostname}</strong>{data.terminalOpen && <TerminalSquare size={11} aria-label="CLI open" />}</span>
          <small>{data.subtitle}</small>
        </span>
        <StatusIndicator status={data.status} compact />
      </button>
      <span className="device-node__type" title={profile.description}>{profile.displayName}</span>
      {data.serviceBadges && data.serviceBadges.length > 0 && <span className="device-node__services" aria-label={`Enabled services: ${data.serviceBadges.join(", ")}`}>{data.serviceBadges.slice(0, 3).map((service) => <b key={service}>{service}</b>)}</span>}
      {data.configurationChanged && <span className="device-node__changed" title="Configuration changed">●</span>}
    </div>
  );
}

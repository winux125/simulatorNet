import type { NodeSpec } from "@sim/contracts";

interface DevicePaletteProps {
  disabled: boolean;
  onAdd(kind: NodeSpec["kind"]): void;
}

const devices: Array<{ kind: NodeSpec["kind"]; icon: string; label: string; ports: string }> = [
  { kind: "pc", icon: "▣", label: "PC", ports: "1 × Ethernet" },
  { kind: "l2-switch", icon: "⇄", label: "L2 Switch", ports: "8 × Gigabit" },
  { kind: "router", icon: "◇", label: "Router", ports: "2 × Gigabit" },
];

export function DevicePalette({ disabled, onAdd }: DevicePaletteProps) {
  return (
    <aside className="palette panel" aria-label="Device palette">
      <div className="panel-heading"><span>Devices</span><small>Draft topology</small></div>
      <p className="panel-help">Add devices, then connect free interface handles on the canvas.</p>
      <div className="palette-list">
        {devices.map((device) => (
          <button key={device.kind} type="button" aria-label={`Add ${device.label}`} disabled={disabled} onClick={() => onAdd(device.kind)}>
            <span className="palette-icon" aria-hidden="true">{device.icon}</span>
            <span><strong>Add {device.label}</strong><small>{device.ports}</small></span>
          </button>
        ))}
      </div>
      <div className="reset-note" role="note">
        <strong>Rebuild boundary</strong>
        <span>Applying topology changes resets runtime state. Structured device configuration is preserved where possible.</span>
      </div>
    </aside>
  );
}

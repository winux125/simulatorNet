import { DEVICE_PROFILE_LIST, type NodeSpec } from "@sim/contracts";
import {
  Cable, GitMerge, Monitor, Network, Router as RouterIcon, Server, Share2,
  Sparkles, Trash2, Waypoints, type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { WorkspaceTool } from "../state/workspace-store";

interface DevicePaletteProps {
  disabled: boolean;
  selectedKind: NodeSpec["kind"] | undefined;
  activeTool: WorkspaceTool;
  onSelectKind(kind: NodeSpec["kind"]): void;
  onTool(tool: WorkspaceTool): void;
}

type PaletteCategory = "network" | "end-device" | "connections";

const icons: Record<NodeSpec["kind"], LucideIcon> = {
  pc: Monitor,
  server: Server,
  hub: Share2,
  bridge: GitMerge,
  "l2-switch": Network,
  "l3-switch": Waypoints,
  router: RouterIcon,
};

const categories: Array<{ id: PaletteCategory; label: string }> = [
  { id: "network", label: "Network Devices" },
  { id: "end-device", label: "End Devices" },
  { id: "connections", label: "Connections" },
];

export function DevicePalette(props: DevicePaletteProps) {
  const [category, setCategory] = useState<PaletteCategory>("network");
  const devices = useMemo(
    () => DEVICE_PROFILE_LIST.filter((profile) => profile.category === category),
    [category],
  );

  return (
    <aside className="device-palette" aria-label="Device palette" data-region="bottom">
      <div className="device-palette__categories" role="tablist" aria-label="Device categories">
        {categories.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={category === entry.id}
            className={category === entry.id ? "is-active" : ""}
            onClick={() => setCategory(entry.id)}
          >
            {entry.id === "network" ? <Network size={15} /> : entry.id === "end-device" ? <Monitor size={15} /> : <Cable size={15} />}
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
      <div className="device-palette__models" role="tabpanel" aria-label={`${categories.find((entry) => entry.id === category)?.label} models`}>
        {category !== "connections" && devices.map((profile) => {
          const DeviceIcon = icons[profile.type];
          const selected = props.selectedKind === profile.type;
          return (
            <button
              key={profile.type}
              type="button"
              className={`palette-model${selected ? " is-active" : ""}`}
              aria-label={`Add ${profile.displayName}`}
              aria-pressed={selected}
              title={`${profile.description} Click, then place on the logical workspace.`}
              disabled={props.disabled}
              draggable={!props.disabled}
              data-device-kind={profile.type}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData("application/x-simulator-device", profile.type);
              }}
              onClick={() => props.onSelectKind(profile.type)}
            >
              <span className="palette-model__icon"><DeviceIcon size={22} strokeWidth={1.55} /></span>
              <span>{profile.displayName}</span>
            </button>
          );
        })}
        {category === "connections" && <>
          <ConnectionTool
            label="Automatic Ethernet"
            description="Choose compatible free Ethernet ports"
            icon={Sparkles}
            active={props.activeTool === "add-link"}
            disabled={props.disabled}
            onClick={() => props.onTool("add-link")}
          />
          <ConnectionTool
            label="Ethernet Link"
            description="Drag between interface endpoints"
            icon={Cable}
            active={props.activeTool === "add-link"}
            disabled={props.disabled}
            onClick={() => props.onTool("add-link")}
          />
          <ConnectionTool
            label="Delete Link"
            description="Select a link, then delete it"
            icon={Trash2}
            active={props.activeTool === "delete"}
            disabled={props.disabled}
            onClick={() => props.onTool("delete")}
          />
        </>}
        <p className="device-palette__hint">
          {props.disabled ? "Enable Edit Topology to place devices and connections." : "Drag a model, or click it and place it on the canvas."}
        </p>
      </div>
    </aside>
  );
}

function ConnectionTool({
  label,
  description,
  icon: ToolIcon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  description: string;
  icon: LucideIcon;
  active: boolean;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`palette-model palette-model--connection${active ? " is-active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={description}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="palette-model__icon"><ToolIcon size={21} /></span>
      <span>{label}</span>
    </button>
  );
}

import {
  DEVICE_PROFILE_LIST,
  getDeviceHardwareProfiles,
  type DeviceHardwareProfileId,
  type NodeSpec,
} from "@sim/contracts";
import {
  Cable,
  ChevronDown,
  Cloud,
  Monitor,
  Network,
  Plus,
  Shield,
  Sparkles,
  Trash2,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceTool } from "../state/workspace-store";
import { DeviceIcon } from "./DeviceIcon";

interface DevicePaletteProps {
  open: boolean;
  disabled: boolean;
  selectedKind: NodeSpec["kind"] | undefined;
  selectedHardwareProfileId: DeviceHardwareProfileId | undefined;
  activeTool: WorkspaceTool;
  onOpenChange(open: boolean): void;
  onSelectKind(kind: NodeSpec["kind"], hardwareProfileId?: DeviceHardwareProfileId): void;
  onTool(tool: WorkspaceTool): void;
}

type PaletteCategory = "network" | "wireless" | "end-device" | "security" | "infrastructure" | "connections";

const categories: Array<{ id: PaletteCategory; label: string }> = [
  { id: "network", label: "Network Devices" },
  { id: "wireless", label: "Wireless Devices" },
  { id: "end-device", label: "End Devices" },
  { id: "security", label: "Security" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "connections", label: "Connections" },
];

export function DevicePalette(props: DevicePaletteProps) {
  const [category, setCategory] = useState<PaletteCategory>("network");
  const rootRef = useRef<HTMLDivElement>(null);
  const devices = useMemo(
    () => DEVICE_PROFILE_LIST.filter((profile) => profile.category === category),
    [category],
  );

  useEffect(() => {
    if (!props.open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) props.onOpenChange(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [props.open, props.onOpenChange]);

  const selectKind = (kind: NodeSpec["kind"], hardwareProfileId?: DeviceHardwareProfileId) => {
    props.onSelectKind(kind, hardwareProfileId);
    props.onOpenChange(false);
  };
  const selectTool = (tool: WorkspaceTool) => {
    props.onTool(tool);
    props.onOpenChange(false);
  };

  return (
    <div className="device-picker" ref={rootRef}>
      <button
        type="button"
        className={`device-picker__trigger${props.open ? " is-open" : ""}${props.selectedKind ? " is-active" : ""}`}
        aria-label="Add Device"
        aria-haspopup="dialog"
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <Plus size={14} />
        <span>Add Device</span>
        <ChevronDown size={12} />
      </button>
      {props.open && (
        <div className="device-picker__menu" role="dialog" aria-label="Add topology item">
          <div className="device-picker__categories" role="tablist" aria-label="Device categories">
            {categories.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={category === entry.id}
                className={category === entry.id ? "is-active" : ""}
                onClick={() => setCategory(entry.id)}
              >
                {entry.id === "network"
                  ? <Network size={15} />
                  : entry.id === "wireless"
                    ? <Wifi size={15} />
                  : entry.id === "end-device"
                    ? <Monitor size={15} />
                    : entry.id === "security"
                      ? <Shield size={15} />
                      : entry.id === "infrastructure"
                        ? <Cloud size={15} />
                        : <Cable size={15} />}
                <span>{entry.label}</span>
              </button>
            ))}
          </div>
          <div className="device-picker__models" role="tabpanel" aria-label={`${categories.find((entry) => entry.id === category)?.label} models`}>
            {category !== "connections" && devices.flatMap((profile) => {
              const hardwareProfiles = getDeviceHardwareProfiles(profile.type);
              const models = hardwareProfiles.length > 0 ? hardwareProfiles : [undefined];
              return models.map((hardwareProfile, modelIndex) => {
                const selected = props.selectedKind === profile.type
                  && props.selectedHardwareProfileId === hardwareProfile?.id;
                const isLegacyDefault = modelIndex === 0;
                const ariaLabel = isLegacyDefault
                  ? `Add ${profile.displayName}`
                  : `Add ${hardwareProfile!.displayName} ${profile.displayName}`;
                return (
                <button
                  key={`${profile.type}:${hardwareProfile?.id ?? "default"}`}
                  type="button"
                  className={`device-picker-model${selected ? " is-active" : ""}`}
                  aria-label={ariaLabel}
                  aria-pressed={selected}
                  title={`${hardwareProfile?.description ?? profile.description} Click, then place on the logical workspace.`}
                  disabled={props.disabled}
                  draggable={!props.disabled}
                  data-device-kind={profile.type}
                  data-hardware-profile={hardwareProfile?.id}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-simulator-device", profile.type);
                    if (hardwareProfile) {
                      event.dataTransfer.setData("application/x-simulator-hardware-profile", hardwareProfile.id);
                    }
                  }}
                  onDragEnd={() => props.onOpenChange(false)}
                  onClick={() => selectKind(profile.type, hardwareProfile?.id)}
                >
                  <span className="device-picker-model__icon"><DeviceIcon type={profile.type} size={30} /></span>
                  <span>{hardwareProfile?.displayName ?? profile.displayName}</span>
                </button>
                );
              });
            })}
            {category === "connections" && <>
              <ConnectionTool
                label="Automatic Ethernet"
                description="Drag a cable handle between devices, then confirm their interfaces"
                icon={Sparkles}
                active={props.activeTool === "add-link"}
                disabled={props.disabled}
                onClick={() => selectTool("add-link")}
              />
              <ConnectionTool
                label="Ethernet Link"
                description="Advanced: drag directly between physical interface endpoints"
                icon={Cable}
                active={props.activeTool === "add-link"}
                disabled={props.disabled}
                onClick={() => selectTool("add-link")}
              />
              <ConnectionTool
                label="Delete Link"
                description="Select a link, then delete it"
                icon={Trash2}
                active={props.activeTool === "delete"}
                disabled={props.disabled}
                onClick={() => selectTool("delete")}
              />
            </>}
          </div>
          <p className="device-picker__hint">
            {props.disabled ? "Enable Edit Topology to place devices and connections." : "Drag a model, or select it and place it on the canvas."}
          </p>
        </div>
      )}
    </div>
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
      className={`device-picker-model device-picker-model--connection${active ? " is-active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={description}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="device-picker-model__icon"><ToolIcon size={21} /></span>
      <span>{label}</span>
    </button>
  );
}

import { DEVICE_PROFILE_LIST, type DeviceProfile, type NodeSpec } from "@sim/contracts";
import { ChevronDown, ChevronRight, GitMerge, GripVertical, Monitor, Network, Router as RouterIcon, Search, Server, Share2, Waypoints, X, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { IconButton, PanelHeader } from "../ui";

interface DevicePaletteProps {
  disabled: boolean;
  onAdd(kind: NodeSpec["kind"]): void;
  onClose(): void;
}

const icons: Record<NodeSpec["kind"], LucideIcon> = {
  pc: Monitor,
  server: Server,
  hub: Share2,
  bridge: GitMerge,
  "l2-switch": Network,
  "l3-switch": Waypoints,
  router: RouterIcon,
};

const categoryLabels = { "end-device": "End devices", network: "Network devices" } as const;
const categories = (["end-device", "network"] as const).map((category) => ({
  id: category,
  label: categoryLabels[category],
  devices: DEVICE_PROFILE_LIST.filter((profile) => profile.category === category).map((profile) => ({
    profile,
    kind: profile.type,
    icon: icons[profile.type],
    label: profile.displayName,
    short: `${profile.interfaceTemplates.length} Ethernet · ${capabilitySummary(profile)}`,
  })),
}));

function capabilitySummary(profile: DeviceProfile): string {
  if (profile.capabilities.includes("ipv4-routing")) return "Layer 3";
  if (profile.capabilities.includes("layer2-switching")) return "VLAN switching";
  if (profile.capabilities.includes("ethernet-repeater")) return "Repeater";
  if (profile.capabilities.includes("ethernet-bridge")) return "MAC learning";
  return "IPv4 host";
}

export function DevicePalette({ disabled, onAdd, onClose }: DevicePaletteProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => categories.map((category) => ({
    ...category,
    devices: category.devices.filter((device) => `${device.label} ${device.short} ${device.profile.description}`.toLowerCase().includes(query.toLowerCase())),
  })).filter((category) => category.devices.length > 0), [query]);

  const toggleCategory = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <aside className="device-library" aria-label="Device library">
      <PanelHeader
        title="Device library"
        detail="Drag or click to add"
        actions={<IconButton label="Close device library" icon={<X size={15} />} onClick={onClose} />}
      />
      <label className="library-search">
        <Search size={14} aria-hidden="true" />
        <span className="visually-hidden">Filter devices</span>
        <input aria-label="Filter devices" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter devices" />
      </label>
      <div className="library-groups">
        {filtered.map((category) => {
          const isCollapsed = collapsed.has(category.id);
          return (
            <section key={category.id}>
              <button className="library-category" type="button" aria-expanded={!isCollapsed} onClick={() => toggleCategory(category.id)}>
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span>{category.label}</span>
                <small>{category.devices.length}</small>
              </button>
              {!isCollapsed && <div className="library-items">
                {category.devices.map((device) => {
                  const DeviceIcon = device.icon;
                  return (
                    <button
                      key={device.kind}
                      type="button"
                      className="library-device"
                      aria-label={`Add ${device.label}`}
                      title={device.profile.description}
                      disabled={disabled}
                      draggable={!disabled}
                      data-device-kind={device.kind}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "copy";
                        event.dataTransfer.setData("application/x-simulator-device", device.kind);
                      }}
                      onClick={() => onAdd(device.kind)}
                    >
                      <span className="library-device__icon"><DeviceIcon size={21} strokeWidth={1.6} /></span>
                      <span><strong>{device.label}</strong><small>{device.short}</small></span>
                      <GripVertical className="library-device__grip" size={15} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>}
            </section>
          );
        })}
      </div>
      <p className="library-tip">Drop on the canvas to place precisely. New topology stays local until Apply &amp; Rebuild.</p>
    </aside>
  );
}

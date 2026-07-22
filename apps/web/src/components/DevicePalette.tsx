import type { NodeSpec } from "@sim/contracts";
import { ChevronDown, ChevronRight, GripVertical, Monitor, Network, Router as RouterIcon, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { IconButton, PanelHeader } from "../ui";

interface DevicePaletteProps {
  disabled: boolean;
  onAdd(kind: NodeSpec["kind"]): void;
  onClose(): void;
}

const categories = [
  {
    id: "end",
    label: "End devices",
    devices: [{ kind: "pc" as const, icon: Monitor, label: "PC", short: "Host · 1 Ethernet" }],
  },
  {
    id: "network",
    label: "Network devices",
    devices: [
      { kind: "l2-switch" as const, icon: Network, label: "L2 Switch", short: "LAN · 8 Gigabit" },
      { kind: "router" as const, icon: RouterIcon, label: "Router", short: "Layer 3 · 2 Gigabit" },
    ],
  },
];

export function DevicePalette({ disabled, onAdd, onClose }: DevicePaletteProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => categories.map((category) => ({
    ...category,
    devices: category.devices.filter((device) => `${device.label} ${device.short}`.toLowerCase().includes(query.toLowerCase())),
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

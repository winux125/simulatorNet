import { getDeviceProfile, resolveDeviceInterfaceTemplates, type LabDocument, type NodeSpec } from "@sim/contracts";
import { ArrowRight, Cable, X } from "lucide-react";
import { useState, type FormEvent, type MouseEvent } from "react";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Button } from "../../ui";
import { validateConnection } from "./x6/lab-document-adapter";

interface DeviceConnectionDialogProps {
  document: LabDocument;
  sourceId: string;
  targetId: string;
  preferredSourcePort?: string;
  preferredTargetPort?: string;
  reconnectLinkId?: string;
  onConnect(sourceId: string, sourcePort: string, targetId: string, targetPort: string): void;
  onClose(): void;
}

export type ConnectionInterfaceFilter = "available" | "connected" | "all";

export interface ConnectionInterfaceOption {
  readonly id: string;
  readonly occupied: boolean;
  readonly peer?: string;
}

export function naturalInterfaceCompare(left: string, right: string): number {
  const leftParts = left.match(/\d+|\D+/g) ?? [left];
  const rightParts = right.match(/\d+|\D+/g) ?? [right];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined;
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined;
    const comparison = aNumber !== undefined && bNumber !== undefined
      ? aNumber - bNumber
      : a.localeCompare(b, "en", { sensitivity: "base" });
    if (comparison !== 0) return comparison;
  }
  return left.localeCompare(right);
}

export function connectionInterfaceInventory(
  document: LabDocument,
  nodeId: string,
  ignoreLinkId?: string,
): ConnectionInterfaceOption[] {
  const node = document.topology.nodes.find((candidate) => candidate.id === nodeId);
  const ethernet = node
    ? new Set(
        resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId)
          .filter((iface) => iface.media === "ethernet")
          .map((iface) => iface.id),
      )
    : new Set<string>();
  const peersByInterface = new Map<string, { nodeId: string; interfaceId: string }>();
  for (const link of document.topology.links) {
    if (link.id === ignoreLinkId) continue;
    if (link.a.node === nodeId) peersByInterface.set(link.a.iface, { nodeId: link.b.node, interfaceId: link.b.iface });
    if (link.b.node === nodeId) peersByInterface.set(link.b.iface, { nodeId: link.a.node, interfaceId: link.a.iface });
  }
  return node?.interfaces
    .map((iface) => iface.id)
    .filter((interfaceId) => ethernet.has(interfaceId) || node.kind === "l2-switch" || node.kind === "l3-switch")
    .sort(naturalInterfaceCompare)
    .map((interfaceId) => {
      const peer = peersByInterface.get(interfaceId);
      if (!peer) return { id: interfaceId, occupied: false };
      const peerNode = document.topology.nodes.find((candidate) => candidate.id === peer.nodeId);
      return {
        id: interfaceId,
        occupied: true,
        peer: `${peerNode ? hostname(document, peerNode) : peer.nodeId} ${peer.interfaceId}`,
      };
    }) ?? [];
}

function hostname(document: LabDocument, node: NodeSpec): string {
  return document.configurations[node.id]?.hostname ?? node.name ?? node.id;
}

function preferredFreePort(inventory: readonly ConnectionInterfaceOption[], preferred: string | undefined): string {
  const available = inventory.filter((entry) => !entry.occupied);
  return preferred && available.some((entry) => entry.id === preferred) ? preferred : available[0]?.id ?? "";
}

/** Confirms the physical interfaces after a device-to-device drag gesture. */
export function DeviceConnectionDialog(props: DeviceConnectionDialogProps) {
  const sourceNode = props.document.topology.nodes.find((node) => node.id === props.sourceId);
  const targetNode = props.document.topology.nodes.find((node) => node.id === props.targetId);
  const sourceInventory = connectionInterfaceInventory(props.document, props.sourceId, props.reconnectLinkId);
  const targetInventory = connectionInterfaceInventory(props.document, props.targetId, props.reconnectLinkId);
  const sourceAvailable = sourceInventory.filter((entry) => !entry.occupied);
  const targetAvailable = targetInventory.filter((entry) => !entry.occupied);
  const [sourcePort, setSourcePort] = useState(preferredFreePort(sourceInventory, props.preferredSourcePort));
  const [targetPort, setTargetPort] = useState(preferredFreePort(targetInventory, props.preferredTargetPort));
  const [error, setError] = useState<string>();

  if (!sourceNode || !targetNode) return null;
  const sourceName = hostname(props.document, sourceNode);
  const targetName = hostname(props.document, targetNode);
  const canConnect = Boolean(sourcePort && targetPort);
  const titleId = `connect-device-${sourceNode.id}-${targetNode.id}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canConnect) return;
    const validation = validateConnection(
      props.document,
      sourceNode.id,
      sourcePort,
      targetNode.id,
      targetPort,
      { ignoreLinkId: props.reconnectLinkId },
    );
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    props.onConnect(sourceNode.id, sourcePort, targetNode.id, targetPort);
    props.onClose();
  };

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) props.onClose();
  };

  return (
    <div className="dialog-backdrop" onMouseDown={closeFromBackdrop}>
      <form
        className="workspace-dialog device-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
      >
        <header>
          <div>
            <p>{props.reconnectLinkId ? "Topology reconnection" : "Topology connection"}</p>
            <h2 id={titleId}>{props.reconnectLinkId ? "Reconnect link" : "Configure connection"}</h2>
          </div>
          <button type="button" className="dialog-close" aria-label="Close connection dialog" onClick={props.onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="workspace-dialog__body">
        <div className="connection-device-route">
          <EndpointCard label="From device" name={sourceName} kind={sourceNode.kind} />
          <ArrowRight size={17} aria-hidden="true" />
          <EndpointCard label="To device" name={targetName} kind={targetNode.kind} />
        </div>

        <label className="connection-dialog__type">
          <span>Connection type</span>
          <select aria-label="Connection type" value="ethernet" disabled>
            <option value="ethernet">Ethernet</option>
          </select>
          <small>SimulatorNet currently uses deterministic Ethernet links.</small>
        </label>

        <div className="connection-dialog__fields">
          <InterfaceChooser
            name={sourceName}
            direction="From"
            inventory={sourceInventory}
            value={sourcePort}
            onChange={(value) => { setSourcePort(value); setError(undefined); }}
          />

          <span className="connection-dialog__direction" aria-hidden="true"><ArrowRight size={16} /></span>

          <InterfaceChooser
            name={targetName}
            direction="To"
            inventory={targetInventory}
            value={targetPort}
            onChange={(value) => { setTargetPort(value); setError(undefined); }}
          />
        </div>

        {canConnect && (
          <div className="connection-preview" aria-label="Connection preview">
            <strong>{sourceName}</strong><code>{sourcePort}</code>
            <ArrowRight size={14} aria-hidden="true" />
            <strong>{targetName}</strong><code>{targetPort}</code>
          </div>
        )}
        {sourceAvailable.length === 0 && <p className="connection-dialog__error">All interfaces on {sourceName} are already connected.</p>}
        {targetAvailable.length === 0 && <p className="connection-dialog__error">All interfaces on {targetName} are already connected.</p>}
        {error && <p className="connection-dialog__error" role="alert">{error}</p>}

        <p className="section-note">The connection is added only after both physical interfaces are confirmed.</p>
        </div>
        <div className="dialog-actions">
          <Button type="button" variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={<Cable size={14} />} disabled={!canConnect}>{props.reconnectLinkId ? "Reconnect" : "Connect"}</Button>
        </div>
      </form>
    </div>
  );
}

function InterfaceChooser({
  name,
  direction,
  inventory,
  value,
  onChange,
}: {
  name: string;
  direction: "From" | "To";
  inventory: readonly ConnectionInterfaceOption[];
  value: string;
  onChange(value: string): void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ConnectionInterfaceFilter>("available");
  const available = inventory.filter((entry) => !entry.occupied);
  const filtered = inventory.filter((entry) => {
    if (filter === "available" && entry.occupied) return false;
    if (filter === "connected" && !entry.occupied) return false;
    return !search || `${entry.id} ${entry.peer ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
  });
  const selectedOutsideFilter = value && !filtered.some((entry) => entry.id === value)
    ? inventory.find((entry) => entry.id === value)
    : undefined;

  return (
    <fieldset className="connection-interface-picker">
      <legend>{name} interface</legend>
      <div className="connection-interface-picker__tools">
        <input
          type="search"
          aria-label={`${direction} interface search`}
          placeholder="Search ports"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label={`${direction} interface filter`}
          value={filter}
          onChange={(event) => setFilter(event.target.value as ConnectionInterfaceFilter)}
        >
          <option value="available">Available</option>
          <option value="connected">Connected</option>
          <option value="all">All</option>
        </select>
      </div>
      <select
        aria-label={`${direction} interface`}
        value={value}
        disabled={available.length === 0}
        onChange={(event) => onChange(event.target.value)}
      >
        {available.length === 0 && <option value="">No free interfaces</option>}
        {selectedOutsideFilter && (
          <option value={selectedOutsideFilter.id} disabled={selectedOutsideFilter.occupied}>
            {formatInterfaceOption(selectedOutsideFilter)}
          </option>
        )}
        {filtered.length === 0 && available.length > 0 && <option value="" disabled>No matching interfaces</option>}
        {filtered.map((entry) => (
          <option key={entry.id} value={entry.id} disabled={entry.occupied}>{formatInterfaceOption(entry)}</option>
        ))}
      </select>
      <small>{available.length} of {inventory.length} Ethernet interfaces available</small>
    </fieldset>
  );
}

function formatInterfaceOption(entry: ConnectionInterfaceOption): string {
  return entry.occupied
    ? `${entry.id} — Connected to ${entry.peer ?? "unknown peer"}`
    : `${entry.id} — Available — Ethernet`;
}

function EndpointCard({ label, name, kind }: { label: string; name: string; kind: NodeSpec["kind"] }) {
  return (
    <div className="connection-endpoint">
      <span aria-hidden="true"><DeviceIcon type={kind} size={25} /></span>
      <div>
        <small>{label}</small>
        <strong>{name}</strong>
        <code>{getDeviceProfile(kind).displayName}</code>
      </div>
    </div>
  );
}

import { getDeviceProfile, type LabDocument, type NodeSpec } from "@sim/contracts";
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

function endpointOccupied(document: LabDocument, nodeId: string, interfaceId: string, ignoreLinkId?: string): boolean {
  return document.topology.links.some((link) =>
    link.id !== ignoreLinkId && (
      (link.a.node === nodeId && link.a.iface === interfaceId)
      || (link.b.node === nodeId && link.b.iface === interfaceId)
    ));
}

function freeInterfaces(document: LabDocument, nodeId: string, ignoreLinkId?: string): string[] {
  const node = document.topology.nodes.find((candidate) => candidate.id === nodeId);
  return node?.interfaces
    .map((iface) => iface.id)
    .filter((interfaceId) => !endpointOccupied(document, nodeId, interfaceId, ignoreLinkId)) ?? [];
}

function hostname(document: LabDocument, node: NodeSpec): string {
  return document.configurations[node.id]?.hostname ?? node.name ?? node.id;
}

function preferredFreePort(ports: string[], preferred: string | undefined): string {
  return preferred && ports.includes(preferred) ? preferred : ports[0] ?? "";
}

/** Confirms the physical interfaces after a device-to-device drag gesture. */
export function DeviceConnectionDialog(props: DeviceConnectionDialogProps) {
  const sourceNode = props.document.topology.nodes.find((node) => node.id === props.sourceId);
  const targetNode = props.document.topology.nodes.find((node) => node.id === props.targetId);
  const sourcePorts = freeInterfaces(props.document, props.sourceId, props.reconnectLinkId);
  const targetPorts = freeInterfaces(props.document, props.targetId, props.reconnectLinkId);
  const [sourcePort, setSourcePort] = useState(preferredFreePort(sourcePorts, props.preferredSourcePort));
  const [targetPort, setTargetPort] = useState(preferredFreePort(targetPorts, props.preferredTargetPort));
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
          <label>
            <span>{sourceName} interface</span>
            <select
              aria-label="Source interface"
              value={sourcePort}
              disabled={sourcePorts.length === 0}
              onChange={(event) => { setSourcePort(event.target.value); setError(undefined); }}
            >
              {sourcePorts.length === 0
                ? <option value="">No free interfaces</option>
                : sourcePorts.map((interfaceId) => (
                    <option key={interfaceId} value={interfaceId}>{interfaceId} — Available — Ethernet</option>
                  ))}
            </select>
            <small>{sourcePorts.length} of {sourceNode.interfaces.length} interfaces available</small>
          </label>

          <span className="connection-dialog__direction" aria-hidden="true"><ArrowRight size={16} /></span>

          <label>
            <span>{targetName} interface</span>
            <select
              aria-label="Target interface"
              value={targetPort}
              disabled={targetPorts.length === 0}
              onChange={(event) => { setTargetPort(event.target.value); setError(undefined); }}
            >
              {targetPorts.length === 0
                ? <option value="">No free interfaces</option>
                : targetPorts.map((interfaceId) => (
                    <option key={interfaceId} value={interfaceId}>{interfaceId} — Available — Ethernet</option>
                  ))}
            </select>
            <small>{targetPorts.length} of {targetNode.interfaces.length} interfaces available</small>
          </label>
        </div>

        {canConnect && (
          <div className="connection-preview" aria-label="Connection preview">
            <strong>{sourceName}</strong><code>{sourcePort}</code>
            <ArrowRight size={14} aria-hidden="true" />
            <strong>{targetName}</strong><code>{targetPort}</code>
          </div>
        )}
        {sourcePorts.length === 0 && <p className="connection-dialog__error">All interfaces on {sourceName} are already connected.</p>}
        {targetPorts.length === 0 && <p className="connection-dialog__error">All interfaces on {targetName} are already connected.</p>}
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

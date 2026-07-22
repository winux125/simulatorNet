import { getDeviceProfile, type DeviceCapability, type LabDocument } from "@sim/contracts";
import type { DeviceInspection, LabUiSnapshot } from "@sim/sim-worker";
import { Braces, CircleX, Cpu, ListTree, Network, TerminalSquare, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import type { InspectorTab } from "../../state/workspace-store";
import { Button, EmptyState, IconButton, Panel, PanelHeader, StatusIndicator, Tabs } from "../../ui";

interface InspectorPanelProps {
  client: SimulatorClient;
  document: LabDocument | undefined;
  snapshot: LabUiSnapshot | undefined;
  selectedNodeId: string | undefined;
  selectedLinkId: string | undefined;
  tab: InspectorTab;
  mode: "edit" | "simulate";
  compact: boolean;
  onTab(tab: InspectorTab): void;
  onOpenTerminal(deviceId: string): void;
  onError(message: string): void;
  onClose(): void;
}

const tabs = [
  { value: "overview" as const, label: "Overview", icon: <Cpu size={13} /> },
  { value: "interfaces" as const, label: "Interfaces", icon: <Network size={13} /> },
  { value: "configuration" as const, label: "Configuration", icon: <Braces size={13} /> },
  { value: "runtime" as const, label: "Runtime", icon: <ListTree size={13} /> },
];

function connectedTo(document: LabDocument | undefined, nodeId: string, interfaceId: string): string {
  const link = document?.topology.links.find((candidate) =>
    (candidate.a.node === nodeId && candidate.a.iface === interfaceId)
      || (candidate.b.node === nodeId && candidate.b.iface === interfaceId));
  if (!link) return "—";
  return link.a.node === nodeId ? `${link.b.node} / ${link.b.iface}` : `${link.a.node} / ${link.a.iface}`;
}

function stateLabel(adminUp: boolean, operationalUp: boolean): string {
  return !adminUp ? "shutdown" : operationalUp ? "up" : "down";
}

export function InspectorPanel(props: InspectorPanelProps) {
  const [inspection, setInspection] = useState<DeviceInspection>();
  const [loading, setLoading] = useState(false);
  const node = props.snapshot?.nodes.find((candidate) => candidate.id === props.selectedNodeId);
  const link = props.document?.topology.links.find((candidate) => candidate.id === props.selectedLinkId);
  const profile = node ? getDeviceProfile(node.type) : undefined;

  useEffect(() => {
    if (!props.selectedNodeId || !props.snapshot) {
      setInspection(undefined);
      return;
    }
    let active = true;
    setLoading(true);
    void props.client.request({ type: "GET_DEVICE_INSPECTION", deviceId: props.selectedNodeId })
      .then((result) => { if (active) setInspection(result); })
      .catch((error: unknown) => props.onError(error instanceof Error ? error.message : "Inspection request failed"))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [props.client, props.onError, props.selectedNodeId, props.snapshot]);

  return (
    <Panel className={`inspector-panel ${props.compact ? "is-drawer" : ""}`} aria-label="Inspector">
      <PanelHeader
        title="Inspector"
        detail={node ? node.hostname : link ? link.id : "No selection"}
        actions={<IconButton label="Close inspector" icon={<X size={15} />} onClick={props.onClose} />}
      />
      {node && <Tabs label="Inspector sections" value={props.tab} options={tabs} onChange={props.onTab} />}
      <div className="inspector-content">
        {!node && !link && (
          <EmptyState icon={<Cpu size={28} />} title="Nothing selected" description="Select a device or link on the topology to inspect its live and configured state." />
        )}
        {link && !node && (
          <div className="inspector-section">
            <p className="section-eyebrow">Topology link</p>
            <h3>{link.id}</h3>
            <dl className="property-list">
              <div><dt>Endpoint A</dt><dd>{link.a.node} / <code>{link.a.iface}</code></dd></div>
              <div><dt>Endpoint B</dt><dd>{link.b.node} / <code>{link.b.iface}</code></dd></div>
              <div><dt>State</dt><dd><StatusIndicator status="up" label="Connected" /></dd></div>
            </dl>
          </div>
        )}
        {node && props.tab === "overview" && (
          <div className="inspector-section">
            <div className="device-summary">
              <span className="device-summary__icon"><Cpu size={22} /></span>
              <div><p>{node.type}</p><h3>{node.hostname}</h3></div>
              <StatusIndicator status={node.status} label={node.status} />
            </div>
            <dl className="property-list">
              <div><dt>Device ID</dt><dd><code>{node.id}</code></dd></div>
              <div><dt>Interfaces</dt><dd>{node.interfaces.length}</dd></div>
              <div><dt>Capabilities</dt><dd>{profile?.capabilities.length ?? 0}</dd></div>
              <div><dt>Lab</dt><dd>{props.snapshot?.title}</dd></div>
              <div><dt>Virtual time</dt><dd><code>{((props.snapshot?.virtualTime ?? 0) / 1_000_000).toFixed(3)} ms</code></dd></div>
            </dl>
            {profile?.cliProfile
              ? <Button variant="primary" icon={<TerminalSquare size={14} />} disabled={props.mode !== "simulate"} onClick={() => props.onOpenTerminal(node.id)}>Open CLI</Button>
              : <p className="section-note">This device has no interactive CLI. Use the topology and runtime inspector.</p>}
          </div>
        )}
        {node && props.tab === "interfaces" && (
          <div className="inspector-table-wrap">
            <table className="data-table interface-table">
              <thead><tr><th>Interface</th><th>State</th><th>Mode</th><th>VLAN / IP</th><th>Connected to</th></tr></thead>
              <tbody>
                {(inspection?.interfaces ?? node.interfaces).map((iface) => {
                  const detailed = "id" in iface ? iface : undefined;
                  const mode = detailed && "mode" in detailed ? detailed.mode : undefined;
                  const vlan = detailed && "vlan" in detailed ? detailed.vlan : undefined;
                  const ipAddress = "ipAddress" in iface ? iface.ipAddress : undefined;
                  return <tr key={iface.id}>
                    <td><code>{iface.id}</code></td>
                    <td><span className={`table-state ${iface.operationalUp ? "is-up" : ""}`}>{stateLabel(iface.adminUp, iface.operationalUp)}</span></td>
                    <td>{mode ?? "—"}</td>
                    <td><code>{ipAddress ? `${ipAddress}${detailed && "prefixLength" in detailed && detailed.prefixLength !== undefined ? `/${detailed.prefixLength}` : ""}` : vlan ? `VLAN ${vlan}` : "—"}</code></td>
                    <td><code>{connectedTo(props.document, node.id, iface.id)}</code></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
        {node && props.tab === "configuration" && (
          <div className="inspector-section">
            <p className="section-eyebrow">Read-only structured configuration</p>
            <pre className="configuration-view">{JSON.stringify(props.document?.configurations[node.id] ?? {}, null, 2)}</pre>
            <p className="section-note">Use the device CLI to change configuration. Topology edits are applied through the rebuild boundary.</p>
          </div>
        )}
        {node && props.tab === "runtime" && (
          <div className="runtime-inspection">
            {loading && <p className="loading-line">Reading worker runtime…</p>}
            {!loading && inspection && <>
              {hasAnyCapability(inspection.capabilities, ["ipv4-host", "ipv4-routing"])
                && <RuntimeTable title="ARP table" empty="No ARP entries" columns={["IP address", "MAC address"]} rows={inspection.arpEntries.map((row) => [row.ipAddress, row.macAddress])} />}
              {hasAnyCapability(inspection.capabilities, ["ethernet-bridge", "layer2-switching"])
                && <RuntimeTable title="MAC table" empty="No learned MAC entries" columns={["VLAN", "MAC address", "Interface"]} rows={inspection.macEntries.map((row) => [row.vlan === undefined ? "—" : String(row.vlan), row.macAddress, row.interfaceId])} />}
              {inspection.capabilities.includes("ipv4-routing")
                && <RuntimeTable title="Routes" empty="No routes" columns={["Type", "Network", "Next hop", "Interface"]} rows={inspection.routes.map((row) => [row.kind, `${row.network}/${row.prefixLength}`, row.nextHop ?? "connected", row.interfaceId])} />}
              {inspection.svis && <RuntimeTable title="SVIs" empty="No switch virtual interfaces" columns={["VLAN", "Interface", "Address", "Admin", "Operational"]} rows={inspection.svis.map((row) => [String(row.vlanId), row.interfaceId, row.ipAddress ? `${row.ipAddress}/${row.prefixLength}` : "—", row.adminUp ? "up" : "shutdown", row.operationalUp ? "up" : "down"])} />}
              {inspection.ipRoutingEnabled !== undefined && <div className="runtime-card"><h4>IP routing</h4><p>{inspection.ipRoutingEnabled ? "Enabled" : "Disabled"}</p></div>}
              {inspection.counters && <div className="runtime-card"><h4>Repeater counters</h4><p>{inspection.counters.repeatedFrames ?? 0} repeated · {inspection.counters.droppedFrames ?? 0} dropped</p></div>}
              {inspection.dhcp && <div className="runtime-card">
                <h4>DHCP</h4>
                <p>{inspection.dhcp.state ? `Client state: ${inspection.dhcp.state}` : `${inspection.dhcp.pools?.length ?? 0} configured pools`}</p>
                {inspection.dhcp.lease && <code>{inspection.dhcp.lease.ipAddress} via {inspection.dhcp.lease.gateway ?? "—"}</code>}
              </div>}
              {inspection.type === "server" && <div className="runtime-card"><h4>Application services</h4><p>Services will be added in M10.2.</p></div>}
            </>}
            {!loading && !inspection && <EmptyState icon={<CircleX size={24} />} title="Runtime unavailable" description="The worker did not return inspection data for this device." />}
          </div>
        )}
      </div>
    </Panel>
  );
}

function hasAnyCapability(capabilities: readonly DeviceCapability[], expected: readonly DeviceCapability[]): boolean {
  return expected.some((capability) => capabilities.includes(capability));
}

function RuntimeTable({ title, empty, columns, rows }: { title: string; empty: string; columns: string[]; rows: string[][] }) {
  return (
    <div className="runtime-card">
      <h4>{title}</h4>
      {rows.length === 0 ? <p>{empty}</p> : <table className="data-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}><code>{value}</code></td>)}</tr>)}</tbody></table>}
    </div>
  );
}

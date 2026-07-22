import type { LabUiSnapshot, SimulationTraceEvent } from "@sim/sim-worker";
import { AlertTriangle, Braces, List, Network, TerminalSquare, X } from "lucide-react";
import type { SimulatorClient } from "../../app/simulator-client";
import type { DockTab, WorkspaceMode, WorkspaceProblem } from "../../state/workspace-store";
import type { ResolvedTheme } from "../../hooks/useTheme";
import { Button, EmptyState, IconButton, Tabs } from "../../ui";
import { TerminalWorkspace } from "../terminal/TerminalPanel";

interface BottomDockProps {
  client: SimulatorClient;
  tab: DockTab;
  snapshot: LabUiSnapshot | undefined;
  traces: SimulationTraceEvent[];
  problems: WorkspaceProblem[];
  terminalTabs: string[];
  activeTerminalDeviceId: string | undefined;
  mode: WorkspaceMode;
  theme: ResolvedTheme;
  onTab(tab: DockTab): void;
  onActivateTerminal(deviceId: string): void;
  onCloseTerminal(deviceId: string): void;
  onClearProblems(): void;
  onError(message: string): void;
  onClose(): void;
}

function timeLabel(nanoseconds: number): string {
  return `${(nanoseconds / 1_000_000).toFixed(3)} ms`;
}

const packetTypes = new Set(["arp-request", "arp-reply", "icmp-echo-request", "icmp-echo-reply", "route", "forward", "flood", "ping-success", "icmp-error"]);

export function BottomDock(props: BottomDockProps) {
  const packetEvents = props.traces.filter((event) => packetTypes.has(event.type));
  const options = [
    { value: "terminal" as const, label: "Terminal", icon: <TerminalSquare size={13} />, count: props.terminalTabs.length },
    { value: "events" as const, label: "Events", icon: <List size={13} />, count: props.traces.length },
    { value: "packet-trace" as const, label: "Packet trace", icon: <Network size={13} />, count: packetEvents.length },
    { value: "problems" as const, label: "Problems", icon: <AlertTriangle size={13} />, count: props.problems.length },
  ];
  return (
    <section className="bottom-dock" aria-label="Workspace bottom panel">
      <div className="bottom-dock__header">
        <Tabs label="Bottom panel sections" value={props.tab} options={options} onChange={props.onTab} />
        <IconButton label="Close bottom panel" icon={<X size={14} />} onClick={props.onClose} />
      </div>
      <div className="bottom-dock__content" role="tabpanel">
        {props.tab === "terminal" && <TerminalWorkspace client={props.client} tabs={props.terminalTabs} activeDeviceId={props.activeTerminalDeviceId} nodes={props.snapshot?.nodes ?? []} mode={props.mode} theme={props.theme} onActivate={props.onActivateTerminal} onClose={props.onCloseTerminal} onError={props.onError} />}
        {props.tab === "events" && <EventTable events={props.traces} />}
        {props.tab === "packet-trace" && <PacketTable events={packetEvents} />}
        {props.tab === "problems" && <Problems problems={props.problems} onClear={props.onClearProblems} />}
      </div>
    </section>
  );
}

function EventTable({ events }: { events: SimulationTraceEvent[] }) {
  if (events.length === 0) return <EmptyState icon={<List size={26} />} title="No simulation events" description="Run the lab or issue a CLI packet operation to populate the deterministic event stream." />;
  return <div className="dock-table-wrap"><table className="data-table event-table"><thead><tr><th>Time</th><th>Device</th><th>Interface</th><th>Event</th><th>Details</th></tr></thead><tbody>{events.slice(-300).reverse().map((event) => <tr key={event.sequence} data-event-type={event.type}><td><code>{timeLabel(event.virtualTime)}</code></td><td>{event.deviceId}</td><td><code>{event.interfaceId ?? "—"}</code></td><td><span className="event-type">{event.type}</span></td><td><code>{event.description}</code></td></tr>)}</tbody></table></div>;
}

function PacketTable({ events }: { events: SimulationTraceEvent[] }) {
  if (events.length === 0) return <EmptyState icon={<Network size={26} />} title="No packet trace" description="ARP, ICMP and forwarding events will appear here without inventing protocol data the engine does not expose." />;
  return <div className="dock-table-wrap"><table className="data-table packet-table"><thead><tr><th>Time</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Event</th><th>Result</th></tr></thead><tbody>{events.slice(-300).reverse().map((event) => {
    const detail = event.detail ?? {};
    const source = String(detail.src ?? event.deviceId);
    const destination = String(detail.dst ?? detail.targetIp ?? "—");
    const protocol = event.type.startsWith("arp") ? "ARP" : event.type.includes("icmp") || event.type.includes("ping") ? "ICMP" : "L2/L3";
    const result = event.type.includes("success") || event.type.includes("reply") ? "success" : event.type.includes("error") ? "error" : "observed";
    return <tr key={event.sequence} data-event-type={event.type}><td><code>{timeLabel(event.virtualTime)}</code></td><td><code>{source}</code></td><td><code>{destination}</code></td><td>{protocol}</td><td>{event.type}</td><td><span className={`trace-result trace-result--${result}`}>{result}</span></td></tr>;
  })}</tbody></table></div>;
}

function Problems({ problems, onClear }: { problems: WorkspaceProblem[]; onClear(): void }) {
  if (problems.length === 0) return <EmptyState icon={<Braces size={25} />} title="No problems detected" description="Validation, worker and CLI errors will be listed here without exposing internal stack traces." />;
  return <div className="problems-view"><div className="problems-view__toolbar"><span>{problems.length} diagnostics</span><Button size="sm" variant="ghost" onClick={onClear}>Clear</Button></div><ol>{problems.slice().reverse().map((problem) => <li key={problem.id}><AlertTriangle size={15} /><div><strong>{problem.source}</strong><p>{problem.message}</p></div></li>)}</ol></div>;
}

export default BottomDock;

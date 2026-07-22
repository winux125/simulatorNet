import type { LabUiSnapshot, SimulationTraceEvent } from "@sim/sim-worker";
import { useWorkspaceStore } from "../../state/workspace-store";

interface TracePanelProps {
  snapshot: LabUiSnapshot | undefined;
  selectedNodeId: string | undefined;
  traces: SimulationTraceEvent[];
}

function timeLabel(nanoseconds: number): string {
  return `${(nanoseconds / 1_000_000).toFixed(3)} ms`;
}

export function TracePanel({ snapshot, selectedNodeId, traces }: TracePanelProps) {
  const filters = useWorkspaceStore((state) => state.filters);
  const setFilter = useWorkspaceStore((state) => state.setFilter);
  const selected = snapshot?.nodes.find((node) => node.id === selectedNodeId);
  const types = [...new Set(traces.map((event) => event.type))].sort();
  const filtered = traces.filter((event) => {
    if (filters.device && event.deviceId !== filters.device) return false;
    if (filters.type && event.type !== filters.type) return false;
    if (filters.search && !`${event.type} ${event.deviceId} ${event.description}`.toLowerCase().includes(filters.search.toLowerCase())) return false;
    return true;
  });
  return (
    <aside className="inspector panel" aria-label="Inspector and trace">
      <div className="panel-heading"><span>Inspector</span><small>{selected ? selected.type : "No selection"}</small></div>
      {selected ? (
        <div className="node-inspector">
          <div><strong>{selected.hostname}</strong><span className={`status-pill ${selected.status}`}>{selected.status}</span></div>
          <small>{selected.id}</small>
          <ul>{selected.interfaces.map((iface) => <li key={iface.id}><span>{iface.id}</span><span>{iface.ipAddress ?? iface.mode ?? (iface.operationalUp ? "up" : "down")}</span></li>)}</ul>
        </div>
      ) : <p className="panel-help">Select a device to inspect its compact worker snapshot.</p>}
      <div className="trace-heading"><div><span>Event trace</span><small>{filtered.length} / {traces.length}</small></div></div>
      <div className="trace-filters" aria-label="Trace filters">
        <select aria-label="Filter trace by device" value={filters.device} onChange={(event) => setFilter({ device: event.target.value })}>
          <option value="">All devices</option>
          {snapshot?.nodes.map((node) => <option key={node.id} value={node.id}>{node.hostname}</option>)}
        </select>
        <select aria-label="Filter trace by event type" value={filters.type} onChange={(event) => setFilter({ type: event.target.value })}>
          <option value="">All events</option>
          {types.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <input aria-label="Search trace" placeholder="Search events" value={filters.search} onChange={(event) => setFilter({ search: event.target.value })} />
      </div>
      <ol className="trace-list" data-testid="trace-list" aria-live="polite">
        {filtered.slice(-200).reverse().map((event) => (
          <li key={event.sequence} data-event-type={event.type}>
            <span className="trace-sequence">#{event.sequence}</span>
            <div><strong>{event.type}</strong><small>{event.deviceId}{event.interfaceId ? ` / ${event.interfaceId}` : ""}</small><p>{event.description}</p></div>
            <time>{timeLabel(event.virtualTime)}</time>
          </li>
        ))}
      </ol>
    </aside>
  );
}

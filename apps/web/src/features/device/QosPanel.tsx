import type { LabDocument, QosConfiguration } from "@sim/contracts";
import type { QosConfigurationView } from "@sim/sim-worker";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button } from "../../ui";

export type QosSection =
  | "qos-class-maps"
  | "qos-policy-maps"
  | "qos-interfaces"
  | "qos-queues"
  | "qos-counters";

export const QOS_SECTIONS: ReadonlyArray<{ id: QosSection; label: string }> = [
  { id: "qos-class-maps", label: "Class Maps" },
  { id: "qos-policy-maps", label: "Policy Maps" },
  { id: "qos-interfaces", label: "Interface Policies" },
  { id: "qos-queues", label: "Queues" },
  { id: "qos-counters", label: "Counters" },
];

export function isQosSection(value: string): value is QosSection {
  return QOS_SECTIONS.some((entry) => entry.id === value);
}

interface QosPanelProps {
  client: SimulatorClient;
  deviceId: string;
  section: QosSection;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
}

/** Sections that edit persistent configuration rather than showing runtime. */
const EDITABLE = new Set<QosSection>(["qos-class-maps", "qos-policy-maps", "qos-interfaces"]);

/**
 * The device QoS surface. It is one view of the same worker-owned configuration
 * the CLI writes — never an independent copy — and every change goes through
 * the typed simulation-worker API.
 */
export function QosPanel(props: QosPanelProps) {
  const [view, setView] = useState<QosConfigurationView>();
  const [editor, setEditor] = useState("");
  const [busy, setBusy] = useState(true);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await props.client.request({ type: "GET_QOS_CONFIGURATION", deviceId: props.deviceId });
      setView(next);
      setEditor(JSON.stringify(sectionValue(next, props.section), null, 2));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to load QoS configuration");
    } finally {
      setBusy(false);
    }
  }, [props.client, props.deviceId, props.onError, props.section]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = async () => {
    if (!view) return;
    setBusy(true);
    try {
      const configuration = mergeSection(view.configuration, props.section, JSON.parse(editor));
      const next = await props.client.request({
        type: "SET_QOS_CONFIGURATION",
        deviceId: props.deviceId,
        configuration,
      });
      setView(next);
      setEditor(JSON.stringify(sectionValue(next, props.section), null, 2));
      props.onConfigurationChanged(next.document, true);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to apply QoS configuration");
    } finally {
      setBusy(false);
    }
  };

  const clearRuntime = async () => {
    setBusy(true);
    try {
      const next = await props.client.request({ type: "CLEAR_QOS_RUNTIME", deviceId: props.deviceId });
      setView(next);
      setEditor(JSON.stringify(sectionValue(next, props.section), null, 2));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to clear QoS counters");
    } finally {
      setBusy(false);
    }
  };

  if (busy && !view) return <div className="device-window-section"><p>Loading QoS…</p></div>;
  if (!view) return <div className="device-window-section"><p>QoS is unavailable on this device.</p></div>;

  const editable = EDITABLE.has(props.section);
  const title = QOS_SECTIONS.find((entry) => entry.id === props.section)!.label;

  if (props.section === "qos-queues") {
    return (
      <div className="device-window-section qos-panel">
        <p className="section-eyebrow">Transient runtime</p>
        <h2>Egress queues</h2>
        <p className="section-note">
          Queue depth, drops and virtual waiting time are runtime state. They are never stored in
          LabDocument and never submitted for grading.
        </p>
        <table className="data-table">
          <thead><tr><th>Interface</th><th>Policy</th><th>Capacity</th><th>Depth</th><th>Drops</th><th>Max wait</th></tr></thead>
          <tbody>
            {view.runtime.queues.map((queue) => (
              <tr key={queue.interfaceName}>
                <td><code>{queue.interfaceName}</code></td>
                <td>{queue.policyMapId ?? "—"}</td>
                <td><code>{queue.capacityBps === 0 ? "—" : `${queue.capacityBps / 1_000_000} Mbps`}</code></td>
                <td><code>{queue.depthPackets} pkt / {queue.depthBytes} B</code></td>
                <td><code>{queue.droppedPackets}</code></td>
                <td><code>{(queue.maximumWaitingTimeNs / 1_000_000).toFixed(3)} ms</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        {view.runtime.queues.flatMap((queue) => queue.classes.map((entry) => ({ queue, entry })))
          .filter(({ queue }) => queue.policyMapId !== undefined).length > 0 && (
          <>
            <h3>Class queues</h3>
            <table className="data-table">
              <thead><tr><th>Interface</th><th>Class</th><th>Depth / limit</th><th>Transmitted</th><th>Drops</th></tr></thead>
              <tbody>
                {view.runtime.queues.filter((queue) => queue.policyMapId !== undefined).flatMap((queue) =>
                  queue.classes.map((entry) => (
                    <tr key={`${queue.interfaceName}:${entry.className}`}>
                      <td><code>{queue.interfaceName}</code></td>
                      <td>{entry.className}</td>
                      <td><code>{entry.depthPackets}/{entry.limitPackets}</code></td>
                      <td><code>{entry.dequeuedPackets} pkt / {entry.dequeuedBytes} B</code></td>
                      <td><code>{entry.droppedPackets}</code></td>
                    </tr>
                  )))}
              </tbody>
            </table>
          </>
        )}
        <div className="qos-panel__actions">
          <Button disabled={busy} onClick={() => void refresh()}>Refresh</Button>
          <Button disabled={busy} onClick={() => void clearRuntime()}>Clear counters</Button>
        </div>
        <QosProblems problems={view.runtime.problems} />
      </div>
    );
  }

  if (props.section === "qos-counters") {
    return (
      <div className="device-window-section qos-panel">
        <p className="section-eyebrow">Transient runtime</p>
        <h2>Class counters</h2>
        <table className="data-table">
          <thead><tr><th>Interface</th><th>Direction</th><th>Policy</th><th>Class</th><th>Matched</th><th>Marked</th><th>Dropped</th></tr></thead>
          <tbody>
            {view.runtime.counters.map((row) => (
              <tr key={`${row.interfaceName}:${row.direction}:${row.className}`}>
                <td><code>{row.interfaceName}</code></td>
                <td>{row.direction}</td>
                <td>{row.policyMapId}</td>
                <td>{row.className}</td>
                <td><code>{row.matchedPackets} pkt / {row.matchedBytes} B</code></td>
                <td><code>{row.markedPackets}</code></td>
                <td><code>{row.droppedPackets}</code></td>
              </tr>
            ))}
            {view.runtime.counters.length === 0 && (
              <tr><td colSpan={7}>No class has matched a packet yet.</td></tr>
            )}
          </tbody>
        </table>
        <div className="qos-panel__actions">
          <Button disabled={busy} onClick={() => void refresh()}>Refresh</Button>
          <Button disabled={busy} onClick={() => void clearRuntime()}>Clear counters</Button>
        </div>
        <QosProblems problems={view.runtime.problems} />
      </div>
    );
  }

  return (
    <div className="device-window-section qos-panel">
      <p className="section-eyebrow">Structured configuration</p>
      <h2>{title}</h2>
      <p className="section-note">
        This is the same worker-owned QoS configuration the CLI writes. Edits are applied through the
        typed simulation-worker API and appear in `show class-map` / `show policy-map`.
      </p>
      <textarea
        className="configuration-editor"
        aria-label={`${title} JSON`}
        spellCheck={false}
        value={editor}
        onChange={(event) => setEditor(event.target.value)}
      />
      <div className="qos-panel__actions">
        {editable && <Button variant="primary" disabled={busy} onClick={() => void apply()}>Apply</Button>}
        <Button disabled={busy} onClick={() => void refresh()}>Refresh</Button>
      </div>
      <QosProblems problems={view.runtime.problems} />
    </div>
  );
}

function QosProblems({ problems }: { problems: QosConfigurationView["runtime"]["problems"] }) {
  if (problems.length === 0) return null;
  return (
    <div className="qos-panel__problems">
      {problems.map((problem) => (
        <p className="host-ip-config__warning" key={`${problem.code}:${problem.message}`}>
          <AlertTriangle size={14} /> {problem.message}
        </p>
      ))}
    </div>
  );
}

function sectionValue(view: QosConfigurationView, section: QosSection): unknown {
  switch (section) {
    case "qos-class-maps":
      return view.configuration.classMaps;
    case "qos-policy-maps":
      return view.configuration.policyMaps;
    case "qos-interfaces":
      return view.configuration.servicePolicies;
    case "qos-queues":
      return view.runtime.queues;
    case "qos-counters":
      return view.runtime.counters;
  }
}

function mergeSection(
  configuration: QosConfiguration,
  section: QosSection,
  value: unknown,
): QosConfiguration {
  if (!Array.isArray(value)) throw new Error(`${section} must be a JSON array.`);
  if (section === "qos-class-maps") return { ...configuration, classMaps: value as QosConfiguration["classMaps"] };
  if (section === "qos-policy-maps") return { ...configuration, policyMaps: value as QosConfiguration["policyMaps"] };
  if (section === "qos-interfaces") {
    return { ...configuration, servicePolicies: value as QosConfiguration["servicePolicies"] };
  }
  throw new Error(`Section '${section}' is read-only runtime state.`);
}

import type { DeviceType, LabDocument, QosConfiguration } from "@sim/contracts";
import type { LabUiInterface, QosConfigurationView, QosInterfaceQueueView } from "@sim/sim-worker";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button } from "../../ui";

/**
 * One top-level QoS tab with secondary navigation inside it. The sections are
 * pure UI state: they are never written to LabDocument, a submission, grading
 * or the database, and switching between them changes no configuration.
 */
export type QosSection =
  | "overview"
  | "classification"
  | "policies"
  | "interfaces"
  | "queues";

export const QOS_SECTIONS: ReadonlyArray<{ id: QosSection; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "classification", label: "Classification" },
  { id: "policies", label: "Policies" },
  { id: "interfaces", label: "Interfaces" },
  { id: "queues", label: "Queues & Counters" },
];

/**
 * What a device's QoS surface may offer. One `QosPanel` serves Router, L3
 * Switch and Firewall; the differences are declared here rather than forked
 * into near-identical components. The Wireless Router composes its routed
 * plane internally and exposes no QoS policy engine to the worker yet, so it
 * has no capabilities and gets no QoS tab.
 */
export interface QosDeviceCapabilities {
  /** Switched virtual interfaces can carry a service policy. */
  switchedVirtualInterfaces: boolean;
  /** 802.1Q subinterfaces can carry a service policy. */
  routedSubinterfaces: boolean;
  /** Zone-based policy runs beside QoS on the same routed path. */
  zonePolicy: boolean;
}

const QOS_CAPABILITIES: Partial<Record<DeviceType, QosDeviceCapabilities>> = {
  router: { switchedVirtualInterfaces: false, routedSubinterfaces: true, zonePolicy: false },
  "l3-switch": { switchedVirtualInterfaces: true, routedSubinterfaces: false, zonePolicy: false },
  firewall: { switchedVirtualInterfaces: false, routedSubinterfaces: true, zonePolicy: true },
};

/** The QoS capabilities of a device kind, or undefined when it has no engine. */
export function qosCapabilitiesFor(type: DeviceType): QosDeviceCapabilities | undefined {
  return QOS_CAPABILITIES[type];
}

interface QosPanelProps {
  client: SimulatorClient;
  deviceId: string;
  deviceType: DeviceType;
  /** Topology interfaces, for the honest admin/operational status column. */
  interfaces: readonly LabUiInterface[];
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
}

const CLASS_MAP_TEMPLATE = { id: "NEW-CLASS", matchType: "match-any", matches: [{ kind: "any" }] };
const POLICY_MAP_TEMPLATE = { id: "NEW-POLICY", classes: [{ className: "class-default" }] };
const SERVICE_POLICY_TEMPLATE = { interfaceName: "", direction: "output", policyMapId: "" };

/**
 * The device QoS surface. It is one view of the same worker-owned configuration
 * the CLI writes — never an independent copy — and every change goes through
 * the typed simulation-worker API.
 */
export function QosPanel(props: QosPanelProps) {
  const [view, setView] = useState<QosConfigurationView>();
  const [section, setSection] = useState<QosSection>("overview");
  const [selectedInterface, setSelectedInterface] = useState<string>();
  const [editor, setEditor] = useState("");
  const [busy, setBusy] = useState(true);
  const capabilities = qosCapabilitiesFor(props.deviceType);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const next = await props.client.request({ type: "GET_QOS_CONFIGURATION", deviceId: props.deviceId });
      setView(next);
      return next;
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to load QoS configuration");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [props.client, props.deviceId, props.onError]);

  useEffect(() => { void load(); }, [load]);

  // The editor always shows the section it belongs to, refilled whenever the
  // worker-owned configuration or the visible section changes.
  useEffect(() => {
    if (view) setEditor(JSON.stringify(editableValue(view.configuration, section), null, 2));
  }, [view, section]);

  const apply = async () => {
    if (!view) return;
    setBusy(true);
    try {
      const configuration = mergeSection(view.configuration, section, JSON.parse(editor));
      const next = await props.client.request({
        type: "SET_QOS_CONFIGURATION",
        deviceId: props.deviceId,
        configuration,
      });
      setView(next);
      props.onConfigurationChanged(next.document, true);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to apply QoS configuration");
    } finally {
      setBusy(false);
    }
  };

  /** Clears transient counters only. Class maps, policies and bindings stay. */
  const clearRuntime = async () => {
    setBusy(true);
    try {
      setView(await props.client.request({ type: "CLEAR_QOS_RUNTIME", deviceId: props.deviceId }));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to clear QoS counters");
    } finally {
      setBusy(false);
    }
  };

  const appendTemplate = (template: unknown) => {
    setEditor((current) => {
      try {
        const parsed: unknown = JSON.parse(current);
        return JSON.stringify([...(Array.isArray(parsed) ? parsed : []), template], null, 2);
      } catch {
        return JSON.stringify([template], null, 2);
      }
    });
  };

  const go = (next: QosSection) => { setSection(next); setSelectedInterface(undefined); };

  const totals = useMemo(() => view ? summarize(view) : undefined, [view]);

  if (busy && !view) return <div className="qos-panel"><div className="qos-panel__body"><p>Loading QoS…</p></div></div>;
  if (!view || !capabilities) {
    return <div className="qos-panel"><div className="qos-panel__body">
      <p>QoS is unavailable on this device.</p>
    </div></div>;
  }

  return (
    <div className="qos-panel">
      <nav className="qos-panel__nav" role="tablist" aria-label="QoS sections">
        {QOS_SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={section === entry.id}
            className={section === entry.id ? "is-active" : ""}
            onClick={() => go(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="qos-panel__body" role="tabpanel" aria-label={`QoS ${sectionLabel(section)}`}>
        {section === "overview" && totals && (
          <>
            <p className="section-eyebrow">Quality of service</p>
            <h2>Overview</h2>
            <dl className="property-list qos-summary">
              <div><dt>Class maps</dt><dd>{totals.classMaps}</dd></div>
              <div><dt>Policy maps</dt><dd>{totals.policyMaps}</dd></div>
              <div><dt>Interfaces with a policy</dt><dd>{totals.boundInterfaces}</dd></div>
              <div><dt>Queue drops</dt><dd>{totals.queueDrops}</dd></div>
              <div><dt>Policer drops</dt><dd>{totals.policerDrops}</dd></div>
              <div><dt>Shaper drops</dt><dd>{totals.shaperDrops}</dd></div>
              <div><dt>Active warnings</dt><dd>{view.runtime.problems.length}</dd></div>
            </dl>
            <h3>Attached policies</h3>
            {totals.bindings.length === 0
              ? <p className="section-note">No service policy is attached yet.</p>
              : <ul className="qos-binding-list">
                  {totals.bindings.map((binding) => (
                    <li key={`${binding.interfaceName}:${binding.direction}`}>
                      <code>{binding.interfaceName}</code> {binding.direction} → {binding.policyMapId}
                    </li>
                  ))}
                </ul>}
            <div className="qos-panel__actions">
              <Button onClick={() => go("classification")}>Create Class Map</Button>
              <Button onClick={() => go("policies")}>Create Policy Map</Button>
              <Button onClick={() => go("interfaces")}>Attach Policy</Button>
            </div>
            <p className="section-note">
              The output pipeline is fixed: {capabilities.zonePolicy ? "zone policy and " : ""}
              route decision → classification → marking → policing → shaping/queueing → serialization →
              transmit. Capacity is an educational serialization model, never a hardware throughput claim.
            </p>
            <QosProblems problems={view.runtime.problems} />
          </>
        )}

        {section === "classification" && (
          <>
            <p className="section-eyebrow">Structured configuration</p>
            <h2>Classification</h2>
            <p className="section-note">
              Class maps and their match-all / match-any rules: ACL, protocol, port, prefix, DSCP,
              precedence and CoS. This is the same worker-owned configuration `show class-map` prints.
            </p>
            <ConfigurationEditor label="Class maps" value={editor} onChange={setEditor} />
            <div className="qos-panel__actions">
              <Button variant="primary" disabled={busy} onClick={() => void apply()}>Apply</Button>
              <Button disabled={busy} onClick={() => appendTemplate(CLASS_MAP_TEMPLATE)}>Add class map</Button>
              <Button disabled={busy} onClick={() => void load()}>Refresh</Button>
            </div>
            <h3>Class counters</h3>
            <ClassCounterTable view={view} />
            <QosProblems problems={view.runtime.problems} />
          </>
        )}

        {section === "policies" && (
          <>
            <p className="section-eyebrow">Structured configuration</p>
            <h2>Policies</h2>
            <p className="section-note">
              Policy maps and their classes: marking, priority, bandwidth, policing and shaping.
              A priority class carries a built-in policer so it cannot starve the other queues; a
              policer never delays, and a shaper delays and only drops when its bounded queue is full.
            </p>
            <ConfigurationEditor label="Policy maps" value={editor} onChange={setEditor} />
            <div className="qos-panel__actions">
              <Button variant="primary" disabled={busy} onClick={() => void apply()}>Apply</Button>
              <Button disabled={busy} onClick={() => appendTemplate(POLICY_MAP_TEMPLATE)}>Add policy map</Button>
              <Button disabled={busy} onClick={() => void load()}>Refresh</Button>
            </div>
            <QosProblems problems={view.runtime.problems} />
          </>
        )}

        {section === "interfaces" && (
          <>
            <p className="section-eyebrow">Service policies</p>
            <h2>Interfaces</h2>
            <table className="data-table qos-interface-table">
              <thead><tr>
                <th>Interface</th><th>Input Policy</th><th>Output Policy</th>
                <th>Capacity</th><th>Queue Limit</th><th>Status</th>
              </tr></thead>
              <tbody>
                {view.runtime.queues.map((queue) => {
                  const iface = props.interfaces.find((entry) => entry.id === queue.interfaceName);
                  const bound = policiesOf(view.configuration, queue.interfaceName);
                  return (
                    <tr
                      key={queue.interfaceName}
                      aria-selected={selectedInterface === queue.interfaceName}
                      className={selectedInterface === queue.interfaceName ? "is-selected" : ""}
                    >
                      <td>
                        <button
                          type="button"
                          className="qos-interface-table__pick"
                          onClick={() => setSelectedInterface(queue.interfaceName)}
                        >
                          <code>{queue.interfaceName}</code>
                        </button>
                      </td>
                      <td>{bound.input ?? "—"}</td>
                      <td>{bound.output ?? "—"}</td>
                      <td><code>{formatCapacity(queue.capacityBps)}</code></td>
                      <td><code>{queueLimitOf(queue)}</code></td>
                      <td>{iface
                        ? `${iface.adminUp ? "up" : "shutdown"} / ${iface.operationalUp ? "up" : "down"}`
                        : "—"}</td>
                    </tr>
                  );
                })}
                {view.runtime.queues.length === 0 && <tr><td colSpan={6}>This device has no interface queue.</td></tr>}
              </tbody>
            </table>
            {selectedInterface && (
              <InterfaceDetail
                queue={view.runtime.queues.find((queue) => queue.interfaceName === selectedInterface)}
                view={view}
                onClose={() => setSelectedInterface(undefined)}
              />
            )}
            <h3>Service policy bindings</h3>
            <p className="section-note">
              Bind a policy map to an interface and a direction. A policy applies to
              routed interfaces{capabilities.routedSubinterfaces ? " and 802.1Q subinterfaces" : ""}
              {capabilities.switchedVirtualInterfaces ? " and switched virtual interfaces (Vlan<id>)" : ""}.
            </p>
            <ConfigurationEditor label="Service policies" value={editor} onChange={setEditor} />
            <div className="qos-panel__actions">
              <Button variant="primary" disabled={busy} onClick={() => void apply()}>Apply</Button>
              <Button disabled={busy} onClick={() => appendTemplate(SERVICE_POLICY_TEMPLATE)}>Attach policy</Button>
              <Button disabled={busy} onClick={() => void load()}>Refresh</Button>
            </div>
            <QosProblems problems={view.runtime.problems} />
          </>
        )}

        {section === "queues" && (
          <>
            <p className="section-eyebrow">Transient runtime</p>
            <h2>Queues &amp; Counters</h2>
            <p className="section-note">
              Queue depth, drops and virtual waiting time are runtime state. They are never stored in
              LabDocument and never submitted for grading. Individual shaped packets appear in the
              Packet Trace as `qos-shape-delayed` and `qos-shape-released`.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Interface</th><th>Policy</th><th>Capacity</th><th>Depth</th>
                <th>Drops</th><th>Policer</th><th>Shaper</th><th>Max wait</th>
              </tr></thead>
              <tbody>
                {view.runtime.queues.map((queue) => (
                  <tr key={queue.interfaceName}>
                    <td><code>{queue.interfaceName}</code></td>
                    <td>{queue.policyMapId ?? "—"}</td>
                    <td><code>{formatCapacity(queue.capacityBps)}</code></td>
                    <td><code>{queue.depthPackets} pkt / {queue.depthBytes} B</code></td>
                    <td><code>{queue.droppedPackets}</code></td>
                    <td><code>{queue.dropsByReason["policer-exceed"] ?? 0}</code></td>
                    <td><code>{queue.dropsByReason["shaper-limit"] ?? 0}</code></td>
                    <td><code>{(queue.maximumWaitingTimeNs / 1_000_000).toFixed(3)} ms</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>Class queues</h3>
            <table className="data-table">
              <thead><tr>
                <th>Interface</th><th>Class</th><th>Depth / limit</th><th>Transmitted</th><th>Drops</th>
              </tr></thead>
              <tbody>
                {view.runtime.queues.flatMap((queue) => queue.classes.map((entry) => (
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
            <h3>Class counters</h3>
            <ClassCounterTable view={view} />
            <div className="qos-panel__actions">
              <Button disabled={busy} onClick={() => void load()}>Refresh</Button>
              <Button disabled={busy} onClick={() => void clearRuntime()}>Clear Runtime Counters</Button>
            </div>
            <QosProblems problems={view.runtime.problems} />
          </>
        )}
      </div>
    </div>
  );
}

function ConfigurationEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(next: string): void;
}) {
  return (
    <textarea
      className="configuration-editor"
      aria-label={`${label} JSON`}
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ClassCounterTable({ view }: { view: QosConfigurationView }) {
  return (
    <table className="data-table">
      <thead><tr>
        <th>Interface</th><th>Direction</th><th>Policy</th><th>Class</th>
        <th>Matched</th><th>Marked</th><th>Dropped</th>
      </tr></thead>
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
  );
}

/** Row detail, rendered inside the same QoS tab — never a nested modal window. */
function InterfaceDetail({
  queue,
  view,
  onClose,
}: {
  queue: QosInterfaceQueueView | undefined;
  view: QosConfigurationView;
  onClose(): void;
}) {
  if (!queue) return null;
  const bound = policiesOf(view.configuration, queue.interfaceName);
  return (
    <div className="qos-interface-detail" aria-label={`${queue.interfaceName} QoS detail`}>
      <header>
        <strong>{queue.interfaceName}</strong>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </header>
      <dl className="property-list">
        <div><dt>Input policy</dt><dd>{bound.input ?? "—"}</dd></div>
        <div><dt>Output policy</dt><dd>{bound.output ?? "—"}</dd></div>
        <div><dt>Capacity</dt><dd><code>{formatCapacity(queue.capacityBps)}</code></dd></div>
        <div><dt>Depth</dt><dd><code>{queue.depthPackets} pkt / {queue.depthBytes} B</code></dd></div>
        <div><dt>Drops</dt><dd><code>{queue.droppedPackets}</code></dd></div>
        <div><dt>Max wait</dt><dd><code>{(queue.maximumWaitingTimeNs / 1_000_000).toFixed(3)} ms</code></dd></div>
      </dl>
      <table className="data-table">
        <thead><tr><th>Class</th><th>Depth / limit</th><th>Transmitted</th><th>Drops</th></tr></thead>
        <tbody>
          {queue.classes.map((entry) => (
            <tr key={entry.className}>
              <td>{entry.className}</td>
              <td><code>{entry.depthPackets}/{entry.limitPackets}</code></td>
              <td><code>{entry.dequeuedPackets} pkt / {entry.dequeuedBytes} B</code></td>
              <td><code>{entry.droppedPackets}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
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

function sectionLabel(section: QosSection): string {
  return QOS_SECTIONS.find((entry) => entry.id === section)!.label;
}

function policiesOf(
  configuration: QosConfiguration,
  interfaceName: string,
): { input?: string; output?: string } {
  const bound = configuration.servicePolicies.filter((policy) => policy.interfaceName === interfaceName);
  return {
    input: bound.find((policy) => policy.direction === "input")?.policyMapId,
    output: bound.find((policy) => policy.direction === "output")?.policyMapId,
  };
}

/** The interface queue limit is the depth bound of its default class queue. */
function queueLimitOf(queue: QosInterfaceQueueView): string {
  const fallback = queue.classes.find((entry) => entry.className === "class-default")
    ?? queue.classes[0];
  return fallback ? `${fallback.limitPackets} pkt` : "—";
}

function formatCapacity(capacityBps: number): string {
  return capacityBps === 0 ? "—" : `${capacityBps / 1_000_000} Mbps`;
}

function summarize(view: QosConfigurationView) {
  const dropsFor = (reason: string) => view.runtime.queues
    .reduce((total, queue) => total + (queue.dropsByReason[reason] ?? 0), 0);
  return {
    classMaps: view.configuration.classMaps.length,
    policyMaps: view.configuration.policyMaps.length,
    boundInterfaces: new Set(view.configuration.servicePolicies.map((policy) => policy.interfaceName)).size,
    bindings: [...view.configuration.servicePolicies],
    queueDrops: view.runtime.queues.reduce((total, queue) => total + queue.droppedPackets, 0),
    policerDrops: dropsFor("policer-exceed"),
    shaperDrops: dropsFor("shaper-limit"),
  };
}

/** The slice of persistent configuration a section edits. */
function editableValue(configuration: QosConfiguration, section: QosSection): unknown {
  if (section === "classification") return configuration.classMaps;
  if (section === "policies") return configuration.policyMaps;
  if (section === "interfaces") return configuration.servicePolicies;
  return [];
}

function mergeSection(
  configuration: QosConfiguration,
  section: QosSection,
  value: unknown,
): QosConfiguration {
  if (!Array.isArray(value)) throw new Error(`${sectionLabel(section)} must be a JSON array.`);
  if (section === "classification") return { ...configuration, classMaps: value as QosConfiguration["classMaps"] };
  if (section === "policies") return { ...configuration, policyMaps: value as QosConfiguration["policyMaps"] };
  if (section === "interfaces") {
    return { ...configuration, servicePolicies: value as QosConfiguration["servicePolicies"] };
  }
  throw new Error(`${sectionLabel(section)} is read-only runtime state.`);
}

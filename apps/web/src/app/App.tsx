import type { LabDocument, NodeSpec } from "@sim/contracts";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import type { SimWorkerEvent } from "@sim/sim-worker";
import { useCallback, useEffect, useState } from "react";
import { DevicePalette } from "../components/DevicePalette";
import { Toolbar } from "../components/Toolbar";
import { DEMO_LAB } from "../fixtures/demo-lab";
import { addDraftDevice, loadLabDocumentText, mergeRunningConfiguration } from "../features/lab/document";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { TopologyCanvas } from "../features/topology/TopologyCanvas";
import { TracePanel } from "../features/trace/TracePanel";
import { useWorkspaceStore } from "../state/workspace-store";
import type { SimulatorClient } from "./simulator-client";

interface AppProps { client: SimulatorClient }

export function downloadLabDocument(document: LabDocument): void {
  const blob = new Blob([stringifyLabDocument(document)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = `${document.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function App({ client }: AppProps) {
  const draft = useWorkspaceStore((state) => state.draft);
  const snapshot = useWorkspaceStore((state) => state.snapshot);
  const traces = useWorkspaceStore((state) => state.traces);
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId);
  const activeTerminalDeviceId = useWorkspaceStore((state) => state.activeTerminalDeviceId);
  const workerStatus = useWorkspaceStore((state) => state.workerStatus);
  const dirty = useWorkspaceStore((state) => state.dirty);
  const error = useWorkspaceStore((state) => state.error);
  const setDraft = useWorkspaceStore((state) => state.setDraft);
  const setSnapshot = useWorkspaceStore((state) => state.setSnapshot);
  const appendTraces = useWorkspaceStore((state) => state.appendTraces);
  const clearTraces = useWorkspaceStore((state) => state.clearTraces);
  const selectNode = useWorkspaceStore((state) => state.selectNode);
  const setWorkerStatus = useWorkspaceStore((state) => state.setWorkerStatus);
  const setError = useWorkspaceStore((state) => state.setError);
  const [confirmApply, setConfirmApply] = useState(false);

  useEffect(() => client.onEvent((event: SimWorkerEvent) => {
    if (event.type === "LAB_READY" || event.type === "STATE_CHANGED") setSnapshot(event.snapshot);
    if (event.type === "TRACE_BATCH") appendTraces(event.events);
    if (event.type === "RUNTIME_ERROR") setError(event.error.message);
  }), [appendTraces, client, setError, setSnapshot]);

  const reportError = useCallback((value: unknown) => {
    setError(value instanceof Error ? value.message : "Unexpected simulator error");
  }, [setError]);
  const reportTerminalError = useCallback((message: string) => setError(message), [setError]);

  const initialize = async (document: LabDocument) => {
    setWorkerStatus("loading");
    setError(undefined);
    clearTraces();
    const canonical = canonicalizeLabDocument(document);
    const ready = await client.request({ type: "INITIALIZE_LAB", document: canonical });
    setDraft(canonical, false);
    setSnapshot(ready);
    selectNode(undefined);
  };

  const loadDemo = () => void initialize(DEMO_LAB).catch(reportError);
  const loadFile = (file: File) => void file.text()
    .then(loadLabDocumentText)
    .then(initialize)
    .catch(reportError);

  const save = () => void (async () => {
    if (!draft) return;
    const running = await client.request({ type: "SERIALIZE_LAB" });
    const merged = mergeRunningConfiguration(running, draft);
    setDraft(merged, false);
    downloadLabDocument(merged);
  })().catch(reportError);

  const apply = () => void (async () => {
    if (!draft) return;
    const running = await client.request({ type: "SERIALIZE_LAB" });
    const merged = mergeRunningConfiguration(running, draft);
    const ready = await client.request({ type: "REBUILD_LAB", document: merged });
    setDraft(merged, false);
    setSnapshot(ready);
    clearTraces();
    setConfirmApply(false);
  })().catch(reportError);

  const run = () => void client.request({ type: "RUN_UNTIL_IDLE" }).then((result) => setSnapshot(result.snapshot)).catch(reportError);
  const step = () => void client.request({ type: "ADVANCE_TIME", milliseconds: 10 }).then((result) => setSnapshot(result.snapshot)).catch(reportError);
  const reset = () => void client.request({ type: "RESET_RUNTIME" }).then((ready) => {
    clearTraces();
    setSnapshot(ready);
  }).catch(reportError);
  const pause = () => void client.request({ type: "SET_PAUSED", paused: snapshot?.engineState !== "paused" })
    .then((result) => setSnapshot(result.snapshot)).catch(reportError);

  const addDevice = (kind: NodeSpec["kind"]) => {
    if (draft) setDraft(addDraftDevice(draft, kind), true);
  };
  const updateDraft = (document: LabDocument) => setDraft(document, true);
  const terminalNode = snapshot?.nodes.find((node) => node.id === activeTerminalDeviceId);
  const ready = workerStatus === "ready" && snapshot !== undefined;

  return (
    <div className="app-shell">
      <Toolbar
        ready={ready}
        dirty={dirty}
        paused={snapshot?.engineState === "paused"}
        onLoadDemo={loadDemo}
        onLoadFile={loadFile}
        onSave={save}
        onReset={reset}
        onRun={run}
        onStep={step}
        onPause={pause}
        onApply={() => setConfirmApply(true)}
      />
      <div className="status-row">
        <span className={`worker-status ${workerStatus}`}><i /> Worker: {workerStatus}</span>
        <span>{snapshot ? `Virtual time ${(snapshot.virtualTime / 1_000_000).toFixed(3)} ms` : "No runtime"}</span>
        {dirty && <span className="dirty-status">Unsaved topology changes</span>}
      </div>
      {error && <div className="error-banner" role="alert"><strong>Simulator error</strong><span>{error}</span><button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">×</button></div>}
      <main className="workspace-grid">
        <DevicePalette disabled={!draft} onAdd={addDevice} />
        <TopologyCanvas
          document={draft}
          snapshot={snapshot}
          selectedNodeId={selectedNodeId}
          onSelect={selectNode}
          onChange={updateDraft}
        />
        <TracePanel snapshot={snapshot} selectedNodeId={selectedNodeId} traces={traces} />
        <TerminalPanel
          client={client}
          deviceId={activeTerminalDeviceId}
          hostname={terminalNode?.hostname}
          available={terminalNode !== undefined}
          onError={reportTerminalError}
        />
      </main>
      {confirmApply && (
        <div className="dialog-backdrop" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="apply-title">
            <p className="eyebrow">Runtime rebuild</p>
            <h2 id="apply-title">Apply topology changes?</h2>
            <p>Applying topology changes resets runtime state. Structured device configuration will be preserved where possible.</p>
            <div><button type="button" onClick={() => setConfirmApply(false)}>Cancel</button><button type="button" className="primary" onClick={apply}>Apply and rebuild</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

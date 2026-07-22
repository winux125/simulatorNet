import type { LabDocument, NodeSpec } from "@sim/contracts";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import type { SimWorkerEvent } from "@sim/sim-worker";
import { Group as PanelGroup, Panel as ResizablePanel, Separator } from "react-resizable-panels";
import { AlertTriangle, Command, Download, FolderOpen, Keyboard, Maximize2, Play, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { DevicePalette } from "../components/DevicePalette";
import { ToolRail } from "../components/ToolRail";
import { Toolbar } from "../components/Toolbar";
import { DEMO_LAB } from "../fixtures/demo-lab";
import {
  addDraftDevice,
  autoArrangeDocument,
  loadLabDocumentText,
  mergeRunningConfiguration,
  removeDraftDevice,
  removeDraftLink,
} from "../features/lab/document";
import { InspectorPanel } from "../features/inspector/InspectorPanel";
import { useLaunchSession } from "../features/session/useLaunchSession";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTheme } from "../hooks/useTheme";
import { useWorkspaceStore, type WorkspaceMode } from "../state/workspace-store";
import { Button, IconButton, Kbd } from "../ui";
import type { SimulatorClient } from "./simulator-client";

const TopologyCanvas = lazy(() => import("../features/topology/TopologyCanvas"));
const BottomDock = lazy(() => import("../features/dock/BottomDock"));

interface AppProps { client: SimulatorClient }

export const EMPTY_LAB: LabDocument = {
  schemaVersion: 1,
  id: "untitled-lab",
  title: "Untitled Lab",
  description: "A deterministic browser network laboratory",
  simulation: { seed: 1 },
  topology: { schemaVersion: 1, nodes: [], links: [] },
  configurations: {},
};

export function downloadLabDocument(document: LabDocument): void {
  const blob = new Blob([stringifyLabDocument(document)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = `${document.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true'], .xterm"));
}

export function App({ client }: AppProps) {
  const workspace = useWorkspaceStore();
  const compact = useMediaQuery("(max-width: 999px)");
  const theme = useTheme();
  const launchSession = useLaunchSession();
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<WorkspaceMode>();

  useEffect(() => client.onEvent((event: SimWorkerEvent) => {
    if (event.type === "LAB_READY" || event.type === "STATE_CHANGED") workspace.setSnapshot(event.snapshot);
    if (event.type === "TRACE_BATCH") workspace.appendTraces(event.events);
    if (event.type === "RUNTIME_ERROR") {
      workspace.setError(event.error.message, "worker");
      workspace.setDockTab("problems");
    }
  }), [client, workspace.appendTraces, workspace.setDockTab, workspace.setError, workspace.setSnapshot]);

  const reportError = useCallback((value: unknown, source: "worker" | "cli" | "validation" = "worker") => {
    const message = value instanceof Error ? value.message : typeof value === "string" ? value : "Unexpected simulator error";
    useWorkspaceStore.getState().setError(message, source);
    useWorkspaceStore.getState().setDockTab("problems");
  }, []);
  const reportCliError = useCallback((message: string) => reportError(message, "cli"), [reportError]);
  const reportInspectionError = useCallback((message: string) => reportError(message, "worker"), [reportError]);

  const initialize = async (document: LabDocument, initialMode: WorkspaceMode = "simulate") => {
    workspace.reset();
    workspace.setWorkerStatus("loading");
    const canonical = canonicalizeLabDocument(document);
    const ready = await client.request({ type: "INITIALIZE_LAB", document: canonical });
    workspace.setDraft(canonical, false);
    workspace.setSnapshot(ready);
    workspace.selectNode(undefined);
    workspace.selectLink(undefined);
    workspace.setMode(initialMode);
    window.requestAnimationFrame(() => workspace.requestFit());
  };

  const loadDemo = () => void initialize(DEMO_LAB).catch((error) => reportError(error, "validation"));
  const newLab = () => void initialize(EMPTY_LAB, "edit").catch((error) => reportError(error, "validation"));
  const loadFile = (file: File) => void file.text().then(loadLabDocumentText).then(initialize).catch((error) => reportError(error, "validation"));
  const importLab = () => document.getElementById("load-lab-file")?.click();
  const closeLab = () => {
    if (workspace.dirty) setConfirmClose(true);
    else workspace.reset();
  };

  const save = useCallback(() => void (async () => {
    const draft = useWorkspaceStore.getState().draft;
    if (!draft) return;
    const running = await client.request({ type: "SERIALIZE_LAB" });
    const merged = mergeRunningConfiguration(running, draft);
    useWorkspaceStore.getState().setDraft(merged, false);
    downloadLabDocument(merged);
  })().catch(reportError), [client, reportError]);

  const rebuild = useCallback(async (nextMode: WorkspaceMode = "simulate") => {
    const state = useWorkspaceStore.getState();
    if (!state.draft) return;
    const running = await client.request({ type: "SERIALIZE_LAB" });
    const merged = mergeRunningConfiguration(running, state.draft);
    const ready = await client.request({ type: "REBUILD_LAB", document: merged });
    const current = useWorkspaceStore.getState();
    current.setDraft(merged, false);
    current.setSnapshot(ready);
    current.clearTraces();
    current.setMode(nextMode);
    setConfirmApply(false);
    setPendingMode(undefined);
  }, [client]);

  const changeMode = (mode: WorkspaceMode) => {
    if (!workspace.snapshot || mode === workspace.mode) return;
    if (mode === "edit") {
      void client.request({ type: "SERIALIZE_LAB" }).then((running) => {
        const draft = useWorkspaceStore.getState().draft;
        if (draft) useWorkspaceStore.getState().setDraft(mergeRunningConfiguration(running, draft), false);
        useWorkspaceStore.getState().setMode("edit");
      }).catch(reportError);
      return;
    }
    setPendingMode("simulate");
    if (workspace.dirty) setConfirmApply(true);
    else void rebuild("simulate").catch(reportError);
  };

  const run = useCallback(() => void client.request({ type: "RUN_UNTIL_IDLE" }).then((result) => useWorkspaceStore.getState().setSnapshot(result.snapshot)).catch(reportError), [client, reportError]);
  const step = () => void client.request({ type: "ADVANCE_TIME", milliseconds: 10 }).then((result) => workspace.setSnapshot(result.snapshot)).catch(reportError);
  const reset = () => void client.request({ type: "RESET_RUNTIME" }).then((ready) => { workspace.clearTraces(); workspace.setSnapshot(ready); }).catch(reportError);
  const pause = () => void client.request({ type: "SET_PAUSED", paused: workspace.snapshot?.engineState !== "paused" }).then((result) => workspace.setSnapshot(result.snapshot)).catch(reportError);

  const addDevice = (kind: NodeSpec["kind"]) => {
    const draft = useWorkspaceStore.getState().draft;
    if (draft && useWorkspaceStore.getState().mode === "edit") workspace.setDraft(addDraftDevice(draft, kind), true);
  };
  const updateDraft = (document: LabDocument) => workspace.setDraft(document, true);
  const deleteSelection = useCallback(() => {
    const state = useWorkspaceStore.getState();
    if (!state.draft || state.mode !== "edit") return;
    if (state.selectedNodeId) {
      state.setDraft(removeDraftDevice(state.draft, state.selectedNodeId), true);
      state.selectNode(undefined);
    } else if (state.selectedLinkId) {
      state.setDraft(removeDraftLink(state.draft, state.selectedLinkId), true);
      state.selectLink(undefined);
    }
  }, []);
  const arrange = () => {
    if (workspace.draft && workspace.mode === "edit") workspace.setDraft(autoArrangeDocument(workspace.draft), true);
    workspace.requestFit();
  };
  const openTerminal = (deviceId: string) => {
    if (useWorkspaceStore.getState().mode !== "simulate") {
      reportError("CLI is available in Simulate mode", "cli");
      return;
    }
    workspace.openTerminal(deviceId);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        document.getElementById("load-lab-file")?.click();
      } else if (commandKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      } else if (commandKey && event.key === "Enter") {
        event.preventDefault();
        run();
      } else if (commandKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelection();
      } else if (event.key.toLowerCase() === "f") {
        workspace.requestFit();
      } else if (event.key === "?") {
        setShortcutsOpen(true);
      } else if (event.key === "Escape") {
        setShortcutsOpen(false);
        setCommandPaletteOpen(false);
        setConfirmApply(false);
        workspace.setPaletteOpen(false);
        workspace.selectNode(undefined);
        workspace.selectLink(undefined);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteSelection, run, save, workspace.requestFit, workspace.selectLink, workspace.selectNode, workspace.setPaletteOpen]);

  const labOpen = workspace.snapshot !== undefined;
  const ready = workspace.workerStatus === "ready" && labOpen;
  const inspector = labOpen && workspace.inspectorOpen && (
    <InspectorPanel
      client={client}
      document={workspace.draft}
      snapshot={workspace.snapshot}
      selectedNodeId={workspace.selectedNodeId}
      selectedLinkId={workspace.selectedLinkId}
      tab={workspace.inspectorTab}
      mode={workspace.mode}
      compact={compact}
      onTab={workspace.setInspectorTab}
      onOpenTerminal={openTerminal}
      onError={reportInspectionError}
      onClose={() => workspace.setInspectorOpen(false)}
    />
  );

  return (
    <div className="app-shell" data-workspace-mode={workspace.mode} data-responsive={compact ? "compact" : "desktop"}>
      <Toolbar
        labTitle={workspace.snapshot?.title}
        workerStatus={workspace.workerStatus}
        engineState={workspace.snapshot?.engineState}
        ready={ready}
        hasLab={labOpen}
        dirty={workspace.dirty}
        mode={workspace.mode}
        inspectorOpen={workspace.inspectorOpen}
        bottomDockOpen={workspace.bottomDockOpen}
        theme={theme.preference}
        session={launchSession.state.status === "authenticated" ? launchSession.state.identity : undefined}
        sessionPending={launchSession.state.status === "checking" || launchSession.state.status === "exchanging"}
        onModeChange={changeMode}
        onLoadDemo={loadDemo}
        onLoadFile={loadFile}
        onSave={save}
        onReset={reset}
        onRun={run}
        onStep={step}
        onPause={pause}
        onFit={workspace.requestFit}
        onToggleInspector={() => workspace.setInspectorOpen(!workspace.inspectorOpen)}
        onToggleBottomDock={() => workspace.setBottomDockOpen(!workspace.bottomDockOpen)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onThemeChange={theme.setPreference}
        onCloseLab={closeLab}
        onLogout={() => void launchSession.logout().catch((error) => reportError(error, "validation"))}
      />
      {launchSession.state.status === "exchanging" && <div className="launch-status" role="status">Exchanging secure launch code…</div>}
      {launchSession.state.status === "error" && <div className="workspace-error" role="alert"><AlertTriangle size={14} /><span>{launchSession.state.message}</span></div>}
      {workspace.error && <div className="workspace-error" role="alert"><AlertTriangle size={14} /><span>{workspace.error}</span><button type="button" onClick={() => workspace.setDockTab("problems")}>View problems</button><IconButton label="Dismiss error" icon={<X size={13} />} onClick={() => workspace.setError(undefined)} /></div>}
      {workspace.dirty && workspace.mode === "edit" && <div className="pending-banner"><span><i /> Topology changes pending</span><Button size="sm" variant="primary" onClick={() => { setPendingMode("edit"); setConfirmApply(true); }}>Apply &amp; Rebuild</Button></div>}
      <div className="workspace-body">
        <ToolRail
          mode={workspace.mode}
          activeTool={workspace.activeTool}
          dirty={workspace.dirty}
          canDelete={Boolean(workspace.selectedNodeId || workspace.selectedLinkId)}
          onTool={workspace.setActiveTool}
          onDelete={deleteSelection}
          onFit={workspace.requestFit}
          onArrange={arrange}
          onApply={() => { setPendingMode("edit"); setConfirmApply(true); }}
        />
        {workspace.paletteOpen && <DevicePalette disabled={!workspace.draft || workspace.mode !== "edit"} onAdd={addDevice} onClose={() => workspace.setPaletteOpen(false)} />}
        <PanelGroup orientation="vertical" className="workspace-resizable" id="workspace-layout">
          <ResizablePanel id="workspace-main" minSize="300px" defaultSize="68%">
            <div className="main-workspace">
              {!compact && workspace.inspectorOpen ? (
                <PanelGroup orientation="horizontal" id="main-layout">
                  <ResizablePanel id="topology" minSize="520px" defaultSize="76%">
                    <Suspense fallback={<CanvasLoading />}><TopologyCanvas {...topologyProps()} /></Suspense>
                  </ResizablePanel>
                  <Separator className="resize-handle resize-handle--vertical" />
                  <ResizablePanel id="inspector" minSize="280px" maxSize="440px" defaultSize="330px">{inspector}</ResizablePanel>
                </PanelGroup>
              ) : <Suspense fallback={<CanvasLoading />}><TopologyCanvas {...topologyProps()} /></Suspense>}
              {compact && inspector}
            </div>
          </ResizablePanel>
          {labOpen && workspace.bottomDockOpen && <>
            <Separator className="resize-handle resize-handle--horizontal" />
            <ResizablePanel id="bottom-dock" minSize="170px" maxSize="48%" defaultSize="270px">
              <Suspense fallback={<DockLoading />}>
                <BottomDock
                  client={client}
                  tab={workspace.dockTab}
                  snapshot={workspace.snapshot}
                  traces={workspace.traces}
                  problems={workspace.problems}
                  terminalTabs={workspace.terminalTabs}
                  activeTerminalDeviceId={workspace.activeTerminalDeviceId}
                  mode={workspace.mode}
                  theme={theme.resolved}
                  onTab={workspace.setDockTab}
                  onActivateTerminal={workspace.setActiveTerminal}
                  onCloseTerminal={workspace.closeTerminal}
                  onClearProblems={workspace.clearProblems}
                  onError={reportCliError}
                  onClose={() => workspace.setBottomDockOpen(false)}
                />
              </Suspense>
            </ResizablePanel>
          </>}
        </PanelGroup>
      </div>
      <footer className="workspace-footer"><span>Mode: <strong>{workspace.mode}</strong></span><span>Virtual time <code>{((workspace.snapshot?.virtualTime ?? 0) / 1_000_000).toFixed(3)} ms</code></span><span>{workspace.snapshot?.nodes.length ?? 0} devices</span><span className="workspace-footer__right">Schema v{workspace.draft?.schemaVersion ?? 1} · deterministic runtime</span></footer>

      {confirmApply && <WorkspaceDialog title="Apply topology changes?" eyebrow="Runtime rebuild" onClose={() => { setConfirmApply(false); setPendingMode(undefined); }}>
        <p>Applying the draft serializes the current device configuration, merges topology positions and rebuilds the worker runtime. Volatile ARP, MAC and event state will reset.</p>
        <div className="dialog-actions"><Button variant="ghost" onClick={() => { setConfirmApply(false); setPendingMode(undefined); }}>Cancel</Button><Button variant="primary" onClick={() => void rebuild(pendingMode ?? "edit").catch(reportError)}>Apply &amp; Rebuild</Button></div>
      </WorkspaceDialog>}
      {confirmClose && <WorkspaceDialog title="Close laboratory?" eyebrow="Unsaved topology" onClose={() => setConfirmClose(false)}>
        <p>The current topology has unapplied changes. Closing the laboratory will discard that draft.</p>
        <div className="dialog-actions"><Button variant="ghost" onClick={() => setConfirmClose(false)}>Keep Editing</Button><Button variant="danger" onClick={() => { setConfirmClose(false); workspace.reset(); }}>Discard &amp; Close</Button></div>
      </WorkspaceDialog>}
      {shortcutsOpen && <WorkspaceDialog title="Keyboard shortcuts" eyebrow="Quick workflow" onClose={() => setShortcutsOpen(false)}>
        <div className="shortcut-list"><Shortcut keys="Ctrl / Cmd + O" label="Import lab" /><Shortcut keys="Ctrl / Cmd + S" label="Export JSON" /><Shortcut keys="Ctrl / Cmd + Enter" label="Run until idle" /><Shortcut keys="Ctrl / Cmd + K" label="Command palette" /><Shortcut keys="Delete" label="Delete selection in Edit mode" /><Shortcut keys="F" label="Fit topology" /><Shortcut keys="Escape" label="Close menus and clear selection" /></div>
      </WorkspaceDialog>}
      {commandPaletteOpen && <WorkspaceDialog title="Command palette" eyebrow="SimulatorNet" onClose={() => setCommandPaletteOpen(false)}>
        <div className="command-list">
          <button type="button" onClick={() => { document.getElementById("load-lab-file")?.click(); setCommandPaletteOpen(false); }}><FolderOpen size={15} /><span><strong>Import lab</strong><small>Open a LabDocument JSON file</small></span><Kbd>⌘ O</Kbd></button>
          <button type="button" disabled={!ready} onClick={() => { save(); setCommandPaletteOpen(false); }}><Download size={15} /><span><strong>Export lab</strong><small>Save canonical JSON</small></span><Kbd>⌘ S</Kbd></button>
          <button type="button" disabled={!ready || workspace.mode !== "simulate"} onClick={() => { run(); setCommandPaletteOpen(false); }}><Play size={15} /><span><strong>Run until idle</strong><small>Drain deterministic event queue</small></span><Kbd>⌘ ↵</Kbd></button>
          <button type="button" onClick={() => { workspace.requestFit(); setCommandPaletteOpen(false); }}><Maximize2 size={15} /><span><strong>Fit topology</strong><small>Frame all devices</small></span><Kbd>F</Kbd></button>
          <button type="button" onClick={() => { setShortcutsOpen(true); setCommandPaletteOpen(false); }}><Keyboard size={15} /><span><strong>Keyboard shortcuts</strong><small>View quick workflow keys</small></span></button>
        </div>
      </WorkspaceDialog>}
    </div>
  );

  function topologyProps() {
    return {
      document: workspace.draft,
      snapshot: workspace.snapshot,
      mode: workspace.mode,
      activeTool: workspace.activeTool,
      selectedNodeId: workspace.selectedNodeId,
      selectedLinkId: workspace.selectedLinkId,
      terminalTabs: workspace.terminalTabs,
      showLinkLabels: workspace.showLinkLabels,
      fitRequest: workspace.fitRequest,
      onSelectNode: workspace.selectNode,
      onSelectLink: workspace.selectLink,
      onOpenTerminal: openTerminal,
      onInspect: (id: string) => { workspace.selectNode(id); workspace.setInspectorOpen(true); },
      onShowLinkLabels: workspace.setShowLinkLabels,
      onChange: updateDraft,
      onLoadDemo: loadDemo,
      onNewLab: newLab,
      onImportLab: importLab,
    };
  }
}

function CanvasLoading() {
  return <div className="panel-loading"><Command size={24} /><span>Loading topology canvas…</span></div>;
}

function DockLoading() {
  return <div className="panel-loading"><Command size={20} /><span>Loading workspace panel…</span></div>;
}

function WorkspaceDialog({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose(): void; children: React.ReactNode }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-label={title}><header><div><p>{eyebrow}</p><h2>{title}</h2></div><IconButton label="Close dialog" icon={<X size={15} />} onClick={onClose} /></header>{children}</section></div>;
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return <div><Kbd>{keys}</Kbd><span>{label}</span></div>;
}

import type { LabDocument, NodeSpec } from "@sim/contracts";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import type { SimWorkerEvent } from "@sim/sim-worker";
import { Group as PanelGroup, Panel as ResizablePanel, Separator } from "react-resizable-panels";
import {
  AlertTriangle, CheckCircle2, Command, Download, Eraser, FilePlus2, FlaskConical, FolderOpen, FolderX,
  Info, Keyboard, Maximize2, Pause, PanelBottom, PanelRight, Play, Redo2, RotateCcw, SkipForward,
  SunMoon, Tag, TerminalSquare, Undo2, X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { DevicePalette } from "../components/DevicePalette";
import { ToolRail } from "../components/ToolRail";
import { Toolbar } from "../components/Toolbar";
import type { MenuDef } from "../components/MenuBar";
import { DEMO_LAB } from "../fixtures/demo-lab";
import {
  addDraftDevice,
  autoArrangeDocument,
  duplicateDraftDevice,
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

export function downloadLabDocument(document: LabDocument, fileName?: string): void {
  const blob = new Blob([stringifyLabDocument(document)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  const name = (fileName ?? document.id).replace(/\.json$/i, "");
  anchor.download = `${name || "lab"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input, textarea, select, [contenteditable='true'], .xterm, .terminal-session, [role='menu'], [role='menubar']"));
}

export function App({ client }: AppProps) {
  const workspace = useWorkspaceStore();
  const compact = useMediaQuery("(max-width: 999px)");
  const theme = useTheme();
  const launchSession = useLaunchSession();
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [labInfoOpen, setLabInfoOpen] = useState(false);
  const [cliCommandsOpen, setCliCommandsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [advanceTimeOpen, setAdvanceTimeOpen] = useState(false);
  const [validation, setValidation] = useState<string>();
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
  const loadFile = (file: File) => void file.text().then(loadLabDocumentText).then((document) => initialize(document)).catch((error) => reportError(error, "validation"));
  const importLab = () => document.getElementById("load-lab-file")?.click();
  const closeLab = () => {
    if (workspace.dirty) setConfirmClose(true);
    else workspace.reset();
  };

  const exportLab = useCallback((fileName?: string) => void (async () => {
    const draft = useWorkspaceStore.getState().draft;
    if (!draft) return;
    const running = await client.request({ type: "SERIALIZE_LAB" });
    const merged = mergeRunningConfiguration(running, draft);
    useWorkspaceStore.getState().setDraft(merged, false);
    downloadLabDocument(merged, fileName);
  })().catch(reportError), [client, reportError]);
  const save = useCallback(() => exportLab(), [exportLab]);

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
  const advanceTime = (milliseconds: number) => void client.request({ type: "ADVANCE_TIME", milliseconds }).then((result) => workspace.setSnapshot(result.snapshot)).catch(reportError);
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
  const duplicateSelected = () => {
    const state = useWorkspaceStore.getState();
    if (state.draft && state.mode === "edit" && state.selectedNodeId) {
      state.setDraft(duplicateDraftDevice(state.draft, state.selectedNodeId), true);
    }
  };
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
  const openTerminalFromMenu = () => {
    const state = useWorkspaceStore.getState();
    if (state.mode === "simulate") {
      const target = state.selectedNodeId ?? state.snapshot?.nodes[0]?.id;
      if (target) { openTerminal(target); return; }
    }
    workspace.setDockTab("terminal");
  };
  const validateDocument = () => {
    const draft = useWorkspaceStore.getState().draft;
    if (!draft) return;
    try {
      canonicalizeLabDocument(draft);
      setValidation("Document is valid — schema and semantics passed.");
    } catch (error) {
      setValidation(undefined);
      reportError(error, "validation");
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (commandKey && key === "n") { event.preventDefault(); newLab(); }
      else if (commandKey && key === "o") { event.preventDefault(); importLab(); }
      else if (commandKey && event.shiftKey && key === "s") { event.preventDefault(); setSaveAsOpen(true); }
      else if (commandKey && key === "s") { event.preventDefault(); save(); }
      else if (commandKey && key === "z" && event.shiftKey) { event.preventDefault(); useWorkspaceStore.getState().redo(); }
      else if (commandKey && key === "z") { event.preventDefault(); useWorkspaceStore.getState().undo(); }
      else if (commandKey && event.key === "Enter") { event.preventDefault(); run(); }
      else if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
      else if (key === "f") workspace.requestFit();
      else if (event.key === "?") setShortcutsOpen(true);
      else if (event.key === "Escape") {
        setShortcutsOpen(false); setLabInfoOpen(false); setCliCommandsOpen(false); setAboutOpen(false);
        setSaveAsOpen(false); setAdvanceTimeOpen(false); setConfirmApply(false); setValidation(undefined);
        workspace.setPaletteOpen(false); workspace.selectNode(undefined); workspace.selectLink(undefined);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteSelection, run, save]);

  const labOpen = workspace.snapshot !== undefined;
  const ready = workspace.workerStatus === "ready" && labOpen;
  const simulationEnabled = ready && workspace.mode === "simulate";
  const paused = workspace.snapshot?.engineState === "paused";
  const editMode = workspace.mode === "edit";
  const hasSelection = Boolean(workspace.selectedNodeId || workspace.selectedLinkId);

  const menus: MenuDef[] = [
    { id: "file", label: "File", items: [
      { id: "file-new", label: "New Lab", shortcut: "Ctrl N", icon: <FilePlus2 size={14} />, onSelect: newLab },
      { id: "file-open", label: "Open / Import Lab…", shortcut: "Ctrl O", icon: <FolderOpen size={14} />, onSelect: importLab },
      { id: "file-demo", label: "Load Demo Lab", icon: <FlaskConical size={14} />, onSelect: loadDemo },
      { id: "file-close", label: "Close Lab", icon: <FolderX size={14} />, disabled: !labOpen, onSelect: closeLab },
      { separator: true },
      { id: "file-save", label: "Save / Export Lab", shortcut: "Ctrl S", icon: <Download size={14} />, disabled: !ready, onSelect: save },
      { id: "file-saveas", label: "Save As…", shortcut: "Ctrl ⇧ S", disabled: !ready, onSelect: () => setSaveAsOpen(true) },
    ] },
    { id: "edit", label: "Edit", items: [
      { id: "edit-undo", label: "Undo", shortcut: "Ctrl Z", icon: <Undo2 size={14} />, disabled: workspace.past.length === 0, onSelect: workspace.undo },
      { id: "edit-redo", label: "Redo", shortcut: "Ctrl ⇧ Z", icon: <Redo2 size={14} />, disabled: workspace.future.length === 0, onSelect: workspace.redo },
      { separator: true },
      { id: "edit-delete", label: "Delete Selected", shortcut: "Del", disabled: !editMode || !hasSelection, onSelect: deleteSelection },
      { id: "edit-duplicate", label: "Duplicate Device", disabled: !editMode || !workspace.selectedNodeId, onSelect: duplicateSelected },
    ] },
    { id: "view", label: "View", items: [
      { id: "view-fit", label: "Fit Topology", shortcut: "F", icon: <Maximize2 size={14} />, disabled: !labOpen, onSelect: workspace.requestFit },
      { id: "view-zoom", label: "Reset Zoom", disabled: !labOpen, onSelect: workspace.requestZoomReset },
      { separator: true },
      { id: "view-inspector", label: workspace.inspectorOpen ? "Hide Inspector" : "Show Inspector", icon: <PanelRight size={14} />, onSelect: () => workspace.setInspectorOpen(!workspace.inspectorOpen) },
      { id: "view-bottom", label: workspace.bottomDockOpen ? "Hide Bottom Panel" : "Show Bottom Panel", icon: <PanelBottom size={14} />, onSelect: () => workspace.setBottomDockOpen(!workspace.bottomDockOpen) },
      { id: "view-ports", label: workspace.showLinkLabels ? "Hide Port Labels" : "Show Port Labels", icon: <Tag size={14} />, onSelect: () => workspace.setShowLinkLabels(!workspace.showLinkLabels) },
      { id: "view-terminal", label: "Open Terminal", icon: <TerminalSquare size={14} />, disabled: !labOpen, onSelect: openTerminalFromMenu },
      { separator: true },
      { id: "view-theme", label: "Theme", icon: <SunMoon size={14} />, submenu: [
        { id: "theme-system", label: "System", checked: theme.preference === "system", onSelect: () => theme.setPreference("system") },
        { id: "theme-dark", label: "Dark", checked: theme.preference === "dark", onSelect: () => theme.setPreference("dark") },
        { id: "theme-light", label: "Light", checked: theme.preference === "light", onSelect: () => theme.setPreference("light") },
      ] },
    ] },
    { id: "lab", label: "Lab", items: [
      { id: "lab-edit", label: "Edit Mode", checked: editMode, disabled: !ready, onSelect: () => changeMode("edit") },
      { id: "lab-sim", label: "Simulate Mode", checked: workspace.mode === "simulate", disabled: !ready, onSelect: () => changeMode("simulate") },
      { separator: true },
      { id: "lab-apply", label: "Apply & Rebuild", disabled: !workspace.dirty, onSelect: () => { setPendingMode(workspace.mode); setConfirmApply(true); } },
      { id: "lab-info", label: "Lab Information", icon: <Info size={14} />, disabled: !labOpen, onSelect: () => setLabInfoOpen(true) },
      { id: "lab-validate", label: "Validate Document", icon: <CheckCircle2 size={14} />, disabled: !labOpen, onSelect: validateDocument },
      { id: "lab-reset", label: "Reset Runtime", icon: <RotateCcw size={14} />, disabled: !simulationEnabled, onSelect: reset },
    ] },
    { id: "simulation", label: "Simulation", items: [
      { id: "sim-run", label: "Run Until Idle", shortcut: "Ctrl ↵", icon: <Play size={14} />, disabled: !simulationEnabled || paused, onSelect: run },
      { id: "sim-step", label: "Advance One Step", icon: <SkipForward size={14} />, disabled: !simulationEnabled || paused, onSelect: step },
      { id: "sim-advance", label: "Advance Time…", disabled: !simulationEnabled, onSelect: () => setAdvanceTimeOpen(true) },
      { id: "sim-pause", label: paused ? "Resume" : "Pause", icon: paused ? <Play size={14} /> : <Pause size={14} />, disabled: !simulationEnabled, onSelect: pause },
      { separator: true },
      { id: "sim-clear", label: "Clear Trace", icon: <Eraser size={14} />, disabled: !labOpen, onSelect: workspace.clearTraces },
    ] },
    { id: "help", label: "Help", items: [
      { id: "help-cli", label: "CLI Commands", icon: <TerminalSquare size={14} />, onSelect: () => setCliCommandsOpen(true) },
      { id: "help-shortcuts", label: "Keyboard Shortcuts", shortcut: "?", icon: <Keyboard size={14} />, onSelect: () => setShortcutsOpen(true) },
      { id: "help-about", label: "About SimulatorNet", icon: <Info size={14} />, onSelect: () => setAboutOpen(true) },
    ] },
  ];

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
        menus={menus}
        labTitle={workspace.snapshot?.title}
        sessionScope={launchSession.state.status === "authenticated" ? "Organization" : "Local Lab"}
        workerStatus={workspace.workerStatus}
        engineState={workspace.snapshot?.engineState}
        ready={ready}
        dirty={workspace.dirty}
        mode={workspace.mode}
        theme={theme.preference}
        session={launchSession.state.status === "authenticated" ? launchSession.state.identity : undefined}
        sessionPending={launchSession.state.status === "checking" || launchSession.state.status === "exchanging"}
        onModeChange={changeMode}
        onRun={run}
        onStep={step}
        onPause={pause}
        onReset={reset}
        onThemeChange={theme.setPreference}
        onLogout={() => void launchSession.logout().catch((error) => reportError(error, "validation"))}
      />
      <input id="load-lab-file" className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) loadFile(file); event.target.value = ""; }} />
      {launchSession.state.status === "exchanging" && <div className="launch-status" role="status">Exchanging secure launch code…</div>}
      {launchSession.state.status === "error" && <div className="workspace-error" role="alert"><AlertTriangle size={14} /><span>{launchSession.state.message}</span></div>}
      {validation && <div className="workspace-notice" role="status"><CheckCircle2 size={14} /><span>{validation}</span><IconButton label="Dismiss notice" icon={<X size={13} />} onClick={() => setValidation(undefined)} /></div>}
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
      {saveAsOpen && <SaveAsDialog defaultName={workspace.draft?.id ?? "lab"} onClose={() => setSaveAsOpen(false)} onSave={(name) => { exportLab(name); setSaveAsOpen(false); }} />}
      {advanceTimeOpen && <AdvanceTimeDialog onClose={() => setAdvanceTimeOpen(false)} onAdvance={(ms) => { advanceTime(ms); setAdvanceTimeOpen(false); }} />}
      {labInfoOpen && workspace.draft && <LabInformationDialog document={workspace.draft} mode={workspace.mode} onClose={() => setLabInfoOpen(false)} />}
      {cliCommandsOpen && <CliCommandsDialog onClose={() => setCliCommandsOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {shortcutsOpen && <WorkspaceDialog title="Keyboard shortcuts" eyebrow="Quick workflow" onClose={() => setShortcutsOpen(false)}>
        <div className="shortcut-list">
          <Shortcut keys="Ctrl / Cmd + N" label="New lab" />
          <Shortcut keys="Ctrl / Cmd + O" label="Open / import lab" />
          <Shortcut keys="Ctrl / Cmd + S" label="Save / export JSON" />
          <Shortcut keys="Ctrl / Cmd + Shift + S" label="Save As…" />
          <Shortcut keys="Ctrl / Cmd + Z" label="Undo topology edit" />
          <Shortcut keys="Ctrl / Cmd + Enter" label="Run until idle" />
          <Shortcut keys="Delete" label="Delete selection in Edit mode" />
          <Shortcut keys="F" label="Fit topology" />
          <Shortcut keys="Ctrl + L" label="Clear focused terminal" />
          <Shortcut keys="Escape" label="Close menus and dialogs" />
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
      zoomResetRequest: workspace.zoomResetRequest,
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

function SaveAsDialog({ defaultName, onClose, onSave }: { defaultName: string; onClose(): void; onSave(name: string): void }) {
  const [name, setName] = useState(defaultName);
  return <WorkspaceDialog title="Save lab as" eyebrow="Canonical export" onClose={onClose}>
    <p>Export the canonical LabDocument JSON under a file name of your choice. Server autosave is not the primary model yet, so Save writes a portable snapshot.</p>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSave(name.trim() || defaultName); }}>
      <label htmlFor="save-as-name">File name</label>
      <div className="dialog-field"><input id="save-as-name" value={name} autoFocus onChange={(event) => setName(event.target.value)} /><span>.json</span></div>
      <div className="dialog-actions"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit">Save</Button></div>
    </form>
  </WorkspaceDialog>;
}

function AdvanceTimeDialog({ onClose, onAdvance }: { onClose(): void; onAdvance(ms: number): void }) {
  const [value, setValue] = useState("100");
  const ms = Number(value);
  const valid = Number.isFinite(ms) && ms > 0;
  return <WorkspaceDialog title="Advance virtual time" eyebrow="Deterministic clock" onClose={onClose}>
    <p>Drain scheduled events up to a virtual-time horizon. This uses the deterministic clock — there is no wall-clock loop.</p>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (valid) onAdvance(ms); }}>
      <label htmlFor="advance-ms">Milliseconds</label>
      <div className="dialog-field"><input id="advance-ms" type="number" min={1} value={value} autoFocus onChange={(event) => setValue(event.target.value)} /><span>ms</span></div>
      <div className="dialog-actions"><Button variant="ghost" type="button" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" disabled={!valid}>Advance</Button></div>
    </form>
  </WorkspaceDialog>;
}

function LabInformationDialog({ document, mode, onClose }: { document: LabDocument; mode: WorkspaceMode; onClose(): void }) {
  return <WorkspaceDialog title="Lab information" eyebrow="Document metadata" onClose={onClose}>
    <dl className="property-list">
      <div><dt>Title</dt><dd>{document.title}</dd></div>
      <div><dt>Identifier</dt><dd><code>{document.id}</code></dd></div>
      <div><dt>Schema</dt><dd>v{document.schemaVersion}</dd></div>
      <div><dt>Seed</dt><dd><code>{document.simulation.seed}</code></dd></div>
      <div><dt>Devices</dt><dd>{document.topology.nodes.length}</dd></div>
      <div><dt>Links</dt><dd>{document.topology.links.length}</dd></div>
      <div><dt>Mode</dt><dd>{mode}</dd></div>
    </dl>
    {document.description && <p className="section-note">{document.description}</p>}
  </WorkspaceDialog>;
}

function CliCommandsDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="CLI commands" eyebrow="Implemented surface" onClose={onClose}>
    <div className="cli-command-reference">
      <section><h3>PC</h3><ul>
        <li><code>ping &lt;ip&gt;</code> — send ICMP echoes to a destination</li>
        <li><code>ipconfig</code> — show interface addressing and DHCP lease</li>
        <li><code>arp</code> — display the ARP cache</li>
      </ul></section>
      <section><h3>Switch</h3><ul>
        <li><code>enable</code> / <code>configure terminal</code> — enter privileged / global config</li>
        <li><code>vlan &lt;id&gt;</code>, <code>name &lt;text&gt;</code> — define VLANs</li>
        <li><code>interface &lt;id&gt;</code>, <code>switchport mode access|trunk</code>, <code>switchport access vlan &lt;id&gt;</code></li>
        <li><code>show vlan brief</code>, <code>show mac address-table</code>, <code>show interfaces status</code></li>
      </ul></section>
      <section><h3>Router</h3><ul>
        <li><code>interface &lt;id&gt;</code>, <code>ip address &lt;ip&gt; &lt;mask&gt;</code>, <code>no shutdown</code></li>
        <li><code>interface &lt;id&gt;.&lt;vlan&gt;</code>, <code>encapsulation dot1q &lt;vlan&gt;</code> — router-on-a-stick</li>
        <li><code>ip route &lt;net&gt; &lt;mask&gt; &lt;next-hop&gt;</code> — static routes</li>
        <li><code>show ip interface brief</code>, <code>show ip route</code></li>
      </ul></section>
      <section><h3>Modes</h3><ul>
        <li>User EXEC <code>&gt;</code> → Privileged <code>#</code> (<code>enable</code>) → Global config (<code>configure terminal</code>) → Interface / VLAN sub-modes</li>
        <li><code>end</code> / Ctrl-Z returns to privileged EXEC; <code>exit</code> steps up one mode</li>
      </ul></section>
    </div>
    <p className="section-note">This is a Cisco-like teaching CLI, not Cisco IOS. Only the commands implemented by the deterministic engine are listed.</p>
  </WorkspaceDialog>;
}

function AboutDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="About SimulatorNet" eyebrow="Deterministic network lab" onClose={onClose}>
    <p>SimulatorNet is an open-source, browser-based network simulator for CCNA-level labs. Switching, routing, VLAN and DHCP behaviour is reimplemented in TypeScript and runs deterministically inside a Web Worker.</p>
    <p className="section-note">The same engine re-runs headlessly on the server to grade submissions, so a browser is never trusted to report its own score.</p>
  </WorkspaceDialog>;
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return <div><Kbd>{keys}</Kbd><span>{label}</span></div>;
}

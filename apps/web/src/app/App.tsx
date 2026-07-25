import { getDeviceProfile, type LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import type { LabUiNode, SimWorkerEvent } from "@sim/sim-worker";
import { Group as PanelGroup, Panel as ResizablePanel, Separator } from "react-resizable-panels";
import {
  AlertTriangle, CheckCircle2, Command, Download, Eraser, FilePlus2, FlaskConical, FolderOpen, FolderX,
  Grid3X3, Info, Keyboard, Maximize2, PanelRight, Play, Redo2, RotateCcw, SkipForward,
  Square, SunMoon, Tag, TerminalSquare, Undo2, Wrench, X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { DevicePalette } from "../components/DevicePalette";
import { Toolbar } from "../components/Toolbar";
import type { MenuDef } from "../components/MenuBar";
import { AssignmentPanel } from "../features/assignment/AssignmentPanel";
import { DEMO_LABS, type DemoLabId } from "../fixtures/m10-demo-labs";
import {
  autoArrangeDocument,
  consoleAccessOf,
  duplicateDraftDevice,
  loadLabDocumentText,
  mergeRunningConfiguration,
  removeDraftDevice,
  removeDraftLink,
} from "../features/lab/document";
import type { LabChangeImpact } from "../features/lab/change-impact";
import { detectLabImportFormat } from "@sim/importers";
import { ImportLabWizard } from "../features/lab/ImportLabWizard";
import { InspectorPanel } from "../features/inspector/InspectorPanel";
import { DeviceWindow } from "../features/device/DeviceWindow";
import { useLaunchSession } from "../features/session/useLaunchSession";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTheme } from "../hooks/useTheme";
import {
  setDeviceIconProfile,
  useDeviceIconProfile,
} from "../hooks/useDeviceIconProfile";
import { applyTerminalAppearance, getTerminalAppearance, type TerminalAppearance } from "../features/terminal/terminal-appearance";
import { TerminalPresentation } from "../features/terminal/TerminalPresentation";
import { isTopologyEditable, useWorkspaceStore, type ExecutionMode, type WorkspaceMode } from "../state/workspace-store";
import { Button, IconButton, Kbd } from "../ui";
import type { SimulatorClient } from "./simulator-client";

const TopologyCanvas = lazy(() => import("../features/topology/TopologyCanvas"));
const BottomDock = lazy(() => import("../features/dock/BottomDock"));
const STEP_EXPLANATION_KEY = "simulatornet.stepModeExplained";

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

function draftDeviceNode(document: LabDocument, deviceId: string): LabUiNode | undefined {
  const node = document.topology.nodes.find((candidate) => candidate.id === deviceId);
  if (!node) return undefined;
  const configuration = document.configurations[deviceId];
  const configuredInterfaces = configuration?.interfaces ?? [];
  return {
    id: node.id,
    type: node.kind,
    hostname: configuration?.hostname ?? node.name ?? node.id,
    position: node.position ?? { x: 0, y: 0 },
    status: "down",
    interfaces: node.interfaces.map((iface, index) => {
      const configured = configuredInterfaces.find((candidate) => candidate.id === iface.id);
      let ipAddress: string | undefined;
      let mode: "access" | "trunk" | "routed" | undefined;
      if (configuration?.kind === "pc" && index === 0) ipAddress = configuration.ipv4?.address;
      if (configuration?.kind === "traffic-generator" && index === 0) ipAddress = configuration.ipv4?.address;
      if (configuration?.kind === "server") ipAddress = configuration.interfaces.find((candidate) => candidate.id === iface.id)?.ipv4?.address;
      if (configuration?.kind === "router" || configuration?.kind === "firewall" || configuration?.kind === "cloud") {
        ipAddress = configuration.interfaces.find((candidate) => candidate.id === iface.id)?.ipv4?.address;
      }
      if (configuration?.kind === "l2-switch") mode = configuration.interfaces.find((candidate) => candidate.id === iface.id)?.mode;
      if (configuration?.kind === "l3-switch") {
        const l3 = configuration.interfaces.find((candidate) => candidate.id === iface.id);
        mode = l3?.mode;
        if (l3?.mode === "routed") ipAddress = l3.ipv4?.address;
      }
      return {
        id: iface.id,
        adminUp: !(configured?.shutdown ?? false),
        operationalUp: false,
        ipAddress,
        mode,
      };
    }),
  };
}

export function App({ client }: AppProps) {
  const workspace = useWorkspaceStore();
  const compact = useMediaQuery("(max-width: 999px)");
  const theme = useTheme();
  const deviceIconProfile = useDeviceIconProfile();
  const [terminalAppearance, setTerminalAppearanceState] = useState<TerminalAppearance>(getTerminalAppearance());
  const chooseTerminalAppearance = (id: TerminalAppearance) => { applyTerminalAppearance(id); setTerminalAppearanceState(id); };
  const launchSession = useLaunchSession();
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [labInfoOpen, setLabInfoOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | undefined>(undefined);
  const [cliCommandsOpen, setCliCommandsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [demoLabOpen, setDemoLabOpen] = useState(false);
  const [stepExplanationOpen, setStepExplanationOpen] = useState(false);
  const [packetModesOpen, setPacketModesOpen] = useState(false);
  const [validation, setValidation] = useState<string>();
  const [pendingMode, setPendingMode] = useState<WorkspaceMode>();
  const [deviceWindowId, setDeviceWindowId] = useState<string>();
  const dismissStepExplanation = useCallback(() => {
    window.localStorage.setItem(STEP_EXPLANATION_KEY, "true");
    setStepExplanationOpen(false);
  }, []);

  useEffect(() => client.onEvent((event: SimWorkerEvent) => {
    if (event.type === "LAB_READY" || event.type === "STATE_CHANGED") workspace.setSnapshot(event.snapshot);
    if (event.type === "TRACE_BATCH") workspace.appendTraces(event.events);
    if (event.type === "RUNTIME_WARNING") workspace.replaceRuntimeWarnings(event.warnings.map((warning) => warning.message));
    if (event.type === "RUNTIME_ERROR") {
      workspace.setError(event.error.message, "worker");
      workspace.setDockTab("problems");
    }
  }), [client, workspace.appendTraces, workspace.replaceRuntimeWarnings, workspace.setDockTab, workspace.setError, workspace.setSnapshot]);

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
    workspace.replaceDraft(canonical);
    workspace.setSnapshot(ready);
    workspace.selectNode(undefined);
    workspace.selectLink(undefined);
    workspace.setInspectorOpen(false);
    workspace.setMode(initialMode);
    // A freshly loaded lab in simulate mode is running; a new/edit lab is stopped.
    workspace.setPowerState(initialMode === "simulate" ? "running" : "stopped");
    window.requestAnimationFrame(() => workspace.requestFit());
  };

  const loadDemo = (id: DemoLabId) => {
    const demo = DEMO_LABS.find((candidate) => candidate.id === id);
    if (!demo) return;
    setDemoLabOpen(false);
    void initialize(demo.document).catch((error) => reportError(error, "validation"));
  };
  const newLab = () => void initialize(EMPTY_LAB, "edit").catch((error) => reportError(error, "validation"));
  const loadFile = (file: File) => void (async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const detection = detectLabImportFormat({ filename: file.name, bytes });
      // A .json file is native intent: use the native loader so JSON/validation
      // errors are reported directly. Foreign formats go through the wizard.
      const nativeIntent = detection.format === "simulatornet"
        || (detection.format === "unknown" && file.name.toLowerCase().endsWith(".json"));
      if (nativeIntent) {
        await initialize(loadLabDocumentText(new TextDecoder().decode(bytes)));
      } else {
        setImportFile(file);
      }
    } catch (error) { reportError(error, "validation"); }
  })();
  const importLab = () => document.getElementById("load-lab-file")?.click();
  const closeLab = () => {
    if (workspace.unsaved) setConfirmClose(true);
    else workspace.reset();
  };

  const exportLab = useCallback((fileName?: string) => void (async () => {
    const draft = useWorkspaceStore.getState().draft;
    if (!draft) return;
    const running = await client.request({ type: "SERIALIZE_LAB" });
    const merged = mergeRunningConfiguration(running, draft);
    useWorkspaceStore.getState().markSaved(merged);
    downloadLabDocument(merged, fileName);
  })().catch(reportError), [client, reportError]);
  const save = useCallback(() => exportLab(), [exportLab]);

  const rebuild = useCallback(async (nextMode: WorkspaceMode = "simulate") => {
    const state = useWorkspaceStore.getState();
    if (!state.draft) return;
    // Starting (or applying into) a running data plane rebuilds the worker.
    if (nextMode === "simulate") state.setPowerState("starting");
    try {
      const running = await client.request({ type: "SERIALIZE_LAB" });
      const merged = mergeRunningConfiguration(running, state.draft);
      const ready = await client.request({ type: "REBUILD_LAB", document: merged });
      const current = useWorkspaceStore.getState();
      current.acceptTopology(merged);
      current.setSnapshot(ready);
      current.clearTraces();
      current.setMode(nextMode);
      current.setPowerState(nextMode === "simulate" ? "running" : "stopped");
      setConfirmApply(false);
      setPendingMode(undefined);
    } catch (error) {
      useWorkspaceStore.getState().setPowerState("error");
      throw error;
    }
  }, [client]);

  const changeMode = (mode: WorkspaceMode) => {
    if (!workspace.snapshot || mode === workspace.mode) return;
    if (mode === "edit") {
      // Stop: preserve structured configuration + editor positions, then clear
      // the transient runtime (ARP/MAC/leases/traces/virtual time) and unlock.
      useWorkspaceStore.getState().setPowerState("stopping");
      void client.request({ type: "SERIALIZE_LAB" }).then(async (running) => {
        const draft = useWorkspaceStore.getState().draft;
        if (draft) useWorkspaceStore.getState().synchronizeConfiguration(mergeRunningConfiguration(running, draft));
        await client.request({ type: "RESET_RUNTIME" }).catch(() => undefined);
        const current = useWorkspaceStore.getState();
        current.clearTraces();
        current.setMode("edit");
        current.setPowerState("stopped");
      }).catch((error) => { useWorkspaceStore.getState().setPowerState("error"); reportError(error); });
      return;
    }
    void rebuild("simulate").catch(reportError);
  };

  const changeExecutionMode = useCallback((mode: ExecutionMode) => {
    void client.request({ type: "SET_EXECUTION_MODE", mode }).then((result) => {
      const state = useWorkspaceStore.getState();
      state.setExecutionMode(mode);
      state.setSnapshot(result.snapshot);
      state.setDockTab("packet-trace");
      if (mode === "step" && window.localStorage.getItem(STEP_EXPLANATION_KEY) !== "true") {
        setStepExplanationOpen(true);
      }
    }).catch(reportError);
  }, [client, reportError]);

  const run = useCallback(() => void client.request({ type: "RUN_UNTIL_IDLE" }).then((result) => useWorkspaceStore.getState().setSnapshot(result.snapshot)).catch(reportError), [client, reportError]);
  const step = useCallback(() => void client.request({ type: "STEP_NEXT_EVENT" }).then((result) => useWorkspaceStore.getState().setSnapshot(result.snapshot)).catch(reportError), [client, reportError]);
  const reset = () => void client.request({ type: "RESET_RUNTIME" }).then((ready) => { workspace.clearTraces(); workspace.setSnapshot(ready); }).catch(reportError);

  // Structural connectivity is locked while running; presentation and typed
  // configuration changes remain live without rebuilding the worker.
  const updateDraft = (document: LabDocument, impact: LabChangeImpact) => {
    const state = useWorkspaceStore.getState();
    if (impact === "structural" && !isTopologyEditable(state.powerState)) {
      reportError("Topology connectivity is locked while the lab is running. Layout, labels and notes can still be edited.", "validation");
      return;
    }
    try {
      state.applyDraft(document, impact);
    } catch (error) {
      reportError(error, "validation");
    }
  };

  const startLab = () => {
    const state = useWorkspaceStore.getState();
    if (!state.snapshot) return;
    if (state.powerState === "running" || state.powerState === "starting") {
      reportError("The lab is already running.", "validation");
      return;
    }
    changeMode("simulate");
  };

  const performStop = () => { setConfirmStop(false); changeMode("edit"); };

  const stopLab = () => {
    const state = useWorkspaceStore.getState();
    if (state.powerState === "stopped" || state.powerState === "stopping") {
      reportError("The lab is already stopped.", "validation");
      return;
    }
    const hasTransientState = (state.snapshot?.virtualTime ?? 0) > 0 || state.traces.length > 0;
    if (hasTransientState) setConfirmStop(true);
    else performStop();
  };
  const deleteSelection = useCallback(() => {
    const state = useWorkspaceStore.getState();
    if (!state.draft || state.mode !== "edit" || !isTopologyEditable(state.powerState)) return;
    if (state.selectedNodeId) {
      const removedDeviceId = state.selectedNodeId;
      state.applyDraft(removeDraftDevice(state.draft, removedDeviceId), "structural");
      state.closeTerminal(removedDeviceId);
      setDeviceWindowId((current) => current === removedDeviceId ? undefined : current);
      state.selectNode(undefined);
    } else if (state.selectedLinkId) {
      state.applyDraft(removeDraftLink(state.draft, state.selectedLinkId), "structural");
      state.selectLink(undefined);
    }
  }, []);
  const duplicateSelected = () => {
    const state = useWorkspaceStore.getState();
    if (state.draft && state.mode === "edit" && state.selectedNodeId) {
      state.applyDraft(duplicateDraftDevice(state.draft, state.selectedNodeId), "structural");
    }
  };
  const arrange = () => {
    if (workspace.draft) workspace.applyDraft(autoArrangeDocument(workspace.draft), "presentation");
    workspace.requestFit();
  };
  const openTerminal = (deviceId: string) => {
    if (useWorkspaceStore.getState().mode !== "simulate") {
      reportError("CLI is available in Simulate mode", "cli");
      return;
    }
    const node = useWorkspaceStore.getState().snapshot?.nodes.find((candidate) => candidate.id === deviceId);
    if (!node || !getDeviceProfile(node.type).cliProfile) {
      reportError(`${node ? getDeviceProfile(node.type).displayName : "Device"} does not provide an interactive CLI`, "cli");
      return;
    }
    workspace.openTerminal(deviceId);
  };
  const openTerminalFromMenu = () => {
    const state = useWorkspaceStore.getState();
    if (state.mode === "simulate") {
      const target = state.selectedNodeId
        ?? state.snapshot?.nodes.find((node) => getDeviceProfile(node.type).cliProfile)?.id;
      if (target) { openTerminal(target); return; }
    }
    workspace.setDockTab("terminal");
    workspace.setTerminalVisible(true);
  };
  const showTerminal = () => {
    const state = useWorkspaceStore.getState();
    if (state.terminalTabs.length === 0) openTerminalFromMenu();
    else {
      state.setTerminalVisible(true);
      if (state.terminalPresentationMode === "docked") state.setDockTab("terminal");
    }
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
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const terminalFocused = event.target instanceof HTMLElement
        && Boolean(event.target.closest(".terminal-presentation"));
      if (commandKey && event.code === "Backquote") {
        if (!useWorkspaceStore.getState().snapshot) return;
        event.preventDefault();
        const state = useWorkspaceStore.getState();
        if (event.shiftKey) {
          state.setTerminalPresentationMode(state.terminalPresentationMode === "floating" ? "docked" : "floating");
        } else if (state.terminalVisible) {
          state.setTerminalVisible(false);
        } else {
          showTerminal();
        }
        return;
      }
      if (commandKey && event.altKey && event.key === "Enter") {
        const state = useWorkspaceStore.getState();
        if (!state.snapshot || state.terminalTabs.length === 0) return;
        event.preventDefault();
        if (state.terminalPresentationMode === "maximized") state.restoreTerminalPresentation();
        else state.setTerminalPresentationMode("maximized");
        return;
      }
      if (commandKey && key === "w" && terminalFocused) {
        event.preventDefault();
        const state = useWorkspaceStore.getState();
        if (state.activeTerminalDeviceId) state.closeTerminal(state.activeTerminalDeviceId);
        return;
      }
      if (event.key === "Escape" && useWorkspaceStore.getState().terminalPresentationMode === "maximized") {
        event.preventDefault();
        useWorkspaceStore.getState().restoreTerminalPresentation();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (commandKey && key === "n") { event.preventDefault(); newLab(); }
      else if (commandKey && key === "o") { event.preventDefault(); importLab(); }
      else if (commandKey && event.shiftKey && key === "s") { event.preventDefault(); setSaveAsOpen(true); }
      else if (commandKey && key === "s") { event.preventDefault(); save(); }
      else if (commandKey && key === "z" && event.shiftKey) { event.preventDefault(); useWorkspaceStore.getState().redo(); }
      else if (commandKey && key === "z") { event.preventDefault(); useWorkspaceStore.getState().undo(); }
      else if (commandKey && key === "y") { event.preventDefault(); useWorkspaceStore.getState().redo(); }
      else if (commandKey && !event.altKey && event.key === "Enter") { event.preventDefault(); run(); }
      else if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
      else if (key === "f") workspace.requestFit();
      else if (event.key === "?") setShortcutsOpen(true);
      else if (event.key === "Escape") {
        setShortcutsOpen(false); setLabInfoOpen(false); setCliCommandsOpen(false); setAboutOpen(false);
        setSaveAsOpen(false); setDemoLabOpen(false); setStepExplanationOpen(false); setPacketModesOpen(false); setConfirmApply(false); setConfirmStop(false); setValidation(undefined);
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
  const editMode = workspace.mode === "edit";
  const hasSelection = Boolean(workspace.selectedNodeId || workspace.selectedLinkId);
  const powerState = workspace.powerState;
  const labRunning = powerState === "running";
  const labStopped = powerState === "stopped";
  const powerBusy = powerState === "starting" || powerState === "stopping";

  const menus: MenuDef[] = [
    { id: "file", label: "File", items: [
      { id: "file-new", label: "New Lab", shortcut: "Ctrl N", icon: <FilePlus2 size={14} />, onSelect: newLab },
      { id: "file-open", label: "Open / Import Lab…", shortcut: "Ctrl O", icon: <FolderOpen size={14} />, onSelect: importLab },
      { id: "file-demo", label: "Load Demo Lab", icon: <FlaskConical size={14} />, onSelect: () => setDemoLabOpen(true) },
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
      { id: "view-icons", label: "Device Icon Style", submenu: [
        { id: "icons-classic", label: "Classic Lab", checked: deviceIconProfile === "classic", onSelect: () => setDeviceIconProfile("classic") },
        { id: "icons-education", label: "Education Flat", checked: deviceIconProfile === "education", onSelect: () => setDeviceIconProfile("education") },
        { id: "icons-minimal", label: "Minimal Network", checked: deviceIconProfile === "minimal", onSelect: () => setDeviceIconProfile("minimal") },
      ] },
      { id: "view-terminal-appearance", label: "Terminal Appearance", submenu: [
        { id: "term-appliance", label: "Appliance Console", checked: terminalAppearance === "appliance", onSelect: () => chooseTerminalAppearance("appliance") },
        { id: "term-modern", label: "Modern Dark", checked: terminalAppearance === "modern-dark", onSelect: () => chooseTerminalAppearance("modern-dark") },
        { id: "term-light", label: "Light Console", checked: terminalAppearance === "light", onSelect: () => chooseTerminalAppearance("light") },
      ] },
      { id: "view-ports", label: "Port Labels", icon: <Tag size={14} />, submenu: [
        { id: "ports-always", label: "Always", checked: workspace.portLabelMode === "always", onSelect: () => workspace.setPortLabelMode("always") },
        { id: "ports-selected", label: "Selected", checked: workspace.portLabelMode === "selected", onSelect: () => workspace.setPortLabelMode("selected") },
        { id: "ports-hidden", label: "Hidden", checked: workspace.portLabelMode === "hidden", onSelect: () => workspace.setPortLabelMode("hidden") },
      ] },
      { id: "view-terminal", label: "Terminal", icon: <TerminalSquare size={14} />, submenu: [
        { id: "terminal-show", label: "Show Terminal", shortcut: "Ctrl `", disabled: !labOpen, onSelect: showTerminal },
        { id: "terminal-dock", label: "Dock at Bottom", checked: workspace.terminalPresentationMode === "docked", disabled: !labOpen, onSelect: () => workspace.setTerminalPresentationMode("docked") },
        { id: "terminal-float", label: "Float", shortcut: "Ctrl ⇧ `", checked: workspace.terminalPresentationMode === "floating", disabled: !labOpen, onSelect: () => workspace.setTerminalPresentationMode("floating") },
        { id: "terminal-maximize", label: "Maximize", shortcut: "Ctrl Alt ↵", checked: workspace.terminalPresentationMode === "maximized", disabled: !labOpen, onSelect: () => workspace.setTerminalPresentationMode("maximized") },
        { id: "terminal-hide", label: "Hide Terminal", disabled: !labOpen || !workspace.terminalVisible, onSelect: () => workspace.setTerminalVisible(false) },
      ] },
      { separator: true },
      { id: "view-theme", label: "Theme", icon: <SunMoon size={14} />, submenu: [
        { id: "theme-system", label: "System", checked: theme.preference === "system", onSelect: () => theme.setPreference("system") },
        { id: "theme-dark", label: "Dark", checked: theme.preference === "dark", onSelect: () => theme.setPreference("dark") },
        { id: "theme-light", label: "Light", checked: theme.preference === "light", onSelect: () => theme.setPreference("light") },
      ] },
    ] },
    { id: "lab", label: "Lab", items: [
      { id: "lab-start", label: "Start Lab", icon: <Play size={14} />, disabled: !ready || !labStopped || powerBusy, onSelect: startLab },
      { id: "lab-stop", label: "Stop Lab", icon: <Square size={14} />, disabled: !ready || !labRunning || powerBusy, onSelect: stopLab },
      { separator: true },
      { id: "lab-edit", label: "Edit Topology", checked: editMode, disabled: !ready, onSelect: () => changeMode("edit") },
      { id: "lab-sim", label: "Operate Topology", checked: workspace.mode === "simulate", disabled: !ready, onSelect: () => changeMode("simulate") },
      { separator: true },
      {
        id: "lab-apply",
        label: "Apply Topology",
        disabled: !workspace.pendingTopologyChanges,
        onSelect: () => { setPendingMode("edit"); setConfirmApply(true); },
      },
      { id: "lab-info", label: "Lab Information", icon: <Info size={14} />, disabled: !labOpen, onSelect: () => setLabInfoOpen(true) },
      { id: "lab-validate", label: "Validate Document", icon: <CheckCircle2 size={14} />, disabled: !labOpen, onSelect: validateDocument },
      { id: "lab-reset", label: "Reset Runtime", icon: <RotateCcw size={14} />, disabled: !simulationEnabled, onSelect: reset },
    ] },
    { id: "simulation", label: "Simulation", items: [
      { id: "sim-execution-mode", label: "Execution Mode", submenu: [
        { id: "sim-auto", label: "Auto", checked: workspace.executionMode === "auto", disabled: !ready, onSelect: () => changeExecutionMode("auto") },
        { id: "sim-step-mode", label: "Step", checked: workspace.executionMode === "step", disabled: !ready, onSelect: () => changeExecutionMode("step") },
      ] },
      { separator: true },
      { id: "sim-step", label: "Step Next Event", icon: <SkipForward size={14} />, disabled: !simulationEnabled || workspace.executionMode !== "step" || (workspace.snapshot?.queuedEvents ?? 0) === 0, onSelect: step },
      { id: "sim-run", label: "Run All Queued Events", shortcut: "Ctrl ↵", icon: <Play size={14} />, disabled: !simulationEnabled || (workspace.snapshot?.queuedEvents ?? 0) === 0, onSelect: run },
      { separator: true },
      { id: "sim-clear", label: "Clear Event List", icon: <Eraser size={14} />, disabled: !labOpen, onSelect: workspace.clearTraces },
    ] },
    { id: "tools", label: "Tools", items: [
      { id: "tools-terminal", label: "Open Terminal", icon: <TerminalSquare size={14} />, disabled: !labOpen, onSelect: openTerminalFromMenu },
      { id: "tools-arrange", label: "Auto Arrange Topology", icon: <Grid3X3 size={14} />, disabled: !editMode, onSelect: arrange },
      { id: "tools-annotations", label: "Add Diagram Annotation", disabled: !labOpen, submenu: [
        { id: "annotation-text", label: "Text", onSelect: () => workspace.setActiveTool("annotation-text") },
        { id: "annotation-rectangle", label: "Rectangle", onSelect: () => workspace.setActiveTool("annotation-rectangle") },
        { id: "annotation-ellipse", label: "Ellipse", onSelect: () => workspace.setActiveTool("annotation-ellipse") },
        { id: "annotation-line", label: "Line", onSelect: () => workspace.setActiveTool("annotation-line") },
        { id: "annotation-arrow", label: "Arrow", onSelect: () => workspace.setActiveTool("annotation-arrow") },
      ] },
      { id: "tools-validate", label: "Validate Document", icon: <CheckCircle2 size={14} />, disabled: !labOpen, onSelect: validateDocument },
      { separator: true },
      { id: "tools-cli", label: "CLI Compatibility", icon: <Wrench size={14} />, onSelect: () => setCliCommandsOpen(true) },
    ] },
    { id: "help", label: "Help", items: [
      { id: "help-packet-modes", label: "Packet Execution Modes", icon: <SkipForward size={14} />, onSelect: () => setPacketModesOpen(true) },
      { id: "help-cli", label: "CLI Commands", icon: <TerminalSquare size={14} />, onSelect: () => setCliCommandsOpen(true) },
      { id: "help-shortcuts", label: "Keyboard Shortcuts", shortcut: "?", icon: <Keyboard size={14} />, onSelect: () => setShortcutsOpen(true) },
      { id: "help-about", label: "About SimulatorNet", icon: <Info size={14} />, onSelect: () => setAboutOpen(true) },
    ] },
  ];

  const runtimeDeviceNode = deviceWindowId
    ? workspace.snapshot?.nodes.find((node) => node.id === deviceWindowId)
    : undefined;
  const openDeviceNode = runtimeDeviceNode
    ?? (deviceWindowId && workspace.draft ? draftDeviceNode(workspace.draft, deviceWindowId) : undefined);
  const topologyXs = workspace.draft?.topology.nodes.map((node) => node.position?.x ?? 0) ?? [];
  const selectedNodeX = workspace.draft?.topology.nodes.find((node) => node.id === workspace.selectedNodeId)?.position?.x;
  const topologyMidpoint = topologyXs.length > 0 ? (Math.min(...topologyXs) + Math.max(...topologyXs)) / 2 : 0;
  const inspectorSide = selectedNodeX !== undefined && selectedNodeX >= topologyMidpoint ? "left" : "right";

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
      side={inspectorSide}
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
        devicePicker={labOpen ? (
          <DevicePalette
            open={workspace.paletteOpen}
            disabled={!workspace.draft || workspace.mode !== "edit"}
            selectedKind={workspace.pendingDeviceKind}
            activeTool={workspace.activeTool}
            onOpenChange={workspace.setPaletteOpen}
            onSelectKind={workspace.setPendingDeviceKind}
            onTool={workspace.setActiveTool}
          />
        ) : undefined}
        labTitle={workspace.snapshot?.title}
        sessionScope={launchSession.state.status === "authenticated" ? "Organization" : "Local Lab"}
        workerStatus={workspace.workerStatus}
        engineState={workspace.snapshot?.engineState}
        ready={ready}
        unsaved={workspace.unsaved}
        powerState={powerState}
        mode={workspace.mode}
        executionMode={workspace.executionMode}
        activeTool={workspace.activeTool}
        canUndo={workspace.past.length > 0}
        canRedo={workspace.future.length > 0}
        canDelete={hasSelection}
        session={launchSession.state.status === "authenticated" ? launchSession.state.identity : undefined}
        sessionPending={launchSession.state.status === "checking" || launchSession.state.status === "exchanging"}
        onModeChange={changeMode}
        onTool={workspace.setActiveTool}
        onNew={newLab}
        onOpen={importLab}
        onSave={save}
        onUndo={workspace.undo}
        onRedo={workspace.redo}
        onDelete={deleteSelection}
        onZoomIn={workspace.requestZoomIn}
        onZoomOut={workspace.requestZoomOut}
        onFit={workspace.requestFit}
        onOpenPacketTrace={() => workspace.setDockTab("packet-trace")}
        onStartLab={startLab}
        onStopLab={stopLab}
        onLogout={() => void launchSession.logout().catch((error) => reportError(error, "validation"))}
      />
      <input id="load-lab-file" className="visually-hidden" type="file" accept="application/json,.json,.unl,.zip,.gns3,.gns3project,.yml,.yaml,.virl,.pkt,.pka" onChange={(event) => { const file = event.target.files?.[0]; if (file) loadFile(file); event.target.value = ""; }} />
      {launchSession.state.status === "authenticated" && <AssignmentPanel client={client} document={workspace.draft} onOpenDocument={(document) => initialize(document, "simulate")} onError={(message) => reportError(message, "validation")} />}
      {launchSession.state.status === "exchanging" && <div className="launch-status" role="status">Exchanging secure launch code…</div>}
      {launchSession.state.status === "error" && <div className="workspace-error" role="alert"><AlertTriangle size={14} /><span>{launchSession.state.message}</span></div>}
      {validation && <div className="workspace-notice" role="status"><CheckCircle2 size={14} /><span>{validation}</span><IconButton label="Dismiss notice" icon={<X size={13} />} onClick={() => setValidation(undefined)} /></div>}
      {workspace.error && <div className="workspace-error" role="alert"><AlertTriangle size={14} /><span>{workspace.error}</span><button type="button" onClick={() => workspace.setDockTab("problems")}>View problems</button><IconButton label="Dismiss error" icon={<X size={13} />} onClick={() => workspace.setError(undefined)} /></div>}
      {workspace.pendingTopologyChanges && workspace.mode === "edit" && (
        <div className="pending-banner">
          <span>Pending topology changes</span>
          <Button
            size="sm"
            variant="primary"
            title="Rebuild the running model after adding, removing or reconnecting devices."
            onClick={() => { setPendingMode("edit"); setConfirmApply(true); }}
          >
            Apply Topology
          </Button>
        </div>
      )}
      <div className="workspace-body">
        <PanelGroup orientation="vertical" className="workspace-resizable" id="workspace-layout">
          <ResizablePanel id="workspace-main" minSize="300px" defaultSize="76%">
            <div className="main-workspace">
              <Suspense fallback={<CanvasLoading />}><TopologyCanvas {...topologyProps()} /></Suspense>
              {inspector}
            </div>
          </ResizablePanel>
          {labOpen && <>
            <Separator className="resize-handle resize-handle--horizontal" />
            <ResizablePanel
              id="bottom-dock"
              minSize="220px"
              maxSize="48%"
              defaultSize={`${workspace.terminalDockHeight}px`}
            >
              <Suspense fallback={<DockLoading />}>
                <BottomDock
                  tab={workspace.dockTab}
                  snapshot={workspace.snapshot}
                  traces={workspace.traces}
                  problems={workspace.problems}
                  terminalTabs={workspace.terminalTabs}
                  terminalPresentationMode={workspace.terminalPresentationMode}
                  terminalVisible={workspace.terminalVisible}
                  executionMode={workspace.executionMode}
                  onTab={workspace.setDockTab}
                  onClearProblems={workspace.clearProblems}
                  onExecutionModeChange={changeExecutionMode}
                  onStep={step}
                  onRunAll={run}
                  onClearTraces={workspace.clearTraces}
                />
              </Suspense>
            </ResizablePanel>
          </>}
        </PanelGroup>
        {labOpen && <TerminalPresentation
          client={client}
          tabs={workspace.terminalTabs}
          activeDeviceId={workspace.activeTerminalDeviceId}
          nodes={workspace.snapshot?.nodes ?? []}
          workspaceMode={workspace.mode}
          theme={theme.resolved}
          appearance={terminalAppearance}
          presentationMode={workspace.terminalPresentationMode}
          visible={workspace.terminalVisible}
          minimized={workspace.terminalMinimized}
          floatingBounds={workspace.terminalFloatingBounds}
          consoleAccessFor={(deviceId) => workspace.draft ? consoleAccessOf(workspace.draft, deviceId) : undefined}
          onActivate={workspace.setActiveTerminal}
          onCloseTab={workspace.closeTerminal}
          onReorder={workspace.reorderTerminal}
          onCloseOthers={workspace.closeOtherTerminals}
          onCloseToRight={workspace.closeTerminalsToRight}
          onPresentationMode={workspace.setTerminalPresentationMode}
          onRestore={workspace.restoreTerminalPresentation}
          onVisible={workspace.setTerminalVisible}
          onMinimized={workspace.setTerminalMinimized}
          onFloatingBounds={workspace.setTerminalFloatingBounds}
          onDockHeight={workspace.setTerminalDockHeight}
          onError={reportCliError}
        />}
      </div>
      <footer className="workspace-footer"><span>Workspace: <strong>{workspace.mode === "edit" ? "Edit" : "Operate"}</strong></span><span>Virtual time <code>{((workspace.snapshot?.virtualTime ?? 0) / 1_000_000).toFixed(3)} ms</code></span><span>{workspace.snapshot?.nodes.length ?? 0} devices</span><span className="workspace-footer__right">Schema v{workspace.draft?.schemaVersion ?? 1} · deterministic runtime</span></footer>

      {confirmApply && <WorkspaceDialog title="Apply topology changes?" eyebrow="Runtime rebuild" onClose={() => { setConfirmApply(false); setPendingMode(undefined); }}>
        <p>Applying the draft serializes the current device configuration, merges topology positions and rebuilds the worker runtime. Volatile ARP, MAC and event state will reset.</p>
        <div className="dialog-actions"><Button variant="ghost" onClick={() => { setConfirmApply(false); setPendingMode(undefined); }}>Cancel</Button><Button variant="primary" onClick={() => void rebuild(pendingMode ?? "edit").catch(reportError)}>Apply Topology</Button></div>
      </WorkspaceDialog>}
      {confirmStop && <WorkspaceDialog title="Stop this lab?" eyebrow="Power lifecycle" onClose={() => setConfirmStop(false)}>
        <p>Topology editing will be unlocked. Transient runtime state, active connections, learned tables and packet trace will be cleared. Device configuration will be preserved.</p>
        <div className="dialog-actions"><Button variant="ghost" onClick={() => setConfirmStop(false)}>Cancel</Button><Button variant="danger" onClick={performStop}>Stop Lab</Button></div>
      </WorkspaceDialog>}
      {confirmClose && <WorkspaceDialog title="Close laboratory?" eyebrow="Unsaved document" onClose={() => setConfirmClose(false)}>
        <p>The current laboratory has unsaved changes. Closing it will discard the current document.</p>
        <div className="dialog-actions"><Button variant="ghost" onClick={() => setConfirmClose(false)}>Keep Editing</Button><Button variant="danger" onClick={() => { setConfirmClose(false); workspace.reset(); }}>Discard &amp; Close</Button></div>
      </WorkspaceDialog>}
      {saveAsOpen && <SaveAsDialog defaultName={workspace.draft?.id ?? "lab"} onClose={() => setSaveAsOpen(false)} onSave={(name) => { exportLab(name); setSaveAsOpen(false); }} />}
      {demoLabOpen && <DemoLabDialog onClose={() => setDemoLabOpen(false)} onLoad={loadDemo} />}
      {importFile && <ImportLabWizard
        file={importFile}
        onCancel={() => setImportFile(undefined)}
        onImported={(document) => { setImportFile(undefined); void initialize(document, "edit").catch((error) => reportError(error, "validation")); }}
        onError={(message) => reportError(message, "validation")}
      />}
      {labInfoOpen && workspace.draft && <LabInformationDialog document={workspace.draft} mode={workspace.mode} onClose={() => setLabInfoOpen(false)} />}
      {cliCommandsOpen && <CliCommandsDialog onClose={() => setCliCommandsOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {packetModesOpen && <PacketExecutionHelpDialog onClose={() => setPacketModesOpen(false)} />}
      {stepExplanationOpen && <WorkspaceDialog title="Step mode" eyebrow="Packet execution" onClose={dismissStepExplanation}>
        <p>Step mode lets you inspect ARP, ICMP, TCP and other network events one at a time.</p>
        <p>Your device configurations are unchanged. Switch back to Auto for normal operation.</p>
        <div className="dialog-actions"><Button variant="primary" onClick={dismissStepExplanation}>Got it</Button></div>
      </WorkspaceDialog>}
      {shortcutsOpen && <WorkspaceDialog title="Keyboard shortcuts" eyebrow="Quick workflow" onClose={() => setShortcutsOpen(false)}>
        <div className="shortcut-list">
          <Shortcut keys="Ctrl / Cmd + N" label="New lab" />
          <Shortcut keys="Ctrl / Cmd + O" label="Open / import lab" />
          <Shortcut keys="Ctrl / Cmd + S" label="Save / export JSON" />
          <Shortcut keys="Ctrl / Cmd + Shift + S" label="Save As…" />
          <Shortcut keys="Ctrl / Cmd + Z" label="Undo topology edit" />
          <Shortcut keys="Ctrl / Cmd + Enter" label="Run all queued events" />
          <Shortcut keys="Delete" label="Delete selection in Edit mode" />
          <Shortcut keys="F" label="Fit topology" />
          <Shortcut keys="Ctrl + L" label="Clear focused terminal" />
          <Shortcut keys="Ctrl / Cmd + `" label="Show or hide terminal" />
          <Shortcut keys="Ctrl / Cmd + Shift + `" label="Float or dock terminal" />
          <Shortcut keys="Ctrl / Cmd + Alt + Enter" label="Maximize or restore terminal" />
          <Shortcut keys="Ctrl / Cmd + PageUp / PageDown" label="Previous or next terminal tab" />
          <Shortcut keys="Ctrl / Cmd + W" label="Close focused terminal tab" />
          <Shortcut keys="Escape" label="Close menus and dialogs" />
        </div>
      </WorkspaceDialog>}
      {deviceWindowId && workspace.draft && openDeviceNode && <DeviceWindow
        client={client}
        document={workspace.draft}
        node={openDeviceNode}
        powerState={workspace.powerState}
        runtimeAvailable={Boolean(runtimeDeviceNode)}
        onOpenTerminal={(deviceId) => {
          openTerminal(deviceId);
          setDeviceWindowId(undefined);
        }}
        onConfigurationChanged={(next, runtimeSynchronized) => {
          const state = useWorkspaceStore.getState();
          if (!state.draft) return;
          if (runtimeSynchronized) state.synchronizeConfiguration(mergeRunningConfiguration(next, state.draft));
          else state.applyDraft(next, "configuration");
        }}
        onError={reportInspectionError}
        onClose={() => setDeviceWindowId(undefined)}
      />}
    </div>
  );

  function topologyProps() {
    return {
      document: workspace.draft,
      snapshot: workspace.snapshot,
      mode: workspace.mode,
      activeTool: workspace.activeTool,
      pendingDeviceKind: workspace.pendingDeviceKind,
      selectedNodeId: workspace.selectedNodeId,
      selectedLinkId: workspace.selectedLinkId,
      terminalTabs: workspace.terminalTabs,
      portLabelMode: workspace.portLabelMode,
      fitRequest: workspace.fitRequest,
      zoomResetRequest: workspace.zoomResetRequest,
      zoomInRequest: workspace.zoomInRequest,
      zoomOutRequest: workspace.zoomOutRequest,
      onSelectNode: (id: string | undefined) => { workspace.selectNode(id); if (id) workspace.setInspectorOpen(true); },
      onSelectLink: workspace.selectLink,
      onOpenTerminal: openTerminal,
      onOpenDevice: setDeviceWindowId,
      onInspect: (id: string) => { workspace.selectNode(id); workspace.setInspectorOpen(true); },
      onPlacedDevice: () => workspace.setPendingDeviceKind(undefined),
      onActiveTool: workspace.setActiveTool,
      onPortLabelMode: workspace.setPortLabelMode,
      onChange: updateDraft,
      onError: (message: string) => reportError(message, "validation"),
      onLoadDemo: () => setDemoLabOpen(true),
      onNewLab: newLab,
      onImportLab: importLab,
    };
  }
}

function DemoLabDialog({ onClose, onLoad }: { onClose(): void; onLoad(id: DemoLabId): void }) {
  return <WorkspaceDialog title="Load demo laboratory" eyebrow="Deterministic examples" onClose={onClose}>
    <p>Choose a focused topology. Each demo uses the same browser and server simulation core.</p>
    <div className="demo-lab-list">
      {DEMO_LABS.map((demo) => <button key={demo.id} type="button" onClick={() => onLoad(demo.id)}>
        <FlaskConical size={16} aria-hidden="true" />
        <span><strong>{demo.label}</strong><small>{demo.document.description}</small></span>
      </button>)}
    </div>
  </WorkspaceDialog>;
}

function CanvasLoading() {
  return <div className="panel-loading"><Command size={24} /><span>Loading topology canvas…</span></div>;
}

function DockLoading() {
  return <div className="panel-loading"><Command size={20} /><span>Loading workspace panel…</span></div>;
}

function WorkspaceDialog({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose(): void; children: React.ReactNode }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-label={title}><header><div><p>{eyebrow}</p><h2>{title}</h2></div><IconButton label="Close dialog" icon={<X size={15} />} onClick={onClose} /></header><div className="workspace-dialog__body">{children}</div></section></div>;
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

function PacketExecutionHelpDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="Packet execution modes" eyebrow="Deterministic event processing" onClose={onClose}>
    <div className="cli-command-reference">
      <section>
        <h3>Auto</h3>
        <p>Processes all network events required to complete an action automatically. Use this mode for normal configuration and connectivity testing.</p>
      </section>
      <section>
        <h3>Step</h3>
        <p>Pauses queued network events so you can inspect how packets move through the topology. Use Step to process the next event or Run All to finish the operation.</p>
      </section>
    </div>
    <p className="section-note">Both modes use deterministic virtual time. They do not change performance speed and do not use real wall-clock time.</p>
  </WorkspaceDialog>;
}

function CliCommandsDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="CLI commands" eyebrow="Implemented surface" onClose={onClose}>
    <div className="cli-command-reference">
      <section><h3>PC / Server</h3><ul>
        <li><code>ping &lt;ip-or-hostname&gt;</code> — send ICMP echoes to a destination</li>
        <li><code>ipconfig</code> — show interface addressing and DHCP lease</li>
        <li><code>ipconfig /all</code>, <code>ipconfig /renew</code>, <code>ipconfig /release</code></li>
        <li><code>tracert &lt;ip-or-hostname&gt;</code>, <code>arp -a</code>, <code>netstat</code></li>
        <li><code>nslookup &lt;hostname&gt; [dns-server]</code> — resolve an A record</li>
        <li><code>sim http get &lt;url&gt;</code>, <code>sim tftp get &lt;server-ip&gt; &lt;filename&gt;</code></li>
        <li><code>sim ntp query &lt;server-ip&gt;</code>, <code>sim show clock</code></li>
        <li><code>sim syslog send &lt;server-ip&gt; &lt;severity&gt; &lt;message&gt;</code></li>
        <li><code>sim show udp sockets</code>, <code>sim show tcp connections</code></li>
      </ul></section>
      <section><h3>Server inspection</h3><ul>
        <li><code>sim show services</code> — enabled state and listening ports</li>
        <li><code>sim show dns</code>, <code>sim show http</code>, <code>sim show tftp</code>, <code>sim show syslog</code></li>
      </ul></section>
      <section><h3>Bridge / Switch</h3><ul>
        <li><code>show mac address-table</code> — display learned forwarding entries</li>
        <li><code>enable</code> / <code>configure terminal</code> — enter privileged / global config</li>
        <li><code>vlan &lt;id&gt;</code>, <code>name &lt;text&gt;</code> — define VLANs</li>
        <li><code>interface &lt;id&gt;</code>, <code>switchport mode access|trunk</code>, <code>switchport access vlan &lt;id&gt;</code></li>
        <li><code>show vlan brief</code>, <code>show mac address-table</code>, <code>show interfaces</code></li>
      </ul></section>
      <section><h3>L3 Switch</h3><ul>
        <li><code>interface vlan &lt;id&gt;</code> — configure an SVI</li>
        <li><code>no switchport</code> — convert a physical port to routed mode</li>
        <li><code>ip routing</code> — enable IPv4 forwarding between SVIs and routed ports</li>
        <li><code>show ip interface brief</code>, <code>show ip route</code></li>
      </ul></section>
      <section><h3>Router</h3><ul>
        <li><code>interface &lt;id&gt;</code>, <code>ip address &lt;ip&gt; &lt;mask&gt;</code>, <code>no shutdown</code></li>
        <li><code>interface &lt;id&gt;.&lt;vlan&gt;</code>, <code>encapsulation dot1q &lt;vlan&gt;</code> — router-on-a-stick</li>
        <li><code>ip route &lt;net&gt; &lt;mask&gt; &lt;next-hop&gt;</code> — static routes</li>
        <li><code>show ip interface brief</code>, <code>show ip route</code></li>
      </ul></section>
      <section><h3>Modes</h3><ul>
        <li>User EXEC <code>&gt;</code> → Privileged <code>#</code> (<code>enable</code>) → Global config (<code>configure terminal</code>) → Interface / VLAN sub-modes</li>
        <li><code>end</code> returns to privileged EXEC; <code>exit</code> steps up one mode</li>
      </ul></section>
    </div>
    <p className="section-note">SimulatorNet implements a deterministic educational subset of Cisco IOS-like network CLI and Packet Tracer-style host tools. Only implemented commands are listed.</p>
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

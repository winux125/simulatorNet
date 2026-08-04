import { getDeviceProfile, type LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import type { LabConfigurationStatusView, LabUiNode, SimWorkerEvent } from "@sim/sim-worker";
import {
  Group as PanelGroup,
  Panel as ResizablePanel,
  Separator,
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";
import {
  AlertTriangle, Cable, CheckCircle2, ClipboardPaste, Clock3, Command, Download, Eraser, FilePlus2, FlaskConical, FolderOpen, FolderX,
  FileDown, FileUp,
  Grid3X3, Info, Keyboard, Maximize2, Move, PanelBottom, PanelRight, Play, Redo2, RotateCcw, Save, SkipForward,
  Square, SunMoon, Tag, TerminalSquare, Type, Undo2, Wrench, X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { DeviceIcon } from "../components/DeviceIcon";
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
import {
  detectLabImportFormat,
  deviceConfigurationProjections,
  readSimulatorNetLabPackage,
  SIMLAB_EXTENSION,
  writeDeviceConfigurationArchive,
  writeSimulatorNetLabPackage,
} from "@sim/importers";
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
import {
  bottomPanelAnnouncement,
  MIN_BOTTOM_PANEL_HEIGHT,
  type BottomPanelState,
} from "../features/dock/bottom-panel-state";
import {
  createDefaultWorkspacePanelLayout,
  LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY,
  persistWorkspacePanelLayout,
  readWorkspacePanelLayout,
  WORKSPACE_BOTTOM_PANEL_ID,
  WORKSPACE_BOTTOM_SEPARATOR_ID,
  WORKSPACE_MAIN_PANEL_ID,
  WORKSPACE_PANEL_CONSTRAINTS,
  WORKSPACE_PANEL_GROUP_ID,
  WORKSPACE_PANEL_IDS,
} from "../features/layout/workspace-panel-layout";
import { applyTerminalAppearance, getTerminalAppearance, type TerminalAppearance } from "../features/terminal/terminal-appearance";
import { persistConfirmMultilinePaste, readConfirmMultilinePaste, TERMINAL_PASTE_LIMITS } from "../features/terminal/terminal-paste";
import { TerminalPresentation } from "../features/terminal/TerminalPresentation";
import { isTopologyEditable, useWorkspaceStore, type DockTab, type ExecutionMode, type WorkspaceMode, type WorkspaceView } from "../state/workspace-store";
import { Button, IconButton, Kbd } from "../ui";
import type { SimulatorClient } from "./simulator-client";

const TopologyCanvas = lazy(() => import("../features/topology/TopologyCanvas"));
const PhysicalWorkspace = lazy(() => import("../features/physical/PhysicalWorkspace"));
const BottomDock = lazy(() => import("../features/dock/BottomDock"));
const BottomPanelStrip = lazy(() => import("../features/dock/BottomDock").then((module) => ({ default: module.BottomPanelStrip })));
const STEP_EXPLANATION_KEY = "simulatornet.stepModeExplained";
const WIRELESS_ASSOCIATIONS_KEY = "simulatornet.wirelessAssociations";
const VPN_TUNNEL_OVERLAY_KEY = "simulatornet.vpnTunnelOverlay";
const MPLS_LABEL_OVERLAY_KEY = "simulatornet.mplsLabelOverlay";
const L3VPN_OVERLAY_KEY = "simulatornet.l3VpnOverlay";
const INSPECTOR_AUTO_OPEN_KEY = "simulatornet.inspectorAutoOpen";

interface AppProps { client: SimulatorClient }

function warnInvalidWorkspaceLayout(reason: string): void {
  if (import.meta.env.DEV) console.warn(`[workspace-layout] ${reason}`);
}

export const EMPTY_LAB: LabDocument = {
  schemaVersion: 1,
  id: "untitled-lab",
  title: "Untitled Lab",
  description: "A deterministic browser network laboratory",
  simulation: { seed: 1 },
  topology: { schemaVersion: 1, nodes: [], links: [] },
  configurations: {},
};

/**
 * Advanced-only warning shown wherever the canonical JSON is exposed. JSON
 * remains the internal model; it is not the format a learner saves in.
 */
export const ADVANCED_JSON_NOTICE =
  "Advanced format intended for diagnostics and integration. For normal use, save a SimulatorNet Lab package.";

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadLabDocument(document: LabDocument, fileName?: string): void {
  const name = (fileName ?? document.id).replace(/\.json$/i, "");
  downloadBlob(new Blob([stringifyLabDocument(document)], { type: "application/json" }), `${name || "lab"}.json`);
}

/**
 * The ordinary Save: one `.simlab` file holding the canonical document and the
 * readable `.cfg` projections. JSON stays internal.
 */
export async function downloadLabPackage(document: LabDocument, fileName?: string): Promise<void> {
  const bytes = await writeSimulatorNetLabPackage(document, {
    // Provenance for a converted lab travels with the package as non-canonical
    // metadata; it never affects the document or a grade.
    importReport: document.sourceImport,
  });
  const name = (fileName ?? document.id).replace(/\.simlab$/i, "");
  downloadBlob(
    new Blob([bytes as unknown as BlobPart], { type: "application/zip" }),
    `${name || "lab"}${SIMLAB_EXTENSION}`,
  );
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
      if (
        (configuration?.kind === "pc"
          || configuration?.kind === "laptop"
          || configuration?.kind === "smartphone")
        && index === 0
      ) ipAddress = configuration.ipv4?.address;
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
  const bottomPanelRef = usePanelRef();
  const [workspacePanelLayout, setWorkspacePanelLayout] = useState(() => {
    const defaultLayout = createDefaultWorkspacePanelLayout(
      workspace.bottomPanelExpandedHeight,
      window.innerHeight,
    );
    return readWorkspacePanelLayout({
      storage: window.localStorage,
      groupId: WORKSPACE_PANEL_GROUP_ID,
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      defaultLayout,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
      legacyStorageKeys: [LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY],
      onInvalid: warnInvalidWorkspaceLayout,
    });
  });
  const recordWorkspacePanelLayout = useCallback((layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const persisted = persistWorkspacePanelLayout({
      storage: window.localStorage,
      groupId: WORKSPACE_PANEL_GROUP_ID,
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      candidateLayout: layout,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
    });
    if (!persisted) {
      warnInvalidWorkspaceLayout(`Ignored invalid ${WORKSPACE_PANEL_GROUP_ID} resize result.`);
      return;
    }
    setWorkspacePanelLayout(persisted);
  }, []);
  const compact = useMediaQuery("(max-width: 999px)");
  const narrow = useMediaQuery("(max-width: 1299px)");
  const [inspectorAutoOpen, setInspectorAutoOpen] = useState(() => {
    const stored = window.localStorage.getItem(INSPECTOR_AUTO_OPEN_KEY);
    if (stored === "true" || stored === "false") return stored === "true";
    return !narrow;
  });
  const chooseInspectorVisibility = useCallback((open: boolean) => {
    window.localStorage.setItem(INSPECTOR_AUTO_OPEN_KEY, String(open));
    setInspectorAutoOpen(open);
    useWorkspaceStore.getState().setInspectorOpen(open);
  }, []);
  const theme = useTheme();
  const deviceIconProfile = useDeviceIconProfile();
  const [terminalAppearance, setTerminalAppearanceState] = useState<TerminalAppearance>(getTerminalAppearance());
  const [wirelessAssociationsShown, setWirelessAssociationsShown] = useState(() =>
    window.localStorage.getItem(WIRELESS_ASSOCIATIONS_KEY) !== "hide");
  const chooseWirelessAssociations = (shown: boolean) => {
    window.localStorage.setItem(WIRELESS_ASSOCIATIONS_KEY, shown ? "show" : "hide");
    setWirelessAssociationsShown(shown);
  };
  // A VPN overlay is derived presentation, so whether it is drawn is local
  // workspace state; it never enters LabDocument, a submission or grading.
  const [vpnTunnelsShown, setVpnTunnelsShown] = useState(() =>
    window.localStorage.getItem(VPN_TUNNEL_OVERLAY_KEY) !== "hide");
  const chooseVpnTunnels = (shown: boolean) => {
    window.localStorage.setItem(VPN_TUNNEL_OVERLAY_KEY, shown ? "show" : "hide");
    setVpnTunnelsShown(shown);
  };
  const [mplsLabelsShown, setMplsLabelsShown] = useState(() =>
    window.localStorage.getItem(MPLS_LABEL_OVERLAY_KEY) === "show");
  const chooseMplsLabels = (shown: boolean) => {
    window.localStorage.setItem(MPLS_LABEL_OVERLAY_KEY, shown ? "show" : "hide");
    setMplsLabelsShown(shown);
  };
  const [l3VpnShown, setL3VpnShown] = useState(() =>
    window.localStorage.getItem(L3VPN_OVERLAY_KEY) === "show");
  const chooseL3Vpn = (shown: boolean) => {
    window.localStorage.setItem(L3VPN_OVERLAY_KEY, shown ? "show" : "hide");
    setL3VpnShown(shown);
  };
  const chooseTerminalAppearance = (id: TerminalAppearance) => { applyTerminalAppearance(id); setTerminalAppearanceState(id); };
  // Local-only terminal preference: never part of LabDocument or a submission.
  const [confirmMultilinePaste, setConfirmMultilinePasteState] = useState(() => readConfirmMultilinePaste());
  const chooseConfirmMultilinePaste = (confirm: boolean) => { persistConfirmMultilinePaste(confirm); setConfirmMultilinePasteState(confirm); };
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
  const [canvasNavigationOpen, setCanvasNavigationOpen] = useState(false);
  const [diagramTextOpen, setDiagramTextOpen] = useState(false);
  const [connectingHelpOpen, setConnectingHelpOpen] = useState(false);
  const [terminalHelpOpen, setTerminalHelpOpen] = useState(false);
  const [validation, setValidation] = useState<string>();
  const [pendingMode, setPendingMode] = useState<WorkspaceMode>();
  const [deviceWindowId, setDeviceWindowId] = useState<string>();
  const [confirmSaveAll, setConfirmSaveAll] = useState(false);
  const [advancedJsonOpen, setAdvancedJsonOpen] = useState(false);
  const [exportConfigsOpen, setExportConfigsOpen] = useState(false);
  const [configurationStatus, setConfigurationStatus] = useState<LabConfigurationStatusView>();
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

  // Bottom panel presentation. Changing it never touches a terminal session,
  // a CLI mode, the event buffer or the topology model.
  const setBottomPanel = useCallback((state: BottomPanelState) => {
    useWorkspaceStore.getState().setBottomPanelState(state);
  }, []);
  const recordBottomPanelHeight = useCallback((height: number) => {
    useWorkspaceStore.getState().setBottomPanelExpandedHeight(height, window.innerHeight);
  }, []);
  const openDockTab = useCallback((tab: DockTab) => {
    useWorkspaceStore.getState().openDockTab(tab);
  }, []);

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
      // A `.simlab` package opens directly: it is our own format, and a
      // projection mismatch is reported rather than silently applied.
      if (detection.format === "simulatornet-package") {
        const read = await readSimulatorNetLabPackage(bytes);
        await initialize(read.document);
        for (const warning of read.warnings) reportError(warning, "validation");
        return;
      }
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

  /**
   * Refresh the per-device Saved/Modified badges. Configuration status is
   * derived worker state, so it is fetched rather than tracked in the store.
   */
  const refreshConfigurationStatus = useCallback(() => {
    const state = useWorkspaceStore.getState();
    if (state.workerStatus !== "ready" || state.powerState !== "running") {
      setConfigurationStatus(undefined);
      return;
    }
    void client.request({ type: "GET_LAB_CONFIGURATION_STATUS" })
      .then(setConfigurationStatus)
      .catch(() => setConfigurationStatus(undefined));
  }, [client]);

  useEffect(refreshConfigurationStatus, [refreshConfigurationStatus, workspace.powerState, workspace.snapshot]);

  const saveAllConfigurations = useCallback(() => {
    setConfirmSaveAll(false);
    void client.request({ type: "SAVE_ALL_DEVICE_CONFIGURATIONS" }).then((status) => {
      setConfigurationStatus(status);
      const state = useWorkspaceStore.getState();
      if (state.draft) state.synchronizeConfiguration(mergeRunningConfiguration(status.document, state.draft));
      setValidation(`Saved the running configuration on ${status.devices.filter((device) => device.supportsConfigurationText).length} device(s).`);
    }).catch(reportError);
  }, [client, reportError]);

  const saveDeviceConfiguration = useCallback((deviceId: string) => {
    void client.request({ type: "SAVE_DEVICE_CONFIGURATION", deviceId }).then((view) => {
      const state = useWorkspaceStore.getState();
      if (state.draft) state.synchronizeConfiguration(mergeRunningConfiguration(view.document, state.draft));
      refreshConfigurationStatus();
      setValidation(`${view.hostname}: running configuration copied to startup.`);
    }).catch(reportError);
  }, [client, refreshConfigurationStatus, reportError]);

  const reloadDevice = useCallback((deviceId: string) => {
    void client.request({ type: "RELOAD_DEVICE", deviceId, save: false }).then((view) => {
      const state = useWorkspaceStore.getState();
      if (state.draft) state.synchronizeConfiguration(mergeRunningConfiguration(view.document, state.draft));
      refreshConfigurationStatus();
      setValidation(`${view.hostname} reloaded from its startup configuration.`);
    }).catch(reportError);
  }, [client, refreshConfigurationStatus, reportError]);

  /** The current draft merged with the worker's running configuration. */
  const currentDocument = useCallback(async (): Promise<LabDocument | undefined> => {
    const draft = useWorkspaceStore.getState().draft;
    if (!draft) return undefined;
    const running = await client.request({ type: "SERIALIZE_LAB" });
    return mergeRunningConfiguration(running, draft);
  }, [client]);

  /** Advanced only: the canonical JSON, for diagnostics and integration. */
  const exportLabJson = useCallback((fileName?: string) => void (async () => {
    const merged = await currentDocument();
    if (!merged) return;
    useWorkspaceStore.getState().markSaved(merged);
    downloadLabDocument(merged, fileName);
  })().catch(reportError), [currentDocument, reportError]);

  /** The ordinary Save: one `.simlab` package. */
  const saveLabPackage = useCallback((fileName?: string) => void (async () => {
    const merged = await currentDocument();
    if (!merged) return;
    useWorkspaceStore.getState().markSaved(merged);
    await downloadLabPackage(merged, fileName);
  })().catch(reportError), [currentDocument, reportError]);
  const save = useCallback(() => saveLabPackage(), [saveLabPackage]);

  const exportDeviceConfigurations = useCallback((choice: "all" | "running" | "startup") => void (async () => {
    const merged = await currentDocument();
    if (!merged) return;
    if (choice === "all") {
      const bytes = await writeDeviceConfigurationArchive(merged);
      downloadBlob(new Blob([bytes as unknown as BlobPart], { type: "application/zip" }), `${merged.id || "lab"}-configs.zip`);
      setExportConfigsOpen(false);
      return;
    }
    const deviceId = useWorkspaceStore.getState().selectedNodeId;
    const projection = deviceConfigurationProjections(merged)
      .find((entry) => entry.deviceId === deviceId && entry.kind === choice);
    if (!projection) {
      reportError("Select a device that keeps a configuration file first.", "validation");
      return;
    }
    downloadBlob(
      new Blob([projection.text], { type: "text/plain;charset=utf-8" }),
      projection.path.slice(projection.path.lastIndexOf("/") + 1),
    );
    setExportConfigsOpen(false);
  })().catch(reportError), [currentDocument, reportError]);

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
  /**
   * Move the deterministic virtual clock forward by a fixed amount. This is how
   * a lifetime-driven event — a DHCP lease, a VTY idle timeout, an IPsec rekey —
   * becomes due without waiting in wall-clock time. It is virtual time, not a
   * playback speed.
   */
  const advanceTime = useCallback(
    (milliseconds: number) => void client.request({ type: "ADVANCE_TIME", milliseconds })
      .then((result) => useWorkspaceStore.getState().setSnapshot(result.snapshot))
      .catch(reportError),
    [client, reportError],
  );

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
      // A floating or maximized terminal is already on screen; only a docked one
      // needs the bottom panel expanded on its Terminal tab.
      if (state.terminalPresentationMode === "docked") state.openDockTab("terminal");
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

  /**
   * Shortcuts that manage the workspace panels themselves. They are handled in
   * both the bubble and capture phases: xterm cancels the key events it
   * consumes (`preventDefault` **and** `stopPropagation`), so a focused
   * terminal would otherwise swallow them. Returns true when handled.
   */
  const handlePanelShortcut = useCallback((event: KeyboardEvent): boolean => {
    const commandKey = event.ctrlKey || event.metaKey;
    if (!commandKey) return false;
    const state = useWorkspaceStore.getState();
    if (!state.snapshot) return false;
    if (event.code === "Backquote" && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey) {
        state.setTerminalPresentationMode(state.terminalPresentationMode === "floating" ? "docked" : "floating");
        return true;
      }
      // A docked terminal behind a collapsed panel needs the panel back before
      // "hide" would mean anything, so opening always wins first.
      const dockedAndCollapsed = state.terminalPresentationMode === "docked"
        && (state.bottomPanelState !== "expanded" || state.dockTab !== "terminal");
      if (state.terminalVisible && !dockedAndCollapsed) state.setTerminalVisible(false);
      else showTerminal();
      return true;
    }
    // Ctrl/Cmd+Shift+J stays the browser's own shortcut.
    if (event.key.toLowerCase() === "j" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      state.toggleBottomPanel();
      return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleCapture = (event: KeyboardEvent) => {
      // Only inside the panels: everywhere else the bubble handler is enough,
      // and handling twice would toggle the panel back again.
      const insidePanels = event.target instanceof HTMLElement
        && Boolean(event.target.closest(".terminal-presentation, .bottom-dock, .bottom-panel-strip"));
      if (insidePanels) handlePanelShortcut(event);
    };
    window.addEventListener("keydown", handleCapture, true);
    return () => window.removeEventListener("keydown", handleCapture, true);
  }, [handlePanelShortcut]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const terminalFocused = event.target instanceof HTMLElement
        && Boolean(event.target.closest(".terminal-presentation"));
      if (handlePanelShortcut(event)) return;
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
        setSaveAsOpen(false); setDemoLabOpen(false); setStepExplanationOpen(false); setPacketModesOpen(false); setCanvasNavigationOpen(false); setDiagramTextOpen(false); setConnectingHelpOpen(false); setTerminalHelpOpen(false); setConfirmApply(false); setConfirmStop(false); setValidation(undefined);
        workspace.setPaletteOpen(false); workspace.selectNode(undefined); workspace.selectLink(undefined);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteSelection, run, save]);

  const labOpen = workspace.snapshot !== undefined;
  const bottomPanelExpanded = workspace.bottomPanelState === "expanded";
  const bottomPanelExpandedInLayout = labOpen && bottomPanelExpanded;
  const ready = workspace.workerStatus === "ready" && labOpen;
  const simulationEnabled = ready && workspace.mode === "simulate";
  const editMode = workspace.mode === "edit";
  const hasSelection = Boolean(workspace.selectedNodeId || workspace.selectedLinkId);
  const powerState = workspace.powerState;
  const labRunning = powerState === "running";
  const labStopped = powerState === "stopped";
  const powerBusy = powerState === "starting" || powerState === "stopping";

  useEffect(() => {
    let active = true;
    const panel = bottomPanelRef.current;
    if (!panel) return;
    const animationFrame = window.requestAnimationFrame(() => {
      if (!active || bottomPanelRef.current !== panel) return;
      if (bottomPanelExpandedInLayout) {
        if (panel.isCollapsed()) panel.expand();
      } else if (!panel.isCollapsed()) {
        panel.collapse();
      }
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(animationFrame);
    };
  }, [bottomPanelExpandedInLayout, bottomPanelRef]);

  const menus: MenuDef[] = [
    { id: "file", label: "File", items: [
      { id: "file-new", label: "New Lab", shortcut: "Ctrl N", icon: <FilePlus2 size={14} />, onSelect: newLab },
      { id: "file-open", label: "Open Lab…", shortcut: "Ctrl O", icon: <FolderOpen size={14} />, onSelect: importLab },
      { id: "file-demo", label: "Load Demo Lab", icon: <FlaskConical size={14} />, onSelect: () => setDemoLabOpen(true) },
      { id: "file-close", label: "Close Lab", icon: <FolderX size={14} />, disabled: !labOpen, onSelect: closeLab },
      { separator: true },
      { id: "file-save", label: "Save Lab", shortcut: "Ctrl S", icon: <Download size={14} />, disabled: !ready, onSelect: save },
      { id: "file-saveas", label: "Save Lab As…", shortcut: "Ctrl ⇧ S", disabled: !ready, onSelect: () => setSaveAsOpen(true) },
      { separator: true },
      { id: "file-import-external", label: "Import External Lab…", icon: <FileUp size={14} />, onSelect: importLab },
      { id: "file-export-configs", label: "Export Device Configurations…", icon: <FileDown size={14} />, disabled: !ready, onSelect: () => setExportConfigsOpen(true) },
      { separator: true },
      // The canonical JSON stays available for diagnostics and integration —
      // and only there. It is the internal model, not the format a learner saves.
      { id: "file-advanced", label: "Advanced", submenu: [
        { id: "file-advanced-import-json", label: "Import Lab JSON…", onSelect: importLab },
        { id: "file-advanced-export-json", label: "Export Lab JSON", disabled: !ready, onSelect: () => setAdvancedJsonOpen(true) },
      ] },
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
      { id: "view-inspector", label: workspace.inspectorOpen ? "Hide Inspector" : "Show Inspector", icon: <PanelRight size={14} />, onSelect: () => chooseInspectorVisibility(!workspace.inspectorOpen) },
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
      // Derived runtime overlays. They are drawn from worker state and are never
      // LabDocument links, so showing or hiding one changes nothing but the view.
      { id: "view-protocol-overlays", label: "Protocol Overlays", submenu: [
        { id: "view-wireless-associations", label: "Wireless Associations", submenu: [
          { id: "wireless-associations-show", label: "Show", checked: wirelessAssociationsShown, onSelect: () => chooseWirelessAssociations(true) },
          { id: "wireless-associations-hide", label: "Hide", checked: !wirelessAssociationsShown, onSelect: () => chooseWirelessAssociations(false) },
        ] },
        { id: "view-vpn-tunnels", label: "VPN Tunnels", submenu: [
          { id: "vpn-tunnels-show", label: "Show", checked: vpnTunnelsShown, onSelect: () => chooseVpnTunnels(true) },
          { id: "vpn-tunnels-hide", label: "Hide", checked: !vpnTunnelsShown, onSelect: () => chooseVpnTunnels(false) },
        ] },
        { id: "view-mpls-labels", label: "MPLS Labels", submenu: [
          { id: "mpls-labels-show", label: "Show", checked: mplsLabelsShown, onSelect: () => chooseMplsLabels(true) },
          { id: "mpls-labels-hide", label: "Hide", checked: !mplsLabelsShown, onSelect: () => chooseMplsLabels(false) },
        ] },
        { id: "view-l3vpn", label: "L3VPN", submenu: [
          { id: "l3vpn-show", label: "Show", checked: l3VpnShown, onSelect: () => chooseL3Vpn(true) },
          { id: "l3vpn-hide", label: "Hide", checked: !l3VpnShown, onSelect: () => chooseL3Vpn(false) },
        ] },
      ] },
      { id: "view-bottom-panel", label: "Bottom Panel", icon: <PanelBottom size={14} />, submenu: [
        { id: "bottom-panel-show", label: "Show", shortcut: "Ctrl J", checked: bottomPanelExpanded, disabled: !labOpen, onSelect: () => setBottomPanel("expanded") },
        { id: "bottom-panel-minimize", label: "Minimize", checked: workspace.bottomPanelState === "minimized", disabled: !labOpen, onSelect: () => setBottomPanel("minimized") },
        { id: "bottom-panel-hide", label: "Hide", checked: workspace.bottomPanelState === "hidden", disabled: !labOpen, onSelect: () => setBottomPanel("hidden") },
      ] },
      { id: "view-terminal", label: "Terminal", icon: <TerminalSquare size={14} />, submenu: [
        { id: "terminal-show", label: "Show Terminal", shortcut: "Ctrl `", disabled: !labOpen, onSelect: showTerminal },
        { id: "terminal-dock", label: "Dock at Bottom", checked: workspace.terminalPresentationMode === "docked", disabled: !labOpen, onSelect: () => workspace.setTerminalPresentationMode("docked") },
        { id: "terminal-float", label: "Float", shortcut: "Ctrl ⇧ `", checked: workspace.terminalPresentationMode === "floating", disabled: !labOpen, onSelect: () => workspace.setTerminalPresentationMode("floating") },
        { id: "terminal-maximize", label: "Maximize", shortcut: "Ctrl Alt ↵", checked: workspace.terminalPresentationMode === "maximized", disabled: !labOpen, onSelect: () => workspace.setTerminalPresentationMode("maximized") },
        { id: "terminal-hide", label: "Hide Terminal", disabled: !labOpen || !workspace.terminalVisible, onSelect: () => workspace.setTerminalVisible(false) },
        { separator: true },
        { id: "terminal-paste-confirm", label: "Confirm Multi-line Paste", checked: confirmMultilinePaste, onSelect: () => chooseConfirmMultilinePaste(!confirmMultilinePaste) },
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
      { separator: true },
      {
        id: "lab-save-configs",
        label: "Save All Device Configurations",
        icon: <Save size={14} />,
        disabled: !simulationEnabled,
        onSelect: () => setConfirmSaveAll(true),
      },
      { separator: true },
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
      // Virtual time, never wall-clock playback: this is what makes a lease,
      // an idle timeout or an IPsec rekey become due on demand.
      { id: "sim-advance", label: "Advance Virtual Time", icon: <Clock3 size={14} />, disabled: !simulationEnabled, submenu: [
        { id: "sim-advance-1s", label: "1 second", onSelect: () => advanceTime(1_000) },
        { id: "sim-advance-10s", label: "10 seconds", onSelect: () => advanceTime(10_000) },
        { id: "sim-advance-1m", label: "1 minute", onSelect: () => advanceTime(60_000) },
        { id: "sim-advance-5m", label: "5 minutes", onSelect: () => advanceTime(300_000) },
      ] },
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
      { id: "help-canvas-navigation", label: "Canvas Navigation", icon: <Move size={14} />, onSelect: () => setCanvasNavigationOpen(true) },
      { id: "help-diagram-text", label: "Diagram Text Editing", icon: <Type size={14} />, onSelect: () => setDiagramTextOpen(true) },
      { id: "help-connecting", label: "Connecting Devices", icon: <Cable size={14} />, onSelect: () => setConnectingHelpOpen(true) },
      { id: "help-packet-modes", label: "Packet Execution Modes", icon: <SkipForward size={14} />, onSelect: () => setPacketModesOpen(true) },
      { id: "help-terminal", label: "Terminal Workspace", icon: <ClipboardPaste size={14} />, onSelect: () => setTerminalHelpOpen(true) },
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
      onClose={() => chooseInspectorVisibility(false)}
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
            selectedHardwareProfileId={workspace.pendingHardwareProfileId}
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
        zoomScale={workspace.viewport.scale}
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
        onOpenPacketTrace={() => openDockTab("packet-trace")}
        onStartLab={startLab}
        onStopLab={stopLab}
        onLogout={() => void launchSession.logout().catch((error) => reportError(error, "validation"))}
      />
      <input id="load-lab-file" className="visually-hidden" type="file" accept=".simlab,application/json,.json,.unl,.zip,.gns3,.gns3project,.yml,.yaml,.virl,.pkt,.pka" onChange={(event) => { const file = event.target.files?.[0]; if (file) loadFile(file); event.target.value = ""; }} />
      {launchSession.state.status === "authenticated" && <AssignmentPanel client={client} document={workspace.draft} onOpenDocument={(document) => initialize(document, "simulate")} onError={(message) => reportError(message, "validation")} />}
      {launchSession.state.status === "exchanging" && <div className="launch-status" role="status">Exchanging secure launch code…</div>}
      {launchSession.state.status === "error" && <div className="workspace-error" role="alert"><AlertTriangle size={14} /><span>{launchSession.state.message}</span></div>}
      {validation && <div className="workspace-notice" role="status"><CheckCircle2 size={14} /><span>{validation}</span><IconButton label="Dismiss notice" icon={<X size={13} />} onClick={() => setValidation(undefined)} /></div>}
      {workspace.error && <div className="workspace-error" role="alert"><AlertTriangle size={14} /><span>{workspace.error}</span><button type="button" onClick={() => openDockTab("problems")}>View problems</button><IconButton label="Dismiss error" icon={<X size={13} />} onClick={() => workspace.setError(undefined)} /></div>}
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
        <PanelGroup
          orientation="vertical"
          className="workspace-resizable"
          id={WORKSPACE_PANEL_GROUP_ID}
          defaultLayout={workspacePanelLayout}
          onLayoutChanged={recordWorkspacePanelLayout}
          data-bottom-panel-state={bottomPanelExpandedInLayout ? "expanded" : "collapsed"}
        >
          <ResizablePanel
            id={WORKSPACE_MAIN_PANEL_ID}
            minSize="300px"
            defaultSize={`${workspacePanelLayout[WORKSPACE_MAIN_PANEL_ID]}%`}
          >
            <div className="main-workspace">
              {labOpen && (
                <nav className="workspace-view-switch" role="tablist" aria-label="Workspace view">
                  {([
                    { id: "logical", label: "Logical", hint: "Topology canvas: devices, cables and diagram." },
                    { id: "physical", label: "Physical", hint: "Where the equipment is: sites, rooms and racks." },
                  ] as const).map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={workspace.view === entry.id}
                      className={workspace.view === entry.id ? "is-active" : ""}
                      title={entry.hint}
                      onClick={() => workspace.setView(entry.id as WorkspaceView)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </nav>
              )}
              {workspace.view === "physical" && workspace.draft ? (
                <Suspense fallback={<CanvasLoading />}>
                  <PhysicalWorkspace
                    document={workspace.draft}
                    nodes={workspace.snapshot?.nodes ?? []}
                    onChange={updateDraft}
                    onOpenDevice={setDeviceWindowId}
                    onError={(message) => reportError(message, "validation")}
                  />
                </Suspense>
              ) : (
                <>
                  <Suspense fallback={<CanvasLoading />}><TopologyCanvas {...topologyProps()} /></Suspense>
                  {inspector}
                </>
              )}
            </div>
          </ResizablePanel>
          {bottomPanelExpandedInLayout && (
            <Separator
              id={WORKSPACE_BOTTOM_SEPARATOR_ID}
              className="resize-handle resize-handle--horizontal"
            />
          )}
          <ResizablePanel
            id={WORKSPACE_BOTTOM_PANEL_ID}
            panelRef={bottomPanelRef}
            collapsible
            collapsedSize="0%"
            minSize={`${MIN_BOTTOM_PANEL_HEIGHT}px`}
            maxSize="48%"
            defaultSize={`${workspacePanelLayout[WORKSPACE_BOTTOM_PANEL_ID]}%`}
            groupResizeBehavior="preserve-pixel-size"
          >
            {bottomPanelExpandedInLayout && (
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
                  onMinimize={() => setBottomPanel("minimized")}
                  onHide={() => setBottomPanel("hidden")}
                  onHeight={recordBottomPanelHeight}
                />
              </Suspense>
            )}
          </ResizablePanel>
        </PanelGroup>
        {labOpen && workspace.bottomPanelState === "minimized" && (
          <Suspense fallback={null}>
            <BottomPanelStrip
              tab={workspace.dockTab}
              traces={workspace.traces}
              problems={workspace.problems}
              terminalTabs={workspace.terminalTabs}
              onTab={workspace.setDockTab}
              onExpand={() => setBottomPanel("expanded")}
              onHide={() => setBottomPanel("hidden")}
            />
          </Suspense>
        )}
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
          dockAvailable={bottomPanelExpanded && workspace.dockTab === "terminal"}
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
      <footer className="workspace-footer">
        <span>Workspace: <strong>{workspace.mode === "edit" ? "Edit" : "Operate"}</strong></span>
        <span>Virtual time <code>{((workspace.snapshot?.virtualTime ?? 0) / 1_000_000).toFixed(3)} ms</code></span>
        <span>{workspace.snapshot?.nodes.length ?? 0} devices</span>
        <span>{workspace.draft?.topology.links.length ?? 0} links</span>
        {labOpen && !bottomPanelExpanded && <BottomPanelStatus
          state={workspace.bottomPanelState}
          traces={workspace.traces.length}
          queuedEvents={workspace.snapshot?.queuedEvents ?? 0}
          problems={workspace.problems.length}
          onOpen={openDockTab}
        />}
        <span className="workspace-footer__right">Schema v{workspace.draft?.schemaVersion ?? 1} · deterministic runtime</span>
      </footer>
      <span className="visually-hidden" role="status" aria-live="polite">{labOpen ? bottomPanelAnnouncement(workspace.bottomPanelState) : ""}</span>

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
      {confirmSaveAll && <WorkspaceDialog title="Save all device configurations?" eyebrow="Configuration lifecycle" onClose={() => setConfirmSaveAll(false)}>
        <p>This copies the running configuration to the startup configuration on every device that keeps a configuration file — the same as running <code>copy running-config startup-config</code> on each of them.</p>
        <p className="section-note">Runtime state is not copied and no device is reloaded.</p>
        <div className="dialog-actions"><Button variant="ghost" onClick={() => setConfirmSaveAll(false)}>Cancel</Button><Button variant="primary" onClick={saveAllConfigurations}>Save All</Button></div>
      </WorkspaceDialog>}
      {advancedJsonOpen && <WorkspaceDialog title="Export Lab JSON" eyebrow="Advanced format" onClose={() => setAdvancedJsonOpen(false)}>
        <p>{ADVANCED_JSON_NOTICE}</p>
        <p className="section-note">The canonical <code>LabDocument</code> JSON is what the simulator, the database and the verifier use internally. It is fully supported — it is simply not the file a learner normally saves.</p>
        <div className="dialog-actions"><Button variant="ghost" onClick={() => setAdvancedJsonOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => { setAdvancedJsonOpen(false); exportLabJson(); }}>Export JSON</Button></div>
      </WorkspaceDialog>}
      {exportConfigsOpen && <WorkspaceDialog title="Export device configurations" eyebrow="Readable .cfg files" onClose={() => setExportConfigsOpen(false)}>
        <p>Configuration files are rendered from the canonical device configuration. They contain no password, key, community string or verifier — only <code>&lt;configured&gt;</code>.</p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => setExportConfigsOpen(false)}>Cancel</Button>
          <Button variant="ghost" disabled={!workspace.selectedNodeId} onClick={() => exportDeviceConfigurations("startup")}>Selected startup-config</Button>
          <Button variant="ghost" disabled={!workspace.selectedNodeId} onClick={() => exportDeviceConfigurations("running")}>Selected running-config</Button>
          <Button variant="primary" onClick={() => exportDeviceConfigurations("all")}>All devices (ZIP)</Button>
        </div>
      </WorkspaceDialog>}
      {saveAsOpen && <SaveAsDialog defaultName={workspace.draft?.id ?? "lab"} onClose={() => setSaveAsOpen(false)} onSave={(name) => { saveLabPackage(name); setSaveAsOpen(false); }} />}
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
      {canvasNavigationOpen && <CanvasNavigationHelpDialog onClose={() => setCanvasNavigationOpen(false)} />}
      {diagramTextOpen && <DiagramTextHelpDialog onClose={() => setDiagramTextOpen(false)} />}
      {connectingHelpOpen && <ConnectingDevicesHelpDialog onClose={() => setConnectingHelpOpen(false)} />}
      {terminalHelpOpen && <TerminalWorkspaceHelpDialog onClose={() => setTerminalHelpOpen(false)} />}
      {stepExplanationOpen && <WorkspaceDialog title="Step mode" eyebrow="Packet execution" onClose={dismissStepExplanation}>
        <p>Step mode lets you inspect ARP, ICMP, TCP and other network events one at a time.</p>
        <p>Your device configurations are unchanged. Switch back to Auto for normal operation.</p>
        <div className="dialog-actions"><Button variant="primary" onClick={dismissStepExplanation}>Got it</Button></div>
      </WorkspaceDialog>}
      {shortcutsOpen && <WorkspaceDialog title="Keyboard shortcuts" eyebrow="Quick workflow" onClose={() => setShortcutsOpen(false)}>
        <div className="shortcut-list">
          <Shortcut keys="Ctrl / Cmd + N" label="New lab" />
          <Shortcut keys="Ctrl / Cmd + O" label="Open / import lab" />
          <Shortcut keys="Ctrl / Cmd + S" label="Save lab package" />
          <Shortcut keys="Ctrl / Cmd + Shift + S" label="Save Lab As…" />
          <Shortcut keys="Ctrl / Cmd + Z" label="Undo topology edit" />
          <Shortcut keys="Ctrl / Cmd + Enter" label="Run all queued events" />
          <Shortcut keys="Delete" label="Delete selection in Edit mode" />
          <Shortcut keys="F" label="Fit topology" />
          <Shortcut keys="Ctrl + L" label="Clear focused terminal" />
          <Shortcut keys="Ctrl / Cmd + V" label="Paste into the focused terminal" />
          <Shortcut keys="Shift + Insert" label="Paste into the focused terminal" />
          <Shortcut keys="Ctrl / Cmd + J" label="Show or hide the bottom panel" />
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
        configurationDrift={configurationStatus?.devices.find((device) => device.deviceId === deviceWindowId
          && device.supportsConfigurationText)?.drift}
        onOpenTerminal={(deviceId) => {
          openTerminal(deviceId);
          setDeviceWindowId(undefined);
        }}
        onConfigurationChanged={(next, runtimeSynchronized) => {
          const state = useWorkspaceStore.getState();
          if (!state.draft) return;
          if (runtimeSynchronized) state.synchronizeConfiguration(mergeRunningConfiguration(next, state.draft));
          else state.applyDraft(next, "configuration");
          refreshConfigurationStatus();
        }}
        onTopologyChanged={(next) => useWorkspaceStore.getState().applyDraft(next, "structural")}
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
      pendingHardwareProfileId: workspace.pendingHardwareProfileId,
      selectedNodeId: workspace.selectedNodeId,
      selectedLinkId: workspace.selectedLinkId,
      terminalTabs: workspace.terminalTabs,
      portLabelMode: workspace.portLabelMode,
      wirelessAssociationsShown,
      vpnTunnelsShown,
      mplsLabelsShown,
      l3VpnShown,
      fitRequest: workspace.fitRequest,
      zoomResetRequest: workspace.zoomResetRequest,
      zoomInRequest: workspace.zoomInRequest,
      zoomOutRequest: workspace.zoomOutRequest,
      viewport: workspace.viewport,
      onViewport: workspace.setViewport,
      onSelectNode: (id: string | undefined) => {
        workspace.selectNode(id);
        if (id && inspectorAutoOpen) workspace.setInspectorOpen(true);
      },
      onSelectLink: workspace.selectLink,
      onOpenTerminal: openTerminal,
      onOpenDevice: setDeviceWindowId,
      configurationStatus: configurationStatus?.devices,
      onSaveDeviceConfiguration: saveDeviceConfiguration,
      onReloadDevice: reloadDevice,
      onInspect: (id: string) => { workspace.selectNode(id); workspace.setInspectorOpen(true); },
      onPlacedDevice: () => workspace.setPendingDeviceKind(undefined),
      onActiveTool: workspace.setActiveTool,
      onChange: updateDraft,
      onError: (message: string) => reportError(message, "validation"),
      onLoadDemo: () => setDemoLabOpen(true),
      onNewLab: newLab,
      onImportLab: importLab,
    };
  }
}

/**
 * Compact status entry shown while the bottom panel is collapsed. Data keeps
 * accumulating out of sight, so the counts stay reachable — and a new Problems
 * error gets a visible indicator instead of an intrusive toast per event.
 */
function BottomPanelStatus({ state, traces, queuedEvents, problems, onOpen }: {
  state: BottomPanelState;
  traces: number;
  queuedEvents: number;
  problems: number;
  onOpen(tab: DockTab): void;
}) {
  return <span className="bottom-panel-status" data-panel-state={state}>
    <button type="button" aria-label="Show bottom panel: Events" aria-expanded={false} onClick={() => onOpen("events")}>Events <small>{traces}</small></button>
    <button type="button" aria-label="Show bottom panel: Packet trace" aria-expanded={false} onClick={() => onOpen("packet-trace")}>Queued <small>{queuedEvents}</small></button>
    <button
      type="button"
      className={problems > 0 ? "has-problems" : ""}
      aria-label={`Show bottom panel: Problems${problems > 0 ? `, ${problems} reported` : ""}`}
      aria-expanded={false}
      onClick={() => onOpen("problems")}
    >
      {problems > 0 && <AlertTriangle size={11} aria-hidden="true" />}Problems <small>{problems}</small>
    </button>
  </span>;
}

function DemoLabDialog({ onClose, onLoad }: { onClose(): void; onLoad(id: DemoLabId): void }) {
  return <WorkspaceDialog title="Load demo laboratory" eyebrow="Deterministic examples" onClose={onClose}>
    <p>Choose a focused topology. Each demo uses the same browser and server simulation core.</p>
    <div className="demo-lab-list">
      {DEMO_LABS.map((demo) => {
        const representativeType = demo.document.topology.nodes[0]?.kind ?? "external-appliance";
        return <button key={demo.id} type="button" onClick={() => onLoad(demo.id)}>
          <DeviceIcon type={representativeType} size={24} />
          <span><strong>{demo.label}</strong><small>{demo.document.description}</small></span>
        </button>;
      })}
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
  return <WorkspaceDialog title="Save lab as" eyebrow="SimulatorNet Lab package" onClose={onClose}>
    <p>One file holds the whole lab: the canonical document, every device&apos;s readable running and startup configuration, and the diagram.</p>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSave(name.trim() || defaultName); }}>
      <label htmlFor="save-as-name">File name</label>
      <div className="dialog-field"><input id="save-as-name" value={name} autoFocus onChange={(event) => setName(event.target.value)} /><span>{SIMLAB_EXTENSION}</span></div>
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

function CanvasNavigationHelpDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="Canvas navigation" eyebrow="Moving around the topology" onClose={onClose}>
    <div className="shortcut-list">
      <Shortcut keys="Two-finger move" label="Pan the canvas freely, including diagonally" />
      <Shortcut keys="Pinch" label="Zoom smoothly around the pointer" />
      <Shortcut keys="Wheel" label="Scroll the canvas vertically" />
      <Shortcut keys="Shift + Wheel" label="Scroll the canvas horizontally" />
      <Shortcut keys="Ctrl / Cmd + Wheel" label="Gentle zoom around the pointer" />
      <Shortcut keys="Middle-button drag" label="Pan" />
      <Shortcut keys="Space + drag" label="Pan" />
      <Shortcut keys="Left drag on empty canvas" label="Select / marquee" />
    </div>
    <p className="section-note">A plain wheel never zooms and never scrolls the page. Zoom is limited to 20%–300%; the primary toolbar shows the current percentage and resets it to 100%. Fit Topology stays a separate action.</p>
  </WorkspaceDialog>;
}

function DiagramTextHelpDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="Diagram text editing" eyebrow="Editing on the canvas" onClose={onClose}>
    <p>Diagram text is edited directly on the canvas. Choose the Text tool and click to place a caret, or double-click existing text, a link, or a diagram line to edit its label in place. No text editing step opens a dialog window.</p>
    <div className="shortcut-list">
      <Shortcut keys="Enter" label="New line in text; commits a single-line label" />
      <Shortcut keys="Ctrl / Cmd + Enter" label="Commit and close the editor" />
      <Shortcut keys="Escape" label="Cancel — a new annotation is discarded" />
      <Shortcut keys="Tab" label="Commit and return focus to the canvas" />
      <Shortcut keys="Click outside" label="Commit" />
    </div>
    <p className="section-note">Formatting controls stay available while the editor is open. Text is stored as plain text; pasted content uses text/plain only. One edit session is one undo step, and editing text while the lab runs never rebuilds the simulation.</p>
  </WorkspaceDialog>;
}

function ConnectingDevicesHelpDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="Connecting devices" eyebrow="Device-first cabling" onClose={onClose}>
    <p>Hover or select a device to reveal its single cable handle, then drag it onto another device. A modal asks for the connection type and the From/To interfaces, and only then is the link created. The same flow is available from a device&apos;s Connect… menu item and the toolbar connection tool.</p>
    <p>Only free interfaces are offered. Cancelling, or dropping outside a device, creates nothing.</p>
    <p className="section-note">Devices deliberately show no port dots. Interfaces still exist and every link stays anchored to an exact interface — Port Labels (View ▸ Port Labels) display those interface names, they are not connection points. Connections are locked while the lab is running; stop the lab to change cabling.</p>
  </WorkspaceDialog>;
}

function TerminalWorkspaceHelpDialog({ onClose }: { onClose(): void }) {
  return <WorkspaceDialog title="Terminal workspace" eyebrow="Typing and pasting commands" onClose={onClose}>
    <p>xterm is the only CLI input. Paste with <strong>Ctrl/Cmd+V</strong>, <strong>Shift+Insert</strong>, or the terminal right-click menu; the text lands at the cursor in the current input line.</p>
    <div className="cli-command-reference">
      <section>
        <h3>One command</h3>
        <p>Clipboard text without a line break is inserted into the input line and waits — you still press Enter yourself. Pasting works at the start, middle, or end of the line, and Arrow keys, Home/End, Backspace/Delete and history keep working afterwards.</p>
      </section>
      <section>
        <h3>Several commands</h3>
        <p>Clipboard text with line breaks is a bulk paste. A compact confirmation lists the commands before anything runs, then each line is executed in order through the normal CLI parser, so modes change exactly as if you had typed them. A final line without a trailing newline is left in the input line, unexecuted.</p>
        <p>Turn the confirmation off under View ▸ Terminal ▸ Confirm Multi-line Paste.</p>
      </section>
      <section>
        <h3>Interactive prompts</h3>
        <p>A pasted sequence stops at a prompt that expects an answer — Username, Password, enable secret, an interactive ping target, <code>[confirm]</code>, or <code>--More--</code> — so the next command is never mistaken for a credential. Answer the prompt, then choose Continue Paste or Cancel Remaining.</p>
      </section>
      <section>
        <h3>Passwords</h3>
        <p>Pasting into a credential prompt is allowed. The characters are not echoed, not added to command history, not written to the transcript or Problems, and not logged. A multi-line paste is refused at a password prompt.</p>
      </section>
      <section>
        <h3>Right-click menu</h3>
        <p>Copy, Paste, Select All, Clear Terminal, Search and Close Tab. Clear Terminal clears the visible buffer only: the CLI mode, authentication, history and worker session stay open.</p>
      </section>
      <section>
        <h3>Bottom panel</h3>
        <p>The bottom panel is Expanded, Minimized (a compact tab strip) or Hidden (no height at all, so the topology takes the space). Use View ▸ Bottom Panel, the panel controls, or <strong>Ctrl/Cmd+J</strong>.</p>
        <p>Hiding or minimizing the panel only changes what is displayed. Terminal tabs, CLI sessions, authentication, the current input line, history, scrollback and a pending paste all survive — only <strong>Close Tab</strong> ends a session. Events, Packet Trace and Problems keep collecting, with their counts on the compact strip or workspace footer.</p>
      </section>
    </div>
    <p className="section-note">Pasted text is plain text. Escape sequences, OSC clipboard/title/hyperlink commands and other terminal control codes are stripped; binary data is refused. One paste is limited to {TERMINAL_PASTE_LIMITS.maximumCharacters.toLocaleString("en-US")} characters, {TERMINAL_PASTE_LIMITS.maximumLines.toLocaleString("en-US")} lines and {TERMINAL_PASTE_LIMITS.maximumPendingCommands.toLocaleString("en-US")} queued commands.</p>
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
      <section><h3>IPv6</h3><ul>
        <li><code>ping -6 &lt;address-or-hostname&gt;</code>, <code>tracert -6 &lt;address-or-hostname&gt;</code>, <code>ipconfig /all</code></li>
        <li><code>ipv6 unicast-routing</code>, <code>ipv6 address &lt;prefix&gt;/&lt;length&gt;</code>, <code>ipv6 route &lt;prefix&gt;/&lt;length&gt; &lt;next-hop&gt;</code></li>
        <li><code>ipv6 router ospf &lt;process&gt;</code>, <code>ipv6 ospf &lt;process&gt; area 0</code></li>
        <li><code>ipv6 access-list &lt;name&gt;</code>, <code>ipv6 traffic-filter &lt;name&gt; in|out</code></li>
        <li><code>show ipv6 interface brief</code>, <code>show ipv6 neighbors</code>, <code>show ipv6 route</code>, <code>show ipv6 ospf</code>, <code>show ipv6 access-list</code></li>
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

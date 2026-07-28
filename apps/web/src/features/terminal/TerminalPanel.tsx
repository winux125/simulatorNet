import type { ConsoleAccessConfiguration } from "@sim/contracts";
import type { CliExecutionResult, LabUiNode } from "@sim/sim-worker";
import { ConsoleAuthSession, managementCredentialFingerprint } from "@sim/console-auth";
import { stripControlSequences } from "@sim/importers";
import { Clipboard, ClipboardPaste, Eraser, Search, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { SimulatorClient } from "../../app/simulator-client";
import type { WorkspaceMode } from "../../state/workspace-store";
import type { ResolvedTheme } from "../../hooks/useTheme";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Button, EmptyState, IconButton } from "../../ui";
import { TerminalCommandHistory } from "./terminal-history";
import { LineBuffer, classifyTerminalKey } from "./terminal-line-editor";
import {
  getTerminalAppearance,
  terminalAppearanceProfile,
  TERMINAL_APPEARANCE_EVENT,
  type TerminalAppearance,
} from "./terminal-appearance";
import { TerminalPager } from "./terminal-pager";
import {
  CLIPBOARD_UNAVAILABLE_MESSAGE,
  isInteractivePrompt,
  pastePreview,
  PASTE_PAUSED_FOR_INPUT,
  PASTE_PAUSED_FOR_OPERATION,
  prepareSecretPaste,
  prepareTerminalPaste,
  readConfirmMultilinePaste,
  type TerminalPastePreview,
} from "./terminal-paste";

interface TerminalWorkspaceProps {
  client: SimulatorClient;
  tabs: string[];
  activeDeviceId: string | undefined;
  nodes: LabUiNode[];
  mode: WorkspaceMode;
  theme: ResolvedTheme;
  appearance?: TerminalAppearance;
  sessionNamespace?: string;
  layoutSignal?: string;
  /** False while the presentation is off-screen: never fit a 0x0 container. */
  measurable?: boolean;
  /** Simulated console-access config for a device, if it requires a login. */
  consoleAccessFor?(deviceId: string): ConsoleAccessConfiguration | undefined;
  onActivate(deviceId: string): void;
  onClose(deviceId: string): void;
  onReorder?(fromIndex: number, toIndex: number): void;
  onCloseOthers?(deviceId: string): void;
  onCloseToRight?(deviceId: string): void;
  onError(message: string): void;
}

function terminalText(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

export function TerminalWorkspace(props: TerminalWorkspaceProps) {
  const activeNode = props.nodes.find((node) => node.id === props.activeDeviceId);
  const [tabMenu, setTabMenu] = useState<{ deviceId: string; x: number; y: number }>();
  // A tab shows what its terminal is really driving: the local device, or the
  // remote session opened from it. The session itself never changes.
  const [remoteLabels, setRemoteLabels] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [tabMenu]);

  const cycleTab = (direction: -1 | 1) => {
    if (props.tabs.length < 2) return;
    const current = Math.max(0, props.tabs.indexOf(props.activeDeviceId ?? ""));
    props.onActivate(props.tabs[(current + direction + props.tabs.length) % props.tabs.length]!);
  };

  if (props.tabs.length === 0) {
    return <EmptyState icon={<TerminalSquare size={28} />} title="No terminal sessions" description="Open a device context menu or use Open CLI in the inspector. Type or paste commands directly into the terminal — each session keeps its own history inside the worker." />;
  }
  return (
    <div
      className="terminal-workspace"
      data-overflow-boundary="hidden"
      onKeyDownCapture={(event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key === "PageUp") {
          event.preventDefault();
          cycleTab(-1);
        } else if (event.key === "PageDown") {
          event.preventDefault();
          cycleTab(1);
        }
      }}
    >
      <div className="terminal-tabs" role="tablist" aria-label="Device terminal sessions">
        {props.tabs.map((deviceId, index) => {
          const node = props.nodes.find((candidate) => candidate.id === deviceId);
          const active = props.activeDeviceId === deviceId;
          const remoteLabel = remoteLabels[deviceId];
          const localTitle = node?.type === "pc"
            ? `${node.hostname} — Command Prompt`
            : node?.type === "server" ? `${node.hostname} — Terminal` : `${node?.hostname ?? deviceId} — CLI`;
          const title = remoteLabel ? `${node?.hostname ?? deviceId} → ${remoteLabel}` : localTitle;
          return (
            <button
              key={deviceId}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`${node?.hostname ?? deviceId}${remoteLabel ? ` → ${remoteLabel}` : ""} terminal${active ? ", active" : ""}`}
              className={active ? "is-active" : ""}
              draggable={Boolean(props.onReorder)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-simulatornet-terminal-tab", String(index));
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("application/x-simulatornet-terminal-tab")) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromIndex = Number(event.dataTransfer.getData("application/x-simulatornet-terminal-tab"));
                if (Number.isInteger(fromIndex)) props.onReorder?.(fromIndex, index);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onActivate(deviceId);
                setTabMenu({
                  deviceId,
                  x: Math.max(4, Math.min(event.clientX, window.innerWidth - 176)),
                  y: Math.max(4, Math.min(event.clientY, window.innerHeight - 120)),
                });
              }}
              onClick={() => props.onActivate(deviceId)}
            >
              {node
                ? <DeviceIcon type={node.type} size={15} state={node.status === "up" ? "running" : "stopped"} />
                : <TerminalSquare size={13} aria-hidden="true" />}
              <span>{title}</span>
              <small><i className={node?.status === "up" ? "is-ready" : ""} />{remoteLabel ? "remote session" : node?.status === "up" ? "connected" : deviceId}</small>
              <span className="terminal-tab-close" role="button" aria-label={`Close ${node?.hostname ?? deviceId} CLI`} tabIndex={0} onClick={(event) => { event.stopPropagation(); props.onClose(deviceId); }} onKeyDown={(event) => { if (event.key === "Enter") props.onClose(deviceId); }}><X size={12} /></span>
            </button>
          );
        })}
        <span className="terminal-tabs__meta">{activeNode ? `${activeNode.type} · isolated session` : ""}</span>
      </div>
      {tabMenu && <div
        className="terminal-tab-menu"
        role="menu"
        aria-label="Terminal tab actions"
        style={{ left: tabMenu.x, top: tabMenu.y }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" role="menuitem" onClick={() => { props.onActivate(tabMenu.deviceId); setTabMenu(undefined); }}>Activate</button>
        <button type="button" role="menuitem" onClick={() => { props.onClose(tabMenu.deviceId); setTabMenu(undefined); }}>Close</button>
        <button type="button" role="menuitem" disabled={props.tabs.length < 2} onClick={() => { props.onCloseOthers?.(tabMenu.deviceId); setTabMenu(undefined); }}>Close Others</button>
        <button type="button" role="menuitem" disabled={props.tabs.indexOf(tabMenu.deviceId) === props.tabs.length - 1} onClick={() => { props.onCloseToRight?.(tabMenu.deviceId); setTabMenu(undefined); }}>Close Tabs to the Right</button>
      </div>}
      <div className="terminal-sessions">
        {props.tabs.map((deviceId) => {
          const node = props.nodes.find((candidate) => candidate.id === deviceId);
          return (
            <TerminalSession
              key={deviceId}
              client={props.client}
              deviceId={deviceId}
              hostname={node?.hostname ?? deviceId}
              active={props.activeDeviceId === deviceId}
              enabled={props.mode === "simulate" && node !== undefined}
              theme={props.theme}
              appearance={props.appearance}
              layoutSignal={props.layoutSignal}
              measurable={props.measurable ?? true}
              sessionNamespace={props.sessionNamespace ?? "terminal"}
              consoleAccess={props.consoleAccessFor?.(deviceId)}
              onRemoteLabel={(label) => setRemoteLabels((current) => ({ ...current, [deviceId]: label }))}
              onCloseTab={() => props.onClose(deviceId)}
              onError={props.onError}
            />
          );
        })}
      </div>
    </div>
  );
}

interface TerminalSessionProps {
  client: SimulatorClient;
  deviceId: string;
  hostname: string;
  active: boolean;
  enabled: boolean;
  theme: ResolvedTheme;
  appearance?: TerminalAppearance;
  layoutSignal?: string;
  measurable: boolean;
  sessionNamespace: string;
  consoleAccess?: ConsoleAccessConfiguration;
  /** Reports the remote session this terminal drives, e.g. "SSH R1". */
  onRemoteLabel?(label: string | undefined): void;
  onCloseTab(): void;
  onError(message: string): void;
}

/** Imperative paste actions owned by the mounted xterm session. */
interface PasteControls {
  fromClipboard(): void;
  confirm(): void;
  dismissConfirm(): void;
  resume(): void;
  cancel(): void;
}

interface PasteConfirmState {
  count: number;
  preview: TerminalPastePreview;
}

interface PasteRunState {
  remaining: number;
  paused: boolean;
}

const NO_PASTE_CONTROLS: PasteControls = {
  fromClipboard: () => undefined,
  confirm: () => undefined,
  dismissConfirm: () => undefined,
  resume: () => undefined,
  cancel: () => undefined,
};

function TerminalSession({ client, deviceId, hostname, active, enabled, theme, appearance, layoutSignal, measurable, sessionNamespace, consoleAccess, onRemoteLabel, onCloseTab, onError }: TerminalSessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<XtermTerminal | undefined>(undefined);
  const fitRef = useRef<XtermFitAddon | undefined>(undefined);
  const focusRef = useRef<() => void>(() => undefined);
  const clearRef = useRef<() => void>(() => undefined);
  const pasteRef = useRef<PasteControls>(NO_PASTE_CONTROLS);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(active);
  // Fitting is skipped while the presentation is off-screen: xterm must never
  // measure a 0x0 container (a hidden bottom panel, a closed terminal window).
  const measurableRef = useRef(measurable);
  // Captured at mount: reopening the terminal starts a fresh login.
  const consoleAccessRef = useRef(consoleAccess);
  consoleAccessRef.current = consoleAccess;
  const remoteLabelRef = useRef(onRemoteLabel);
  remoteLabelRef.current = onRemoteLabel;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const [transcript, setTranscript] = useState("");
  const [ready, setReady] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pasteConfirm, setPasteConfirm] = useState<PasteConfirmState>();
  const [pasteRun, setPasteRun] = useState<PasteRunState>();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selection: string }>();

  enabledRef.current = enabled;
  activeRef.current = active;
  measurableRef.current = measurable;

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sessionId = `${sessionNamespace}:${deviceId}`;
    let disposed = false;
    let dataDisposable: { dispose(): void } | undefined;
    let eventUnsubscribe: (() => void) | undefined;
    let fitFrame: number | undefined;
    let prompt = "";
    let awaitingDeferredOutput = false;
    let pager: TerminalPager | undefined;
    let pendingPromptResult: CliExecutionResult | undefined;
    let pasteListenerCleanup: (() => void) | undefined;
    /** Set while a remote device is asking this terminal for a credential. */
    let remoteCredentialScope: string | undefined;
    let currentRemoteLabel: string | undefined;
    const setRemoteLabel = (label: string | undefined) => {
      if (label === currentRemoteLabel) return;
      currentRemoteLabel = label;
      remoteLabelRef.current?.(label);
    };
    const buffer = new LineBuffer();
    const history = new TerminalCommandHistory();

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, addon]) => {
      if (disposed) return;
      const profile = terminalAppearanceProfile(appearanceRef.current ?? getTerminalAppearance());
      const terminal = new xterm.Terminal({
        cursorBlink: profile.cursorBlink,
        cursorStyle: profile.cursorStyle,
        convertEol: true,
        fontFamily: profile.fontFamily,
        fontSize: profile.fontSize,
        fontWeight: profile.fontWeight,
        fontWeightBold: profile.fontWeightBold,
        lineHeight: profile.lineHeight,
        letterSpacing: profile.letterSpacing,
        scrollback: profile.scrollback,
        theme: profile.theme,
      });
      const fit = new addon.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;
      focusRef.current = () => { try { terminal.focus(); } catch { /* not attached */ } };
      setReady(true);

      // Name the hidden input xterm uses for keyboard capture so screen readers
      // announce which device's CLI has focus.
      const helper = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      helper?.setAttribute("aria-label", `${hostname} command line`);

      const promptText = () => `${prompt} `;
      const scrollToBottom = () => terminal.scrollToBottom();
      // Repaint the current line: clear it, rewrite prompt + buffer, then park the
      // caret at its logical offset. This is what makes mid-line editing visible.
      const redraw = () => {
        terminal.write(`\x1b[2K\r${promptText()}${buffer.value}`);
        if (buffer.tail > 0) terminal.write(`\x1b[${buffer.tail}D`);
        scrollToBottom();
      };
      const clearViewport = () => {
        terminal.clear();
        terminal.write("\x1b[2J\x1b[H");
        redraw();
        setTranscript("");
      };
      clearRef.current = clearViewport;
      const finishPrompt = (result: CliExecutionResult) => {
        awaitingDeferredOutput = false;
        prompt = result.prompt;
        terminal.write(promptText());
        scrollToBottom();
      };
      const writePagerPage = (page: { text: string; more: boolean }) => {
        if (page.text) terminal.write(`${terminalText(page.text)}\r\n`);
        if (page.more) terminal.write("\x1b[7m--More--\x1b[0m");
        scrollToBottom();
      };
      const renderResult = (result: CliExecutionResult, fromDeferredEvent = false) => {
        // A remote login prompt owns the next line: hide echo and derive the
        // credential fingerprint against the scope the device published.
        remoteCredentialScope = result.secret ? result.credentialScope : undefined;
        // The tab shows what this terminal is really driving, e.g. "SSH R1".
        setRemoteLabel(result.remote?.label);
        // Sanitize CLI output: strip any escape sequence an imported config might
        // carry, so only the terminal's own generated sequences ever run.
        const output = result.output ? stripControlSequences(result.output) : "";
        // Page by the viewport height, but only for genuinely long output, so a
        // short listing (e.g. `?`) never paginates even in a small terminal.
        const viewport = Math.max(1, (terminal.rows || 24) - 1);
        const threshold = Math.max(viewport, 20);
        if (output && !result.deferred && TerminalPager.needed(output, threshold)) {
          pager = new TerminalPager(output, viewport);
          pendingPromptResult = result;
          writePagerPage(pager.page());
          if (fromDeferredEvent) setTranscript((current) => `${current}${output}\n`);
          return;
        }
        if (output) terminal.write(`${terminalText(output)}\r\n`);
        if (result.deferred) { awaitingDeferredOutput = true; scrollToBottom(); }
        else finishPrompt(result);
        if (fromDeferredEvent && output) setTranscript((current) => `${current}${output}\n`);
      };
      eventUnsubscribe = client.onEvent((event) => {
        if (event.type !== "CLI_OUTPUT" || event.sessionId !== sessionId || event.deviceId !== deviceId) return;
        renderResult(event, true);
      });
      const execute = (value: string, alreadyEchoed = false): Promise<CliExecutionResult | undefined> => {
        const submittedPrompt = prompt;
        if (!alreadyEchoed) terminal.write(`${terminalText(value)}\r\n`);
        // A remote device asked for a credential: derive the opaque, scope-bound
        // fingerprint here, in the main thread, and send only that. The
        // plaintext never reaches the worker, the engine, a trace or a log, and
        // it never enters the transcript or command history.
        const scope = remoteCredentialScope;
        remoteCredentialScope = undefined;
        const request = scope === undefined
          ? Promise.resolve({ input: value })
          : managementCredentialFingerprint(scope, value)
            .then((credential) => ({ input: "", credential }))
            .catch(() => ({ input: "" }));
        return request
          .then((payload) => client.request({ type: "EXECUTE_CLI", sessionId, deviceId, ...payload }))
          .then((result) => {
            if (disposed) return undefined;
            renderResult(result);
            const echoed = scope === undefined ? value : "";
            if (echoed || result.output) {
              setTranscript((current) => `${current}${submittedPrompt} ${echoed}\n${result.output ? `${result.output}\n` : ""}`);
            }
            return result;
          }).catch((error: unknown) => {
            onError(error instanceof Error ? error.message : "CLI request failed");
            return undefined;
          });
      };

      // --- Console login gate: async credential check in front of the worker CLI.
      // Commands never reach the CLI parser until authentication succeeds; the
      // gate handles the enable secret and drives the device prompt afterwards.
      const access = consoleAccessRef.current;
      let forwardAfterGate: string | undefined;
      const gate = access && access.mode !== "none"
        ? new ConsoleAuthSession(access, { execute: (line) => { forwardAfterGate = line; return ""; } })
        : undefined;
      const writeGate = (text: string) => { if (text) terminal.write(`${terminalText(text)}\r\n`); };
      const syncDevicePrompt = (privileged: boolean) => execute(privileged ? "enable" : "", true);
      const isPrivileged = () => (gate!.state as string) === "privileged-exec";
      const submitGate = (line: string): Promise<void> => {
        if (!gate) return Promise.resolve();
        forwardAfterGate = undefined;
        const wasAuthenticated = gate.isAuthenticated();
        const wasPrivileged = isPrivileged();
        return gate.submit(line).then(async (outcome) => {
          if (disposed) return;
          writeGate(outcome.output);
          if (forwardAfterGate !== undefined) { history.record(forwardAfterGate); await execute(forwardAfterGate, true); }
          else if (!wasAuthenticated && gate.isAuthenticated()) await syncDevicePrompt(isPrivileged());
          else if (wasAuthenticated && !wasPrivileged && isPrivileged()) await syncDevicePrompt(true);
        }).catch((error: unknown) => onError(error instanceof Error ? error.message : "Console login failed"));
      };

      // --- Clipboard paste ---------------------------------------------------
      // A paste is delivered by the browser's own paste event on this container
      // (Ctrl/Cmd+V, Shift+Insert and platform middle-click all produce one).
      // There is no document-level clipboard interception and no separate HTML
      // command input: xterm remains the only CLI surface.
      let pasteQueue: string[] = [];
      let pasteRemainder = "";
      let pasteTail = "";
      let pasteRunning = false;
      // Bumped whenever the queue is replaced or cancelled, so an in-flight loop
      // that is awaiting a worker reply retires instead of draining a new paste.
      let pasteGeneration = 0;
      let confirmedPlan: { commands: string[]; remainder: string; tail: string } | undefined;
      let nativePasteSequence = 0;
      let shiftInsertTimer: number | undefined;

      /** A credential prompt owns the line: never repaint the hidden buffer. */
      const secretExpected = () => (gate?.expectsSecret() ?? false) || remoteCredentialScope !== undefined;
      const notify = (message: string) => {
        terminal.write(`\r\n${terminalText(message)}\r\n`);
        if (!secretExpected()) redraw();
      };
      const publishRun = () => setPasteRun(
        pasteQueue.length === 0 && !pasteRunning
          ? undefined
          : { remaining: pasteQueue.length, paused: !pasteRunning },
      );
      const finishPaste = () => {
        pasteRunning = false;
        pasteQueue = [];
        // Restore the unexecuted tail of the input line with the caret between
        // the pasted fragment and whatever already followed it.
        buffer.clear();
        if (pasteTail.length > 0) { buffer.insert(pasteTail); buffer.home(); }
        if (pasteRemainder.length > 0) buffer.insert(pasteRemainder);
        pasteRemainder = "";
        pasteTail = "";
        redraw();
        publishRun();
      };
      const cancelPaste = () => {
        pasteGeneration += 1;
        pasteRunning = false;
        pasteQueue = [];
        pasteRemainder = "";
        pasteTail = "";
        publishRun();
      };
      /**
       * Why the queue must stop before sending its next line: an interactive
       * prompt would otherwise consume a command as its answer — turning the
       * following line into a password, a ping target or a [confirm] reply.
       */
      const pauseReason = (): "input" | "operation" | undefined => {
        if (pager) return "input";
        // A remote credential prompt must never be answered by the next pasted
        // command line: the queue stops and waits for the learner.
        if (remoteCredentialScope !== undefined) return "input";
        if (gate && (!gate.isAuthenticated() || secretExpected())) return "input";
        if (awaitingDeferredOutput) return "operation";
        if (isInteractivePrompt(prompt)) return "input";
        return undefined;
      };
      const runPasteQueue = async () => {
        if (pasteRunning) return;
        const generation = pasteGeneration;
        pasteRunning = true;
        publishRun();
        while (pasteQueue.length > 0) {
          if (disposed) { pasteRunning = false; return; }
          // A newer paste (or a cancel) has taken ownership of the queue.
          if (generation !== pasteGeneration) return;
          const reason = pauseReason();
          if (reason) {
            pasteRunning = false;
            notify(reason === "input" ? PASTE_PAUSED_FOR_INPUT : PASTE_PAUSED_FOR_OPERATION);
            publishRun();
            return;
          }
          const line = pasteQueue.shift() ?? "";
          // Echo the pasted line exactly as if it had been typed and submitted.
          terminal.write(`${terminalText(line)}\r\n`);
          if (gate && !remoteCredentialScope) await submitGate(line);
          else { history.record(line); await execute(line, true); }
        }
        if (!disposed && generation === pasteGeneration) finishPaste();
      };
      const startPaste = (commands: readonly string[], remainder: string, tail: string) => {
        pasteGeneration += 1;
        pasteRunning = false;
        // The merged input line now lives in the queue; repaint an empty prompt
        // so the queue's own echo is the only copy on screen.
        buffer.clear();
        terminal.write(`\x1b[2K\r${promptText()}`);
        pasteQueue = [...commands];
        pasteRemainder = remainder;
        pasteTail = tail;
        void runPasteQueue();
      };
      const applySecretPaste = (raw: string) => {
        const secret = prepareSecretPaste(raw);
        if (secret.status === "rejected") { notify(secret.message); return; }
        // No redraw and no history: a credential never reaches the visible
        // buffer, the transcript, Problems or a log.
        buffer.insert(secret.text);
      };
      const applyPaste = (raw: string) => {
        if (!enabledRef.current || disposed) return;
        if (pager || awaitingDeferredOutput) {
          notify("Paste is unavailable while the terminal is waiting for input.");
          return;
        }
        if (secretExpected()) { applySecretPaste(raw); return; }
        const plan = prepareTerminalPaste(raw);
        if (plan.status === "empty") return;
        if (plan.status === "rejected") { notify(plan.message); return; }
        if (plan.commands.length === 0) { buffer.insert(plan.remainder); redraw(); return; }
        // Merge the paste into the current input line at the caret, exactly like
        // a real terminal: text already typed becomes part of the first command
        // and anything after the caret trails the last, unexecuted fragment.
        const merged = {
          commands: [`${buffer.head}${plan.commands[0] ?? ""}`, ...plan.commands.slice(1)],
          remainder: plan.remainder,
          tail: buffer.rest,
        };
        if (plan.bulk && readConfirmMultilinePaste()) {
          confirmedPlan = merged;
          setPasteConfirm({
            count: merged.commands.length,
            preview: pastePreview(merged.commands, `${merged.remainder}${merged.tail}`),
          });
          return;
        }
        startPaste(merged.commands, merged.remainder, merged.tail);
      };
      const pasteFromClipboard = () => {
        const clipboard = navigator.clipboard;
        if (!clipboard || typeof clipboard.readText !== "function") { notify(CLIPBOARD_UNAVAILABLE_MESSAGE); return; }
        void clipboard.readText().then((text) => {
          if (disposed || !text) return;
          applyPaste(text);
        }).catch(() => { if (!disposed) notify(CLIPBOARD_UNAVAILABLE_MESSAGE); });
      };

      pasteRef.current = {
        fromClipboard: () => { pasteFromClipboard(); focusRef.current(); },
        confirm: () => {
          const plan = confirmedPlan;
          confirmedPlan = undefined;
          setPasteConfirm(undefined);
          if (plan) startPaste(plan.commands, plan.remainder, plan.tail);
          focusRef.current();
        },
        dismissConfirm: () => { confirmedPlan = undefined; setPasteConfirm(undefined); focusRef.current(); },
        resume: () => { void runPasteQueue(); focusRef.current(); },
        cancel: () => { cancelPaste(); focusRef.current(); },
      };

      const onNativePaste = (event: ClipboardEvent) => {
        // Handled here so the text is sanitized and bounded before xterm sees
        // it; the canvas and diagram paste handlers stay untouched.
        event.preventDefault();
        event.stopPropagation();
        nativePasteSequence += 1;
        applyPaste(event.clipboardData?.getData("text/plain") ?? "");
      };
      const onHostKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Insert" || !event.shiftKey) return;
        // Most browsers turn Shift+Insert into a native paste event. Only read
        // the clipboard directly when this one did not.
        const seen = nativePasteSequence;
        if (shiftInsertTimer !== undefined) window.clearTimeout(shiftInsertTimer);
        shiftInsertTimer = window.setTimeout(() => {
          shiftInsertTimer = undefined;
          if (disposed || nativePasteSequence !== seen) return;
          pasteFromClipboard();
        }, 30);
      };
      host.addEventListener("paste", onNativePaste);
      host.addEventListener("keydown", onHostKeyDown);
      pasteListenerCleanup = () => {
        host.removeEventListener("paste", onNativePaste);
        host.removeEventListener("keydown", onHostKeyDown);
        if (shiftInsertTimer !== undefined) window.clearTimeout(shiftInsertTimer);
      };

      dataDisposable = terminal.onData((data) => {
        if (pager) {
          terminal.write("\x1b[2K\r"); // erase the --More-- prompt line
          if (data === " " || data === "\r") {
            const page = data === " " ? pager.page() : pager.line();
            writePagerPage(page);
            if (!page.more) { pager = undefined; if (pendingPromptResult) { finishPrompt(pendingPromptResult); pendingPromptResult = undefined; } }
          } else if (data === "q" || data === "\x1b" || data === "\x03") {
            pager = undefined;
            if (pendingPromptResult) { finishPrompt(pendingPromptResult); pendingPromptResult = undefined; }
          }
          return;
        }
        const key = classifyTerminalKey(data);
        if (!key) return;
        if (key.kind === "interrupt") {
          const selection = terminal.getSelection();
          if (selection) {
            void navigator.clipboard?.writeText(selection).catch(() => onError("Clipboard permission was denied"));
          } else {
            terminal.write("^C\r\n");
            buffer.clear();
            terminal.write(promptText());
          }
          return;
        }
        if (key.kind === "clear") {
          // Clear both scrollback and the active viewport. xterm.clear() alone
          // intentionally preserves the current line and would append prompts
          // after repeated Ctrl+L presses.
          clearViewport();
          return;
        }
        if (!enabledRef.current) return;
        if (awaitingDeferredOutput) return;
        // While the gate is waiting for a password, input is never echoed and is
        // kept out of the line editor's visible state and history.
        const secret = secretExpected();
        switch (key.kind) {
          case "enter": {
            const submitted = buffer.value;
            buffer.clear();
            terminal.write("\r\n");
            if (gate && !remoteCredentialScope) void submitGate(submitted);
            else {
              // A credential never reaches history or the transcript.
              if (!secret) history.record(submitted);
              void execute(submitted, true);
            }
            break;
          }
          case "insert": buffer.insert(key.text); if (!secret) redraw(); break;
          case "backspace": if (buffer.backspace() && !secret) redraw(); break;
          case "delete": if (buffer.deleteForward() && !secret) redraw(); break;
          case "left": if (!secret && buffer.left()) terminal.write("\x1b[D"); break;
          case "right": if (!secret && buffer.right()) terminal.write("\x1b[C"); break;
          case "home": if (!secret) { buffer.home(); redraw(); } break;
          case "end": if (!secret) { buffer.end(); redraw(); } break;
          case "history-prev": if (!secret) { buffer.replace(history.previous()); redraw(); } break;
          case "history-next": if (!secret) { buffer.replace(history.next()); redraw(); } break;
        }
      });
      if (gate) writeGate(gate.begin().output);
      else void execute("");
      fitTerminal();
    }).catch(() => onError("Terminal component failed to load"));

    function fitTerminal() {
      if (!activeRef.current || !measurableRef.current || disposed) return;
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (!activeRef.current || !measurableRef.current || disposed) return;
        try {
          fitRef.current?.fit();
          terminalRef.current?.scrollToBottom();
        } catch { /* zero-sized or transitioning dock */ }
      });
    }
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fitTerminal);
    resizeObserver?.observe(host);
    window.addEventListener("resize", fitTerminal);
    return () => {
      disposed = true;
      focusRef.current = () => undefined;
      clearRef.current = () => undefined;
      pasteRef.current = NO_PASTE_CONTROLS;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fitTerminal);
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      pasteListenerCleanup?.();
      dataDisposable?.dispose();
      eventUnsubscribe?.();
      terminalRef.current?.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      remoteLabelRef.current?.(undefined);
      // Closing the tab also ends whatever remote session it carried.
      void client.request({ type: "CLOSE_CLI_SESSION", sessionId }).catch(() => undefined);
    };
  }, [client, deviceId, hostname, onError, sessionNamespace]);

  useEffect(() => {
    const apply = () => {
      const term = terminalRef.current;
      if (!term) return;
      const profile = terminalAppearanceProfile(appearanceRef.current ?? getTerminalAppearance());
      term.options.theme = profile.theme;
      term.options.fontFamily = profile.fontFamily;
      term.options.fontSize = profile.fontSize;
      term.options.lineHeight = profile.lineHeight;
      term.options.cursorBlink = profile.cursorBlink;
      if (measurableRef.current) { try { fitRef.current?.fit(); } catch { /* transitioning */ } }
    };
    apply();
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, apply);
    return () => window.removeEventListener(TERMINAL_APPEARANCE_EVENT, apply);
  }, [appearance, theme]);

  useEffect(() => {
    // Restore keyboard focus (and layout) when this session's tab becomes active
    // and the presentation actually has a measurable size again.
    if (active && measurable) window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        terminalRef.current?.scrollToBottom();
      } catch { /* dock transition */ }
      focusRef.current();
    });
  }, [active, measurable]);

  useEffect(() => {
    if (!active || !measurable) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        terminalRef.current?.scrollToBottom();
      } catch { /* presentation transition */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, measurable, layoutSignal]);

  const copy = () => {
    const text = terminalRef.current?.getSelection() || transcript;
    if (text) void navigator.clipboard?.writeText(text).catch(() => onError("Clipboard permission was denied"));
  };
  const clear = () => {
    clearRef.current();
    focusRef.current();
  };
  const openContextMenu = (clientX: number, clientY: number) => {
    setContextMenu({
      x: Math.max(4, Math.min(clientX, window.innerWidth - 188)),
      y: Math.max(4, Math.min(clientY, window.innerHeight - 210)),
      selection: terminalRef.current?.getSelection() ?? "",
    });
  };
  const searchMatches = searchQuery
    ? transcript.toLocaleLowerCase().split(searchQuery.toLocaleLowerCase()).length - 1
    : 0;

  return (
    <section className={`terminal-session ${active ? "is-active" : ""}`} role="group" aria-label={`${hostname} CLI`} aria-hidden={!active} hidden={!active}>
      <div className="terminal-session__actions">
        <span><i className={ready ? "is-ready" : ""} />{ready ? `${hostname} connected` : "Loading terminal…"}</span>
        <label className="terminal-search">
          <Search size={11} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={searchQuery}
            aria-label={`${hostname} terminal search`}
            placeholder="Search"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery && <small>{searchMatches}</small>}
        </label>
        <IconButton label={`Paste into ${hostname} terminal`} icon={<ClipboardPaste size={13} />} onClick={() => pasteRef.current.fromClipboard()} />
        <IconButton label="Copy terminal selection" icon={<Clipboard size={13} />} onClick={copy} />
        <IconButton label="Clear terminal (Ctrl+L)" icon={<Eraser size={13} />} onClick={clear} />
      </div>
      {pasteRun && <div className="terminal-paste-run" role="status">
        <span>
          {pasteRun.paused
            ? `Pasted sequence paused — ${pasteRun.remaining} command${pasteRun.remaining === 1 ? "" : "s"} remaining`
            : `Pasting ${pasteRun.remaining} remaining command${pasteRun.remaining === 1 ? "" : "s"}…`}
        </span>
        {pasteRun.paused && <Button size="sm" variant="primary" onClick={() => pasteRef.current.resume()}>Continue Paste</Button>}
        <Button size="sm" variant="ghost" onClick={() => pasteRef.current.cancel()}>Cancel Remaining</Button>
      </div>}
      <div
        ref={hostRef}
        className="xterm-host"
        data-scroll-owner="xterm"
        aria-label={`${hostname} terminal`}
        onMouseDown={() => { if (active) focusRef.current(); }}
        onContextMenu={(event) => { event.preventDefault(); openContextMenu(event.clientX, event.clientY); }}
      />
      {contextMenu && <div
        className="terminal-context-menu"
        role="menu"
        aria-label={`${hostname} terminal actions`}
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" role="menuitem" disabled={!contextMenu.selection} onClick={() => { copy(); setContextMenu(undefined); }}>Copy</button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(undefined); pasteRef.current.fromClipboard(); }}>Paste</button>
        <button type="button" role="menuitem" onClick={() => { terminalRef.current?.selectAll(); setContextMenu(undefined); }}>Select All</button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(undefined); clear(); }}>Clear Terminal</button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(undefined); searchRef.current?.focus(); }}>Search</button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(undefined); onCloseTab(); }}>Close Tab</button>
      </div>}
      {pasteConfirm && <div className="terminal-paste-confirm" role="dialog" aria-label={`Paste ${pasteConfirm.count} commands into ${hostname}`}>
        <p>Paste {pasteConfirm.count} command{pasteConfirm.count === 1 ? "" : "s"} into {hostname}?</p>
        <pre>{pasteConfirm.preview.lines.join("\n")}</pre>
        {pasteConfirm.preview.hidden > 0 && <small>…and {pasteConfirm.preview.hidden} more line{pasteConfirm.preview.hidden === 1 ? "" : "s"}</small>}
        <div className="terminal-paste-confirm__actions">
          <Button size="sm" variant="ghost" onClick={() => pasteRef.current.dismissConfirm()}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => pasteRef.current.confirm()}>Paste Commands</Button>
        </div>
      </div>}
      <pre className="visually-hidden" data-testid={active ? "terminal-transcript" : `terminal-transcript-${deviceId}`} aria-live="polite">{transcript}</pre>
    </section>
  );
}

export default TerminalWorkspace;

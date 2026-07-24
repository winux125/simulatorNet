import type { ConsoleAccessConfiguration } from "@sim/contracts";
import type { CliExecutionResult, LabUiNode } from "@sim/sim-worker";
import { ConsoleAuthSession } from "@sim/console-auth";
import { stripControlSequences } from "@sim/importers";
import { Clipboard, Eraser, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { SimulatorClient } from "../../app/simulator-client";
import type { WorkspaceMode } from "../../state/workspace-store";
import type { ResolvedTheme } from "../../hooks/useTheme";
import { EmptyState, IconButton } from "../../ui";
import { TerminalCommandHistory } from "./terminal-history";
import { LineBuffer, classifyTerminalKey } from "./terminal-line-editor";
import {
  getTerminalAppearance,
  terminalAppearanceProfile,
  TERMINAL_APPEARANCE_EVENT,
  type TerminalAppearance,
} from "./terminal-appearance";
import { TerminalPager } from "./terminal-pager";

interface TerminalWorkspaceProps {
  client: SimulatorClient;
  tabs: string[];
  activeDeviceId: string | undefined;
  nodes: LabUiNode[];
  mode: WorkspaceMode;
  theme: ResolvedTheme;
  appearance?: TerminalAppearance;
  sessionNamespace?: string;
  /** Simulated console-access config for a device, if it requires a login. */
  consoleAccessFor?(deviceId: string): ConsoleAccessConfiguration | undefined;
  onActivate(deviceId: string): void;
  onClose(deviceId: string): void;
  onError(message: string): void;
}

function terminalText(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

export function TerminalWorkspace(props: TerminalWorkspaceProps) {
  const activeNode = props.nodes.find((node) => node.id === props.activeDeviceId);
  if (props.tabs.length === 0) {
    return <EmptyState icon={<TerminalSquare size={28} />} title="No terminal sessions" description="Open a device context menu or use Open CLI in the inspector. Type commands directly into the terminal — each session keeps its own history inside the worker." />;
  }
  return (
    <div className="terminal-workspace" data-overflow-boundary="hidden">
      <div className="terminal-tabs" role="tablist" aria-label="Device terminal sessions">
        {props.tabs.map((deviceId) => {
          const node = props.nodes.find((candidate) => candidate.id === deviceId);
          const active = props.activeDeviceId === deviceId;
          const title = node?.type === "pc"
            ? `${node.hostname} — Command Prompt`
            : node?.type === "server" ? `${node.hostname} — Terminal` : `${node?.hostname ?? deviceId} — CLI`;
          return (
            <button key={deviceId} type="button" role="tab" aria-selected={active} aria-label={`${node?.hostname ?? deviceId} terminal${active ? ", active" : ""}`} className={active ? "is-active" : ""} onClick={() => props.onActivate(deviceId)}>
              <TerminalSquare size={13} aria-hidden="true" />
              <span>{title}</span>
              <small>{deviceId}</small>
              <span className="terminal-tab-close" role="button" aria-label={`Close ${node?.hostname ?? deviceId} CLI`} tabIndex={0} onClick={(event) => { event.stopPropagation(); props.onClose(deviceId); }} onKeyDown={(event) => { if (event.key === "Enter") props.onClose(deviceId); }}><X size={12} /></span>
            </button>
          );
        })}
        <span className="terminal-tabs__meta">{activeNode ? `${activeNode.type} · isolated session` : ""}</span>
      </div>
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
              sessionNamespace={props.sessionNamespace ?? "terminal"}
              consoleAccess={props.consoleAccessFor?.(deviceId)}
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
  sessionNamespace: string;
  consoleAccess?: ConsoleAccessConfiguration;
  onError(message: string): void;
}

function TerminalSession({ client, deviceId, hostname, active, enabled, theme, appearance, sessionNamespace, consoleAccess, onError }: TerminalSessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | undefined>(undefined);
  const fitRef = useRef<XtermFitAddon | undefined>(undefined);
  const focusRef = useRef<() => void>(() => undefined);
  const clearRef = useRef<() => void>(() => undefined);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(active);
  // Captured at mount: reopening the terminal starts a fresh login.
  const consoleAccessRef = useRef(consoleAccess);
  consoleAccessRef.current = consoleAccess;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const [transcript, setTranscript] = useState("");
  const [ready, setReady] = useState(false);

  enabledRef.current = enabled;
  activeRef.current = active;

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
      const execute = (value: string, alreadyEchoed = false) => {
        const submittedPrompt = prompt;
        if (!alreadyEchoed) terminal.write(`${terminalText(value)}\r\n`);
        void client.request({ type: "EXECUTE_CLI", sessionId, deviceId, input: value }).then((result) => {
          if (disposed) return;
          renderResult(result);
          if (value || result.output) setTranscript((current) => `${current}${submittedPrompt} ${value}\n${result.output ? `${result.output}\n` : ""}`);
        }).catch((error: unknown) => onError(error instanceof Error ? error.message : "CLI request failed"));
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
      const submitGate = (line: string) => {
        if (!gate) return;
        forwardAfterGate = undefined;
        const wasAuthenticated = gate.isAuthenticated();
        const wasPrivileged = isPrivileged();
        void gate.submit(line).then((outcome) => {
          if (disposed) return;
          writeGate(outcome.output);
          if (forwardAfterGate !== undefined) { history.record(forwardAfterGate); execute(forwardAfterGate, true); }
          else if (!wasAuthenticated && gate.isAuthenticated()) syncDevicePrompt(isPrivileged());
          else if (wasAuthenticated && !wasPrivileged && isPrivileged()) syncDevicePrompt(true);
        }).catch((error: unknown) => onError(error instanceof Error ? error.message : "Console login failed"));
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
        const secret = gate?.expectsSecret() ?? false;
        switch (key.kind) {
          case "enter": {
            const submitted = buffer.value;
            buffer.clear();
            terminal.write("\r\n");
            if (gate) submitGate(submitted);
            else { history.record(submitted); execute(submitted, true); }
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
      else execute("");
      fitTerminal();
    }).catch(() => onError("Terminal component failed to load"));

    function fitTerminal() {
      if (!activeRef.current || disposed) return;
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (!activeRef.current || disposed) return;
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
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fitTerminal);
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      dataDisposable?.dispose();
      eventUnsubscribe?.();
      terminalRef.current?.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
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
      try { fitRef.current?.fit(); } catch { /* transitioning */ }
    };
    apply();
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, apply);
    return () => window.removeEventListener(TERMINAL_APPEARANCE_EVENT, apply);
  }, [appearance, theme]);

  useEffect(() => {
    // Restore keyboard focus (and layout) when this session's tab becomes active.
    if (active) window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        terminalRef.current?.scrollToBottom();
      } catch { /* dock transition */ }
      focusRef.current();
    });
  }, [active]);

  const copy = () => {
    const text = terminalRef.current?.getSelection() || transcript;
    if (text) void navigator.clipboard?.writeText(text).catch(() => onError("Clipboard permission was denied"));
  };
  const clear = () => {
    clearRef.current();
    focusRef.current();
  };

  return (
    <section className={`terminal-session ${active ? "is-active" : ""}`} role="group" aria-label={`${hostname} CLI`} aria-hidden={!active} hidden={!active}>
      <div className="terminal-session__actions">
        <span><i className={ready ? "is-ready" : ""} />{ready ? `${hostname} connected` : "Loading terminal…"}</span>
        <IconButton label="Copy terminal selection" icon={<Clipboard size={13} />} onClick={copy} />
        <IconButton label="Clear terminal (Ctrl+L)" icon={<Eraser size={13} />} onClick={clear} />
      </div>
      <div
        ref={hostRef}
        className="xterm-host"
        data-scroll-owner="xterm"
        aria-label={`${hostname} terminal`}
        onMouseDown={() => { if (active) focusRef.current(); }}
      />
      <pre className="visually-hidden" data-testid={active ? "terminal-transcript" : `terminal-transcript-${deviceId}`} aria-live="polite">{transcript}</pre>
    </section>
  );
}

export default TerminalWorkspace;

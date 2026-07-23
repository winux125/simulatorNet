import type { LabUiNode } from "@sim/sim-worker";
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

interface TerminalWorkspaceProps {
  client: SimulatorClient;
  tabs: string[];
  activeDeviceId: string | undefined;
  nodes: LabUiNode[];
  mode: WorkspaceMode;
  theme: ResolvedTheme;
  sessionNamespace?: string;
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
              sessionNamespace={props.sessionNamespace ?? "terminal"}
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
  sessionNamespace: string;
  onError(message: string): void;
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token("--terminal-bg"),
    foreground: token("--terminal-text"),
    cursor: token("--terminal-cursor"),
    selectionBackground: token("--terminal-selection"),
  };
}

function TerminalSession({ client, deviceId, hostname, active, enabled, theme, sessionNamespace, onError }: TerminalSessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | undefined>(undefined);
  const fitRef = useRef<XtermFitAddon | undefined>(undefined);
  const focusRef = useRef<() => void>(() => undefined);
  const clearRef = useRef<() => void>(() => undefined);
  const enabledRef = useRef(enabled);
  const activeRef = useRef(active);
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
    let fitFrame: number | undefined;
    let prompt = "";
    const buffer = new LineBuffer();
    const history = new TerminalCommandHistory();

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, addon]) => {
      if (disposed) return;
      const terminal = new xterm.Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 2000,
        theme: terminalTheme(),
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
      const execute = (value: string, alreadyEchoed = false) => {
        const submittedPrompt = prompt;
        if (!alreadyEchoed) terminal.write(`${terminalText(value)}\r\n`);
        void client.request({ type: "EXECUTE_CLI", sessionId, deviceId, input: value }).then((result) => {
          if (disposed) return;
          if (result.output) terminal.write(`${terminalText(result.output)}\r\n`);
          prompt = result.prompt;
          terminal.write(promptText());
          scrollToBottom();
          if (value || result.output) setTranscript((current) => `${current}${submittedPrompt} ${value}\n${result.output ? `${result.output}\n` : ""}`);
        }).catch((error: unknown) => onError(error instanceof Error ? error.message : "CLI request failed"));
      };

      dataDisposable = terminal.onData((data) => {
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
        switch (key.kind) {
          case "enter": {
            const submitted = buffer.value;
            history.record(submitted);
            buffer.clear();
            terminal.write("\r\n");
            execute(submitted, true);
            break;
          }
          case "insert": buffer.insert(key.text); redraw(); break;
          case "backspace": if (buffer.backspace()) redraw(); break;
          case "delete": if (buffer.deleteForward()) redraw(); break;
          case "left": if (buffer.left()) terminal.write("\x1b[D"); break;
          case "right": if (buffer.right()) terminal.write("\x1b[C"); break;
          case "home": buffer.home(); redraw(); break;
          case "end": buffer.end(); redraw(); break;
          case "history-prev": buffer.replace(history.previous()); redraw(); break;
          case "history-next": buffer.replace(history.next()); redraw(); break;
        }
      });
      execute("");
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
      terminalRef.current?.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      void client.request({ type: "CLOSE_CLI_SESSION", sessionId }).catch(() => undefined);
    };
  }, [client, deviceId, hostname, onError, sessionNamespace]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme();
  }, [theme]);

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

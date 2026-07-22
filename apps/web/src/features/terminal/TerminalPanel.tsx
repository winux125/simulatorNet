import type { LabUiNode } from "@sim/sim-worker";
import { Clipboard, Eraser, Plus, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { SimulatorClient } from "../../app/simulator-client";
import type { WorkspaceMode } from "../../state/workspace-store";
import { EmptyState, IconButton } from "../../ui";

interface TerminalWorkspaceProps {
  client: SimulatorClient;
  tabs: string[];
  activeDeviceId: string | undefined;
  nodes: LabUiNode[];
  mode: WorkspaceMode;
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
    return <EmptyState icon={<TerminalSquare size={28} />} title="No terminal sessions" description="Open a device context menu or use Open CLI in the inspector. Sessions remain isolated inside the worker." />;
  }
  return (
    <div className="terminal-workspace">
      <div className="terminal-tabs" role="tablist" aria-label="Device terminal sessions">
        {props.tabs.map((deviceId) => {
          const node = props.nodes.find((candidate) => candidate.id === deviceId);
          return (
            <button key={deviceId} type="button" role="tab" aria-selected={props.activeDeviceId === deviceId} className={props.activeDeviceId === deviceId ? "is-active" : ""} onClick={() => props.onActivate(deviceId)}>
              <TerminalSquare size={13} aria-hidden="true" />
              <span>{node?.hostname ?? deviceId}</span>
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
  onError(message: string): void;
}

function TerminalSession({ client, deviceId, hostname, active, enabled, onError }: TerminalSessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | undefined>(undefined);
  const fitRef = useRef<XtermFitAddon | undefined>(undefined);
  const submitRef = useRef<(command: string, alreadyEchoed?: boolean) => void>(() => undefined);
  const [command, setCommand] = useState("");
  const [transcript, setTranscript] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sessionId = `terminal:${deviceId}`;
    let disposed = false;
    let dataDisposable: { dispose(): void } | undefined;
    let prompt = "";
    let input = "";
    const history: string[] = [];
    let historyIndex = 0;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, addon]) => {
      if (disposed) return;
      const terminal = new xterm.Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 2000,
        theme: { background: "#070b11", foreground: "#d7e2ef", cursor: "#38bdf8", selectionBackground: "#1e4d68" },
      });
      const fit = new addon.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;
      setReady(true);

      const redrawInput = () => terminal.write(`\x1b[2K\r${prompt}${input}`);
      const execute = (value: string, alreadyEchoed = false) => {
        const submittedPrompt = prompt;
        if (!alreadyEchoed) terminal.write(`${terminalText(value)}\r\n`);
        void client.request({ type: "EXECUTE_CLI", sessionId, deviceId, input: value }).then((result) => {
          if (disposed) return;
          if (result.output) terminal.write(`${terminalText(result.output)}\r\n`);
          prompt = result.prompt;
          terminal.write(prompt);
          if (value || result.output) setTranscript((current) => `${current}${submittedPrompt}${value}\n${result.output ? `${result.output}\n` : ""}`);
        }).catch((error: unknown) => onError(error instanceof Error ? error.message : "CLI request failed"));
      };
      submitRef.current = execute;
      dataDisposable = terminal.onData((data) => {
        if (data === "\r") {
          const submitted = input;
          if (submitted) { history.push(submitted); historyIndex = history.length; }
          input = "";
          terminal.write("\r\n");
          execute(submitted, true);
          return;
        }
        if (data === "\u007f") {
          if (input.length > 0) { input = input.slice(0, -1); terminal.write("\b \b"); }
          return;
        }
        if (data === "\x1b[A" || data === "\x1b[B") {
          historyIndex = data === "\x1b[A" ? Math.max(0, historyIndex - 1) : Math.min(history.length, historyIndex + 1);
          input = history[historyIndex] ?? "";
          redrawInput();
          return;
        }
        if (/^[\x20-\x7e]+$/.test(data)) { input += data; terminal.write(data); }
      });
      execute("");
      window.requestAnimationFrame(() => { if (!disposed && active) { try { fit.fit(); } catch { /* zero-sized dock */ } } });
    }).catch(() => onError("Terminal component failed to load"));

    const fitTerminal = () => { if (active) { try { fitRef.current?.fit(); } catch { /* zero-sized dock */ } } };
    window.addEventListener("resize", fitTerminal);
    return () => {
      disposed = true;
      submitRef.current = () => undefined;
      window.removeEventListener("resize", fitTerminal);
      dataDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      void client.request({ type: "CLOSE_CLI_SESSION", sessionId }).catch(() => undefined);
    };
  }, [client, deviceId, onError]);

  useEffect(() => {
    if (active) window.requestAnimationFrame(() => { try { fitRef.current?.fit(); } catch { /* dock transition */ } });
  }, [active]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (!value) return;
    submitRef.current(value);
    setCommand("");
  };
  const copy = () => {
    const text = terminalRef.current?.getSelection() || transcript;
    if (text) void navigator.clipboard?.writeText(text).catch(() => onError("Clipboard permission was denied"));
  };
  const clear = () => {
    terminalRef.current?.clear();
    setTranscript("");
  };

  return (
    <section className={`terminal-session ${active ? "is-active" : ""}`} aria-label={`${hostname} CLI`} aria-hidden={!active} hidden={!active}>
      <div className="terminal-session__actions">
        <span><i className={ready ? "is-ready" : ""} />{ready ? "Connected" : "Loading terminal…"}</span>
        <IconButton label="Copy terminal text" icon={<Clipboard size={13} />} onClick={copy} />
        <IconButton label="Clear terminal" icon={<Eraser size={13} />} onClick={clear} />
      </div>
      <div ref={hostRef} className="xterm-host" />
      <form className="terminal-command" onSubmit={submit}>
        <label htmlFor={`terminal-command-${deviceId}`}>CLI command</label>
        <input id={`terminal-command-${deviceId}`} aria-label="CLI command" value={command} disabled={!enabled || !ready} onChange={(event) => setCommand(event.target.value)} placeholder={enabled ? "e.g. show vlan brief" : "Switch to Simulate mode to use CLI"} autoComplete="off" />
        <button type="submit" disabled={!enabled || !ready || !command.trim()}><Plus size={13} /> Send</button>
      </form>
      <pre className="visually-hidden" data-testid={active ? "terminal-transcript" : `terminal-transcript-${deviceId}`} aria-live="polite">{transcript}</pre>
    </section>
  );
}

export default TerminalWorkspace;

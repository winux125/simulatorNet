import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";

interface TerminalPanelProps {
  client: SimulatorClient;
  deviceId: string | undefined;
  hostname: string | undefined;
  available: boolean;
  onError(message: string): void;
}

function terminalText(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

export function TerminalPanel({ client, deviceId, hostname, available, onError }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<(command: string, alreadyEchoed?: boolean) => void>(() => undefined);
  const [command, setCommand] = useState("");
  const [transcript, setTranscript] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !deviceId || !available) return;
    setTranscript("");
    const sessionId = `terminal:${deviceId}`;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 1000,
      theme: { background: "#080b10", foreground: "#d8e1ef", cursor: "#7dd3fc", selectionBackground: "#24435a" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    let prompt = "";
    let input = "";
    let disposed = false;
    const history: string[] = [];
    let historyIndex = 0;

    const redrawInput = () => terminal.write(`\x1b[2K\r${prompt}${input}`);
    const execute = (value: string, alreadyEchoed = false) => {
      const submittedPrompt = prompt;
      if (!alreadyEchoed) terminal.write(`${terminalText(value)}\r\n`);
      void client.request({ type: "EXECUTE_CLI", sessionId, deviceId, input: value }).then((result) => {
        if (disposed) return;
        if (result.output) terminal.write(`${terminalText(result.output)}\r\n`);
        prompt = result.prompt;
        terminal.write(prompt);
        if (value || result.output) {
          setTranscript((current) => `${current}${submittedPrompt}${value}\n${result.output ? `${result.output}\n` : ""}`);
        }
      }).catch((error: unknown) => onError(error instanceof Error ? error.message : "CLI request failed"));
    };
    submitRef.current = execute;

    const dataDisposable = terminal.onData((data) => {
      if (data === "\r") {
        const submitted = input;
        if (submitted) {
          history.push(submitted);
          historyIndex = history.length;
        }
        input = "";
        terminal.write("\r\n");
        execute(submitted, true);
        return;
      }
      if (data === "\u007f") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          terminal.write("\b \b");
        }
        return;
      }
      if (data === "\x1b[A" || data === "\x1b[B") {
        if (data === "\x1b[A") historyIndex = Math.max(0, historyIndex - 1);
        else historyIndex = Math.min(history.length, historyIndex + 1);
        input = history[historyIndex] ?? "";
        redrawInput();
        return;
      }
      if (/^[\x20-\x7e]+$/.test(data)) {
        input += data;
        terminal.write(data);
      }
    });
    const fitTerminal = () => {
      try { fit.fit(); } catch { /* hidden panel can have zero dimensions */ }
    };
    window.addEventListener("resize", fitTerminal);
    window.requestAnimationFrame(fitTerminal);
    execute("");

    return () => {
      disposed = true;
      submitRef.current = () => undefined;
      window.removeEventListener("resize", fitTerminal);
      dataDisposable.dispose();
      terminal.dispose();
      void client.request({ type: "CLOSE_CLI_SESSION", sessionId }).catch(() => undefined);
    };
  }, [available, client, deviceId, onError]);

  const submitAccessibleCommand = (event: React.FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (!value) return;
    submitRef.current(value);
    setCommand("");
  };

  return (
    <section className="terminal-panel" aria-label="Device terminal">
      <div className="terminal-title">
        <div><span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span><strong>Device Terminal</strong></div>
        <span>{deviceId && available ? `${hostname ?? deviceId} · ${deviceId}` : "Select a running device"}</span>
      </div>
      <div className="terminal-body">
        {deviceId && available ? <div ref={hostRef} className="xterm-host" /> : (
          <div className="terminal-placeholder"><span>&gt;_</span><p>Select a device on the topology canvas to open its isolated CLI session.</p></div>
        )}
      </div>
      <form className="terminal-command" onSubmit={submitAccessibleCommand}>
        <label htmlFor="terminal-command-input">CLI command</label>
        <input
          id="terminal-command-input"
          value={command}
          disabled={!deviceId || !available}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Type a command, e.g. ping 192.168.20.10"
          autoComplete="off"
        />
        <button type="submit" disabled={!deviceId || !available || !command.trim()}>Send</button>
      </form>
      <pre className="visually-hidden" data-testid="terminal-transcript" aria-live="polite">{transcript}</pre>
    </section>
  );
}

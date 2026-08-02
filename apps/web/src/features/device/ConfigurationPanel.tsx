/**
 * The device Configuration workspace.
 *
 * One Config section with four secondary views — Running Config, Startup
 * Config, Compare and Import / Paste — over the *same* structured configuration
 * the CLI edits. The panel renders nothing itself: every byte of text comes
 * from the worker, which projects it from structured state, so the workspace
 * can never show a configuration the engine does not actually hold.
 *
 * Raw JSON deliberately does not appear here. It is still the canonical model,
 * but it belongs in File ▸ Advanced, not in a network engineer's daily view.
 */
import { createPasswordVerifier } from "@sim/console-auth";
import {
  applyDeviceConfigurationPlan,
  buildConsoleAccessFromCredentials,
  diffConfigurationText,
  inspectDeviceConfigurationText,
  parseConfigurationCredentials,
  type ConfigApplyPlan,
} from "@sim/device-config";
import type { DeviceConfigurationView } from "@sim/sim-worker";
import {
  AlertTriangle, Check, ClipboardCopy, Download, Eraser, FileUp, RotateCcw, Save, Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button, IconButton } from "../../ui";
import {
  CONFIGURATION_SECTIONS,
  configurationFileName,
  driftSummary,
  numberedLines,
  readConfigurationFileText,
  type ConfigurationSection,
} from "./configuration-text";

interface ConfigurationPanelProps {
  client: SimulatorClient;
  deviceId: string;
  hostname: string;
  runtimeAvailable: boolean;
  onConfigurationChanged(document: import("@sim/contracts").LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
}

export function downloadConfigurationText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ConfigurationPanel(props: ConfigurationPanelProps) {
  const [section, setSection] = useState<ConfigurationSection>("running");
  const [view, setView] = useState<DeviceConfigurationView>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    const next = await props.client.request({ type: "GET_DEVICE_CONFIGURATION", deviceId: props.deviceId });
    setView(next);
    return next;
  }, [props.client, props.deviceId]);

  useEffect(() => {
    let active = true;
    void props.client.request({ type: "GET_DEVICE_CONFIGURATION", deviceId: props.deviceId })
      .then((next) => { if (active) setView(next); })
      .catch((error) => {
        if (active) props.onError(error instanceof Error ? error.message : "Unable to read the device configuration");
      });
    return () => { active = false; };
  }, [props.client, props.deviceId, props.onError]);

  /** Every mutating action reports its outcome and re-syncs the document. */
  const run = useCallback(async (label: string, action: () => Promise<DeviceConfigurationView>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const next = await action();
      setView(next);
      props.onConfigurationChanged(next.document, true);
      setNotice(label);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Configuration action failed");
    } finally {
      setBusy(false);
    }
  }, [props]);

  if (!props.runtimeAvailable) {
    return <div className="device-window-section">
      <p className="section-eyebrow">Pending rebuild</p>
      <h2>Start the lab to read this device&apos;s configuration</h2>
      <p>The running configuration is rendered from the live device, so it becomes available after Apply &amp; Rebuild.</p>
    </div>;
  }
  if (!view) return <div className="device-window-section">Loading configuration…</div>;

  const diff = diffConfigurationText(view.startupConfigurationText, view.runningConfigurationText);
  const changed = diff.added + diff.removed;

  return <div className="device-configuration">
    <header className="device-configuration__header">
      <nav className="device-configuration__sections" role="tablist" aria-label="Configuration sections">
        {CONFIGURATION_SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={section === entry.id}
            className={section === entry.id ? "is-active" : ""}
            onClick={() => setSection(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <ConfigurationStatusBadge drift={view.drift} changedLines={changed} />
    </header>
    {notice && <p className="device-configuration__notice" role="status"><Check size={13} /> {notice}</p>}

    {section === "running" && <ConfigurationViewer
      title="Running configuration"
      note="Rendered from the device's structured configuration. Credentials appear only as <configured>."
      text={view.runningConfigurationText}
      fileName={configurationFileName(view.hostname, "running")}
      actions={<>
        <Button size="sm" disabled={busy} onClick={() => void run(
          "Running configuration copied to startup.",
          () => props.client.request({ type: "SAVE_DEVICE_CONFIGURATION", deviceId: props.deviceId }),
        )}><Save size={13} /> Copy Running to Startup</Button>
        {view.supportsConfigurationApply && (
          <Button size="sm" variant="ghost" onClick={() => setSection("import")}>Apply Text Config…</Button>
        )}
      </>}
    />}

    {section === "startup" && <StartupSection
      view={view}
      busy={busy}
      onImport={() => setSection("import")}
      onErase={() => void run(
        "Startup configuration erased. The running configuration is unchanged until a reload.",
        () => props.client.request({ type: "ERASE_DEVICE_STARTUP_CONFIGURATION", deviceId: props.deviceId }),
      )}
      onLoadIntoRunning={() => void run(
        "Device reloaded from its startup configuration.",
        () => props.client.request({ type: "RELOAD_DEVICE", deviceId: props.deviceId, save: false }),
      )}
    />}

    {section === "compare" && <CompareSection view={view} diff={diff} />}

    {section === "import" && <ImportSection
      view={view}
      busy={busy}
      onError={props.onError}
      onApplied={(label, configuration, target) => void run(label, async () => {
        await props.client.request({
          type: "APPLY_DEVICE_CONFIGURATION",
          deviceId: props.deviceId,
          configuration,
          target,
        });
        setSection(target === "startup" ? "startup" : "running");
        return load();
      })}
    />}
  </div>;
}

export function ConfigurationStatusBadge({ drift, changedLines }: { drift: string; changedLines: number }) {
  const label = drift === "saved" ? "Saved" : drift === "modified" ? "Modified" : "No startup configuration";
  return <span className="configuration-status" data-drift={drift} title={driftSummary(drift, changedLines)}>
    Configuration: <strong>{label}</strong>
  </span>;
}

/**
 * A read-only monospace viewer with line numbers and an in-panel search. It is
 * deliberately a `<pre>` and a `<textarea>`, not an embedded code editor: a
 * heavyweight editor would be a large dependency for a read-mostly surface.
 */
function ConfigurationViewer({ title, note, text, fileName, actions }: {
  title: string;
  note: string;
  text: string;
  fileName: string;
  actions?: React.ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => numberedLines(text, search), [text, search]);
  const matches = lines.filter((line) => line.match).length;

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setSearchOpen(true);
      window.requestAnimationFrame(() => searchRef.current?.focus());
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, []);

  return <section className="configuration-pane" ref={container} tabIndex={-1}>
    <header className="configuration-pane__toolbar">
      <div>
        <p className="section-eyebrow">{title}</p>
        <p className="section-note">{note}</p>
      </div>
      <div className="configuration-pane__actions">
        <IconButton label="Search configuration" icon={<Search size={14} />} onClick={() => {
          setSearchOpen((open) => !open);
          window.requestAnimationFrame(() => searchRef.current?.focus());
        }} />
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(text)}>
          <ClipboardCopy size={13} /> Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={() => downloadConfigurationText(text, fileName)}>
          <Download size={13} /> Download .cfg
        </Button>
        {actions}
      </div>
    </header>
    {searchOpen && <div className="configuration-pane__search">
      <input
        ref={searchRef}
        aria-label="Find in configuration"
        placeholder="Find in configuration"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <span>{matches} matching line{matches === 1 ? "" : "s"}</span>
    </div>}
    <div className="configuration-pane__body">
      <pre className="configuration-listing" aria-label={title}>
        {lines.map((line) => (
          <span key={line.number} className={line.match ? "is-match" : undefined}>
            <span className="configuration-listing__number" aria-hidden="true">{line.number}</span>
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  </section>;
}

function StartupSection({ view, busy, onImport, onErase, onLoadIntoRunning }: {
  view: DeviceConfigurationView;
  busy: boolean;
  onImport(): void;
  onErase(): void;
  onLoadIntoRunning(): void;
}) {
  const [confirm, setConfirm] = useState<"erase" | "load">();
  return <>
    <ConfigurationViewer
      title="Startup configuration"
      note="The saved snapshot a reload boots from. It stores configuration only — never runtime state."
      text={view.startupConfigurationText}
      fileName={configurationFileName(view.hostname, "startup")}
      actions={<>
        {view.supportsConfigurationApply && (
          <Button size="sm" variant="ghost" onClick={onImport}>Replace from text/file…</Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("load")}>
          <RotateCcw size={13} /> Load into Running
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("erase")}>
          <Eraser size={13} /> Erase
        </Button>
      </>}
    />
    {confirm === "erase" && <ConfirmStrip
      message="Erasing the NVRAM removes the saved configuration file. The running configuration is unchanged until this device reloads."
      confirmLabel="Erase startup-config"
      danger
      onCancel={() => setConfirm(undefined)}
      onConfirm={() => { setConfirm(undefined); onErase(); }}
    />}
    {confirm === "load" && <ConfirmStrip
      message="This reloads the device from its startup configuration. Unsaved running changes are discarded and this device's runtime state is cleared; other devices keep running."
      confirmLabel="Reload from startup"
      danger
      onCancel={() => setConfirm(undefined)}
      onConfirm={() => { setConfirm(undefined); onLoadIntoRunning(); }}
    />}
  </>;
}

function CompareSection({ view, diff }: {
  view: DeviceConfigurationView;
  diff: ReturnType<typeof diffConfigurationText>;
}) {
  const changed = diff.added + diff.removed;
  return <section className="configuration-pane">
    <header className="configuration-pane__toolbar">
      <div>
        <p className="section-eyebrow">Startup → Running</p>
        <p className="section-note">{driftSummary(view.drift, changed)} The diff is computed from the rendered projections; it is never a configuration source.</p>
      </div>
    </header>
    <div className="configuration-pane__body">
      {changed === 0
        ? <p className="section-note">The running and startup configurations are identical.</p>
        : <pre className="configuration-listing configuration-listing--diff" aria-label="Configuration differences">
          {diff.lines.map((line, index) => (
            <span key={`${line.kind}-${index}`} data-diff={line.kind}>
              <span className="configuration-listing__number" aria-hidden="true">
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
              </span>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>}
    </div>
  </section>;
}

function ImportSection({ view, busy, onError, onApplied }: {
  view: DeviceConfigurationView;
  busy: boolean;
  onError(message: string): void;
  onApplied(
    label: string,
    configuration: import("@sim/contracts").DeviceConfig,
    target: "running" | "startup",
  ): void;
}) {
  const [target, setTarget] = useState<"running" | "startup">("running");
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<ConfigApplyPlan>();
  const fileInput = useRef<HTMLInputElement>(null);

  if (!view.supportsConfigurationApply) {
    return <section className="configuration-pane">
      <header className="configuration-pane__toolbar">
        <div>
          <p className="section-eyebrow">Import / Paste</p>
          <p className="section-note">
            A {view.deviceType} renders and exports a readable configuration, but it is configured through its own
            panels. Applying text back is not supported for this device type.
          </p>
        </div>
      </header>
    </section>;
  }

  const parse = () => {
    setPlan(inspectDeviceConfigurationText(text, {
      deviceId: view.deviceId,
      deviceType: view.deviceType,
      interfaceIds: view.interfaceIds,
      fallbackHostname: view.hostname,
    }));
  };

  const apply = async () => {
    if (!plan) return;
    // Credentials are derived here, in the main thread, exactly like a typed
    // password: only the verifier ever crosses into the worker.
    const credentials = parseConfigurationCredentials(text);
    const consoleAccess = await buildConsoleAccessFromCredentials(credentials, createPasswordVerifier);
    const result = applyDeviceConfigurationPlan(plan, {
      current: view.configuration,
      consoleAccess,
      acceptUnsupportedLines: true,
    });
    if (result.status !== "applied" || !result.configuration) {
      onError(result.message);
      return;
    }
    onApplied(result.message, result.configuration, target);
    setText("");
    setPlan(undefined);
  };

  const chooseFile = (file: File) => void file.text().then((raw) => {
    const read = readConfigurationFileText(raw);
    if (read.status === "rejected") { onError(read.message); return; }
    setText(read.text);
    setPlan(undefined);
  }).catch(() => onError("Unable to read that configuration file."));

  return <section className="configuration-pane">
    <header className="configuration-pane__toolbar">
      <div>
        <p className="section-eyebrow">Import / Paste</p>
        <p className="section-note">Paste a configuration or upload a <code>.cfg</code>/<code>.txt</code> file. Nothing is applied until you review the report.</p>
      </div>
      <div className="configuration-pane__actions">
        <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}><FileUp size={13} /> Upload…</Button>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          accept=".cfg,.txt,text/plain"
          aria-label="Upload configuration file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) chooseFile(file);
            event.target.value = "";
          }}
        />
      </div>
    </header>
    <div className="configuration-pane__body configuration-import">
      <fieldset className="configuration-import__target">
        <legend>Apply to</legend>
        {(["running", "startup"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="configuration-target"
              value={value}
              checked={target === value}
              onChange={() => setTarget(value)}
            />
            {value === "running" ? "Running configuration" : "Startup configuration"}
          </label>
        ))}
      </fieldset>
      <textarea
        className="configuration-editor"
        aria-label="Configuration text"
        spellCheck={false}
        placeholder={"hostname BRANCH\n!\ninterface Gi0/0\n ip address 192.0.2.1 255.255.255.0\n no shutdown"}
        value={text}
        onChange={(event) => { setText(event.target.value); setPlan(undefined); }}
      />
      <div className="configuration-import__actions">
        <Button size="sm" disabled={text.trim().length === 0} onClick={parse}>Parse</Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !plan || plan.problems.length > 0}
          onClick={() => void apply()}
        >
          Apply to {target === "running" ? "running" : "startup"}
        </Button>
      </div>
      {plan && <ConfigurationPlanReport plan={plan} />}
    </div>
  </section>;
}

function ConfigurationPlanReport({ plan }: { plan: ConfigApplyPlan }) {
  return <div className="configuration-report">
    <p className="section-eyebrow">Parse report</p>
    <ul className="configuration-report__summary">
      <li><strong>{plan.appliedCount}</strong> supported line(s)</li>
      <li><strong>{plan.unsupportedCount}</strong> unsupported line(s)</li>
      <li><strong>{plan.credentials.length}</strong> credential(s)</li>
    </ul>
    {plan.problems.map((problem) => (
      <p key={problem.code} className="configuration-report__problem" role="alert">
        <AlertTriangle size={13} /> {problem.message}
      </p>
    ))}
    {plan.warnings.map((warning) => (
      <p key={warning} className="configuration-report__warning"><AlertTriangle size={13} /> {warning}</p>
    ))}
    {plan.credentials.length > 0 && <p className="section-note">
      Credentials are stored as verifiers. No password from this text is kept in the clear, and none is ever shown again.
    </p>}
    {plan.unsupportedCount > 0 && <table className="data-table configuration-report__lines">
      <thead><tr><th>Line</th><th>Unsupported command</th></tr></thead>
      <tbody>
        {plan.lines.filter((line) => line.outcome === "unsupported").map((line) => (
          <tr key={line.number}><td>{line.number}</td><td><code>{line.text}</code></td></tr>
        ))}
      </tbody>
    </table>}
    {plan.truncatedLines > 0 && <p className="section-note">{plan.truncatedLines} further line(s) are not listed.</p>}
  </div>;
}

function ConfirmStrip({ message, confirmLabel, danger, onCancel, onConfirm }: {
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  return <div className="configuration-confirm" role="alertdialog" aria-label={confirmLabel}>
    <p>{message}</p>
    <div className="dialog-actions">
      <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button size="sm" variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </div>;
}

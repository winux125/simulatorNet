import { DEVICE_TYPES, getDeviceProfile, type DeviceType, type LabDocument } from "@sim/contracts";
import {
  DEFAULT_IMPORT_LIMITS,
  applyImportedConsoleCredentials,
  applyImportedWirelessCredentials,
  detectLabImportFormat,
  executeLabImport,
  inspectLabImport,
  registerBuiltinImportAdapters,
  UnsupportedImportFormatError,
  type ImportMappingDecision,
  type ImportMappingProposal,
  type ImportMappingSelection,
  type ImportPlan,
  type ImportReport,
  type ImportReportEntry,
  type ImportResult,
  type ImportSupportLevel,
} from "@sim/importers";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileArchive,
  FileSearch,
  FileWarning,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Button, IconButton } from "../../ui";

registerBuiltinImportAdapters();

interface ImportLabWizardProps {
  file: File;
  onCancel(): void;
  onImported(document: LabDocument): void;
  onError(message: string): void;
}

type WizardPhase = "detecting" | "ready" | "unsupported" | "error" | "importing" | "result";
type WizardStep = 0 | 1 | 2 | 3 | 4;

const STEPS = ["Select File", "Inspect", "Map Devices", "Review Warnings", "Import Result"] as const;
const DEVICE_OPTIONS = DEVICE_TYPES.filter((type) => type !== "external-appliance");
const FOCUSABLE = [
  "button:not([disabled])",
  "select:not([disabled])",
  "input:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function decisionValue(decision: ImportMappingDecision | undefined): string {
  if (!decision) return "auto";
  if (decision.kind === "device") return `device:${decision.deviceType}`;
  return decision.kind;
}

function formatName(format: string | undefined): string {
  if (!format) return "Detecting";
  return {
    simulatornet: "SimulatorNet",
    "pnetlab-unl": "PNETLab UNL",
    "eve-ng-unl": "EVE-NG UNL",
    "gns3-project": "GNS3",
    "gns3-portable": "GNS3 portable archive",
    "containerlab-yaml": "Containerlab",
    "cml-yaml": "CML",
    "virl-xml": "VIRL",
    "packet-tracer-pkt": "Packet Tracer PKT",
    "packet-tracer-pka": "Packet Tracer PKA",
  }[format] ?? format;
}

function fileSize(bytes: number): string {
  if (bytes >= 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

export function ImportLabWizard({ file, onCancel, onImported, onError }: ImportLabWizardProps) {
  const [activeFile, setActiveFile] = useState(file);
  const [phase, setPhase] = useState<WizardPhase>("detecting");
  const [step, setStep] = useState<WizardStep>(0);
  const [plan, setPlan] = useState<ImportPlan>();
  const [result, setResult] = useState<ImportResult>();
  const [selection, setSelection] = useState<ImportMappingSelection>({});
  const [message, setMessage] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setActiveFile(file);
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    setPhase("detecting");
    setPlan(undefined);
    setResult(undefined);
    setSelection({});
    setMessage(undefined);
    void (async () => {
      try {
        const bytes = new Uint8Array(await activeFile.arrayBuffer());
        const source = { filename: activeFile.name, bytes };
        const detection = detectLabImportFormat(source);
        if (!detection.supported) {
          if (cancelled) return;
          setPhase("unsupported");
          setMessage(detection.format.startsWith("packet-tracer")
            ? "Packet Tracer files are recognised, but direct conversion is unavailable. Keep the original file and export through a supported intermediate topology format."
            : "This file was not recognised as a supported network-lab format.");
          return;
        }
        const inspected = await inspectLabImport(source);
        if (cancelled) return;
        setPlan(inspected);
        setPhase("ready");
      } catch (error) {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : "Import inspection failed";
        setPhase(error instanceof UnsupportedImportFormatError ? "unsupported" : "error");
        setMessage(detail);
      }
    })();
    return () => { cancelled = true; };
  }, [activeFile]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const replaceFile = (next: File | undefined) => {
    if (!next) return;
    setStep(0);
    setActiveFile(next);
  };

  const setDecision = (nodeId: string, value: string) => {
    setSelection((current) => {
      const next = { ...current };
      if (value === "auto") delete next[nodeId];
      else if (value === "placeholder") next[nodeId] = { kind: "placeholder" };
      else if (value === "exclude") next[nodeId] = { kind: "exclude" };
      else next[nodeId] = { kind: "device", deviceType: value.slice("device:".length) as DeviceType };
      return next;
    });
  };

  const acceptSuggestions = () => {
    if (!plan) return;
    setSelection(Object.fromEntries(plan.proposals.map((proposal) => [
      proposal.sourceNodeId,
      proposal.suggestedDeviceType
        ? { kind: "device", deviceType: proposal.suggestedDeviceType }
        : { kind: "placeholder" },
    ])));
  };

  const runImport = async () => {
    if (!plan) return;
    setPhase("importing");
    try {
      const imported = await applyImportedWirelessCredentials(
        await applyImportedConsoleCredentials(executeLabImport(plan, selection)),
      );
      setResult(imported);
      setPhase("result");
      setStep(4);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Import failed";
      setPhase("ready");
      setMessage(detail);
      onError(detail);
    }
  };

  const downloadReport = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result.report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${result.document.id}-import-report.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const ready = phase === "ready" && Boolean(plan);
  const canContinue = ready && (step !== 1 || (plan?.parsed.nodes.length ?? 0) > 0);

  return (
    <div
      className="device-window-backdrop import-wizard-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && phase !== "importing") onCancel(); }}
    >
      <section
        ref={dialogRef}
        className="import-wizard"
        role="dialog"
        aria-modal="true"
        aria-label="Import Lab"
        tabIndex={-1}
        data-testid="import-wizard"
        data-overflow-boundary="hidden"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="import-wizard__header">
          <div className="import-wizard__heading">
            <span className="import-wizard__icon"><FileArchive size={20} /></span>
            <div>
              <p>Network lab conversion</p>
              <h2>Import Lab</h2>
            </div>
          </div>
          <dl className="import-wizard__file-meta">
            <div><dt>Format</dt><dd>{formatName(plan?.format)}</dd></div>
            <div><dt>File</dt><dd title={activeFile.name}>{activeFile.name}</dd></div>
          </dl>
          <IconButton data-import-close label="Close import wizard" icon={<X size={16} />} disabled={phase === "importing"} onClick={onCancel} />
          <ol className="import-wizard__steps" aria-label="Import progress">
            {STEPS.map((label, index) => (
              <li key={label} className={index === step ? "is-current" : index < step ? "is-complete" : ""} aria-current={index === step ? "step" : undefined}>
                <span>{index < step ? <CheckCircle2 size={12} /> : index + 1}</span>
                <strong>{label}</strong>
              </li>
            ))}
          </ol>
        </header>

        <div className="import-wizard__body" data-scroll-owner="import-wizard-body">
          {step === 0 && (
            <SelectFileStep
              file={activeFile}
              phase={phase}
              message={message}
              onChoose={() => fileInputRef.current?.click()}
              onDrop={replaceFile}
            />
          )}
          {step === 1 && plan && <InspectStep plan={plan} />}
          {step === 2 && plan && (
            <MappingStep
              plan={plan}
              selection={selection}
              disabled={phase === "importing"}
              onDecision={setDecision}
              onAcceptSuggestions={acceptSuggestions}
              onReset={() => setSelection({})}
            />
          )}
          {step === 3 && plan && <WarningsStep plan={plan} />}
          {step === 4 && result && <ResultStep result={result} />}
          {step > 0 && !plan && phase !== "result" && (
            <ImportState phase={phase} message={message} filename={activeFile.name} />
          )}
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            aria-label="Choose another lab file"
            accept=".json,.unl,.gns3project,.zip,.yml,.yaml,.xml,.virl,.pkt,.pka"
            onChange={(event) => {
              replaceFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>

        <footer className="import-wizard__footer" data-testid="import-wizard-footer">
          <div>
            {step > 0 && step < 4 && <Button variant="ghost" disabled={phase === "importing"} onClick={() => setStep((step - 1) as WizardStep)}>Back</Button>}
            <Button variant="ghost" disabled={phase === "importing"} onClick={onCancel}>{step === 4 ? "Close" : "Cancel"}</Button>
          </div>
          <span>{step + 1} of {STEPS.length} · {STEPS[step]}</span>
          <div>
            {step < 3 && (
              <Button
                variant="primary"
                disabled={!canContinue}
                data-testid="import-continue"
                onClick={() => setStep((step + 1) as WizardStep)}
              >
                Continue
              </Button>
            )}
            {step === 3 && (
              <Button variant="primary" disabled={!ready || !plan?.importable} data-testid="import-confirm" onClick={() => void runImport()}>
                {phase === "importing" ? "Importing…" : "Import Lab"}
              </Button>
            )}
            {step === 4 && result && <>
              <Button icon={<Download size={14} />} onClick={downloadReport}>Download Import Report</Button>
              <Button variant="primary" data-testid="import-open" onClick={() => onImported(result.document)}>Open Lab</Button>
            </>}
          </div>
        </footer>
      </section>
    </div>
  );
}

function SelectFileStep({ file, phase, message, onChoose, onDrop }: {
  file: File;
  phase: WizardPhase;
  message: string | undefined;
  onChoose(): void;
  onDrop(file: File | undefined): void;
}) {
  const [dragging, setDragging] = useState(false);
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onDrop(event.dataTransfer.files[0]);
  };
  return (
    <div className="import-step import-select-step">
      <div
        className={`import-drop-zone${dragging ? " is-dragging" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <Upload size={28} />
        <h3>Drop a topology file or archive</h3>
        <p><strong>{file.name}</strong> · {fileSize(file.size)}</p>
        <Button onClick={onChoose}>Choose File</Button>
      </div>
      <div className="import-format-grid">
        {[
          ["SimulatorNet", "Native JSON labs"],
          ["PNETLab / EVE-NG", "UNL topology"],
          ["GNS3", "Project or portable archive"],
          ["Containerlab", "YAML topology"],
          ["CML / VIRL", "YAML or XML topology"],
        ].map(([name, detail]) => <div key={name}><CheckCircle2 size={14} /><span><strong>{name}</strong><small>{detail}</small></span></div>)}
      </div>
      <div className="import-safe-notice"><ShieldCheck size={17} /><p><strong>Safe local conversion.</strong> No VM images, executables, scripts or remote resources are run. Maximum input size is {fileSize(DEFAULT_IMPORT_LIMITS.maxInputBytes)}.</p></div>
      <div className="import-boundary-notice"><FileWarning size={17} /><p><strong>Packet Tracer:</strong> recognised, but direct conversion is unavailable.</p></div>
      <ImportState phase={phase} message={message} filename={file.name} />
    </div>
  );
}

function ImportState({ phase, message, filename }: { phase: WizardPhase; message?: string; filename: string }) {
  if (phase === "detecting") return <div className="import-state" role="status"><FileSearch size={16} /><span>Detecting and inspecting <strong>{filename}</strong>…</span></div>;
  if (phase === "unsupported" || phase === "error") {
    return <div className="import-state is-error" role="alert" data-testid="import-unsupported"><AlertCircle size={16} /><span>{message ?? "The file could not be inspected."}</span></div>;
  }
  if (phase === "ready") return <div className="import-state is-ready" role="status"><CheckCircle2 size={16} /><span>Inspection complete. Continue to review the source.</span></div>;
  return null;
}

function InspectStep({ plan }: { plan: ImportPlan }) {
  const cards = [
    ["Format", formatName(plan.format)],
    ["Nodes", String(plan.parsed.nodes.length)],
    ["Links", String(plan.parsed.links.length)],
    ["Annotations", String(plan.report.importedAnnotationCount)],
    ["Startup Configs", String(plan.report.importedStartupConfigs)],
    ["Ignored Images / Binaries", String(plan.report.ignoredVendorImages.length)],
    ["Warnings", String(plan.report.warningCount)],
  ];
  return (
    <div className="import-step">
      <StepHeading eyebrow="Source inspection" title="Review detected content" description="This summary is produced before any topology is added to the workspace." />
      <div className="import-summary-grid">
        {cards.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <details className="import-source-details">
        <summary>Source details <ChevronDown size={14} /></summary>
        <dl>
          <div><dt>Platform</dt><dd>{plan.platform}</dd></div>
          <div><dt>Source version</dt><dd>{plan.sourceVersion ?? "Not declared"}</dd></div>
          <div><dt>Lab title</dt><dd>{plan.labTitle ?? "Generated from filename"}</dd></div>
          <div><dt>Archive entries ignored</dt><dd>{plan.report.ignoredFiles.length}</dd></div>
          <div><dt>Unparsed configuration lines</dt><dd>{plan.report.unparsedConfigLines}</dd></div>
        </dl>
      </details>
      {plan.parsed.nodes.length === 0 && <div className="import-empty-state"><AlertTriangle size={20} /><div><strong>No nodes were found</strong><p>The source is valid but does not contain a topology that can be mapped.</p></div></div>}
      {plan.report.ignoredVendorImages.length > 0 && (
        <div className="import-safe-notice" data-testid="import-ignored-images"><ShieldCheck size={17} /><p>Vendor appliance images and binaries are ignored. SimulatorNet imports topology and supported structured configuration only.</p></div>
      )}
    </div>
  );
}

function MappingStep({ plan, selection, disabled, onDecision, onAcceptSuggestions, onReset }: {
  plan: ImportPlan;
  selection: ImportMappingSelection;
  disabled: boolean;
  onDecision(nodeId: string, value: string): void;
  onAcceptSuggestions(): void;
  onReset(): void;
}) {
  const [search, setSearch] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const proposals = useMemo(() => plan.proposals.filter((proposal) => {
    const query = search.trim().toLowerCase();
    const searchable = `${proposal.label} ${proposal.sourceKind} ${proposal.suggestedDeviceType ?? ""}`.toLowerCase();
    return (!query || searchable.includes(query)) && (!attentionOnly || needsAttention(proposal));
  }), [attentionOnly, plan.proposals, search]);
  return (
    <div className="import-step import-mapping-step">
      <StepHeading eyebrow="Device conversion" title="Map source devices" description="Accept suggested SimulatorNet devices, keep a visual placeholder, or exclude a source node." />
      <div className="import-mapping-tools">
        <label className="import-search"><Search size={14} /><input aria-label="Search source devices" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search hostname or kind" /></label>
        <label className="import-attention-filter"><input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} /> Needs Attention</label>
        <Button size="sm" onClick={onAcceptSuggestions}>Accept All Suggested</Button>
        <Button size="sm" variant="ghost" onClick={onReset}>Reset Mappings</Button>
      </div>
      <div className="import-mapping-table-wrap" data-scroll-owner="mapping-table" data-testid="import-mapping">
        <table className="data-table import-wizard__mapping">
          <thead><tr><th>Source Node</th><th>Source Kind</th><th>Suggested Mapping</th><th>Support Level</th><th>Target Type</th><th>Interfaces</th><th>Status</th></tr></thead>
          <tbody>
            {proposals.map((proposal) => (
              <MappingRow
                key={proposal.sourceNodeId}
                proposal={proposal}
                sourceInterfaces={plan.parsed.nodes.find((node) => node.id === proposal.sourceNodeId)?.interfaces.length ?? 0}
                value={decisionValue(selection[proposal.sourceNodeId])}
                disabled={disabled}
                onDecision={(value) => onDecision(proposal.sourceNodeId, value)}
              />
            ))}
          </tbody>
        </table>
        {proposals.length === 0 && <div className="import-empty-state"><Search size={18} /><div><strong>No matching devices</strong><p>Clear the search or attention filter.</p></div></div>}
      </div>
    </div>
  );
}

function MappingRow({ proposal, sourceInterfaces, value, disabled, onDecision }: {
  proposal: ImportMappingProposal;
  sourceInterfaces: number;
  value: string;
  disabled: boolean;
  onDecision(value: string): void;
}) {
  const selectedType = value.startsWith("device:")
    ? value.slice("device:".length) as DeviceType
    : value === "auto" ? proposal.suggestedDeviceType : undefined;
  return (
    <tr data-attention={needsAttention(proposal)}>
      <td data-label="Source Node"><span className="import-source-node"><FileArchive size={15} /><strong>{proposal.label}</strong></span></td>
      <td data-label="Source Kind"><code>{proposal.sourceKind}</code></td>
      <td data-label="Suggested Mapping">
        <span className="import-target-hint">
          {proposal.suggestedDeviceType ? <DeviceIcon type={proposal.suggestedDeviceType} size={24} /> : <FileWarning size={20} />}
          <span>{proposal.suggestedDeviceType ? getDeviceProfile(proposal.suggestedDeviceType).displayName : "External Appliance"}</span>
        </span>
      </td>
      <td data-label="Support Level"><SupportBadge level={proposal.supportLevel} /></td>
      <td data-label="Target Type">
        <span className="import-target-select">
          {selectedType ? <DeviceIcon type={selectedType} size={22} /> : <FileWarning size={18} />}
          <select aria-label={`Map ${proposal.label}`} value={value} disabled={disabled} onChange={(event) => onDecision(event.target.value)}>
            <option value="auto">Suggested · {proposal.suggestedDeviceType ? getDeviceProfile(proposal.suggestedDeviceType).displayName : "External Appliance"}</option>
            {DEVICE_OPTIONS.map((type) => <option key={type} value={`device:${type}`}>{getDeviceProfile(type).displayName}</option>)}
            <option value="placeholder">External Appliance (placeholder)</option>
            <option value="exclude">Exclude node</option>
          </select>
        </span>
      </td>
      <td data-label="Interfaces">{sourceInterfaces}</td>
      <td data-label="Status">
        {proposal.interfaceWarning
          ? <details className="import-row-warning"><summary><AlertTriangle size={13} /> Attention</summary><p>{proposal.interfaceWarning}</p></details>
          : <span className="import-row-ok"><CheckCircle2 size={13} /> Ready</span>}
      </td>
    </tr>
  );
}

function SupportBadge({ level }: { level: ImportSupportLevel }) {
  return <span className={`import-support import-support--${level}`}>{level.replaceAll("-", " ")}</span>;
}

function needsAttention(proposal: ImportMappingProposal): boolean {
  return Boolean(proposal.interfaceWarning) || !proposal.suggestedDeviceType || proposal.supportLevel !== "full";
}

function WarningsStep({ plan }: { plan: ImportPlan }) {
  const groups = warningGroups(plan.report);
  return (
    <div className="import-step">
      <StepHeading eyebrow="Conversion review" title="Review warnings" description="Warnings are grouped by impact. Passwords, hashes and vendor binaries are never displayed." />
      <div className="import-warning-groups" data-testid="import-warnings">
        {groups.map((group) => (
          <details key={group.title} open={group.entries.length > 0 && (group.severity === "error" || group.title === "Device Mapping Warnings")}>
            <summary>
              <span className={`import-warning-icon is-${group.severity}`}>{group.severity === "error" ? <AlertCircle size={15} /> : <AlertTriangle size={15} />}</span>
              <strong>{group.title}</strong>
              <small>{group.entries.length}</small>
              <ChevronDown size={14} />
            </summary>
            {group.entries.length === 0
              ? <p className="import-warning-empty">No findings in this category.</p>
              : <ul>{group.entries.map((entry, index) => <li key={`${entry.code}-${index}`}><span>{entry.level}</span><div><strong>{entry.nodeId ?? "Lab"}</strong><p>{entry.message}</p><code>{entry.code}</code></div></li>)}</ul>}
          </details>
        ))}
      </div>
      <div className="import-safe-notice"><ShieldCheck size={17} /><p>The lab will open stopped. Review placeholders and partial configuration before starting the simulation.</p></div>
    </div>
  );
}

function warningGroups(report: ImportReport): Array<{ title: string; severity: "warning" | "error"; entries: ImportReportEntry[] }> {
  const entries = report.entries.filter((entry) => entry.level !== "info");
  const take = (predicate: (entry: ImportReportEntry) => boolean) => entries.filter(predicate);
  return [
    { title: "Blocking Errors", severity: "error", entries: take((entry) => entry.level === "error") },
    { title: "Device Mapping Warnings", severity: "warning", entries: take((entry) => /mapping|interface|placeholder/i.test(entry.code)) },
    { title: "Partial Configuration", severity: "warning", entries: take((entry) => /config|route/i.test(entry.code)) },
    { title: "Ignored Vendor Images", severity: "warning", entries: report.ignoredVendorImages.map((name) => ({ level: "warning", code: "vendor-image-ignored", message: `Ignored vendor image: ${name}` })) },
    { title: "Unsupported Nodes", severity: "warning", entries: take((entry) => /unsupported|placeholder/i.test(entry.code)) },
    { title: "Credential Reset Required", severity: "warning", entries: take((entry) => /credential|password|secret/i.test(entry.code)) },
  ];
}

function ResultStep({ result }: { result: ImportResult }) {
  const report = result.report;
  const placeholders = result.document.topology.nodes.filter((node) => node.kind === "external-appliance").length;
  const failed = report.errorCount;
  const ignored = report.ignoredFiles.length + report.ignoredVendorImages.length;
  const status = failed > 0 ? "Failed" : report.warningCount > 0 || placeholders > 0 ? "Partially Imported" : "Imported";
  return (
    <div className="import-step import-result-step">
      <span className={`import-result-mark${failed ? " is-error" : ""}`}>{failed ? <AlertCircle size={30} /> : <CheckCircle2 size={30} />}</span>
      <p className="section-eyebrow">Conversion complete</p>
      <h3>{status}</h3>
      <p>{result.document.title} is ready to open as a stopped SimulatorNet lab.</p>
      <div className="import-result-grid">
        <div><span>Imported</span><strong>{report.importedNodeCount}</strong></div>
        <div><span>Partially Imported</span><strong>{report.warningCount}</strong></div>
        <div><span>Placeholders</span><strong>{placeholders}</strong></div>
        <div><span>Ignored</span><strong>{ignored}</strong></div>
        <div><span>Failed</span><strong>{failed}</strong></div>
      </div>
      <div className="import-safe-notice"><ShieldCheck size={17} /><p>The report contains conversion diagnostics only. Runtime state and credentials are not included.</p></div>
    </div>
  );
}

function StepHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="import-step-heading"><p>{eyebrow}</p><h3>{title}</h3><span>{description}</span></header>;
}

export default ImportLabWizard;

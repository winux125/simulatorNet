import { DEVICE_TYPES, getDeviceProfile, type DeviceType, type LabDocument } from "@sim/contracts";
import {
  DEFAULT_IMPORT_LIMITS,
  applyImportedConsoleCredentials,
  applyImportedWirelessCredentials,
  detectLabImportFormat,
  executeLabImport,
  inspectLabImport,
  inspectPacketTracerCompanions,
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
  type LabImportFormat,
  type PacketTracerDecodeStage,
  type PacketTracerInspection,
  type PacketTracerNetworkSummary,
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
  Loader2,
  Search,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Button, IconButton } from "../../ui";
import {
  createPacketTracerImportClient,
  PacketTracerInspectError,
  type PacketTracerFailureStage,
  type PacketTracerImportClient,
} from "../../worker/packet-tracer-client";

registerBuiltinImportAdapters();

interface ImportLabWizardProps {
  file: File;
  onCancel(): void;
  onImported(document: LabDocument): void;
  onError(message: string): void;
}

type WizardPhase = "detecting" | "decoding" | "ready" | "unsupported" | "error" | "importing" | "result";
type WizardStep = 0 | 1 | 2 | 3 | 4;

const STEPS = ["Select File", "Inspect", "Map Devices", "Review Warnings", "Import Result"] as const;

/**
 * Decode progress is named, never a percentage. The container's cost is not
 * knowable until it has been decrypted and inflated, so a bar would be fiction.
 */
const DECODE_STAGES: ReadonlyArray<readonly [PacketTracerDecodeStage, string]> = [
  ["reading", "Reading file"],
  ["detecting", "Identifying container"],
  ["decoding", "Decoding container"],
  ["decompressing", "Decompressing"],
  ["parsing", "Parsing topology"],
];

const NETWORK_ROLES: Record<PacketTracerNetworkSummary["role"], string> = {
  initial: "Initial network",
  answer: "Answer network",
  current: "Saved progress",
  unknown: "Network",
};
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
    "packet-tracer-companion": "Packet Tracer companion reconstruction",
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
  const [detectedFormat, setDetectedFormat] = useState<LabImportFormat>();
  const [migrationMode, setMigrationMode] = useState(false);
  const [migrationGuideOpen, setMigrationGuideOpen] = useState(false);
  const [companionFiles, setCompanionFiles] = useState<File[]>([]);
  const [migrationError, setMigrationError] = useState<string>();
  const [inspection, setInspection] = useState<PacketTracerInspection>();
  const [decodeStage, setDecodeStage] = useState<PacketTracerDecodeStage>();
  const [decodeFailure, setDecodeFailure] = useState<PacketTracerInspectError>();
  /** Set only by the network chooser; the decoder picks the default otherwise. */
  const [requestedNetworkId, setRequestedNetworkId] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const companionInputRef = useRef<HTMLInputElement>(null);
  const packetTracerRef = useRef<PacketTracerImportClient>(undefined);

  // One decoder for the wizard's lifetime: switching files or networks reuses
  // the thread, and closing the wizard releases it with nothing left running.
  useEffect(() => {
    const client = createPacketTracerImportClient();
    packetTracerRef.current = client;
    return () => {
      packetTracerRef.current = undefined;
      client.dispose();
    };
  }, []);

  useEffect(() => {
    setActiveFile(file);
    setRequestedNetworkId(undefined);
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    setPhase("detecting");
    setPlan(undefined);
    setResult(undefined);
    setSelection({});
    setMessage(undefined);
    setDetectedFormat(undefined);
    setMigrationMode(false);
    setMigrationGuideOpen(false);
    setCompanionFiles([]);
    setMigrationError(undefined);
    setInspection(undefined);
    setDecodeStage(undefined);
    setDecodeFailure(undefined);
    void (async () => {
      try {
        const bytes = new Uint8Array(await activeFile.arrayBuffer());
        const source = { filename: activeFile.name, bytes };
        const detection = detectLabImportFormat(source);
        if (cancelled) return;
        setDetectedFormat(detection.format);
        if (!detection.supported) {
          if (cancelled) return;
          setPhase("unsupported");
          setMessage("This file was not recognised as a supported network-lab format.");
          return;
        }
        if (detection.format === "packet-tracer-pkt" || detection.format === "packet-tracer-pka") {
          // Decrypting, inflating and parsing a container is far too much work
          // for the React thread, so it happens on the decode worker. Nothing
          // leaves the browser: the file is never sent to the API.
          setPhase("decoding");
          const decoded = await packetTracerRef.current!.inspect({
            filename: activeFile.name,
            bytes,
            networkId: requestedNetworkId,
            signal: abort.signal,
            onStage: (stage) => { if (!cancelled) setDecodeStage(stage); },
          });
          if (cancelled) return;
          setInspection(decoded);
          setPlan(decoded.plan);
          setPhase("ready");
          return;
        }
        const inspected = await inspectLabImport(source);
        if (cancelled) return;
        setPlan(inspected);
        setPhase("ready");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof PacketTracerInspectError) {
          if (error.cancelled) return;
          setDecodeFailure(error);
          setPhase("unsupported");
          setMessage(error.message);
          return;
        }
        const detail = error instanceof Error ? error.message : "Import inspection failed";
        setPhase(error instanceof UnsupportedImportFormatError ? "unsupported" : "error");
        setMessage(detail);
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [activeFile, requestedNetworkId]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const replaceFile = (next: File | undefined) => {
    if (!next) return;
    setStep(0);
    setActiveFile(next);
    setRequestedNetworkId(undefined);
  };

  const buildMigrationPlan = async () => {
    if (companionFiles.length === 0) return;
    setMigrationError(undefined);
    try {
      const files = await Promise.all(companionFiles.map(async (companion) => ({
        name: companion.name,
        bytes: new Uint8Array(await companion.arrayBuffer()),
      })));
      const inspected = inspectPacketTracerCompanions({ referenceFilename: activeFile.name, files });
      setPlan(inspected);
      setPhase("ready");
      setStep(1);
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : "Companion files could not be inspected");
    }
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
  // Packet Tracer owns the whole of step 0: decoding, then either its own
  // summary with explicit actions, or the companion fallback. Each carries the
  // actions it needs, so the generic footer would only duplicate them.
  const packetTracerFailed = step === 0 && decodeFailure !== undefined;
  const packetTracerDecoding = step === 0 && phase === "decoding";
  const packetTracerDecoded = step === 0
    && inspection !== undefined
    && (phase === "ready" || phase === "importing");
  const packetTracerStep = packetTracerFailed || packetTracerDecoding || packetTracerDecoded;
  const formatLabel = packetTracerFailed
    ? `${formatName(detectedFormat)} · ${FAILURE_STAGES[decodeFailure!.stage].label}`
    : formatName(plan?.format ?? detectedFormat);

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
            <span className="import-wizard__icon"><FileArchive size={16} /></span>
            <div>
              <h2>Import Lab</h2>
            </div>
          </div>
          <dl className="import-wizard__file-meta">
            <div><dt>Format</dt><dd>{formatLabel}</dd></div>
            {inspection?.packetTracerVersion && (
              <div><dt>Version</dt><dd data-testid="packet-tracer-version">{inspection.packetTracerVersion}</dd></div>
            )}
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
            packetTracerFailed ? (
              <PacketTracerMigrationStep
                file={activeFile}
                failure={decodeFailure!}
                migrationMode={migrationMode}
                guideOpen={migrationGuideOpen}
                files={companionFiles}
                error={migrationError}
                onClose={onCancel}
                onGuide={() => setMigrationGuideOpen((open) => !open)}
                onReconstruct={() => setMigrationMode(true)}
                onChoose={() => companionInputRef.current?.click()}
                onBuild={() => void buildMigrationPlan()}
              />
            ) : packetTracerDecoding ? (
              <PacketTracerDecodingStep file={activeFile} stage={decodeStage} onCancel={onCancel} />
            ) : packetTracerDecoded ? (
              <PacketTracerImportStep
                inspection={inspection!}
                plan={plan!}
                busy={phase === "importing"}
                error={phase === "ready" ? message : undefined}
                onSelectNetwork={setRequestedNetworkId}
                onReviewMapping={() => setStep(2)}
                onImport={() => void runImport()}
                onCancel={onCancel}
              />
            ) : (
              <SelectFileStep
                file={activeFile}
                phase={phase}
                message={message}
                onChoose={() => fileInputRef.current?.click()}
                onDrop={replaceFile}
              />
            )
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
          <input
            ref={companionInputRef}
            className="visually-hidden"
            type="file"
            multiple
            aria-label="Choose Packet Tracer companion files"
            accept=".png,.jpg,.jpeg,.webp,.cfg,.txt,.csv,image/png,image/jpeg,image/webp,text/plain,text/csv"
            onChange={(event) => {
              setCompanionFiles([...(event.target.files ?? [])]);
              setMigrationError(undefined);
              event.target.value = "";
            }}
          />
        </div>

        {!packetTracerStep && <footer className="import-wizard__footer" data-testid="import-wizard-footer">
          <div>
            {step > 0 && step < 4 && <Button variant="ghost" disabled={phase === "importing"} onClick={() => setStep((step - 1) as WizardStep)}>Back</Button>}
            <Button variant="ghost" disabled={phase === "importing"} onClick={onCancel}>{step === 4 ? "Close" : "Cancel"}</Button>
          </div>
          {/* The step rail in the header already reports the stage and its number. */}
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
        </footer>}
      </section>
    </div>
  );
}

/**
 * Progress for a decode in flight. Named stages only: the container does not
 * declare its own size until it has been inflated, so any percentage here would
 * be invented.
 */
function PacketTracerDecodingStep({ file, stage, onCancel }: {
  file: File;
  stage: PacketTracerDecodeStage | undefined;
  onCancel(): void;
}) {
  const reached = DECODE_STAGES.findIndex(([id]) => id === stage);
  return (
    <div className="import-step packet-tracer-import" data-testid="packet-tracer-decoding">
      <header className="import-step-heading">
        <p>Packet Tracer Import</p>
        <h3>Decoding {file.name}</h3>
        <span>The file is decoded in this browser, on a background thread. It is never uploaded.</span>
      </header>
      <ol className="packet-tracer-import__stages" aria-label="Decode progress">
        {DECODE_STAGES.map(([id, label], index) => (
          <li key={id} className={index === reached ? "is-current" : index < reached ? "is-complete" : ""}>
            <span aria-hidden="true">
              {index < reached ? <CheckCircle2 size={13} /> : index === reached ? <Loader2 size={13} className="is-spinning" /> : index + 1}
            </span>
            <strong>{label}</strong>
          </li>
        ))}
      </ol>
      <div className="import-state" role="status">
        <FileSearch size={16} />
        <span>{reached < 0 ? "Starting…" : `${DECODE_STAGES[reached]![1]}…`}</span>
      </div>
      <div className="packet-tracer-migration__actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * The decoded summary and the two things a user can do with it. The network
 * chooser appears only for a file that genuinely holds more than one, and the
 * answer network is never the pre-selected one.
 */
function PacketTracerImportStep({ inspection, plan, busy, error, onSelectNetwork, onReviewMapping, onImport, onCancel }: {
  inspection: PacketTracerInspection;
  plan: ImportPlan;
  busy: boolean;
  error?: string;
  onSelectNetwork(networkId: string): void;
  onReviewMapping(): void;
  onImport(): void;
  onCancel(): void;
}) {
  const report = plan.report;
  const summary = [
    ["Devices", String(plan.parsed.nodes.length)],
    ["Links", String(plan.parsed.links.length)],
    ["Configurations", String(report.importedStartupConfigs)],
    ["Warnings", String(report.warningCount)],
  ] as const;
  const selected = inspection.networks.find((network) => network.id === inspection.selectedNetworkId);
  return (
    <div className="import-step packet-tracer-import" data-testid="packet-tracer-import">
      <div className="packet-tracer-import__card" role="status">
        <CheckCircle2 size={24} />
        <div>
          <p className="section-eyebrow">Packet Tracer Import</p>
          <h3>Packet Tracer file decoded</h3>
          <p>
            {inspection.packetTracerVersion
              ? `Written by Packet Tracer ${inspection.packetTracerVersion}.`
              : "The container declared no version."}
            {" "}Topology and supported configuration are converted; runtime state, grading rules and passwords are not.
          </p>
        </div>
      </div>
      <div className="import-summary-grid">
        {summary.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <LinkAccounting report={report} />
      {inspection.activityTitle && (
        <section className="packet-tracer-import__activity" aria-label="Packet Tracer activity">
          <h4>{inspection.activityTitle}</h4>
          {inspection.activityInstructions && <p>{inspection.activityInstructions}</p>}
          <small>Activity instructions are imported as lab text. Packet Tracer grading rules are not converted.</small>
        </section>
      )}
      {inspection.networks.length > 1 && (
        <fieldset className="packet-tracer-import__networks" data-testid="packet-tracer-networks">
          <legend>Which network should be imported?</legend>
          <p>{inspection.selectionReason}</p>
          {inspection.networks.map((network) => (
            <label key={network.id} className={network.id === inspection.selectedNetworkId ? "is-selected" : ""}>
              <input
                type="radio"
                name="packet-tracer-network"
                value={network.id}
                checked={network.id === inspection.selectedNetworkId}
                disabled={busy}
                onChange={() => onSelectNetwork(network.id)}
              />
              <span>
                <strong>{network.name}</strong>
                <small>
                  {NETWORK_ROLES[network.role]} · {network.deviceCount} devices · {network.linkCount} links
                  {network.configuredDeviceCount > 0 ? ` · ${network.configuredDeviceCount} configured` : ""}
                </small>
              </span>
              {network.role === "answer" && <em>Contains the completed solution</em>}
            </label>
          ))}
        </fieldset>
      )}
      {selected?.role === "answer" && (
        <div className="import-state is-error" role="alert">
          <AlertTriangle size={16} />
          <span>This is the activity's answer network. Importing it brings in the completed solution.</span>
        </div>
      )}
      {error && <div className="import-state is-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
      <div className="import-safe-notice">
        <ShieldCheck size={17} />
        <p><strong>Decoded locally.</strong> The file was read in this browser and never sent to a server. Only its name and version are kept as source metadata.</p>
      </div>
      <div className="packet-tracer-migration__actions">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button data-testid="packet-tracer-review" disabled={busy} onClick={onReviewMapping}>Review Mapping</Button>
        <Button variant="primary" data-testid="packet-tracer-import-lab" disabled={busy || !plan.importable} onClick={onImport}>
          {busy ? "Importing…" : "Import Lab"}
        </Button>
      </div>
    </div>
  );
}

/**
 * What each failure stage actually means for the user. The container, the
 * mapping and the assembled document fail for entirely different reasons, and
 * telling someone their file "could not be decoded" when it decoded perfectly
 * and then failed schema validation sends them to re-export a file that was
 * never the problem.
 */
const FAILURE_STAGES: Readonly<Record<PacketTracerFailureStage, {
  readonly title: string;
  readonly label: string;
  readonly explanation: string;
}>> = {
  decode: {
    title: "Packet Tracer file could not be decoded",
    label: "Could not be decoded",
    explanation: "The container itself could not be read, so nothing inside it has been seen yet.",
  },
  "safety-limit": {
    title: "Packet Tracer file exceeded a safety limit",
    label: "Refused by a safety limit",
    explanation: "A specific bound was exceeded while reading this file. It was refused by that limit"
      + " rather than by its format, so a different export of the same lab is unlikely to help.",
  },
  mapping: {
    title: "Packet Tracer file decoded, but its network could not be mapped",
    label: "Could not be mapped",
    explanation: "The container was read successfully — this failed afterwards, while converting its"
      + " network onto SimulatorNet devices. Re-exporting from Packet Tracer will not change it.",
  },
  validation: {
    title: "Packet Tracer file decoded, but the imported lab was not valid",
    label: "Imported lab was not valid",
    explanation: "The container was read and its devices were mapped; the lab that came out did not pass"
      + " SimulatorNet's own validation. This is a SimulatorNet defect, not a problem with your file.",
  },
};

function PacketTracerMigrationStep({ file, failure, migrationMode, guideOpen, files, error, onClose, onGuide, onReconstruct, onChoose, onBuild }: {
  file: File;
  failure: PacketTracerInspectError;
  migrationMode: boolean;
  guideOpen: boolean;
  files: readonly File[];
  error?: string;
  onClose(): void;
  onGuide(): void;
  onReconstruct(): void;
  onChoose(): void;
  onBuild(): void;
}) {
  const stage = FAILURE_STAGES[failure.stage];
  // Companion reconstruction rebuilds a lab whose *container* could not be read.
  // Offering it for a mapping or validation failure would send the user off to
  // collect screenshots for a file this decoder already read perfectly.
  const offerCompanions = failure.stage === "decode";
  return (
    <div className="import-step packet-tracer-migration" data-testid="packet-tracer-migration" data-failure-stage={failure.stage}>
      <div className="packet-tracer-migration__card" role="status">
        <FileWarning size={24} />
        <div>
          <p className="section-eyebrow">Recognised source</p>
          <h3>{stage.title}</h3>
          <p>{failure.message}</p>
          <small>
            {failure.suggestsCompanionFallback
              ? "Re-saving the lab from Packet Tracer may produce a container this decoder reads. Otherwise, reconstruct it from companion files below."
              : stage.explanation}
            {" "}<strong>{file.name}</strong> is retained only as source metadata.
          </small>
        </div>
      </div>
      {failure.details && failure.details.length > 0 && (
        <section className="packet-tracer-migration__details" aria-label="Validation details" data-testid="packet-tracer-failure-details">
          <h4>What failed validation</h4>
          <ul>{failure.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
        </section>
      )}
      <div className="packet-tracer-migration__actions">
        <Button variant="ghost" onClick={onClose}>Close</Button>
        {offerCompanions && <>
          <Button onClick={onGuide}>Open Migration Guide</Button>
          <Button variant="primary" onClick={onReconstruct}>Reconstruct Lab from Companion Files</Button>
        </>}
      </div>
      {guideOpen && (
        <section className="packet-tracer-migration__guide" aria-label="Packet Tracer migration guide">
          <h4>Companion data</h4>
          <p>Attach screenshots, device <code>.cfg/.txt</code> files and explicit CSV inventories. SimulatorNet performs no OCR and never infers cables from a screenshot.</p>
          <pre>devices.csv: hostname,type,x,y{"\n"}interfaces.csv: device,interface,address,mask,gateway{"\n"}connections.csv: deviceA,interfaceA,deviceB,interfaceB</pre>
        </section>
      )}
      {migrationMode && (
        <section className="packet-tracer-migration__assistant" aria-label="Packet Tracer companion reconstruction">
          <h4>Reconstruct from companion files</h4>
          <p>Supported: PNG/JPEG/WebP screenshots, device configuration text, <code>devices.csv</code>, <code>interfaces.csv</code>, and optional <code>connections.csv</code>.</p>
          <div className="packet-tracer-migration__picker">
            <Button icon={<Upload size={14} />} onClick={onChoose}>Choose Companion Files</Button>
            <span>{files.length === 0 ? "No companion files selected" : `${files.length} companion file${files.length === 1 ? "" : "s"} selected`}</span>
          </div>
          {files.length > 0 && <ul>{files.map((entry) => <li key={`${entry.name}-${entry.size}`}>{entry.name} · {fileSize(entry.size)}</li>)}</ul>}
          {error && <div className="import-state is-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
          <Button variant="primary" disabled={files.length === 0} onClick={onBuild}>Build Reconstruction Plan</Button>
        </section>
      )}
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
          ["Packet Tracer", "PKT lab or PKA activity"],
        ].map(([name, detail]) => <div key={name}><CheckCircle2 size={14} /><span><strong>{name}</strong><small>{detail}</small></span></div>)}
      </div>
      <div className="import-safe-notice"><ShieldCheck size={17} /><p><strong>Safe local conversion.</strong> No VM images, executables, scripts or remote resources are run. Maximum input size is {fileSize(DEFAULT_IMPORT_LIMITS.maxInputBytes)}.</p></div>
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

/**
 * Every source link accounted for. A cable that was not created is the one
 * import outcome a user cannot see by looking at the canvas, so the four numbers
 * are always shown together and each unresolved link names its own reason.
 */
function LinkAccounting({ report }: { report: ImportPlan["report"] }) {
  const unresolved = report.entries.filter((entry) => entry.code === "packet-tracer-link-unresolved");
  return (
    <section className="import-link-accounting" data-testid="import-link-accounting" aria-label="Link mapping">
      <dl>
        <div><dt>Source links</dt><dd>{report.sourceLinkCount}</dd></div>
        <div><dt>Mapped</dt><dd>{report.importedLinkCount - report.compatibilityMappedLinkCount}</dd></div>
        <div><dt>Compatibility mapped</dt><dd>{report.compatibilityMappedLinkCount}</dd></div>
        <div className={report.unresolvedLinkCount > 0 ? "is-warning" : ""}>
          <dt>Unresolved</dt><dd>{report.unresolvedLinkCount}</dd>
        </div>
      </dl>
      {unresolved.length > 0 && (
        <ul data-testid="import-link-unresolved">
          {unresolved.map((entry, index) => (
            <li key={`${entry.code}-${index}`}>
              <strong>{String(entry.detail?.device ?? "")} {String(entry.detail?.sourceInterface ?? "")}</strong>
              <span>{String(entry.detail?.reason ?? entry.message)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
      <StepHeading title="Review detected content" description="This summary is produced before any topology is added to the workspace." />
      <div className="import-summary-grid">
        {cards.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <LinkAccounting report={plan.report} />
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
      <StepHeading title="Map source devices" description="Accept suggested SimulatorNet devices, keep a visual placeholder, or exclude a source node." />
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
          ? <details className="import-row-warning"><summary><AlertTriangle size={12} /> Attention</summary><p>{proposal.interfaceWarning}</p></details>
          : <span className="import-row-ok">Ready</span>}
      </td>
    </tr>
  );
}

function SupportBadge({ level }: { level: ImportSupportLevel }) {
  return <span className={`import-support import-support--${level}`}>{level.replaceAll("-", " ")}</span>;
}

/**
 * A row needs attention when the conversion genuinely lost something: an
 * interface warning, no suggested device type, or a source that survives only
 * as a placeholder or not at all.
 *
 * `configuration-partial` and `topology-only` are *successful* mappings — the
 * report still states them. Treating them as attention tinted every row amber
 * on an ordinary import, which hides the two rows that actually need a
 * decision among the thirty-eight that do not.
 */
function needsAttention(proposal: ImportMappingProposal): boolean {
  return Boolean(proposal.interfaceWarning)
    || !proposal.suggestedDeviceType
    || proposal.supportLevel === "visual-placeholder"
    || proposal.supportLevel === "unsupported";
}

function WarningsStep({ plan }: { plan: ImportPlan }) {
  const groups = warningGroups(plan.report);
  return (
    <div className="import-step">
      <StepHeading title="Review warnings" description="Warnings are grouped by impact. Passwords, hashes and vendor binaries are never displayed." />
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
  const reconstruction = report.entries.find((entry) => entry.code === "packet-tracer-companion-reconstruction");
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
      {reconstruction && <div className="packet-tracer-migration__result"><FileWarning size={17} /><p>{reconstruction.message}</p></div>}
      <div className="import-safe-notice"><ShieldCheck size={17} /><p>The report contains conversion diagnostics only. Runtime state and credentials are not included.</p></div>
    </div>
  );
}

/** The step rail names the stage, so the heading is a title and one line. */
function StepHeading({ title, description }: { title: string; description: string }) {
  return <header className="import-step-heading"><h3>{title}</h3><span>{description}</span></header>;
}

export default ImportLabWizard;

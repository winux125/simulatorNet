import { DEVICE_TYPES, getDeviceProfile, type DeviceType, type LabDocument } from "@sim/contracts";
import {
  applyImportedConsoleCredentials,
  detectLabImportFormat,
  executeLabImport,
  inspectLabImport,
  registerBuiltinImportAdapters,
  UnsupportedImportFormatError,
  type ImportMappingDecision,
  type ImportMappingSelection,
  type ImportPlan,
} from "@sim/importers";
import { AlertTriangle, FileWarning, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, IconButton } from "../../ui";

registerBuiltinImportAdapters();

interface ImportLabWizardProps {
  file: File;
  onCancel(): void;
  onImported(document: LabDocument): void;
  onError(message: string): void;
}

type WizardState =
  | { phase: "loading" }
  | { phase: "unsupported"; message: string }
  | { phase: "ready"; plan: ImportPlan }
  | { phase: "importing"; plan: ImportPlan };

const DEVICE_OPTIONS = DEVICE_TYPES.filter((type) => type !== "external-appliance");

function decisionValue(decision: ImportMappingDecision | undefined): string {
  if (!decision) return "auto";
  if (decision.kind === "device") return `device:${decision.deviceType}`;
  return decision.kind;
}

export function ImportLabWizard({ file, onCancel, onImported, onError }: ImportLabWizardProps) {
  const [state, setState] = useState<WizardState>({ phase: "loading" });
  const [selection, setSelection] = useState<ImportMappingSelection>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const source = { filename: file.name, bytes };
        const detection = detectLabImportFormat(source);
        if (!detection.supported) {
          if (cancelled) return;
          setState({
            phase: "unsupported",
            message: detection.format.startsWith("packet-tracer")
              ? "Packet Tracer files were recognised, but this format has no supported public conversion contract in SimulatorNet. Direct conversion is unavailable — keep the file unchanged and use a supported intermediate topology format."
              : "This file was not recognised as a supported lab format.",
          });
          return;
        }
        const plan = await inspectLabImport(source);
        if (!cancelled) setState({ phase: "ready", plan });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof UnsupportedImportFormatError) setState({ phase: "unsupported", message: error.message });
        else { onError(error instanceof Error ? error.message : "Import inspection failed"); onCancel(); }
      }
    })();
    return () => { cancelled = true; };
  }, [file, onCancel, onError]);

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

  const runImport = async (plan: ImportPlan) => {
    setState({ phase: "importing", plan });
    try {
      const result = await applyImportedConsoleCredentials(executeLabImport(plan, selection));
      onImported(result.document);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Import failed");
      setState({ phase: "ready", plan });
    }
  };

  return (
    <div className="device-window-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="device-window import-wizard" role="dialog" aria-modal="true" aria-label="Import Lab" data-testid="import-wizard">
        <header className="device-window__titlebar">
          <strong>Import Lab</strong>
          <IconButton label="Cancel import" icon={<X size={15} />} onClick={onCancel} />
        </header>
        <div className="device-window__content">
          {state.phase === "loading" && <p className="section-note">Inspecting {file.name}…</p>}

          {state.phase === "unsupported" && (
            <div className="import-wizard__unsupported" role="alert" data-testid="import-unsupported">
              <FileWarning size={22} aria-hidden="true" />
              <p>{state.message}</p>
              <p className="section-note">The original file is left unchanged and no lab was created.</p>
              <Button variant="primary" onClick={onCancel}>Close</Button>
            </div>
          )}

          {(state.phase === "ready" || state.phase === "importing") && (
            <ReadyView
              plan={state.plan}
              selection={selection}
              busy={state.phase === "importing"}
              onDecision={setDecision}
              onImport={() => void runImport(state.plan)}
              onCancel={onCancel}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function ReadyView({ plan, selection, busy, onDecision, onImport, onCancel }: {
  plan: ImportPlan;
  selection: ImportMappingSelection;
  busy: boolean;
  onDecision(nodeId: string, value: string): void;
  onImport(): void;
  onCancel(): void;
}) {
  const warnings = plan.report.entries.filter((entry) => entry.level !== "info");
  return (
    <div className="import-wizard__body">
      <dl className="property-list">
        <div><dt>Source</dt><dd>{plan.platform}{plan.sourceVersion ? ` · ${plan.sourceVersion}` : ""}</dd></div>
        <div><dt>Nodes</dt><dd>{plan.report.importedNodeCount}</dd></div>
        <div><dt>Links</dt><dd>{plan.report.importedLinkCount}</dd></div>
        <div><dt>Startup configs</dt><dd>{plan.report.importedStartupConfigs}</dd></div>
      </dl>

      {plan.report.ignoredVendorImages.length > 0 && (
        <p className="import-wizard__notice" data-testid="import-ignored-images">
          Vendor appliance images are not imported. SimulatorNet reimplements supported behaviour and never executes these files ({plan.report.ignoredVendorImages.length} ignored).
        </p>
      )}

      <table className="data-table import-wizard__mapping" data-testid="import-mapping">
        <thead><tr><th>Source node</th><th>Kind</th><th>Map to</th></tr></thead>
        <tbody>
          {plan.proposals.map((proposal) => (
            <tr key={proposal.sourceNodeId}>
              <td>{proposal.label}{proposal.interfaceWarning ? <AlertTriangle size={12} aria-label={proposal.interfaceWarning} /> : null}</td>
              <td><code>{proposal.sourceKind}</code></td>
              <td>
                <select
                  aria-label={`Map ${proposal.label}`}
                  value={decisionValue(selection[proposal.sourceNodeId])}
                  disabled={busy}
                  onChange={(event) => onDecision(proposal.sourceNodeId, event.target.value)}
                >
                  <option value="auto">Suggested{proposal.suggestedDeviceType ? ` · ${getDeviceProfile(proposal.suggestedDeviceType).displayName}` : " · External Appliance"}</option>
                  {DEVICE_OPTIONS.map((type) => <option key={type} value={`device:${type}`}>{getDeviceProfile(type).displayName}</option>)}
                  <option value="placeholder">External Appliance (placeholder)</option>
                  <option value="exclude">Exclude node</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {warnings.length > 0 && (
        <details className="import-wizard__warnings" data-testid="import-warnings">
          <summary>{warnings.length} warning(s)</summary>
          <ul>{warnings.map((entry, index) => <li key={index}>{entry.message}</li>)}</ul>
        </details>
      )}

      <p className="section-note">The imported lab opens stopped. External appliances are placeholders you can replace before starting.</p>
      <div className="import-wizard__actions">
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={onImport} disabled={busy} data-testid="import-confirm">{busy ? "Importing…" : "Import"}</Button>
      </div>
    </div>
  );
}

export default ImportLabWizard;

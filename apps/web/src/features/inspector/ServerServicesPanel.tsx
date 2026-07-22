import type { ServerServiceConfig } from "@sim/contracts";
import type { ServerServiceRuntimeSnapshot, ServerServicesView } from "@sim/sim-worker";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button, StatusIndicator } from "../../ui";

interface ServerServicesPanelProps {
  client: SimulatorClient;
  deviceId: string;
  refreshKey: number;
  onError(message: string): void;
}

const serviceTypes = ["dns", "http", "tftp", "ntp", "syslog"] as const;

function defaultConfiguration(type: (typeof serviceTypes)[number]): ServerServiceConfig {
  if (type === "dns") return { id: "dns-main", type, enabled: false, port: 53, records: [] };
  if (type === "http") return { id: "http-main", type, enabled: false, port: 80, resources: [] };
  if (type === "tftp") return { id: "tftp-main", type, enabled: false, port: 69, files: [] };
  if (type === "ntp") return { id: "ntp-main", type, enabled: false, port: 123, offsetNs: 0 };
  return { id: "syslog-main", type, enabled: false, port: 514, retention: 200 };
}

export function ServerServicesPanel({ client, deviceId, refreshKey, onError }: ServerServicesPanelProps) {
  const [view, setView] = useState<ServerServicesView>();
  const [runtime, setRuntime] = useState<ServerServiceRuntimeSnapshot>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    void Promise.all([
      client.request({ type: "GET_SERVER_SERVICES", deviceId }),
      client.request({ type: "GET_SERVER_SERVICE_RUNTIME", deviceId }),
    ]).then(([services, currentRuntime]) => {
      setView(services);
      setRuntime(currentRuntime);
    }).catch((error: unknown) => onError(error instanceof Error ? error.message : "Unable to load server services"))
      .finally(() => setLoading(false));
  }, [client, deviceId, onError]);

  useEffect(refresh, [refresh, refreshKey]);

  const apply = (configuration: ServerServiceConfig) => {
    void client.request({ type: "CONFIGURE_SERVER_SERVICE", deviceId, configuration })
      .then((result) => { setView(result); return client.request({ type: "GET_SERVER_SERVICE_RUNTIME", deviceId }); })
      .then(setRuntime)
      .catch((error: unknown) => onError(error instanceof Error ? error.message : "Unable to configure service"));
  };

  const toggle = (configuration: ServerServiceConfig, enabled: boolean) => {
    if (!view?.configurations.some((candidate) => candidate.id === configuration.id)) {
      apply({ ...configuration, enabled });
      return;
    }
    const request = enabled
      ? { type: "ENABLE_SERVER_SERVICE" as const, deviceId, serviceId: configuration.id }
      : { type: "DISABLE_SERVER_SERVICE" as const, deviceId, serviceId: configuration.id };
    void client.request(request).then(setView)
      .catch((error: unknown) => onError(error instanceof Error ? error.message : "Unable to change service state"));
  };

  const clearSyslog = () => {
    void client.request({ type: "CLEAR_SYSLOG_RUNTIME", deviceId }).then(setRuntime)
      .catch((error: unknown) => onError(error instanceof Error ? error.message : "Unable to clear Syslog runtime"));
  };

  if (loading && !view) return <p className="loading-line">Reading server services…</p>;

  return (
    <section className="server-services" aria-label="Server services">
      <header className="server-services__header">
        <div><p className="section-eyebrow">Application services</p><h3>Services</h3></div>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={refresh}>Refresh</Button>
      </header>
      <p className="section-note">Configuration is persistent. Requests, connections, downloaded files, and logs are runtime-only.</p>
      <div className="service-config-list">
        {serviceTypes.map((type) => {
          const config = view?.configurations.find((candidate) => candidate.type === type) ?? defaultConfiguration(type);
          const status = view?.services.find((candidate) => candidate.id === config.id);
          return (
            <ServiceEditor
              key={`${type}:${config.id}`}
              configuration={config}
              status={status?.state ?? "disabled"}
              error={status?.error}
              onApply={apply}
              onToggle={(enabled) => toggle(config, enabled)}
            />
          );
        })}
      </div>
      <div className="service-runtime-grid">
        <RuntimeMetric label="DNS queries" value={runtime?.dns.queries ?? 0} />
        <RuntimeMetric label="HTTP requests" value={runtime?.http.requests ?? 0} />
        <RuntimeMetric label="TFTP completed" value={runtime?.tftp.completedTransfers ?? 0} />
        <RuntimeMetric label="NTP queries" value={runtime?.ntp.queries ?? 0} />
      </div>
      <div className="runtime-card service-syslog-runtime">
        <header><h4>Syslog runtime</h4><Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={clearSyslog}>Clear</Button></header>
        {(runtime?.syslog.entries.length ?? 0) === 0
          ? <p>No received messages.</p>
          : <table className="data-table"><thead><tr><th>Time</th><th>Source</th><th>Severity</th><th>Message</th></tr></thead><tbody>{runtime!.syslog.entries.slice(-20).reverse().map((entry) => <tr key={entry.sequence}><td><code>{entry.receivedAtNs}</code></td><td>{entry.source}</td><td>{entry.severity}</td><td>{entry.message}</td></tr>)}</tbody></table>}
      </div>
    </section>
  );
}

function ServiceEditor({
  configuration,
  status,
  error,
  onApply,
  onToggle,
}: {
  configuration: ServerServiceConfig;
  status: "disabled" | "starting" | "listening" | "error";
  error?: string;
  onApply(configuration: ServerServiceConfig): void;
  onToggle(enabled: boolean): void;
}) {
  const [draft, setDraft] = useState(configuration);
  useEffect(() => setDraft(configuration), [configuration]);
  const update = (patch: Partial<ServerServiceConfig>) => setDraft((current) => ({ ...current, ...patch }) as ServerServiceConfig);
  return (
    <article className="service-config-card" data-service-type={draft.type}>
      <header>
        <div><strong>{draft.type.toUpperCase()}</strong><small>{draft.id}</small></div>
        <StatusIndicator status={status === "listening" ? "up" : status === "error" ? "error" : "down"} label={status} />
      </header>
      <div className="service-form-row">
        <label>Port<input aria-label={`${draft.type} port`} type="number" min={1} max={65_535} value={draft.port} onChange={(event) => update({ port: Number(event.target.value) })} /></label>
        <label className="service-enabled"><input aria-label={`${draft.type} enabled`} type="checkbox" checked={draft.enabled} onChange={(event) => { update({ enabled: event.target.checked }); onToggle(event.target.checked); }} /> Enabled</label>
      </div>
      {draft.type === "dns" && <label>Records <span>name address, one per line</span><textarea aria-label="DNS records" value={draft.records.map((record) => `${record.name} ${record.address}`).join("\n")} onChange={(event) => update({ records: parsePairs(event.target.value).map(([name, address]) => ({ name, address })) })} /></label>}
      {draft.type === "http" && <label>Resources <span>path | content-type | body</span><textarea aria-label="HTTP resources" value={draft.resources.map((resource) => `${resource.path} | ${resource.contentType} | ${resource.body}`).join("\n")} onChange={(event) => update({ resources: parseTriples(event.target.value).map(([path, contentType, body]) => ({ path, contentType, body })) })} /></label>}
      {draft.type === "tftp" && <label>Files <span>filename | content</span><textarea aria-label="TFTP files" value={draft.files.map((file) => `${file.filename} | ${file.content}`).join("\n")} onChange={(event) => update({ files: parsePairs(event.target.value, "|").map(([filename, content]) => ({ filename, content })) })} /></label>}
      {draft.type === "ntp" && <label>Virtual clock offset (ns)<input aria-label="NTP offset" type="number" value={draft.offsetNs} onChange={(event) => update({ offsetNs: Number(event.target.value) })} /></label>}
      {draft.type === "syslog" && <label>Retained entries<input aria-label="Syslog retention" type="number" min={1} max={1_000} value={draft.retention} onChange={(event) => update({ retention: Number(event.target.value) })} /></label>}
      {error && <p className="service-error">{error}</p>}
      <Button size="sm" variant="default" icon={<Save size={12} />} onClick={() => onApply(draft)}>Apply {draft.type.toUpperCase()}</Button>
    </article>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: number }) {
  return <div className="runtime-card"><h4>{label}</h4><p>{value}</p></div>;
}

function parsePairs(value: string, separator: string | RegExp = /\s+/): Array<[string, string]> {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = typeof separator === "string" ? line.split(separator) : line.split(separator);
    return [parts[0]?.trim() ?? "", parts.slice(1).join(typeof separator === "string" ? separator : " ").trim()];
  });
}

function parseTriples(value: string): Array<[string, string, string]> {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [first = "", second = "", ...rest] = line.split("|");
    return [first.trim(), second.trim(), rest.join("|").trim()];
  });
}

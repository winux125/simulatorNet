import type { LabDocument } from "@sim/contracts";
import type {
  SecurityConfigurationView,
  SecurityDeviceConfiguration,
} from "@sim/sim-worker";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button } from "../../ui";

export type SecuritySection =
  | "overview"
  | "routing"
  | "routes"
  | "vlans"
  | "svis"
  | "acl"
  | "nat"
  | "zones"
  | "policies"
  | "impairments"
  | "flows"
  | "run"
  | "results"
  | "runtime"
  | "connections";

interface SecurityConfigurationPanelProps {
  client: SimulatorClient;
  deviceId: string;
  section: SecuritySection;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
}

const EDITABLE = new Set<SecuritySection>([
  "acl",
  "nat",
  "zones",
  "policies",
  "impairments",
  "flows",
]);

export function SecurityConfigurationPanel(props: SecurityConfigurationPanelProps) {
  const [view, setView] = useState<SecurityConfigurationView>();
  const [editor, setEditor] = useState("");
  const [busy, setBusy] = useState(true);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await props.client.request({
        type: "GET_SECURITY_CONFIGURATION",
        deviceId: props.deviceId,
      });
      setView(next);
      setEditor(JSON.stringify(sectionValue(next, props.section), null, 2));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to load device configuration");
    } finally {
      setBusy(false);
    }
  }, [props.client, props.deviceId, props.onError, props.section]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const editable = EDITABLE.has(props.section);
  const title = useMemo(() => sectionTitle(props.section), [props.section]);

  const apply = async () => {
    if (!view) return;
    setBusy(true);
    try {
      const value: unknown = JSON.parse(editor);
      const configuration = mergeSection(view.configuration, props.section, value);
      const next = await props.client.request({
        type: "SET_SECURITY_CONFIGURATION",
        deviceId: props.deviceId,
        configuration,
      });
      setView(next);
      setEditor(JSON.stringify(sectionValue(next, props.section), null, 2));
      props.onConfigurationChanged(next.document, true);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to apply configuration");
    } finally {
      setBusy(false);
    }
  };

  const clearRuntime = async () => {
    setBusy(true);
    try {
      const next = await props.client.request({
        type: "CLEAR_SECURITY_RUNTIME",
        deviceId: props.deviceId,
      });
      setView(next);
      setEditor(JSON.stringify(sectionValue(next, props.section), null, 2));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to clear runtime state");
    } finally {
      setBusy(false);
    }
  };

  const runFlow = async (flowId: string) => {
    setBusy(true);
    try {
      const next = await props.client.request({
        type: "RUN_TRAFFIC_FLOW",
        deviceId: props.deviceId,
        flowId,
      });
      setView(next);
      setEditor(JSON.stringify(sectionValue(next, props.section), null, 2));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to run traffic flow");
    } finally {
      setBusy(false);
    }
  };

  if (busy && !view) {
    return <div className="device-window-section"><p>Loading {title.toLowerCase()}…</p></div>;
  }
  if (!view) {
    return <div className="device-window-section"><p>Configuration is unavailable.</p></div>;
  }
  if (props.section === "run" && view.configuration.kind === "traffic-generator") {
    return (
      <div className="device-window-section security-config-panel">
        <p className="section-eyebrow">Bounded deterministic traffic</p>
        <h2>Run configured flow</h2>
        <p>Auto completes the flow. Step queues its events for Packet Trace.</p>
        <div className="security-flow-list">
          {view.configuration.flows.map((flow) => (
            <div key={flow.id}>
              <code>{flow.id}</code>
              <span>{flow.protocol.toUpperCase()} → {flow.destination} × {flow.count}</span>
              <Button disabled={busy} onClick={() => void runFlow(flow.id)}>Run</Button>
            </div>
          ))}
          {view.configuration.flows.length === 0 && <p>No flows configured.</p>}
        </div>
      </div>
    );
  }

  const runtimeSection = props.section === "runtime"
    || props.section === "results"
    || props.section === "connections";
  return (
    <div className="device-window-section security-config-panel">
      <p className="section-eyebrow">{editable ? "Structured configuration" : runtimeSection ? "Transient runtime" : "Device configuration"}</p>
      <h2>{title}</h2>
      <p className="section-note">
        {editable
          ? "Edit bounded JSON fields and apply them through the typed simulation-worker API."
          : runtimeSection
            ? "Runtime counters, translations, sessions and results are never stored in LabDocument."
            : "This read-only view is derived from the canonical LabDocument."}
      </p>
      {editable
        ? <textarea
            className="configuration-editor"
            aria-label={`${title} JSON`}
            spellCheck={false}
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
          />
        : <pre className="configuration-view">{editor}</pre>}
      <div className="security-config-panel__actions">
        {editable && <Button variant="primary" disabled={busy} onClick={() => void apply()}>Apply</Button>}
        <Button disabled={busy} onClick={() => void refresh()}>Refresh</Button>
        {runtimeSection && <Button disabled={busy} onClick={() => void clearRuntime()}>Clear runtime</Button>}
      </div>
    </div>
  );
}

function sectionTitle(section: SecuritySection): string {
  return {
    overview: "Overview",
    routing: "Routing",
    routes: "Routes",
    vlans: "VLANs",
    svis: "SVIs",
    acl: "IPv4 ACL",
    nat: "NAT / PAT",
    zones: "Security Zones",
    policies: "Firewall Policies",
    impairments: "Deterministic Impairments",
    flows: "Traffic Flows",
    run: "Run",
    results: "Flow Results",
    runtime: "Runtime",
    connections: "Stateful Connections",
  }[section];
}

function sectionValue(view: SecurityConfigurationView, section: SecuritySection): unknown {
  const config = view.configuration;
  switch (section) {
    case "overview":
      return { kind: config.kind, hostname: config.hostname };
    case "routing":
    case "routes":
      return "staticRoutes" in config ? { staticRoutes: config.staticRoutes } : {};
    case "vlans":
      return config.kind === "l3-switch" ? config.vlans : [];
    case "svis":
      return config.kind === "l3-switch" ? config.svis : [];
    case "acl":
      return "acls" in config ? { acls: config.acls, aclBindings: config.aclBindings } : {};
    case "nat":
      return "natPools" in config
        ? {
            natPools: config.natPools,
            natRules: config.natRules,
            natInterfaceRoles: config.natInterfaceRoles,
            translations: view.runtime.natTranslations,
          }
        : {};
    case "zones":
      return config.kind === "firewall"
        ? { zones: config.zones, defaultPolicy: config.defaultPolicy }
        : {};
    case "policies":
      return config.kind === "firewall" ? config.firewallPolicies : [];
    case "impairments":
      return config.kind === "cloud" ? config.impairments : [];
    case "flows":
      return config.kind === "traffic-generator" ? config.flows : [];
    case "results":
      return view.runtime.trafficResults;
    case "connections":
      return view.runtime.firewallConnections;
    case "runtime":
      return view.runtime;
    case "run":
      return {};
  }
}

function mergeSection(
  configuration: SecurityDeviceConfiguration,
  section: SecuritySection,
  value: unknown,
): SecurityDeviceConfiguration {
  const object = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  if (section === "acl" && "acls" in configuration && object) {
    return {
      ...configuration,
      acls: object.acls as typeof configuration.acls,
      aclBindings: object.aclBindings as typeof configuration.aclBindings,
    };
  }
  if (section === "nat" && "natPools" in configuration && object) {
    return {
      ...configuration,
      natPools: object.natPools as typeof configuration.natPools,
      natRules: object.natRules as typeof configuration.natRules,
      natInterfaceRoles: object.natInterfaceRoles as typeof configuration.natInterfaceRoles,
    };
  }
  if (section === "zones" && configuration.kind === "firewall" && object) {
    return {
      ...configuration,
      zones: object.zones as typeof configuration.zones,
      defaultPolicy: object.defaultPolicy as typeof configuration.defaultPolicy,
    };
  }
  if (section === "policies" && configuration.kind === "firewall" && Array.isArray(value)) {
    return { ...configuration, firewallPolicies: value as typeof configuration.firewallPolicies };
  }
  if (section === "impairments" && configuration.kind === "cloud" && Array.isArray(value)) {
    return { ...configuration, impairments: value as typeof configuration.impairments };
  }
  if (section === "flows" && configuration.kind === "traffic-generator" && Array.isArray(value)) {
    return { ...configuration, flows: value as typeof configuration.flows };
  }
  throw new Error(`Section '${section}' is not editable for ${configuration.kind}.`);
}

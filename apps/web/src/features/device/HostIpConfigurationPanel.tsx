import {
  Ipv6PrefixLengthSchema,
  Ipv6Schema,
  type HostIpConfiguration,
  type HostIpv6Config,
  type LabDocument,
} from "@sim/contracts";
import type { HostIpv6NetworkStatus, HostNetworkStatus, LabUiNode } from "@sim/sim-worker";
import { AlertTriangle, Info, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import type { LabPowerState } from "../../state/workspace-store";
import { Button } from "../../ui";
import {
  hostIpConfigurationFromDocument,
  hostIpv6ConfigurationFromDocument,
  withHostIpv6Configuration,
  withHostDhcpMode,
  withHostStaticConfiguration,
} from "../lab/document";
import {
  nextExampleAddress,
  prefixLengthToMask,
  validateHostIpFields,
  type HostIpFieldErrors,
  type HostIpFormFields,
} from "./host-ip-validation";

interface HostIpConfigurationPanelProps {
  client: SimulatorClient;
  document: LabDocument;
  node: LabUiNode;
  powerState: LabPowerState;
  runtimeAvailable: boolean;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
}

const EMPTY_FIELDS: HostIpFormFields = { address: "", subnetMask: "255.255.255.0", defaultGateway: "", dnsServer: "" };

export function HostIpConfigurationPanel(props: HostIpConfigurationPanelProps) {
  const [family, setFamily] = useState<"ipv4" | "ipv6">("ipv4");
  return <div>
    <nav className="device-window__tabs" role="tablist" aria-label="IP version">
      <button type="button" role="tab" aria-selected={family === "ipv4"} className={family === "ipv4" ? "is-active" : ""} onClick={() => setFamily("ipv4")}>IPv4</button>
      <button type="button" role="tab" aria-selected={family === "ipv6"} className={family === "ipv6" ? "is-active" : ""} onClick={() => setFamily("ipv6")}>IPv6</button>
    </nav>
    {family === "ipv4"
      ? <HostIpv4ConfigurationPanel {...props} />
      : <HostIpv6ConfigurationPanel {...props} />}
  </div>;
}

function HostIpv4ConfigurationPanel(props: HostIpConfigurationPanelProps) {
  const [mode, setMode] = useState<"static" | "dhcp">("static");
  const [fields, setFields] = useState<HostIpFormFields>(EMPTY_FIELDS);
  const [errors, setErrors] = useState<HostIpFieldErrors>({});
  const [status, setStatus] = useState<HostNetworkStatus>();
  const [busy, setBusy] = useState(true);
  const running = props.powerState === "running";

  const updateFromConfiguration = useCallback((configuration: HostIpConfiguration) => {
    setMode(configuration.mode);
    setFields({
      address: configuration.address ?? "",
      subnetMask: prefixLengthToMask(configuration.prefixLength),
      defaultGateway: configuration.defaultGateway ?? "",
      dnsServer: configuration.dnsServer ?? "",
    });
  }, []);

  const syncDocument = useCallback(async () => {
    const document = await props.client.request({ type: "SERIALIZE_LAB" });
    props.onConfigurationChanged(document, true);
  }, [props.client, props.onConfigurationChanged]);

  const refresh = useCallback(async () => {
    try {
      if (!props.runtimeAvailable) {
        const configuration = hostIpConfigurationFromDocument(props.document, props.node.id);
        if (!configuration) throw new Error(`Host configuration is unavailable for '${props.node.id}'`);
        updateFromConfiguration(configuration);
        setStatus(undefined);
        return;
      }
      const [configuration, network] = await Promise.all([
        props.client.request({ type: "GET_HOST_IP_CONFIGURATION", deviceId: props.node.id }),
        props.client.request({ type: "GET_HOST_NETWORK_STATUS", deviceId: props.node.id }),
      ]);
      updateFromConfiguration(configuration);
      setStatus(network);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to load host IP configuration");
    } finally {
      setBusy(false);
    }
  }, [props.client, props.document, props.node.id, props.onError, props.runtimeAvailable, updateFromConfiguration]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setField = (field: keyof HostIpFormFields, value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const apply = async () => {
    setBusy(true);
    try {
      let next: HostNetworkStatus;
      if (mode === "static") {
        const validated = validateHostIpFields(fields);
        setErrors(validated.errors);
        if (!validated.configuration) return;
        if (!props.runtimeAvailable) {
          props.onConfigurationChanged(
            withHostStaticConfiguration(props.document, props.node.id, validated.configuration),
            false,
          );
          updateFromConfiguration({ mode: "static", ...validated.configuration });
          return;
        }
        next = await props.client.request({
          type: "SET_HOST_STATIC_CONFIGURATION",
          deviceId: props.node.id,
          configuration: validated.configuration,
        });
      } else {
        if (!props.runtimeAvailable) {
          props.onConfigurationChanged(withHostDhcpMode(props.document, props.node.id), false);
          updateFromConfiguration({
            mode: "dhcp",
            prefixLength: hostIpConfigurationFromDocument(props.document, props.node.id)?.prefixLength ?? 24,
          });
          return;
        }
        next = await props.client.request({
          type: "SET_HOST_DHCP_MODE",
          deviceId: props.node.id,
          startImmediately: running,
        });
      }
      setStatus(next);
      updateFromConfiguration(next.configuration);
      const document = await props.client.request({ type: "SERIALIZE_LAB" });
      props.onConfigurationChanged(document, true);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to apply host IP configuration");
    } finally {
      setBusy(false);
    }
  };

  const dhcpAction = async (action: "renew" | "release") => {
    setBusy(true);
    try {
      const next = await props.client.request({
        type: action === "renew" ? "RENEW_HOST_DHCP" : "RELEASE_HOST_DHCP",
        deviceId: props.node.id,
      });
      setStatus(next);
      await syncDocument();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : `Unable to ${action} DHCP`);
    } finally {
      setBusy(false);
    }
  };

  if (busy && !status) return <div className="host-ip-config host-ip-config--loading">Loading IP configuration…</div>;

  return (
    <form className="host-ip-config" onSubmit={(event) => { event.preventDefault(); void apply(); }}>
      <header><div><p className="section-eyebrow">Desktop utility</p><h3>IP Configuration</h3></div>
        <Button type="button" size="sm" onClick={() => setFields((current) => ({
          ...current,
          address: nextExampleAddress(props.document, props.node.id),
          subnetMask: "255.255.255.0",
        }))}>Use Example</Button>
      </header>
      <fieldset className="host-ip-config__modes">
        <legend>Address assignment</legend>
        <label><input type="radio" name={`host-mode-${props.node.id}`} checked={mode === "dhcp"} onChange={() => setMode("dhcp")} /> DHCP</label>
        <label><input type="radio" name={`host-mode-${props.node.id}`} checked={mode === "static"} onChange={() => setMode("static")} /> Static</label>
      </fieldset>
      <div className="host-ip-config__fields">
        <IpField label="IPv4 Address" value={fields.address} disabled={mode === "dhcp"} error={errors.address} onChange={(value) => setField("address", value)} />
        <IpField label="Subnet Mask" value={fields.subnetMask} disabled={mode === "dhcp"} error={errors.subnetMask} onChange={(value) => setField("subnetMask", value)} />
        <IpField label="Default Gateway" value={fields.defaultGateway} disabled={mode === "dhcp"} error={errors.defaultGateway} onChange={(value) => setField("defaultGateway", value)} />
        <IpField label="DNS Server" value={fields.dnsServer} disabled={mode === "dhcp"} error={errors.dnsServer} onChange={(value) => setField("dnsServer", value)} />
      </div>
      {mode === "dhcp" && !running && <p className="host-ip-config__notice"><Info size={15} /> DHCP will start when the lab is started.</p>}
      {status?.guidance && <pre className="host-ip-config__guidance">{status.guidance}</pre>}
      {status?.warnings.map((warning) => <p className="host-ip-config__warning" key={`${warning.code}:${warning.deviceIds.join(":")}`}><AlertTriangle size={15} /> {warning.message}</p>)}
      <p className="host-ip-config__hint"><Info size={15} /> Devices in the same subnet can communicate through an L2 switch without a router.<br />A DHCP server is required only for automatic address assignment.</p>
      <footer>
        {mode === "dhcp" && <div>
          <Button type="button" size="sm" disabled={!running || busy} icon={<RefreshCw size={13} />} onClick={() => void dhcpAction("renew")}>Renew</Button>
          <Button type="button" size="sm" disabled={!running || busy} icon={<Unplug size={13} />} onClick={() => void dhcpAction("release")}>Release</Button>
        </div>}
        <span>{status?.runtime.address ? `Active: ${status.runtime.address}/${status.runtime.prefixLength}` : "No active IPv4 address"}</span>
        <Button type="submit" variant="primary" disabled={busy}>Apply</Button>
      </footer>
    </form>
  );
}

interface Ipv6Fields {
  address: string;
  prefixLength: string;
  defaultRouter: string;
  dnsServer: string;
}

type Ipv6FieldErrors = Partial<Record<keyof Ipv6Fields, string>>;

function HostIpv6ConfigurationPanel(props: HostIpConfigurationPanelProps) {
  const [mode, setMode] = useState<HostIpv6Config["mode"]>("static");
  const [fields, setFields] = useState<Ipv6Fields>({
    address: "",
    prefixLength: "64",
    defaultRouter: "",
    dnsServer: "",
  });
  const [errors, setErrors] = useState<Ipv6FieldErrors>({});
  const [status, setStatus] = useState<HostIpv6NetworkStatus>();
  const [busy, setBusy] = useState(true);
  const running = props.powerState === "running";

  const updateFromConfiguration = useCallback((configuration: HostIpv6Config) => {
    setMode(configuration.mode);
    setFields({
      address: configuration.address ?? "",
      prefixLength: String(configuration.prefixLength ?? 64),
      defaultRouter: configuration.defaultRouter ?? "",
      dnsServer: configuration.dnsServer ?? "",
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      if (!props.runtimeAvailable) {
        const configuration = hostIpv6ConfigurationFromDocument(props.document, props.node.id);
        if (!configuration) throw new Error(`IPv6 configuration is unavailable for '${props.node.id}'`);
        updateFromConfiguration(configuration);
        setStatus(undefined);
        return;
      }
      const [configuration, network] = await Promise.all([
        props.client.request({ type: "GET_HOST_IPV6_CONFIGURATION", deviceId: props.node.id }),
        props.client.request({ type: "GET_HOST_IPV6_NETWORK_STATUS", deviceId: props.node.id }),
      ]);
      updateFromConfiguration(configuration);
      setStatus(network);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to load host IPv6 configuration");
    } finally {
      setBusy(false);
    }
  }, [props.client, props.document, props.node.id, props.onError, props.runtimeAvailable, updateFromConfiguration]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setField = (field: keyof Ipv6Fields, value: string) => {
    setFields((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const validateStatic = (): HostIpv6Config | undefined => {
    const nextErrors: Ipv6FieldErrors = {};
    if (!fields.address) nextErrors.address = "IPv6 address is required.";
    else if (!Ipv6Schema.safeParse(fields.address).success) nextErrors.address = "IPv6 address is invalid.";
    const prefixLength = Number(fields.prefixLength);
    if (!Ipv6PrefixLengthSchema.safeParse(prefixLength).success) {
      nextErrors.prefixLength = "Prefix length must be between 0 and 128.";
    }
    if (fields.defaultRouter && !Ipv6Schema.safeParse(fields.defaultRouter).success) {
      nextErrors.defaultRouter = "Default router must be a valid IPv6 address.";
    }
    if (fields.dnsServer && !Ipv6Schema.safeParse(fields.dnsServer).success) {
      nextErrors.dnsServer = "DNS server must be a valid IPv6 address.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return undefined;
    return {
      mode: "static",
      address: fields.address,
      prefixLength,
      defaultRouter: fields.defaultRouter || undefined,
      dnsServer: fields.dnsServer || undefined,
    };
  };

  const apply = async () => {
    setBusy(true);
    try {
      const configuration = mode === "static" ? validateStatic() : { mode };
      if (!configuration) return;
      if (!props.runtimeAvailable) {
        props.onConfigurationChanged(
          withHostIpv6Configuration(props.document, props.node.id, configuration),
          false,
        );
        updateFromConfiguration(configuration);
        return;
      }
      const next = mode === "static"
        ? await props.client.request({
            type: "SET_HOST_IPV6_STATIC_CONFIGURATION",
            deviceId: props.node.id,
            configuration,
          })
        : await props.client.request({
            type: "SET_HOST_IPV6_MODE",
            deviceId: props.node.id,
            mode,
            startImmediately: running,
          });
      setStatus(next);
      updateFromConfiguration(next.configuration);
      const document = await props.client.request({ type: "SERIALIZE_LAB" });
      props.onConfigurationChanged(document, true);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to apply host IPv6 configuration");
    } finally {
      setBusy(false);
    }
  };

  const dhcpv6Action = async (action: "renew" | "release") => {
    setBusy(true);
    try {
      const next = await props.client.request({
        type: action === "renew" ? "RENEW_HOST_DHCPV6" : "RELEASE_HOST_DHCPV6",
        deviceId: props.node.id,
      });
      setStatus(next);
      const document = await props.client.request({ type: "SERIALIZE_LAB" });
      props.onConfigurationChanged(document, true);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : `Unable to ${action} DHCPv6`);
    } finally {
      setBusy(false);
    }
  };

  if (busy && !status) return <div className="host-ip-config host-ip-config--loading">Loading IPv6 configuration…</div>;

  return <form className="host-ip-config" onSubmit={(event) => { event.preventDefault(); void apply(); }}>
    <header><div><p className="section-eyebrow">Desktop utility</p><h3>IPv6 Configuration</h3></div></header>
    <fieldset className="host-ip-config__modes">
      <legend>Address assignment</legend>
      {(["static", "slaac", "dhcpv6"] as const).map((entry) =>
        <label key={entry}><input type="radio" name={`host-ipv6-mode-${props.node.id}`} checked={mode === entry} onChange={() => setMode(entry)} /> {entry === "static" ? "Static" : entry === "slaac" ? "SLAAC" : "DHCPv6"}</label>)}
    </fieldset>
    <div className="host-ip-config__fields">
      <IpField label="IPv6 Address" value={fields.address} disabled={mode !== "static"} error={errors.address} onChange={(value) => setField("address", value)} />
      <IpField label="Prefix Length" value={fields.prefixLength} disabled={mode !== "static"} error={errors.prefixLength} onChange={(value) => setField("prefixLength", value)} />
      <IpField label="Default Router" value={fields.defaultRouter} disabled={mode !== "static"} error={errors.defaultRouter} onChange={(value) => setField("defaultRouter", value)} />
      <IpField label="DNS Server" value={fields.dnsServer} disabled={mode !== "static"} error={errors.dnsServer} onChange={(value) => setField("dnsServer", value)} />
    </div>
    {mode !== "static" && !running && <p className="host-ip-config__notice"><Info size={15} /> {mode === "slaac" ? "SLAAC" : "DHCPv6"} will start when the lab is started.</p>}
    {status?.runtime.problems.map((problem) =>
      <p className="host-ip-config__warning" key={problem}><AlertTriangle size={15} /> {problem}</p>)}
    <p className="host-ip-config__hint"><Info size={15} /> SLAAC uses Router Advertisements. DHCPv6 supplies managed addresses and DNS options. NDP resolves IPv6 neighbors.</p>
    {status && <div className="dock-table-wrap">
      <table className="data-table"><thead><tr><th>Address</th><th>Prefix</th><th>Source</th><th>DAD state</th></tr></thead><tbody>
        {status.runtime.addresses.map((address) => <tr key={address.address}><td><code>{address.address}</code></td><td>{address.prefixLength}</td><td>{address.source}</td><td>{address.state}</td></tr>)}
      </tbody></table>
    </div>}
    <footer>
      {mode === "dhcpv6" && <div>
        <Button type="button" size="sm" disabled={!running || busy} icon={<RefreshCw size={13} />} onClick={() => void dhcpv6Action("renew")}>Renew</Button>
        <Button type="button" size="sm" disabled={!running || busy} icon={<Unplug size={13} />} onClick={() => void dhcpv6Action("release")}>Release</Button>
      </div>}
      <span>{status?.runtime.defaultRouter ? `Router: ${status.runtime.defaultRouter}` : "No IPv6 default router"}</span>
      <Button type="submit" variant="primary" disabled={busy}>Apply</Button>
    </footer>
  </form>;
}

function IpField(props: { label: string; value: string; disabled: boolean; error?: string; onChange(value: string): void }) {
  return <label className={props.error ? "has-error" : ""}><span>{props.label}</span><input value={props.value} disabled={props.disabled} inputMode="decimal" aria-invalid={Boolean(props.error)} onChange={(event) => props.onChange(event.target.value)} />{props.error && <small>{props.error}</small>}</label>;
}

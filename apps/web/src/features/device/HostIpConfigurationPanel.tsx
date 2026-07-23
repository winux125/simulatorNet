import type { HostIpConfiguration, LabDocument } from "@sim/contracts";
import type { HostNetworkStatus, LabUiNode } from "@sim/sim-worker";
import { AlertTriangle, Info, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import type { LabPowerState } from "../../state/workspace-store";
import { Button } from "../../ui";
import {
  hostIpConfigurationFromDocument,
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

function IpField(props: { label: string; value: string; disabled: boolean; error?: string; onChange(value: string): void }) {
  return <label className={props.error ? "has-error" : ""}><span>{props.label}</span><input value={props.value} disabled={props.disabled} inputMode="decimal" aria-invalid={Boolean(props.error)} onChange={(event) => props.onChange(event.target.value)} />{props.error && <small>{props.error}</small>}</label>;
}

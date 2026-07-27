import {
  createWirelessCredentialVerifier,
} from "@sim/console-auth";
import type {
  DeviceType,
  LabDocument,
  PasswordVerifier,
  WirelessAccessPointConfiguration,
  WirelessNetworkSummary,
} from "@sim/contracts";
import type {
  WirelessAccessPointView,
  WirelessStationView,
} from "@sim/sim-worker";
import {
  Eye,
  EyeOff,
  LockKeyhole,
  RefreshCw,
  Search,
  Unplug,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button } from "../../ui";

interface WirelessPanelProps {
  client: SimulatorClient;
  deviceId: string;
  deviceType: DeviceType;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
  section?: "wireless" | "clients";
}

export function WirelessPanel(props: WirelessPanelProps) {
  const station = props.deviceType === "laptop" || props.deviceType === "smartphone";
  return station
    ? <StationWirelessPanel {...props} />
    : <AccessPointWirelessPanel {...props} />;
}

function StationWirelessPanel(props: WirelessPanelProps) {
  const [view, setView] = useState<WirelessStationView>();
  const [selected, setSelected] = useState<WirelessNetworkSummary>();
  const [explicitSsid, setExplicitSsid] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saveNetwork, setSaveNetwork] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    const next = await props.client.request({
      type: "GET_WIRELESS_STATUS",
      deviceId: props.deviceId,
    });
    setView(next);
  };

  useEffect(() => {
    let active = true;
    void props.client.request({
      type: "GET_WIRELESS_STATUS",
      deviceId: props.deviceId,
    }).then((next) => {
      if (active) setView(next);
    }).catch((error) => {
      if (active) props.onError(error instanceof Error ? error.message : "Unable to read wireless status");
    });
    return () => { active = false; };
  }, [props.client, props.deviceId, props.onError]);

  const run = async (action: () => Promise<WirelessStationView>) => {
    setBusy(true);
    setNotice("");
    try {
      const next = await action();
      setView(next);
      props.onConfigurationChanged(next.document, true);
      if (next.status.failureReason === "authentication-failed") {
        setNotice("Authentication failed. The wireless security key is incorrect.");
      } else if (next.status.failureReason === "no-access-point") {
        setNotice("No access point with the requested SSID was found.");
      } else if (next.status.failureReason === "incompatible-band-or-channel") {
        setNotice("No compatible access point is available for this band and channel set.");
      } else if (next.status.failureReason === "access-point-client-limit") {
        setNotice("The access point client limit has been reached.");
      }
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wireless operation failed";
      setNotice(message);
      props.onError(message);
      return undefined;
    } finally {
      setPassword("");
      setShowPassword(false);
      setBusy(false);
    }
  };

  const scan = () => run(() => props.client.request({
    type: "SCAN_WIRELESS_NETWORKS",
    deviceId: props.deviceId,
    explicitSsid: explicitSsid.trim() || undefined,
  }));

  const connect = async () => {
    const ssid = selected?.ssid ?? explicitSsid.trim();
    if (!ssid) {
      setNotice("Select a network or enter an SSID.");
      return;
    }
    const securityMode = selected?.security ?? (password ? "wpa2-personal" : "open");
    let credentialVerifier: PasswordVerifier | undefined;
    if (securityMode === "wpa2-personal") {
      if (!password) {
        setNotice("Enter the wireless security key.");
        return;
      }
      credentialVerifier = await createWirelessCredentialVerifier(ssid, password);
    }
    const next = await run(() => props.client.request({
      type: "CONNECT_WIRELESS_NETWORK",
      deviceId: props.deviceId,
      ssid,
      securityMode,
      preferredBssid: selected?.bssid,
      credentialVerifier,
      saveNetwork,
    }));
    if (next?.status.state === "associated") {
      setNotice(saveNetwork && securityMode === "wpa2-personal"
        ? "Connected. Security key configured."
        : "Connected.");
    }
  };

  if (!view) return <div className="device-window-section">Loading wireless status…</div>;
  const associated = view.status.state === "associated";
  return <div className="device-window-section wireless-panel">
    <div className="wireless-panel__heading">
      <div>
        <p className="section-eyebrow">Wireless station</p>
        <h2><Wifi size={20} /> {associated ? view.status.ssid : "Not connected"}</h2>
        <p>
          Status: <strong>{view.status.state}</strong>
          {view.status.bssid ? <> · BSSID <code>{view.status.bssid}</code></> : null}
        </p>
      </div>
      <div className="wireless-panel__actions">
        <Button icon={<Search size={14} />} disabled={busy} onClick={() => void scan()}>Scan</Button>
        <Button icon={<RefreshCw size={14} />} disabled={busy} onClick={() => void refresh()}>Refresh</Button>
        <Button icon={<Unplug size={14} />} disabled={!associated || busy} onClick={() => void run(() => props.client.request({
          type: "DISCONNECT_WIRELESS_NETWORK",
          deviceId: props.deviceId,
        }))}>Disconnect</Button>
      </div>
    </div>

    <table className="data-table wireless-networks">
      <thead><tr><th>SSID</th><th>Security</th><th>BSSID</th><th>Band</th><th>Channel</th><th>Status</th></tr></thead>
      <tbody>
        {view.networks.map((network) => <tr
          key={network.bssid}
          className={selected?.bssid === network.bssid ? "is-selected" : ""}
          onClick={() => { setSelected(network); setExplicitSsid(network.ssid); setNotice(""); }}
        >
          <td><strong>{network.ssid}</strong></td>
          <td>{network.security === "open" ? "Open" : "WPA2-Personal"}</td>
          <td><code>{network.bssid}</code></td>
          <td>{network.band}</td>
          <td>{network.channel}</td>
          <td>{view.status.bssid === network.bssid ? "Connected" : ""}</td>
        </tr>)}
        {view.networks.length === 0 && <tr><td colSpan={6}>No scan results. Hidden networks require an explicit SSID.</td></tr>}
      </tbody>
    </table>

    <div className="wireless-connect-form">
      <label>SSID
        <input value={explicitSsid} maxLength={32} onChange={(event) => {
          setExplicitSsid(event.target.value);
          if (selected?.ssid !== event.target.value) setSelected(undefined);
        }} />
      </label>
      {(selected?.security === "wpa2-personal" || (!selected && password.length > 0)) && <label>Password
        <span className="wireless-password-input">
          <input
            type={showPassword ? "text" : "password"}
            value={password}
            minLength={8}
            maxLength={63}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="button" aria-label={showPassword ? "Hide wireless password" : "Show wireless password"} onClick={() => setShowPassword((value) => !value)}>
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </span>
      </label>}
      <label className="wireless-checkbox"><input type="checkbox" checked={saveNetwork} onChange={(event) => setSaveNetwork(event.target.checked)} /> Save Network</label>
      <Button variant="primary" icon={<LockKeyhole size={14} />} disabled={busy} onClick={() => void connect()}>Connect</Button>
    </div>

    {notice && <p className="wireless-panel__notice" role="status">{notice}</p>}
    <h3>Saved networks</h3>
    <ul className="wireless-saved-networks">
      {view.configuration.savedNetworks.map((profile) => <li key={profile.id}>
        <span><strong>{profile.ssid}</strong><small>{profile.securityMode === "open" ? "Open" : "WPA2-Personal · Security key configured"}</small></span>
        <Button disabled={busy} onClick={() => void run(() => props.client.request({
          type: "FORGET_WIRELESS_NETWORK",
          deviceId: props.deviceId,
          profileId: profile.id,
        }))}>Forget</Button>
      </li>)}
      {view.configuration.savedNetworks.length === 0 && <li>No saved networks.</li>}
    </ul>
  </div>;
}

function AccessPointWirelessPanel(props: WirelessPanelProps) {
  const [view, setView] = useState<WirelessAccessPointView>();
  const [draft, setDraft] = useState<WirelessAccessPointConfiguration>();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void props.client.request({ type: "GET_AP_CLIENTS", deviceId: props.deviceId })
      .then((next) => {
        if (!active) return;
        setView(next);
        setDraft(next.configuration);
      })
      .catch((error) => {
        if (active) props.onError(error instanceof Error ? error.message : "Unable to inspect access point");
      });
    return () => { active = false; };
  }, [props.client, props.deviceId, props.onError]);

  const applyView = (next: WirelessAccessPointView) => {
    setView(next);
    setDraft(next.configuration);
    props.onConfigurationChanged(next.document, true);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice("");
    try {
      let security = draft.security;
      if (security.mode === "wpa2-personal" && password) {
        security = {
          mode: "wpa2-personal",
          credentialVerifier: await createWirelessCredentialVerifier(draft.ssid, password),
        };
      }
      const next = await props.client.request({
        type: "CONFIGURE_ACCESS_POINT",
        deviceId: props.deviceId,
        configuration: { ...draft, security },
      });
      applyView(next);
      setNotice(security.mode === "wpa2-personal"
        ? "Wireless settings applied. Security key configured."
        : "Wireless settings applied.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to configure access point";
      setNotice(message);
      props.onError(message);
    } finally {
      setPassword("");
      setShowPassword(false);
      setBusy(false);
    }
  };

  const radioChannels = useMemo(
    () => draft?.band === "5ghz" ? [36, 40, 44, 48, 149, 153, 157, 161] : [1, 6, 11],
    [draft?.band],
  );
  if (!view || !draft) return <div className="device-window-section">Loading access point…</div>;
  if (props.section === "clients") {
    return <div className="device-window-section">
      <p className="section-eyebrow">Associated clients</p>
      <h2>{view.clients.length} connected</h2>
      <table className="data-table"><thead><tr><th>Device</th><th>MAC</th><th>IPv4 / IPv6</th><th>Security</th><th>Virtual time</th><th /></tr></thead><tbody>
        {view.clients.map((client) => <tr key={client.deviceId}>
          <td><strong>{client.hostname}</strong><small>{client.deviceId}</small></td>
          <td><code>{client.macAddress}</code></td>
          <td><code>{[client.ipv4Address, ...client.ipv6Addresses].filter(Boolean).join(", ") || "—"}</code></td>
          <td>{client.security === "open" ? "Open" : "WPA2"}</td>
          <td>{client.associatedAtNs} ns</td>
          <td><Button onClick={() => void props.client.request({
            type: "DISCONNECT_AP_CLIENT",
            deviceId: props.deviceId,
            stationDeviceId: client.deviceId,
          }).then(applyView).catch((error) => props.onError(error instanceof Error ? error.message : "Disconnect failed"))}>Disconnect</Button></td>
        </tr>)}
        {view.clients.length === 0 && <tr><td colSpan={6}>No associated clients.</td></tr>}
      </tbody></table>
    </div>;
  }

  return <div className="device-window-section wireless-panel">
    <p className="section-eyebrow">Access point configuration</p>
    <h2><Wifi size={20} /> Wireless</h2>
    <div className="wireless-ap-form">
      <label className="wireless-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enabled</label>
      <label>SSID<input value={draft.ssid} maxLength={32} onChange={(event) => setDraft({ ...draft, ssid: event.target.value })} /></label>
      <label className="wireless-checkbox"><input type="checkbox" checked={draft.broadcastSsid} onChange={(event) => setDraft({ ...draft, broadcastSsid: event.target.checked })} /> Broadcast SSID</label>
      <label>Security<select value={draft.security.mode} onChange={(event) => setDraft({
        ...draft,
        security: event.target.value === "open"
          ? { mode: "open" }
          : draft.security.mode === "wpa2-personal"
            ? draft.security
            : { mode: "wpa2-personal", credentialVerifier: {
                algorithm: "pbkdf2-sha256",
                iterations: 1,
                saltBase64: "reset-required",
                hashBase64: "reset-required",
              } },
      })}><option value="open">Open</option><option value="wpa2-personal">WPA2-Personal</option></select></label>
      {draft.security.mode === "wpa2-personal" && <label>Set / Reset key
        <span className="wireless-password-input">
          <input type={showPassword ? "text" : "password"} value={password} minLength={8} maxLength={63} autoComplete="new-password" placeholder="Security key configured" onChange={(event) => setPassword(event.target.value)} />
          <button type="button" aria-label={showPassword ? "Hide wireless password" : "Show wireless password"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </span>
      </label>}
      <label>Band<select value={draft.band} onChange={(event) => {
        const band = event.target.value as "2.4ghz" | "5ghz";
        setDraft({ ...draft, band, channel: band === "5ghz" ? 36 : 6 });
      }}><option value="2.4ghz">2.4 GHz</option><option value="5ghz">5 GHz</option></select></label>
      <label>Channel<select value={draft.channel} onChange={(event) => setDraft({ ...draft, channel: Number(event.target.value) })}>{radioChannels.map((channel) => <option key={channel}>{channel}</option>)}</select></label>
      <label>Radio domain<input value={draft.radioDomainId} onChange={(event) => setDraft({ ...draft, radioDomainId: event.target.value })} /></label>
      <label>AP priority<input type="number" min={0} max={65_535} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} /></label>
      <label>Maximum clients<input type="number" min={1} max={128} value={draft.maximumClients} onChange={(event) => setDraft({ ...draft, maximumClients: Number(event.target.value) })} /></label>
      <label className="wireless-checkbox"><input type="checkbox" checked={draft.clientIsolation} onChange={(event) => setDraft({ ...draft, clientIsolation: event.target.checked })} /> Client Isolation</label>
    </div>
    <Button variant="primary" disabled={busy || (draft.security.mode === "wpa2-personal" && draft.security.credentialVerifier.hashBase64 === "reset-required" && password.length < 8)} onClick={() => void save()}>Apply</Button>
    {notice && <p className="wireless-panel__notice" role="status">{notice}</p>}
  </div>;
}

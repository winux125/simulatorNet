import { createVpnPreSharedKeyVerifier } from "@sim/console-auth";
import type { DeviceType, LabDocument } from "@sim/contracts";
import type { LabUiInterface, VpnConfigurationView } from "@sim/sim-worker";
import { AlertTriangle, KeyRound, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button } from "../../ui";

/**
 * One reusable VPN surface embedded by Config and Monitor — the same shape as
 * the consolidated QoS tab. The selected section is pure UI state: it never
 * reaches LabDocument, a submission, grading or the database.
 */
export type VpnSection = "tunnels" | "peers" | "profiles" | "sessions" | "counters";

export const VPN_SECTIONS: ReadonlyArray<{ id: VpnSection; label: string }> = [
  { id: "tunnels", label: "Tunnels" },
  { id: "peers", label: "IKE Peers" },
  { id: "profiles", label: "IPsec Profiles" },
  { id: "sessions", label: "Sessions" },
  { id: "counters", label: "Counters" },
];

/** Device kinds whose routing plane terminates a GRE tunnel. */
const VPN_DEVICE_TYPES = new Set<DeviceType>(["router", "firewall"]);

export function vpnSupportedFor(type: DeviceType): boolean {
  return VPN_DEVICE_TYPES.has(type);
}

export function isVpnSection(value: string): value is VpnSection {
  return VPN_SECTIONS.some((entry) => entry.id === value);
}

interface VpnPanelProps {
  client: SimulatorClient;
  deviceId: string;
  deviceType: DeviceType;
  interfaces: readonly LabUiInterface[];
  /** Opens a configuration or runtime subsection when embedded in Config/Monitor. */
  initialSection?: VpnSection;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
}

/**
 * The device VPN surface. It is one view of the same worker-owned configuration
 * the CLI writes — never an independent copy — and every change goes through
 * the typed simulation-worker API.
 *
 * SimulatorNet models deterministic educational GRE and site-to-site IPsec
 * behaviour. Its simulated ESP/IKE implementation does not provide real
 * cryptographic protection, and this panel says so where a learner will read it.
 */
export function VpnPanel(props: VpnPanelProps) {
  const [view, setView] = useState<VpnConfigurationView>();
  const [section, setSection] = useState<VpnSection>(props.initialSection ?? "tunnels");
  const [busy, setBusy] = useState(true);
  const [keyPeerId, setKeyPeerId] = useState<string>();
  const [keyValue, setKeyValue] = useState("");
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const next = await props.client.request({ type: "GET_TUNNEL_INTERFACES", deviceId: props.deviceId });
      setView(next);
      return next;
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to load VPN configuration");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [props.client, props.deviceId, props.onError]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Store a pre-shared key. The verifier is derived here, in the main thread;
   * only that opaque value crosses the worker boundary, and it is never read
   * back into this panel.
   */
  const applyPreSharedKey = async (peerId: string) => {
    if (keyValue.length < 8) {
      setNotice("A pre-shared key must contain at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const verifier = await createVpnPreSharedKeyVerifier(keyValue);
      const next = await props.client.request({
        type: "SET_IKE_PRE_SHARED_KEY",
        deviceId: props.deviceId,
        peerId,
        verifier,
      });
      setView(next);
      props.onConfigurationChanged(next.document, true);
      setNotice(`Pre-shared key stored for ${peerId}. It is never displayed.`);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to store the pre-shared key");
    } finally {
      // The plaintext key never lingers in component state.
      setKeyValue("");
      setKeyPeerId(undefined);
      setBusy(false);
    }
  };

  const act = async (request: "RESTART_IKE_PEER" | "CLEAR_IPSEC_SAS", peerId?: string) => {
    setBusy(true);
    try {
      const next = request === "RESTART_IKE_PEER"
        ? await props.client.request({ type: "RESTART_IKE_PEER", deviceId: props.deviceId, peerId })
        : await props.client.request({ type: "CLEAR_IPSEC_SAS", deviceId: props.deviceId });
      setView(next);
      setNotice(request === "RESTART_IKE_PEER"
        ? "IKEv2 negotiation restarted."
        : "Security associations cleared; a new pair is negotiated on demand.");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to run the VPN action");
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => (view ? summarize(view) : undefined), [view]);

  if (busy && !view) {
    return <div className="qos-panel"><div className="qos-panel__body"><p>Loading VPN…</p></div></div>;
  }
  if (!view || !vpnSupportedFor(props.deviceType)) {
    return <div className="qos-panel"><div className="qos-panel__body">
      <p>Site-to-site VPN is unavailable on this device.</p>
    </div></div>;
  }

  return (
    <div className="qos-panel vpn-panel">
      <nav className="qos-panel__nav" role="tablist" aria-label="VPN sections">
        {VPN_SECTIONS.map((entry) => (
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
      <div className="qos-panel__body" role="tabpanel" aria-label={`VPN ${sectionLabel(section)}`}>
        {section === "tunnels" && (
          <>
            <p className="section-eyebrow">Site-to-site VPN</p>
            <h2>Tunnels</h2>
            <p className="section-note">
              A Tunnel interface is logical: it has no cable, never appears in the connection dialog
              and is never a topology link. Its operational state is derived from the underlay routing
              table — source, destination reachability, and an active security association when the
              tunnel requires protection.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Tunnel</th><th>Source</th><th>Destination</th>
                <th>Overlay</th><th>MTU</th><th>Protection</th><th>Status</th>
              </tr></thead>
              <tbody>
                {view.runtime.tunnels.map((tunnel) => (
                  <tr key={tunnel.name}>
                    <td><code>{tunnel.name}</code></td>
                    <td>
                      <code>{tunnel.sourceAddress ?? "unresolved"}</code>
                      {tunnel.source.type === "interface" && <> ({tunnel.source.interfaceId})</>}
                    </td>
                    <td><code>{tunnel.destinationAddress}</code></td>
                    <td><code>{overlayLabel(tunnel)}</code></td>
                    <td><code>{tunnel.mtu}</code></td>
                    <td>{tunnel.protected
                      ? <span className="vpn-protected"><ShieldCheck size={13} /> {tunnel.ipsecProfileId}</span>
                      : <span className="vpn-unprotected"><ShieldOff size={13} /> plain GRE</span>}</td>
                    <td>{tunnel.operationalUp
                      ? "up"
                      : `down${tunnel.reason ? ` (${tunnel.reason})` : ""}`}</td>
                  </tr>
                ))}
                {view.runtime.tunnels.length === 0 && (
                  <tr><td colSpan={7}>No tunnel interfaces are configured.</td></tr>
                )}
              </tbody>
            </table>
            <VpnProblems problems={view.runtime.problems} />
            <p className="section-note">
              Configure tunnels from the CLI: <code>interface Tunnel0</code>, <code>tunnel source</code>,
              {" "}<code>tunnel destination</code>, <code>tunnel mode gre ip</code> and
              {" "}<code>tunnel protection ipsec profile</code>.
            </p>
          </>
        )}

        {section === "peers" && (
          <>
            <p className="section-eyebrow">IKEv2</p>
            <h2>IKE Peers</h2>
            <p className="section-note">
              This is a deterministic educational IKEv2 model. The pre-shared key is stored only as an
              opaque, scope-bound verifier — it is never displayed here, in <code>show running-config</code>,
              in the Packet Trace, in Problems or in a grading result.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Peer</th><th>Remote</th><th>Proposal</th><th>Lifetime</th>
                <th>Key</th><th>State</th><th></th>
              </tr></thead>
              <tbody>
                {view.runtime.peers.map((peer) => (
                  <tr key={peer.peerId}>
                    <td><code>{peer.peerId}</code></td>
                    <td><code>{peer.remoteAddress}</code></td>
                    <td>{peer.proposalId || "—"}</td>
                    <td><code>{peer.lifetimeSeconds}s</code></td>
                    <td>{peer.preSharedKeyConfigured ? "configured" : "not set"}</td>
                    <td>
                      {peer.state}
                      {peer.failureReason && <><br /><small>{peer.failureReason}</small></>}
                    </td>
                    <td className="vpn-panel__row-actions">
                      <Button
                        size="sm"
                        icon={<KeyRound size={13} />}
                        disabled={busy}
                        onClick={() => { setKeyPeerId(peer.peerId); setKeyValue(""); }}
                      >
                        {peer.preSharedKeyConfigured ? "Reset Key" : "Set Key"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void act("RESTART_IKE_PEER", peer.peerId)}
                      >
                        Restart
                      </Button>
                    </td>
                  </tr>
                ))}
                {view.runtime.peers.length === 0 && (
                  <tr><td colSpan={7}>No IKEv2 peers are configured.</td></tr>
                )}
              </tbody>
            </table>
            {keyPeerId !== undefined && (
              <form
                className="desktop-form vpn-panel__key-form"
                onSubmit={(event) => { event.preventDefault(); void applyPreSharedKey(keyPeerId); }}
              >
                <h3>Pre-shared key for {keyPeerId}</h3>
                <label>
                  Pre-shared key
                  <input
                    type="password"
                    aria-label={`Pre-shared key for ${keyPeerId}`}
                    value={keyValue}
                    onChange={(event) => setKeyValue(event.target.value)}
                  />
                </label>
                <div className="qos-panel__actions">
                  <Button type="submit" variant="primary" disabled={busy}>Store Key</Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { setKeyValue(""); setKeyPeerId(undefined); }}
                  >
                    Cancel
                  </Button>
                </div>
                <p className="section-note">
                  Both peers must derive the same verifier, so configure the identical key on the far
                  end. The key is never stored or sent in the clear.
                </p>
              </form>
            )}
            {notice && <p className="section-note">{notice}</p>}
            <VpnProblems problems={view.runtime.problems} />
          </>
        )}

        {section === "profiles" && (
          <>
            <p className="section-eyebrow">Structured configuration</p>
            <h2>IPsec Profiles</h2>
            <p className="section-note">
              A profile binds one IKEv2 peer and one proposal, and exactly one profile protects a
              tunnel. The <code>sim-</code> transform names are deliberate: SimulatorNet performs no
              encryption and computes no cryptographic message authentication code.
            </p>
            <h3>Proposals</h3>
            <table className="data-table">
              <thead><tr><th>Proposal</th><th>Encryption</th><th>Integrity</th></tr></thead>
              <tbody>
                {view.configuration.proposals.map((proposal) => (
                  <tr key={proposal.id}>
                    <td><code>{proposal.id}</code></td>
                    <td>{proposal.encryption}</td>
                    <td>{proposal.integrity}</td>
                  </tr>
                ))}
                {view.configuration.proposals.length === 0 && (
                  <tr><td colSpan={3}>No IKEv2 proposals are configured.</td></tr>
                )}
              </tbody>
            </table>
            <h3>Profiles</h3>
            <table className="data-table">
              <thead><tr>
                <th>Profile</th><th>Peer</th><th>Proposal</th><th>Lifetime</th><th>Protects</th>
              </tr></thead>
              <tbody>
                {view.configuration.ipsecProfiles.map((profile) => {
                  const bound = view.runtime.tunnels
                    .filter((tunnel) => tunnel.ipsecProfileId === profile.id)
                    .map((tunnel) => tunnel.name);
                  return (
                    <tr key={profile.id}>
                      <td><code>{profile.id}</code></td>
                      <td>{profile.ikePeerId || "—"}</td>
                      <td>{profile.proposalId || "—"}</td>
                      <td><code>{profile.lifetimeSeconds}s</code></td>
                      <td>{bound.length > 0 ? bound.join(", ") : "not bound"}</td>
                    </tr>
                  );
                })}
                {view.configuration.ipsecProfiles.length === 0 && (
                  <tr><td colSpan={5}>No IPsec profiles are configured.</td></tr>
                )}
              </tbody>
            </table>
            <VpnProblems problems={view.runtime.problems} />
          </>
        )}

        {section === "sessions" && (
          <>
            <p className="section-eyebrow">Transient runtime</p>
            <h2>Sessions</h2>
            <p className="section-note">
              Security associations are runtime state. SPIs, sequence numbers, ages and counters are
              never stored in LabDocument and never submitted for grading — a rebuilt lab negotiates
              them again, identically, in the browser worker and in the verifier.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>SA</th><th>Direction</th><th>Peer</th><th>SPI</th>
                <th>State</th><th>Gen</th><th>Virtual age</th><th>Expires in</th>
              </tr></thead>
              <tbody>
                {view.runtime.associations.map((sa) => (
                  <tr key={sa.id}>
                    <td><code>{sa.id}</code></td>
                    <td>{sa.direction}</td>
                    <td><code>{sa.peerAddress}</code></td>
                    <td><code>0x{sa.spi.toString(16)}</code></td>
                    <td>{sa.state}</td>
                    <td><code>{sa.generation}</code></td>
                    <td><code>{formatNs(sa.ageNs)}</code></td>
                    <td><code>{formatNs(sa.expiresInNs)}</code></td>
                  </tr>
                ))}
                {view.runtime.associations.length === 0 && (
                  <tr><td colSpan={8}>No security associations are established.</td></tr>
                )}
              </tbody>
            </table>
            <div className="qos-panel__actions">
              <Button icon={<RefreshCw size={14} />} disabled={busy} onClick={() => void load()}>Refresh</Button>
              <Button disabled={busy} onClick={() => void act("CLEAR_IPSEC_SAS")}>Clear Security Associations</Button>
            </div>
            {notice && <p className="section-note">{notice}</p>}
            <VpnProblems problems={view.runtime.problems} />
          </>
        )}

        {section === "counters" && totals && (
          <>
            <p className="section-eyebrow">Transient runtime</p>
            <h2>Counters</h2>
            <dl className="property-list qos-summary">
              <div><dt>Tunnels</dt><dd>{totals.tunnels}</dd></div>
              <div><dt>Tunnels up</dt><dd>{totals.tunnelsUp}</dd></div>
              <div><dt>Protected tunnels</dt><dd>{totals.protectedTunnels}</dd></div>
              <div><dt>Established peers</dt><dd>{totals.establishedPeers}</dd></div>
              <div><dt>Active SAs</dt><dd>{totals.activeAssociations}</dd></div>
              <div><dt>Protected packets</dt><dd>{totals.packets}</dd></div>
              <div><dt>Protected bytes</dt><dd>{totals.bytes}</dd></div>
              <div><dt>Active warnings</dt><dd>{view.runtime.problems.length}</dd></div>
            </dl>
            <h3>Per security association</h3>
            <table className="data-table">
              <thead><tr><th>SA</th><th>Direction</th><th>Packets</th><th>Bytes</th><th>Sequence</th></tr></thead>
              <tbody>
                {view.runtime.associations.map((sa) => (
                  <tr key={sa.id}>
                    <td><code>{sa.id}</code></td>
                    <td>{sa.direction}</td>
                    <td><code>{sa.packetCount}</code></td>
                    <td><code>{sa.byteCount}</code></td>
                    <td><code>{sa.sequenceNumber}</code></td>
                  </tr>
                ))}
                {view.runtime.associations.length === 0 && (
                  <tr><td colSpan={5}>No protected packets have been sent yet.</td></tr>
                )}
              </tbody>
            </table>
            <div className="qos-panel__actions">
              <Button icon={<RefreshCw size={14} />} disabled={busy} onClick={() => void load()}>Refresh</Button>
            </div>
            <p className="section-note">
              SimulatorNet models deterministic educational GRE and site-to-site IPsec behaviour. Its
              simulated ESP/IKE implementation does not provide real cryptographic protection.
            </p>
            <VpnProblems problems={view.runtime.problems} />
          </>
        )}
      </div>
    </div>
  );
}

function VpnProblems({ problems }: { problems: VpnConfigurationView["runtime"]["problems"] }) {
  if (problems.length === 0) return null;
  return (
    <div className="qos-panel__problems">
      {problems.map((problem) => (
        <p className="host-ip-config__warning" key={`${problem.code}:${problem.message}`}>
          <AlertTriangle size={14} /> {problem.message}
        </p>
      ))}
    </div>
  );
}

function sectionLabel(section: VpnSection): string {
  return VPN_SECTIONS.find((entry) => entry.id === section)!.label;
}

function overlayLabel(tunnel: VpnConfigurationView["runtime"]["tunnels"][number]): string {
  const parts: string[] = [];
  if (tunnel.ipv4) parts.push(`${tunnel.ipv4.address}/${tunnel.ipv4.prefixLength}`);
  for (const address of tunnel.ipv6) parts.push(`${address.address}/${address.prefixLength}`);
  return parts.length > 0 ? parts.join(" ") : "—";
}

/** Virtual time only; the panel never shows a wall clock. */
function formatNs(nanoseconds: number): string {
  if (nanoseconds >= 1_000_000_000) return `${(nanoseconds / 1_000_000_000).toFixed(2)} s`;
  return `${(nanoseconds / 1_000_000).toFixed(3)} ms`;
}

function summarize(view: VpnConfigurationView) {
  const active = view.runtime.associations.filter((sa) => sa.state === "active");
  return {
    tunnels: view.runtime.tunnels.length,
    tunnelsUp: view.runtime.tunnels.filter((tunnel) => tunnel.operationalUp).length,
    protectedTunnels: view.runtime.tunnels.filter((tunnel) => tunnel.protected).length,
    establishedPeers: view.runtime.peers.filter((peer) => peer.state === "ESTABLISHED").length,
    activeAssociations: active.length,
    packets: view.runtime.associations.reduce((total, sa) => total + sa.packetCount, 0),
    bytes: view.runtime.associations.reduce((total, sa) => total + sa.byteCount, 0),
  };
}

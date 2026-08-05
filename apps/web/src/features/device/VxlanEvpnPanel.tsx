import type { DeviceType } from "@sim/contracts";
import type { VxlanEvpnView } from "@sim/sim-worker";
import { AlertTriangle, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button } from "../../ui";

/**
 * One reusable VXLAN/EVPN surface embedded by Config and Monitor — the same
 * shape the QoS and VPN panels use. The selected section is pure UI state: it
 * never reaches LabDocument, a submission, grading or the database.
 */
export type VxlanSection =
  | "nve"
  | "mappings"
  | "peers"
  | "route-targets"
  | "bgp-evpn"
  | "remote-macs"
  | "type2"
  | "type3";

export const VXLAN_SECTIONS: ReadonlyArray<{ id: VxlanSection; label: string }> = [
  { id: "nve", label: "NVE" },
  { id: "mappings", label: "VNI Mappings" },
  { id: "peers", label: "Peers" },
  { id: "route-targets", label: "EVPN RD/RT" },
  { id: "bgp-evpn", label: "BGP EVPN" },
  { id: "remote-macs", label: "Remote MACs" },
  { id: "type2", label: "EVPN Type 2" },
  { id: "type3", label: "EVPN Type 3" },
];

/**
 * The VTEP capability belongs to the L3 Switch alone. A Router stays an
 * underlay router — and may reflect EVPN routes — but is never a VTEP.
 */
export function vxlanSupportedFor(type: DeviceType): boolean {
  return type === "l3-switch";
}

export function isVxlanSection(value: string): value is VxlanSection {
  return VXLAN_SECTIONS.some((entry) => entry.id === value);
}

interface VxlanEvpnPanelProps {
  client: SimulatorClient;
  deviceId: string;
  deviceType: DeviceType;
  /** Opens a configuration or runtime subsection when embedded in Config/Monitor. */
  initialSection?: VxlanSection;
  onError(message: string): void;
}

/**
 * The device VXLAN and BGP EVPN surface.
 *
 * Everything shown here is read from the worker on demand. The remote MAC
 * table, EVPN-derived membership and the EVPN RIB are runtime: they are never
 * persisted, and both the browser worker and the verifier rebuild them from the
 * same structured configuration.
 */
export function VxlanEvpnPanel(props: VxlanEvpnPanelProps) {
  const [view, setView] = useState<VxlanEvpnView>();
  const [section, setSection] = useState<VxlanSection>(props.initialSection ?? "nve");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setView(await props.client.request({ type: "GET_NVE_INTERFACES", deviceId: props.deviceId }));
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to load the VXLAN overlay");
    } finally {
      setBusy(false);
    }
  }, [props.client, props.deviceId, props.onError]);

  useEffect(() => { void load(); }, [load]);

  const act = async (type: "CLEAR_VXLAN_RUNTIME" | "RESTART_NVE") => {
    setBusy(true);
    try {
      setView(await props.client.request({ type, deviceId: props.deviceId }));
      setNotice(type === "CLEAR_VXLAN_RUNTIME"
        ? "Overlay runtime cleared; the configuration is unchanged."
        : "nve1 restarted; membership and remote MACs are relearned.");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to run the overlay action");
    } finally {
      setBusy(false);
    }
  };

  if (busy && !view) {
    return <div className="qos-panel"><div className="qos-panel__body"><p>Loading VXLAN…</p></div></div>;
  }
  if (!view || !vxlanSupportedFor(props.deviceType)) {
    return <div className="qos-panel"><div className="qos-panel__body">
      <p>VXLAN is unavailable on this device. Only an L3 Switch can be a tunnel endpoint.</p>
    </div></div>;
  }

  const type2 = view.evpnRoutes.filter((route) => route.type === 2);
  const type3 = view.evpnRoutes.filter((route) => route.type === 3);

  return (
    <div className="qos-panel vxlan-panel">
      <nav className="qos-panel__nav" role="tablist" aria-label="VXLAN and EVPN sections">
        {VXLAN_SECTIONS.map((entry) => (
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
      <div className="qos-panel__body" role="tabpanel" aria-label={`VXLAN ${section}`}>
        {section === "nve" && (
          <>
            <p className="section-eyebrow">VXLAN &amp; EVPN</p>
            <h2>NVE Interface</h2>
            <p className="section-note">
              <code>nve1</code> is logical: it has no cable, never appears in the connection dialog
              and is never a topology link. It is operational when it is admin up, its source
              Loopback has a usable IPv4 address, and the mapped VLAN exists.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Interface</th><th>Source</th><th>Address</th><th>VNIs</th><th>Admin</th><th>Status</th>
              </tr></thead>
              <tbody>
                {view.nve.map((row) => (
                  <tr key={row.id}>
                    <td><code>{row.id}</code></td>
                    <td><code>{row.sourceInterfaceId}</code></td>
                    <td><code>{row.sourceAddress ?? "unassigned"}</code></td>
                    <td>{row.vniCount}</td>
                    <td>{row.adminUp ? "up" : "down"}</td>
                    <td>{row.up ? "up" : `down${row.reason ? ` (${row.reason})` : ""}`}</td>
                  </tr>
                ))}
                {view.nve.length === 0 && <tr><td colSpan={6}>No NVE interface is configured.</td></tr>}
              </tbody>
            </table>
            <VxlanProblems problems={view.problems} />
            <p className="section-note">
              Configure the overlay from the CLI: <code>interface nve1</code>,
              {" "}<code>source-interface Loopback0</code>, <code>member vni</code> and
              {" "}<code>vlan configuration &lt;id&gt;</code> → <code>member vni</code>.
            </p>
          </>
        )}

        {section === "mappings" && (
          <>
            <h2>VLAN-to-VNI Mappings</h2>
            <p className="section-note">
              One VLAN maps to at most one VNI, and one VNI to at most one VLAN. Replication is
              either a hand-written static peer list or BGP EVPN Inclusive Multicast membership.
            </p>
            <table className="data-table">
              <thead><tr><th>VNI</th><th>VLAN</th><th>Replication</th><th>Status</th></tr></thead>
              <tbody>
                {view.vnis.map((row) => (
                  <tr key={row.vni}>
                    <td><code>{row.vni}</code></td>
                    <td><code>{row.vlanId}</code></td>
                    <td>{row.replication === "bgp-evpn" ? "ingress-replication bgp" : "static peer list"}</td>
                    <td>{row.up ? "up" : `down${row.reason ? ` (${row.reason})` : ""}`}</td>
                  </tr>
                ))}
                {view.vnis.length === 0 && <tr><td colSpan={4}>No VNI is mapped.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {section === "peers" && (
          <>
            <h2>Remote VTEP Peers</h2>
            <p className="section-note">
              Head-end replication sends one copy of every broadcast, unknown-unicast and multicast
              frame to each peer, in stable address order. A peer needs an underlay route that does
              not egress the overlay itself.
            </p>
            <table className="data-table">
              <thead><tr><th>VNI</th><th>Peer</th><th>Learned from</th><th>Underlay</th></tr></thead>
              <tbody>
                {view.peers.map((row) => (
                  <tr key={`${row.vni}-${row.address}`}>
                    <td><code>{row.vni}</code></td>
                    <td><code>{row.address}</code></td>
                    <td>{row.source === "bgp-evpn" ? "BGP EVPN Type 3" : "static peer-ip"}</td>
                    <td>{row.reachable ? "reachable" : "no route"}</td>
                  </tr>
                ))}
                {view.peers.length === 0 && <tr><td colSpan={4}>No remote VTEP is known.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {section === "route-targets" && (
          <>
            <h2>EVPN Route Distinguishers and Targets</h2>
            <p className="section-note">
              A route is imported only when its route targets intersect a local VNI's import list.
              That intersection — not the VNI number — is what controls which tenant a VTEP joins.
            </p>
            <table className="data-table">
              <thead><tr><th>VNI</th><th>RD</th><th>Import RT</th><th>Export RT</th></tr></thead>
              <tbody>
                {view.vnis.map((row) => (
                  <tr key={row.vni}>
                    <td><code>{row.vni}</code></td>
                    <td><code>{row.routeDistinguisher ?? "—"}</code></td>
                    <td><code>{row.importRouteTargets.join(", ") || "—"}</code></td>
                    <td><code>{row.exportRouteTargets.join(", ") || "—"}</code></td>
                  </tr>
                ))}
                {view.vnis.length === 0 && <tr><td colSpan={4}>No VNI is mapped.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {section === "bgp-evpn" && (
          <>
            <h2>BGP EVPN</h2>
            <p className="section-note">
              The <code>l2vpn evpn</code> family rides the existing BGP session — there is no second
              process, FSM or TCP connection. Route targets travel only with
              {" "}<code>send-community extended</code>.
            </p>
            <p>
              Address family:{" "}
              <strong>{view.evpnAddressFamilyActive ? "active on at least one neighbor" : "not activated"}</strong>
            </p>
            <p className="section-note">
              Activate it from the CLI: <code>router bgp &lt;asn&gt;</code> →
              {" "}<code>address-family l2vpn evpn</code> → <code>neighbor &lt;a&gt; activate</code> and
              {" "}<code>neighbor &lt;a&gt; send-community extended</code>.
            </p>
            <VxlanProblems problems={view.problems} />
          </>
        )}

        {section === "remote-macs" && (
          <>
            <h2>Remote MAC Addresses</h2>
            <p className="section-note">
              A remote entry names the VTEP a MAC sits behind. On a BGP EVPN VNI the table is owned
              by the control plane, so a withdrawal genuinely removes an entry. This table is
              runtime and is never saved with the lab.
            </p>
            <table className="data-table">
              <thead><tr><th>VNI</th><th>MAC</th><th>Remote VTEP</th><th>Learned from</th></tr></thead>
              <tbody>
                {view.remoteMacs.map((row) => (
                  <tr key={`${row.vni}-${row.mac}`}>
                    <td><code>{row.vni}</code></td>
                    <td><code>{row.mac}</code></td>
                    <td><code>{row.remoteVtep}</code></td>
                    <td>{row.source === "bgp-evpn" ? "EVPN Type 2" : "data plane"}</td>
                  </tr>
                ))}
                {view.remoteMacs.length === 0 && <tr><td colSpan={4}>No remote MAC has been learned.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {(section === "type2" || section === "type3") && (
          <>
            <h2>{section === "type2" ? "EVPN Type 2 — MAC/IP Advertisement" : "EVPN Type 3 — Inclusive Multicast"}</h2>
            <p className="section-note">
              {section === "type2"
                ? "A Type 2 route advertises one locally learned MAC, so a remote VTEP can forward to it as known unicast instead of flooding."
                : "A Type 3 route advertises this VTEP's membership of a VNI, which is what builds the head-end replication list before any traffic exists."}
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Best</th><th>RD</th><th>VNI</th>
                <th>{section === "type2" ? "MAC" : "Originating VTEP"}</th>
                <th>Next hop</th><th>Route targets</th><th>Originator</th><th>Cluster list</th>
              </tr></thead>
              <tbody>
                {(section === "type2" ? type2 : type3).map((route, index) => (
                  <tr key={`${route.routeDistinguisher}-${route.vni}-${route.macAddress ?? route.originatingVtep}-${index}`}>
                    <td>{route.best ? "*>" : "*"}</td>
                    <td><code>{route.routeDistinguisher}</code></td>
                    <td><code>{route.vni}</code></td>
                    <td><code>{route.macAddress ?? route.originatingVtep}</code></td>
                    <td><code>{route.nextHop}</code></td>
                    <td><code>{route.routeTargets.join(", ") || "—"}</code></td>
                    <td><code>{route.originatorId ?? "—"}</code></td>
                    <td><code>{route.clusterList.join(" ") || "—"}</code></td>
                  </tr>
                ))}
                {(section === "type2" ? type2 : type3).length === 0 && (
                  <tr><td colSpan={8}>No route of this type is present.</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}

        <div className="qos-panel__actions">
          <Button variant="ghost" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={13} /> Refresh
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void act("RESTART_NVE")}>
            <RefreshCw size={13} /> Restart nve1
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void act("CLEAR_VXLAN_RUNTIME")}>
            <Trash2 size={13} /> Clear overlay runtime
          </Button>
        </div>
        {notice && <p className="section-note">{notice}</p>}
      </div>
    </div>
  );
}

function VxlanProblems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="qos-problems">
      {problems.map((problem) => (
        <li key={problem}><AlertTriangle size={13} /> {problem}</li>
      ))}
    </ul>
  );
}

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
  | "l3vni"
  | "anycast"
  | "peers"
  | "route-targets"
  | "bgp-evpn"
  | "remote-macs"
  | "type2"
  | "type3"
  | "type5"
  | "vrf-routes"
  | "routed-overlay"
  | "ethernet-segments"
  | "es-peers"
  | "df-election"
  | "type1"
  | "type4"
  | "multihoming";

export const VXLAN_SECTIONS: ReadonlyArray<{ id: VxlanSection; label: string }> = [
  { id: "nve", label: "NVE" },
  { id: "mappings", label: "L2VNI" },
  { id: "l3vni", label: "L3VNI" },
  { id: "anycast", label: "Anycast Gateway" },
  { id: "ethernet-segments", label: "Ethernet Segments" },
  { id: "peers", label: "Peers" },
  { id: "es-peers", label: "ES Peers" },
  { id: "df-election", label: "DF Election" },
  { id: "route-targets", label: "EVPN RD/RT" },
  { id: "bgp-evpn", label: "BGP EVPN" },
  { id: "remote-macs", label: "Remote MACs" },
  { id: "multihoming", label: "Multihoming Paths" },
  { id: "type1", label: "EVPN Type 1" },
  { id: "type2", label: "EVPN Type 2" },
  { id: "type3", label: "EVPN Type 3" },
  { id: "type4", label: "EVPN Type 4" },
  { id: "type5", label: "EVPN Type 5" },
  { id: "vrf-routes", label: "VRF Routes" },
  { id: "routed-overlay", label: "Routed Overlay" },
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
  // Which L3VNI row is expanded in place. Pure UI state, exactly like the
  // selected section: it never reaches LabDocument, a submission or grading.
  const [l3VniDetail, setL3VniDetail] = useState<number>();

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

  const act = async (type: "CLEAR_VXLAN_RUNTIME" | "RESTART_NVE" | "CLEAR_EVPN_ROUTED_RUNTIME") => {
    setBusy(true);
    try {
      setView(await props.client.request({ type, deviceId: props.deviceId }));
      setNotice(type === "CLEAR_VXLAN_RUNTIME"
        ? "Overlay runtime cleared; the configuration is unchanged."
        : type === "CLEAR_EVPN_ROUTED_RUNTIME"
          ? "Routed overlay runtime cleared; imported Type 5 prefixes are relearned."
          : "nve1 restarted; membership and remote MACs are relearned.");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to run the overlay action");
    } finally {
      setBusy(false);
    }
  };

  /** `shutdown`/`no shutdown` on one L3VNI, as a bounded runtime action. */
  const restartL3Vni = async (vni: number) => {
    setBusy(true);
    try {
      setView(await props.client.request({ type: "RESTART_EVPN_L3VNI", deviceId: props.deviceId, vni }));
      setNotice(`L3VNI ${vni} restarted; the tenant's imported prefixes are re-derived.`);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to restart the L3VNI");
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

  const type1 = view.evpnRoutes.filter((route) => route.type === 1);
  const type2 = view.evpnRoutes.filter((route) => route.type === 2);
  const type3 = view.evpnRoutes.filter((route) => route.type === 3);
  const type4 = view.evpnRoutes.filter((route) => route.type === 4);
  const type5 = view.evpnRoutes.filter((route) => route.type === 5);
  const selectedL3Vni = view.l3Vnis.find((entry) => entry.vni === l3VniDetail);

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

        {section === "l3vni" && (
          <>
            <h2>L3VNI — Routed Transit Segments</h2>
            <p className="section-note">
              <code>member vni &lt;n&gt; associate-vrf &lt;name&gt;</code> declares an L3VNI: a routed
              segment with no VLAN and no broadcast domain. One L3VNI belongs to at most one VRF per
              VTEP, a VRF carries at most one, and a VNI is either bridged or routed — never both.
              Select a row to see the tenant's RD, route targets and origination policy.
            </p>
            <table className="data-table qos-interface-table">
              <thead><tr>
                <th>L3VNI</th><th>VRF</th><th>Status</th><th>advertise l2vpn evpn</th>
                <th>Originated</th><th>Imported</th>
              </tr></thead>
              <tbody>
                {view.l3Vnis.map((row) => (
                  <tr key={row.vni} className={l3VniDetail === row.vni ? "is-selected" : ""}>
                    <td>
                      <button
                        type="button"
                        className="qos-interface-table__pick"
                        aria-expanded={l3VniDetail === row.vni}
                        onClick={() => setL3VniDetail(l3VniDetail === row.vni ? undefined : row.vni)}
                      >
                        <code>{row.vni}</code>
                      </button>
                    </td>
                    <td><code>{row.vrfId}</code></td>
                    <td>{row.up ? "up" : `down${row.reason ? ` (${row.reason})` : ""}`}</td>
                    <td>{row.advertiseEvpn ? "yes" : "no"}</td>
                    <td>{row.originatedPrefixCount}</td>
                    <td>{row.importedPrefixCount}</td>
                  </tr>
                ))}
                {view.l3Vnis.length === 0 && <tr><td colSpan={6}>No L3VNI is associated with a VRF.</td></tr>}
              </tbody>
            </table>
            {selectedL3Vni && (
              <div className="qos-interface-detail" aria-label={`L3VNI ${selectedL3Vni.vni} detail`}>
                <h3>VRF {selectedL3Vni.vrfId}</h3>
                <table className="data-table">
                  <tbody>
                    <tr><th scope="row">L3VNI</th><td><code>{selectedL3Vni.vni}</code></td></tr>
                    <tr><th scope="row">Route distinguisher</th><td><code>{selectedL3Vni.routeDistinguisher ?? "—"}</code></td></tr>
                    <tr><th scope="row">Import route targets</th><td><code>{selectedL3Vni.importRouteTargets.join(", ") || "—"}</code></td></tr>
                    <tr><th scope="row">Export route targets</th><td><code>{selectedL3Vni.exportRouteTargets.join(", ") || "—"}</code></td></tr>
                    <tr><th scope="row">advertise l2vpn evpn</th><td>{selectedL3Vni.advertiseEvpn ? "enabled" : "not configured"}</td></tr>
                    <tr><th scope="row">VTEP source address</th><td><code>{selectedL3Vni.sourceAddress ?? "unassigned"}</code></td></tr>
                  </tbody>
                </table>
                <Button variant="ghost" disabled={busy} onClick={() => void restartL3Vni(selectedL3Vni.vni)}>
                  <RefreshCw size={13} /> Restart L3VNI {selectedL3Vni.vni}
                </Button>
              </div>
            )}
            <p className="section-note">
              Configure the tenant from the CLI: <code>vrf definition &lt;name&gt;</code> with
              {" "}<code>rd</code> and <code>route-target</code>, <code>interface nve1</code> →
              {" "}<code>member vni &lt;n&gt; associate-vrf &lt;name&gt;</code>, then
              {" "}<code>router bgp &lt;asn&gt;</code> → <code>address-family ipv4 vrf &lt;name&gt;</code> →
              {" "}<code>advertise l2vpn evpn</code>.
            </p>
          </>
        )}

        {section === "anycast" && (
          <>
            <h2>Distributed Anycast Gateway</h2>
            <p className="section-note">
              One MAC for the whole fabric: every leaf carrying a tenant VLAN presents the
              <em> same </em> gateway IP and MAC, so a host always talks to its own local leaf and its
              ARP cache stays valid if it moves. That shared address is a distributed gateway, not a
              duplicate. The gateway MAC is never advertised as a Type 2 route, because every leaf
              owns it.
            </p>
            <p>
              Fabric anycast gateway MAC:{" "}
              <strong><code>{view.fabricAnycastGatewayMac ?? "not configured"}</code></strong>
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Interface</th><th>VLAN</th><th>Gateway address</th><th>MAC</th><th>VRF</th><th>Status</th>
              </tr></thead>
              <tbody>
                {view.anycastGateways.map((row) => (
                  <tr key={row.vlanId}>
                    <td><code>{row.interfaceId}</code></td>
                    <td><code>{row.vlanId}</code></td>
                    <td>
                      <code>
                        {row.ipAddress === undefined
                          ? "unassigned"
                          : `${row.ipAddress}/${row.prefixLength ?? ""}`}
                      </code>
                    </td>
                    <td><code>{row.macAddress ?? "—"}</code></td>
                    <td><code>{row.vrfId ?? "global"}</code></td>
                    <td>{row.up ? "up" : row.adminUp ? "down" : "administratively down"}</td>
                  </tr>
                ))}
                {view.anycastGateways.length === 0 && (
                  <tr><td colSpan={6}>No SVI runs in anycast-gateway mode.</td></tr>
                )}
              </tbody>
            </table>
            <p className="section-note">
              Configure it from the CLI: <code>fabric forwarding anycast-gateway-mac &lt;mac&gt;</code>
              {" "}then <code>interface Vlan&lt;id&gt;</code> → <code>fabric forwarding mode anycast-gateway</code>.
            </p>
          </>
        )}

        {section === "ethernet-segments" && (
          <>
            <p className="section-eyebrow">EVPN Multihoming</p>
            <h2>Ethernet Segments</h2>
            <p className="section-note">
              An Ethernet Segment is one CE attached to two leaves, named by a shared ESI. M10.16
              models <strong>Single Active</strong> redundancy only: exactly one leaf forwards toward
              the CE for each VLAN, and the other keeps a deterministic backup. All-active,
              aliasing and MAC mobility are deliberately not modelled.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Segment</th><th>ESI</th><th>Redundancy</th><th>Attachments</th>
                <th>VLANs</th><th>Status</th>
              </tr></thead>
              <tbody>
                {view.ethernetSegments.map((row) => (
                  <tr key={row.id}>
                    <td><code>{row.id}</code></td>
                    <td><code>{row.esi}</code></td>
                    <td>Single Active</td>
                    <td><code>{row.interfaces.join(", ") || "—"}</code></td>
                    <td><code>{row.vlanIds.join(", ") || "—"}</code></td>
                    <td>{row.up ? "up" : `down${row.reason ? ` (${row.reason})` : ""}`}</td>
                  </tr>
                ))}
                {view.ethernetSegments.length === 0 && (
                  <tr><td colSpan={6}>No Ethernet Segment is configured.</td></tr>
                )}
              </tbody>
            </table>
            <p className="section-note">
              Configure it from the CLI: <code>evpn ethernet-segment &lt;name&gt;</code> →
              {" "}<code>identifier &lt;esi&gt;</code> and <code>redundancy-mode single-active</code>,
              then <code>interface &lt;access port&gt;</code> → <code>ethernet-segment &lt;name&gt;</code>.
              The VLAN and VNI come from the existing VLAN-to-VNI mapping.
            </p>
            <VxlanProblems problems={view.problems} />
          </>
        )}

        {section === "es-peers" && (
          <>
            <h2>Ethernet Segment Peers</h2>
            <p className="section-note">
              A leaf discovers who else attaches the same CE from EVPN Type 4 routes. Reachability
              comes from the Ethernet A-D per-ES route: when it is withdrawn, everything behind that
              leaf's attachment is invalidated in one message.
            </p>
            <table className="data-table">
              <thead><tr><th>ESI</th><th>VTEP</th><th>Router ID</th><th>Origin</th><th>Reachability</th></tr></thead>
              <tbody>
                {view.ethernetSegmentPeers.map((row) => (
                  <tr key={`${row.esi}-${row.vtep}`}>
                    <td><code>{row.esi}</code></td>
                    <td><code>{row.vtep}</code></td>
                    <td><code>{row.routerId ?? "—"}</code></td>
                    <td>{row.local ? "local" : "remote"}</td>
                    <td>{row.reachable ? "Ethernet A-D" : "no Ethernet A-D"}</td>
                  </tr>
                ))}
                {view.ethernetSegmentPeers.length === 0 && (
                  <tr><td colSpan={5}>No Ethernet Segment peer is known.</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}

        {section === "df-election" && (
          <>
            <h2>Designated Forwarder Election</h2>
            <p className="section-note">
              Every participating leaf runs the same deterministic election over the same canonically
              ordered candidate list, so all of them reach an identical answer without one telling
              another what it decided. Exactly one leaf is DF per <code>&lt;ESI, VLAN&gt;</code>; the
              non-DF keeps its attachment as a backup and does not forward toward the CE.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>ESI</th><th>VLAN</th><th>Candidates</th><th>Designated Forwarder</th><th>Local role</th>
              </tr></thead>
              <tbody>
                {view.designatedForwarders.map((row) => (
                  <tr key={`${row.esi}-${row.vlanId}`}>
                    <td><code>{row.esi}</code></td>
                    <td><code>{row.vlanId}</code></td>
                    <td><code>{row.candidates.join(", ") || "—"}</code></td>
                    <td><code>{row.designatedForwarder ?? "none"}</code></td>
                    <td><strong>{row.localRole === "df" ? "DF" : "non-DF"}</strong></td>
                  </tr>
                ))}
                {view.designatedForwarders.length === 0 && (
                  <tr><td colSpan={5}>No Designated Forwarder has been elected.</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}

        {section === "multihoming" && (
          <>
            <h2>Multihoming Paths</h2>
            <p className="section-note">
              A MAC behind a multihomed segment is forwarded to the segment's <em>current</em>
              {" "}Designated Forwarder rather than simply to whichever leaf advertised it. That is
              why a mass withdrawal moves traffic without a single address being relearned. Single
              Active never forwards over a backup — there is no aliasing here.
            </p>
            <table className="data-table">
              <thead><tr><th>VNI</th><th>MAC</th><th>ESI</th><th>Primary</th><th>Backup</th></tr></thead>
              <tbody>
                {view.multihomingPaths.map((row) => (
                  <tr key={`${row.vni}-${row.mac}`}>
                    <td><code>{row.vni}</code></td>
                    <td><code>{row.mac}</code></td>
                    <td><code>{row.esi}</code></td>
                    <td><code>{row.primary}</code></td>
                    <td><code>{row.backups.join(", ") || "—"}</code></td>
                  </tr>
                ))}
                {view.multihomingPaths.length === 0 && (
                  <tr><td colSpan={5}>No remote MAC sits behind an Ethernet Segment.</td></tr>
                )}
              </tbody>
            </table>
          </>
        )}

        {(section === "type1" || section === "type4") && (
          <>
            <h2>
              {section === "type1"
                ? "EVPN Type 1 — Ethernet Auto-Discovery"
                : "EVPN Type 4 — Ethernet Segment"}
            </h2>
            <p className="section-note">
              {section === "type1"
                ? "A per-ES route says this VTEP still has a working attachment, so withdrawing one invalidates every MAC behind it at once. A per-EVI route says it can serve the segment in this EVI, which is what makes a deterministic backup selectable before anything fails."
                : "A Type 4 route is how two leaves discover that they attach the same CE. The resulting candidate list is exactly what the Designated Forwarder election runs over."}
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Best</th><th>RD</th><th>ESI</th>
                <th>{section === "type1" ? "Scope" : "Originating VTEP"}</th>
                <th>VNI</th><th>Next hop</th><th>Route targets</th><th>Originator</th>
              </tr></thead>
              <tbody>
                {(section === "type1" ? type1 : type4).map((route, index) => (
                  <tr key={`${route.routeDistinguisher}-${route.esi}-${route.scope ?? ""}-${index}`}>
                    <td>{route.best ? "*>" : "*"}</td>
                    <td><code>{route.routeDistinguisher}</code></td>
                    <td><code>{route.esi ?? "—"}</code></td>
                    <td><code>{section === "type1" ? route.scope ?? "—" : route.originatingVtep ?? "—"}</code></td>
                    <td><code>{route.vni === 0 ? "—" : route.vni}</code></td>
                    <td><code>{route.nextHop}</code></td>
                    <td><code>{route.routeTargets.join(", ") || "—"}</code></td>
                    <td><code>{route.originatorId ?? "—"}</code></td>
                  </tr>
                ))}
                {(section === "type1" ? type1 : type4).length === 0 && (
                  <tr><td colSpan={8}>No route of this type is present.</td></tr>
                )}
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
              <thead><tr>
                <th>VNI</th><th>MAC</th><th>Remote VTEP</th><th>ESI</th><th>Backup</th><th>Learned from</th>
              </tr></thead>
              <tbody>
                {view.remoteMacs.map((row) => (
                  <tr key={`${row.vni}-${row.mac}`}>
                    <td><code>{row.vni}</code></td>
                    <td><code>{row.mac}</code></td>
                    <td><code>{row.remoteVtep}</code></td>
                    <td><code>{row.ethernetSegmentId ?? "—"}</code></td>
                    <td><code>{row.backupVteps.join(", ") || "—"}</code></td>
                    <td>{row.source === "bgp-evpn" ? "EVPN Type 2" : "data plane"}</td>
                  </tr>
                ))}
                {view.remoteMacs.length === 0 && <tr><td colSpan={6}>No remote MAC has been learned.</td></tr>}
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

        {section === "type5" && (
          <>
            <h2>EVPN Type 5 — IP Prefix Route</h2>
            <p className="section-note">
              A Type 5 route advertises one tenant IPv4 prefix and names the L3VNI symmetric IRB
              transits it through. Origination needs an RD, an export route target, an operational
              L3VNI and an explicit <code>advertise l2vpn evpn</code> — there is no hidden
              redistribution. Uniqueness is RD <em>and</em> prefix, so two tenants may advertise the
              same network and remain two routes.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>Best</th><th>RD</th><th>Prefix</th><th>L3VNI</th><th>Next-hop VTEP</th>
                <th>Route targets</th><th>Originator</th><th>Cluster list</th>
              </tr></thead>
              <tbody>
                {type5.map((route, index) => (
                  <tr key={`${route.routeDistinguisher}-${route.network}-${route.prefixLength}-${index}`}>
                    <td>{route.best ? "*>" : "*"}</td>
                    <td><code>{route.routeDistinguisher}</code></td>
                    <td><code>{route.network}/{route.prefixLength}</code></td>
                    <td><code>{route.vni}</code></td>
                    <td><code>{route.nextHopVtep ?? route.nextHop}</code></td>
                    <td><code>{route.routeTargets.join(", ") || "—"}</code></td>
                    <td><code>{route.originatorId ?? "—"}</code></td>
                    <td><code>{route.clusterList.join(" ") || "—"}</code></td>
                  </tr>
                ))}
                {type5.length === 0 && <tr><td colSpan={8}>No Type 5 prefix is present.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {section === "vrf-routes" && (
          <>
            <h2>Tenant VRF Routes</h2>
            <p className="section-note">
              Each VRF is an explicit routing context. A prefix is installed only when its route
              targets intersect that VRF's import list — never by VNI number — which is exactly what
              keeps two tenants with overlapping addresses isolated. The global table is never a
              fallback. This table is runtime and is never saved with the lab.
            </p>
            <table className="data-table">
              <thead><tr>
                <th>VRF</th><th>Prefix</th><th>Source</th><th>Next hop</th>
                <th>Remote VTEP</th><th>L3VNI</th><th>AD/Metric</th>
              </tr></thead>
              <tbody>
                {view.vrfRoutes.map((row, index) => (
                  <tr key={`${row.vrfId}-${row.network}-${row.prefixLength}-${index}`}>
                    <td><code>{row.vrfId}</code></td>
                    <td><code>{row.network}/{row.prefixLength}</code></td>
                    <td>{row.source === "evpn-type5" ? "EVPN Type 5" : row.source}</td>
                    <td><code>{row.nextHop ?? row.outgoingInterfaceId ?? "—"}</code></td>
                    <td><code>{row.remoteVtep ?? "—"}</code></td>
                    <td><code>{row.l3Vni ?? "—"}</code></td>
                    <td>{row.administrativeDistance}/{row.metric}</td>
                  </tr>
                ))}
                {view.vrfRoutes.length === 0 && <tr><td colSpan={7}>No tenant VRF carries a route.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {section === "routed-overlay" && (
          <>
            <h2>Routed Overlay Status</h2>
            <p className="section-note">
              Symmetric IRB means both ends route: the ingress VTEP looks up the tenant VRF and
              encapsulates into the L3VNI, and the egress VTEP maps that VNI back to its VRF and
              repeats the lookup. Underlay routers see only outer IPv4/UDP 4789 and hold no tenant
              route or MAC.
            </p>
            <table className="data-table">
              <tbody>
                <tr>
                  <th scope="row">Routed overlay</th>
                  <td>{view.routedOverlay.operational ? "operational" : "not carrying tenant prefixes"}</td>
                </tr>
                <tr>
                  <th scope="row">L3VNIs</th>
                  <td>{view.routedOverlay.operationalL3VniCount} up of {view.routedOverlay.l3VniCount}</td>
                </tr>
                <tr><th scope="row">Prefixes originated</th><td>{view.routedOverlay.originatedPrefixCount}</td></tr>
                <tr><th scope="row">Prefixes imported</th><td>{view.routedOverlay.importedPrefixCount}</td></tr>
                <tr><th scope="row">Anycast gateways</th><td>{view.routedOverlay.anycastGatewayCount}</td></tr>
              </tbody>
            </table>
            {view.routedOverlay.reasons.length > 0 && (
              <ul className="qos-problems">
                {view.routedOverlay.reasons.map((reason) => (
                  <li key={reason}><AlertTriangle size={13} /> {reason}</li>
                ))}
              </ul>
            )}
            <VxlanProblems problems={view.problems} />
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
          <Button variant="ghost" disabled={busy} onClick={() => void act("CLEAR_EVPN_ROUTED_RUNTIME")}>
            <Trash2 size={13} /> Clear routed runtime
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

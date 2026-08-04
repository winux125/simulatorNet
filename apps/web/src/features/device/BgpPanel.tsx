import type { LabDocument } from "@sim/contracts";
import type { BgpStateView, BgpUnicastAddressFamily } from "@sim/sim-worker";
import { useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";

/**
 * One reusable BGP surface shared by Config and Monitor, following the same
 * shape as the QoS and VPN panels: secondary navigation inside one section
 * rather than new top-level tabs, and no nested modal window.
 *
 * The selected subsection is local UI state. It never reaches `LabDocument`, a
 * submission, grading or the database, and switching between subsections
 * changes no configuration.
 */
export type BgpConfigSection =
  | "overview"
  | "neighbors"
  | "address-families"
  | "route-reflection"
  | "networks"
  | "policies";

export type BgpMonitorSection =
  | "summary"
  | "table"
  | "neighbors"
  | "advertised"
  | "communities"
  | "aggregates"
  | "route-reflection"
  | "policy-counters";

const CONFIG_SECTIONS: ReadonlyArray<{ id: BgpConfigSection; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "neighbors", label: "Neighbors" },
  { id: "address-families", label: "Address Families" },
  { id: "route-reflection", label: "Route Reflection" },
  { id: "networks", label: "Networks & Aggregates" },
  { id: "policies", label: "Policies" },
];

const MONITOR_SECTIONS: ReadonlyArray<{ id: BgpMonitorSection; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "table", label: "BGP Table" },
  { id: "neighbors", label: "Neighbors" },
  { id: "advertised", label: "Advertised/Received" },
  { id: "communities", label: "Communities" },
  { id: "aggregates", label: "Aggregates" },
  { id: "route-reflection", label: "Route Reflection" },
  { id: "policy-counters", label: "Policy Counters" },
];

function Nav<T extends string>({
  sections,
  section,
  onSelect,
  label,
}: {
  sections: ReadonlyArray<{ id: T; label: string }>;
  section: T;
  onSelect(next: T): void;
  label: string;
}) {
  return <nav className="qos-panel__nav" role="tablist" aria-label={label}>
    {sections.map((entry) => <button
      key={entry.id}
      type="button"
      role="tab"
      aria-selected={section === entry.id}
      className={section === entry.id ? "is-active" : ""}
      onClick={() => onSelect(entry.id)}
    >{entry.label}</button>)}
  </nav>;
}

function Empty({ text }: { text: string }) {
  return <p className="section-note">{text}</p>;
}

/** Config ▸ Routing ▸ BGP: structured configuration straight from the document. */
export function BgpConfigurationPanel({ document, deviceId }: { document: LabDocument; deviceId: string }) {
  const [section, setSection] = useState<BgpConfigSection>("overview");
  const configuration = document.configurations[deviceId];
  const bgp = configuration && "bgp" in configuration ? configuration.bgp : undefined;
  const prefixLists = configuration && "prefixLists" in configuration ? configuration.prefixLists ?? [] : [];
  const ipv6PrefixLists = configuration && "ipv6PrefixLists" in configuration ? configuration.ipv6PrefixLists ?? [] : [];
  const routeMaps = configuration && "routeMaps" in configuration ? configuration.routeMaps ?? [] : [];
  const communityLists = configuration && "communityLists" in configuration ? configuration.communityLists ?? [] : [];
  const asPathLists = configuration && "asPathLists" in configuration ? configuration.asPathLists ?? [] : [];

  if (!bgp) {
    return <div className="device-window-section">
      <p className="section-eyebrow">Routing · BGP</p>
      <h3>BGP is not configured</h3>
      <p>Use the CLI command <code>router bgp &lt;asn&gt;</code> to create the educational IPv4-unicast process.</p>
    </div>;
  }

  const clients = bgp.neighbors.filter((neighbor) => neighbor.routeReflectorClient);
  const nonClients = bgp.neighbors.filter((neighbor) => neighbor.remoteAs === bgp.localAs && !neighbor.routeReflectorClient);

  return <div className="qos-panel">
    <Nav sections={CONFIG_SECTIONS} section={section} onSelect={(next) => setSection(next)} label="BGP configuration sections" />
    <div className="qos-panel__body" role="tabpanel">
      {section === "overview" && <>
        <p className="section-eyebrow">Routing · BGP configuration</p>
        <p>Local AS <strong>{bgp.localAs}</strong> · Router ID <code>{bgp.routerId ?? "automatic"}</code>
          {" · "}Cluster ID <code>{bgp.clusterId ?? bgp.routerId ?? "automatic"}</code>
          {" · "}Keepalive {bgp.keepaliveSeconds ?? 60}s · Hold {bgp.holdTimeSeconds ?? 180}s</p>
        <p className="section-note">
          {bgp.neighbors.length} neighbor(s) · {bgp.networks.length} network statement(s)
          {" · "}{(bgp.aggregates ?? []).length} aggregate(s)
        </p>
      </>}

      {section === "neighbors" && <table className="data-table">
        <thead><tr><th>Address</th><th>Remote AS</th><th>Update source</th><th>Multihop</th><th>Next-hop-self</th><th>Policies</th></tr></thead>
        <tbody>{bgp.neighbors.map((neighbor) => <tr key={neighbor.address}>
          <td><code>{neighbor.address}</code></td>
          <td>{neighbor.remoteAs}</td>
          <td>{neighbor.updateSource ?? "—"}</td>
          <td>{neighbor.ebgpMultihop ?? 1}</td>
          <td>{neighbor.nextHopSelf ? "yes" : "no"}</td>
          <td>{[
            neighbor.prefixListIn && `prefix-list ${neighbor.prefixListIn} in`,
            neighbor.prefixListOut && `prefix-list ${neighbor.prefixListOut} out`,
            neighbor.routeMapIn && `route-map ${neighbor.routeMapIn} in`,
            neighbor.routeMapOut && `route-map ${neighbor.routeMapOut} out`,
          ].filter(Boolean).join(", ") || "—"}</td>
        </tr>)}</tbody>
      </table>}

      {section === "address-families" && <>
        <p className="section-note">
          One BGP process and one TCP session per neighbor carry every activated
          address family. IPv4 unicast is implicit on an IPv4-transport neighbor;
          an IPv6-transport neighbor carries IPv6 unicast instead.
        </p>
        <table className="data-table" aria-label="BGP address families">
          <thead><tr>
            <th>Neighbor</th><th>IPv4 unicast</th><th>IPv6 unicast</th><th>VPNv4</th><th>VPNv6</th>
            <th>send-community</th><th>default-originate</th>
          </tr></thead>
          <tbody>{bgp.neighbors.map((neighbor) => {
            const ipv6Transport = neighbor.address.includes(":");
            const ipv6Active = ipv6Transport || neighbor.ipv6?.activated === true;
            return <tr key={neighbor.address}>
              <td><code>{neighbor.address}</code></td>
              <td>{ipv6Transport ? "—" : "active"}</td>
              <td>{ipv6Active ? "active" : "—"}</td>
              <td>{neighbor.vpnv4Activated ? "active" : "—"}</td>
              <td>{neighbor.vpnv6Activated ? "active" : "—"}</td>
              <td>{[
                (neighbor.sendCommunityStandard || neighbor.ipv6?.sendCommunityStandard) && "standard",
                neighbor.sendCommunityExtended && "extended",
              ].filter(Boolean).join(" + ") || "none"}</td>
              <td>{[
                neighbor.defaultOriginate && `IPv4 ${neighbor.defaultOriginateRouteMap ?? "yes"}`,
                neighbor.ipv6?.defaultOriginate && `IPv6 ${neighbor.ipv6.defaultOriginateRouteMap ?? "yes"}`,
              ].filter(Boolean).join(", ") || "—"}</td>
            </tr>;
          })}</tbody>
        </table>
        <h3>IPv6 unicast policies</h3>
        {bgp.neighbors.some((neighbor) => neighbor.ipv6) ? <table className="data-table">
          <thead><tr><th>Neighbor</th><th>Next-hop-self</th><th>RR client</th><th>Policies</th></tr></thead>
          <tbody>{bgp.neighbors.filter((neighbor) => neighbor.ipv6).map((neighbor) => <tr key={neighbor.address}>
            <td><code>{neighbor.address}</code></td>
            <td>{neighbor.ipv6?.nextHopSelf ? "yes" : "no"}</td>
            <td>{neighbor.ipv6?.routeReflectorClient ? "yes" : "no"}</td>
            <td>{[
              neighbor.ipv6?.prefixListIn && `prefix-list ${neighbor.ipv6.prefixListIn} in`,
              neighbor.ipv6?.prefixListOut && `prefix-list ${neighbor.ipv6.prefixListOut} out`,
              neighbor.ipv6?.routeMapIn && `route-map ${neighbor.ipv6.routeMapIn} in`,
              neighbor.ipv6?.routeMapOut && `route-map ${neighbor.ipv6.routeMapOut} out`,
            ].filter(Boolean).join(", ") || "—"}</td>
          </tr>)}</tbody>
        </table> : <Empty text="No neighbor has an IPv6 unicast address-family block." />}
        <h3>VRF address families</h3>
        {bgp.vrfAddressFamilies.length ? <table className="data-table">
          <thead><tr><th>VRF</th><th>IPv4 redistribution</th><th>IPv6 redistribution</th></tr></thead>
          <tbody>{bgp.vrfAddressFamilies.map((family) => <tr key={family.vrfId}>
            <td><code>{family.vrfId}</code></td>
            <td>{[family.redistributeConnected && "connected", family.redistributeStatic && "static"].filter(Boolean).join(", ") || "—"}</td>
            <td>{[family.redistributeConnectedIpv6 && "connected", family.redistributeStaticIpv6 && "static"].filter(Boolean).join(", ") || "—"}</td>
          </tr>)}</tbody>
        </table> : <Empty text="No per-VRF address family is configured." />}
      </>}

      {section === "route-reflection" && <>
        <p>Cluster ID <code>{bgp.clusterId ?? bgp.routerId ?? "automatic (router ID)"}</code></p>
        <h3>Clients</h3>
        {clients.length
          ? <p>{clients.map((neighbor) => neighbor.address).join(", ")}</p>
          : <Empty text="No route-reflector clients; this device uses plain iBGP split horizon." />}
        <h3>Non-client iBGP peers</h3>
        {nonClients.length ? <p>{nonClients.map((neighbor) => neighbor.address).join(", ")}</p> : <Empty text="None." />}
      </>}

      {section === "networks" && <>
        <h3>IPv4 unicast network statements</h3>
        {bgp.networks.length
          ? <p>{bgp.networks.map((network) => `${network.network}/${network.prefixLength}`).join(", ")}</p>
          : <Empty text="No network statements." />}
        <h3>IPv6 unicast network statements</h3>
        {(bgp.ipv6Networks ?? []).length
          ? <p>{(bgp.ipv6Networks ?? []).map((network) => `${network.network}/${network.prefixLength}`).join(", ")}</p>
          : <Empty text="No IPv6 network statements. A prefix is advertised only when an exact IPv6 route exists locally." />}
        <h3>Aggregates</h3>
        {(bgp.aggregates ?? []).length ? <table className="data-table">
          <thead><tr><th>Prefix</th><th>summary-only</th><th>as-set</th></tr></thead>
          <tbody>{(bgp.aggregates ?? []).map((aggregate) => <tr key={`${aggregate.prefix}/${aggregate.prefixLength}`}>
            <td><code>{aggregate.prefix}/{aggregate.prefixLength}</code></td>
            <td>{aggregate.summaryOnly ? "yes" : "no"}</td>
            <td>{aggregate.asSet ? "yes" : "no"}</td>
          </tr>)}</tbody>
        </table> : <Empty text="No aggregate-address statements." />}
      </>}

      {section === "policies" && <>
        <p className="section-note">
          Prefix lists, community lists, AS-path lists and route maps share one BGP Policies section.
        </p>
        <h3>Prefix lists ({prefixLists.length})</h3>
        {prefixLists.map((list) => <p key={list.id}>
          <code>{list.id}</code>: {list.entries.map((entry) => `${entry.sequence} ${entry.action} ${entry.prefix}/${entry.prefixLength}`).join("; ")}
        </p>)}
        <h3>IPv6 prefix lists ({ipv6PrefixLists.length})</h3>
        {ipv6PrefixLists.length ? ipv6PrefixLists.map((list) => <p key={list.id}>
          <code>{list.id}</code>: {list.entries.map((entry) => [
            entry.sequence,
            entry.action,
            `${entry.prefix}/${entry.prefixLength}`,
            entry.ge !== undefined && `ge ${entry.ge}`,
            entry.le !== undefined && `le ${entry.le}`,
          ].filter(Boolean).join(" ")).join("; ")}
        </p>) : <Empty text="No IPv6 prefix lists. An IPv6 prefix list never uses a wildcard mask." />}
        <h3>Community lists ({communityLists.length})</h3>
        {communityLists.map((list) => <p key={list.id}>
          <code>{list.id}</code>: {list.entries.map((entry) => `${entry.sequence} ${entry.action} ${entry.communities.join(" ")}`).join("; ")}
        </p>)}
        <h3>AS-path lists ({asPathLists.length})</h3>
        {asPathLists.map((list) => <p key={list.id}>
          <code>{list.id}</code>: {list.entries.map((entry) => `${entry.sequence} ${entry.action} ${describeMatcher(entry.matcher)}`).join("; ")}
        </p>)}
        <h3>Route maps ({routeMaps.length})</h3>
        {routeMaps.map((map) => <p key={map.id}>
          <code>{map.id}</code>: {map.sequences.map((sequence) => `${sequence.sequence} ${sequence.action}`).join("; ")}
        </p>)}
      </>}
    </div>
  </div>;
}

type AsPathMatcherView = { kind: string; asn?: number; asPath?: readonly number[]; operator?: string; length?: number };

/** The same educational pattern text the CLI and the renderer produce. */
function describeMatcher(matcher: AsPathMatcherView): string {
  switch (matcher.kind) {
    case "empty": return "^$";
    case "contains": return `_${matcher.asn}_`;
    case "starts-with": return `^${matcher.asn}_`;
    case "ends-with": return `_${matcher.asn}$`;
    case "exact": return `^${(matcher.asPath ?? []).join(" ")}$`;
    default: return `length ${matcher.operator} ${matcher.length}`;
  }
}

/** Monitor ▸ BGP: derived runtime state, rebuilt by the worker, never persisted. */
export function BgpRuntimePanel({
  client,
  deviceId,
  onError,
}: {
  client: SimulatorClient;
  deviceId: string;
  onError(message: string): void;
}) {
  const [state, setState] = useState<BgpStateView>();
  const [section, setSection] = useState<BgpMonitorSection>("summary");
  // Which address family is on screen is local UI state: it never reaches a
  // LabDocument, a submission, grading or the database.
  const [addressFamily, setAddressFamily] = useState<BgpUnicastAddressFamily>("ipv4-unicast");

  const apply = (pending: Promise<BgpStateView>) =>
    void pending.then(setState).catch((error) =>
      onError(error instanceof Error ? error.message : "Unable to inspect BGP runtime"));

  useEffect(() => {
    let active = true;
    void client.request({ type: "GET_BGP_STATE", deviceId }).then((next) => {
      if (active) setState(next);
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : "Unable to inspect BGP runtime");
    });
    return () => { active = false; };
  }, [client, deviceId, onError]);

  if (!state) return <div className="device-window-section">Loading BGP runtime…</div>;
  const established = state.neighbors.filter((neighbor) => neighbor.state === "established").length;
  // The RIBs are per address family; the FSM, the TCP session and the policy
  // engine are shared, so the neighbor list stays whole and is only annotated.
  const family = addressFamily === "ipv6-unicast"
    ? state.ipv6Unicast
    : { routes: state.routes, adjRibIn: state.adjRibIn, adjRibOut: state.adjRibOut, ribFailures: state.ribFailures, communities: state.communities };
  const familyNeighbors = state.neighbors.filter((neighbor) => neighbor.addressFamilies.includes(addressFamily));

  return <div className="qos-panel">
    <Nav sections={MONITOR_SECTIONS} section={section} onSelect={(next) => setSection(next)} label="BGP monitor sections" />
    <div className="qos-panel__body" role="tabpanel">
      <div className="toolbar-row" data-testid="bgp-address-family-selector">
        <label htmlFor="bgp-address-family">Address family</label>
        <select
          id="bgp-address-family"
          value={addressFamily}
          onChange={(event) => setAddressFamily(event.target.value as BgpUnicastAddressFamily)}
        >
          <option value="ipv4-unicast">IPv4 unicast</option>
          <option value="ipv6-unicast">IPv6 unicast</option>
        </select>
        <span className="section-note">
          {familyNeighbors.length} neighbor(s) negotiated this family · {family.routes.length} RIB entr(y/ies)
        </span>
      </div>
      {section === "summary" && <>
        <p className="section-eyebrow">BGP monitor</p>
        <p>{state.configuration
          ? `Local AS ${state.configuration.localAs} · ${established}/${state.neighbors.length} Established`
          : "BGP is not configured."}</p>
        <p className="section-note">
          Active address families: {state.addressFamilies.join(", ") || "none"}
        </p>
        <div className="toolbar-row">
          <button type="button" onClick={() => apply(client.request({ type: "RESET_BGP_PROCESS", deviceId }))}>Reset process</button>
          <button type="button" onClick={() => apply(client.request({ type: "SOFT_RESET_BGP_NEIGHBOR", deviceId, direction: "both" }))}>Soft reevaluate policy</button>
          <button type="button" onClick={() => apply(client.request({ type: "GET_BGP_STATE", deviceId }))}>Refresh</button>
        </div>
        <p className="section-note">
          Soft reevaluation re-runs policy against the stored Adj-RIB-In; no TCP session is reset and no configuration changes.
        </p>
      </>}

      {section === "table" && <table className="data-table" aria-label="BGP table">
        <thead><tr><th>Best</th><th>Prefix</th><th>Next hop</th><th>Weight</th><th>Local pref</th><th>MED</th><th>Communities</th><th>AS path</th></tr></thead>
        <tbody>{family.routes.map((route) => <tr key={`${route.routeId}:${route.neighborAddress ?? "local"}`}>
          <td>{route.best ? "✓" : ""}</td>
          <td><code>{route.network}/{route.prefixLength}</code></td>
          <td><code>{route.nextHop}</code></td>
          <td>{route.weight}</td>
          <td>{route.localPreference}</td>
          <td>{route.med}</td>
          <td>{route.communities.join(" ") || "—"}</td>
          <td>{route.asPath.join(" ") || "local"}</td>
        </tr>)}</tbody>
      </table>}

      {section === "neighbors" && <table className="data-table" aria-label="BGP neighbors">
        <thead><tr><th>Neighbor</th><th>AS</th><th>State</th><th>Address families</th><th>RR client</th><th>Prefixes</th><th>Action</th></tr></thead>
        <tbody>{state.neighbors.map((neighbor) => <tr key={neighbor.address}>
          <td><code>{neighbor.address}</code></td>
          <td>{neighbor.remoteAs}</td>
          <td>{neighbor.state}</td>
          <td>{neighbor.addressFamilies.join(", ") || "—"}</td>
          <td>{state.routeReflection.clients.includes(neighbor.address) ? "yes" : "no"}</td>
          <td>{family.adjRibIn.filter((route) => route.neighborAddress === neighbor.address).length}</td>
          <td>
            <button type="button" onClick={() => apply(client.request({ type: "RESET_BGP_NEIGHBOR", deviceId, neighbor: neighbor.address }))}>Reset</button>
            <button type="button" onClick={() => apply(client.request({ type: "SOFT_RESET_BGP_NEIGHBOR", deviceId, neighbor: neighbor.address, direction: "both" }))}>Soft</button>
          </td>
        </tr>)}</tbody>
      </table>}

      {section === "advertised" && <>
        <p>{family.adjRibOut.length} advertised · {family.adjRibIn.length} received · {family.ribFailures.length} RIB failure(s)</p>
        <table className="data-table" aria-label="Advertised and received routes">
          <thead><tr><th>Direction</th><th>Neighbor</th><th>Prefix</th><th>Communities</th><th>Originator</th><th>Cluster list</th></tr></thead>
          <tbody>{[
            ...family.adjRibOut.map((route) => ["out", route] as const),
            ...family.adjRibIn.map((route) => ["in", route] as const),
          ].map(([direction, route], index) => <tr key={`${direction}-${route.routeId}-${index}`}>
            <td>{direction}</td>
            <td><code>{route.neighborAddress ?? "—"}</code></td>
            <td><code>{route.network}/{route.prefixLength}</code></td>
            <td>{route.communities.join(" ") || "—"}</td>
            <td><code>{route.originatorId ?? "—"}</code></td>
            <td>{route.clusterList.join(" ") || "—"}</td>
          </tr>)}</tbody>
        </table>
      </>}

      {section === "communities" && (family.communities.length
        ? <table className="data-table">
          <thead><tr><th>Community</th><th>Routes</th></tr></thead>
          <tbody>{family.communities.map((entry) => <tr key={entry.community}>
            <td><code>{entry.community}</code></td><td>{entry.routes}</td>
          </tr>)}</tbody>
        </table>
        : <Empty text="No BGP route currently carries a standard community." />)}

      {section === "aggregates" && <>
        {state.aggregates.length ? <table className="data-table">
          <thead><tr><th>Aggregate</th><th>Active</th><th>summary-only</th><th>Contributing</th><th>Suppressed</th></tr></thead>
          <tbody>{state.aggregates.map((aggregate) => <tr key={`${aggregate.prefix}/${aggregate.prefixLength}`}>
            <td><code>{aggregate.prefix}/{aggregate.prefixLength}</code></td>
            <td>{aggregate.active ? "yes" : "no"}</td>
            <td>{aggregate.summaryOnly ? "yes" : "no"}</td>
            <td>{aggregate.contributingRoutes}</td>
            <td>{aggregate.suppressedRoutes}</td>
          </tr>)}</tbody>
        </table> : <Empty text="No aggregate-address statements." />}
        <h3>Suppressed more-specific routes</h3>
        {state.suppressedRoutes.length
          ? <p>{state.suppressedRoutes.map((route) => `${route.network}/${route.prefixLength}`).join(", ")}</p>
          : <Empty text="None. summary-only hides advertisements, never the local forwarding table." />}
      </>}

      {section === "route-reflection" && <>
        <p>Cluster ID <code>{state.routeReflection.clusterId}</code>
          {" · "}{state.routeReflection.isRouteReflector ? "acting as a route reflector" : "not a route reflector"}</p>
        <p>Clients: {state.routeReflection.clients.join(", ") || "none"}</p>
        <p>Non-clients: {state.routeReflection.nonClients.join(", ") || "none"}</p>
        <p>Reflected routes: {state.routeReflection.reflectedRoutes}</p>
        <p>Originator loops rejected: {state.routeReflection.originatorLoopsRejected}
          {" · "}Cluster loops rejected: {state.routeReflection.clusterLoopsRejected}</p>
      </>}

      {section === "policy-counters" && <table className="data-table">
        <thead><tr><th>Policy</th><th>Sequence</th><th>Matches</th><th>Permit</th><th>Deny</th></tr></thead>
        <tbody>{state.policyCounters.map((counter) => <tr key={`${counter.policyType}:${counter.policyId}:${counter.sequence}`}>
          <td>{counter.policyType} {counter.policyId}</td>
          <td>{counter.sequence}</td>
          <td>{counter.matches}</td>
          <td>{counter.permits}</td>
          <td>{counter.denies}</td>
        </tr>)}</tbody>
      </table>}
    </div>
  </div>;
}

import type { LabUiSnapshot, SimulationTraceEvent } from "@sim/sim-worker";
import { AlertTriangle, Braces, ChevronUp, EyeOff, List, Minus, Network, TerminalSquare } from "lucide-react";
import type { DockTab, ExecutionMode, WorkspaceProblem } from "../../state/workspace-store";
import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, IconButton, Tabs } from "../../ui";
import {
  TERMINAL_DOCK_SLOT_ID,
  type TerminalPresentationMode,
} from "../terminal/terminal-presentation-state";

interface BottomDockProps {
  tab: DockTab;
  snapshot: LabUiSnapshot | undefined;
  traces: SimulationTraceEvent[];
  problems: WorkspaceProblem[];
  terminalTabs: string[];
  terminalPresentationMode: TerminalPresentationMode;
  terminalVisible: boolean;
  executionMode: ExecutionMode;
  onTab(tab: DockTab): void;
  onClearProblems(): void;
  onExecutionModeChange(mode: ExecutionMode): void;
  onStep(): void;
  onRunAll(): void;
  onClearTraces(): void;
  onMinimize(): void;
  onHide(): void;
  /** Reports the rendered panel height so the expanded height can be restored. */
  onHeight(height: number): void;
}

function timeLabel(nanoseconds: number): string {
  return `${(nanoseconds / 1_000_000).toFixed(3)} ms`;
}

const packetTypes = new Set([
  "arp-request", "arp-reply", "icmp-echo-request", "icmp-echo-reply", "route", "forward", "flood", "ping-success", "icmp-error",
  "udp-datagram-sent", "udp-datagram-received", "udp-port-unreachable",
  "tcp-segment-sent", "tcp-segment-received", "tcp-state-changed", "tcp-connection-established", "tcp-connection-closed", "tcp-retransmission", "tcp-reset", "tcp-timeout",
  "dns-query", "dns-response", "dns-service-query", "http-request", "http-response", "http-service-request",
  "tftp-rrq", "tftp-block", "tftp-complete", "tftp-service-block", "tftp-service-complete", "tftp-service-timeout",
  "ntp-query", "ntp-response", "ntp-service-query", "syslog-sent", "syslog-received",
  "acl-evaluated", "acl-permitted", "acl-denied", "acl-implicit-deny",
  "nat-translated", "nat-no-translation",
  "firewall-permitted", "firewall-denied", "firewall-connection-expired",
  "cloud-packet-dropped", "cloud-packet-delayed",
  "traffic-flow-queued", "traffic-flow-completed",
  // M10.4 control protocols: spanning tree, EtherChannel, discovery and OSPF.
  "bpdu-sent", "bpdu-received", "stp-root-elected", "stp-port-role-changed", "stp-port-state-changed",
  "stp-topology-change", "stp-frame-blocked", "bpdu-guard-triggered", "stp-portfast-cancelled",
  "stp-message-age-expired", "stp-port-recovered", "rstp-proposal", "rstp-agreement",
  "lacpdu-sent", "lacpdu-received", "lacp-member-selected", "lacp-member-suspended",
  "pagp-message-sent", "pagp-message-received", "etherchannel-formed", "etherchannel-down",
  "etherchannel-member-state-changed", "etherchannel-frame-member-selected",
  "cdp-advertisement-sent", "cdp-advertisement-received", "cdp-neighbor-added", "cdp-neighbor-expired",
  "lldp-advertisement-sent", "lldp-advertisement-received", "lldp-neighbor-added", "lldp-neighbor-expired",
  "ospf-hello-sent", "ospf-hello-received", "ospf-neighbor-state-changed", "ospf-dr-elected", "ospf-bdr-elected",
  "ospf-lsa-originated", "ospf-lsa-flooded", "ospf-lsa-acknowledged", "ospf-lsdb-changed",
  "ospf-spf-started", "ospf-spf-completed", "ospf-route-installed", "ospf-route-withdrawn",
  "ospf-adjacency-rejected", "ospf-routing-table-changed",
  // M10.7 management plane: remote CLI, AAA and SNMP.
  "tcp-connection", "remote-session-refused", "aaa-accounting",
  // M10.8 deterministic QoS: link queues, classification, marking, scheduling.
  "packet-enqueued", "packet-dequeued", "packet-serialization-started",
  "packet-serialization-completed", "packet-tail-dropped", "queue-cleared",
]);

/** Every QoS and egress-queue trace prefix, in the order the table groups them. */
const QOS_TRACE_FAMILIES = {
  Classification: ["qos-classified", "qos-class-default", "qos-policy-applied"],
  Marking: ["qos-marked"],
  Policing: ["qos-police-conform", "qos-police-exceed", "qos-police-dropped"],
  Shaping: ["qos-shape-delayed", "qos-shape-released"],
  Queue: [
    "qos-queue-selected", "qos-priority-served", "qos-weighted-served", "qos-queue-dropped",
    "packet-enqueued", "packet-dequeued", "packet-serialization-started",
    "packet-serialization-completed", "packet-tail-dropped", "queue-cleared",
  ],
} as const satisfies Record<string, readonly string[]>;

type QosTraceFamily = keyof typeof QOS_TRACE_FAMILIES;

function qosFamilyOf(type: string): QosTraceFamily | undefined {
  for (const [family, types] of Object.entries(QOS_TRACE_FAMILIES) as Array<[QosTraceFamily, readonly string[]]>) {
    if (types.includes(type)) return family;
  }
  return undefined;
}

/** Management-plane trace prefixes; all of them are packet-trace events. */
const managementPacketPrefixes = [
  "telnet-", "ssh-", "radius-", "tacacs-", "snmp-",
] as const;

/** M10.9 site-to-site VPN: GRE encapsulation, IKEv2 negotiation, simulated ESP. */
const vpnPacketPrefixes = ["gre-", "ike-", "ipsec-", "esp-"] as const;

const ipv6PacketPrefixes = [
  "icmpv6-", "ipv6-", "ndp-", "slaac-", "dhcpv6-", "ospfv3-",
] as const;

function isPacketTraceEvent(event: SimulationTraceEvent): boolean {
  const type = event.type.toLowerCase();
  return packetTypes.has(event.type)
    || type.startsWith("qos-")
    || ipv6PacketPrefixes.some((prefix) => type.startsWith(prefix))
    || managementPacketPrefixes.some((prefix) => type.startsWith(prefix))
    || vpnPacketPrefixes.some((prefix) => type.startsWith(prefix))
    || type.startsWith("bgp-")
    || type.startsWith("prefix-list-")
    || type.startsWith("route-map-")
    || type.startsWith("route-policy-")
    || type.startsWith("community-list-")
    || type.startsWith("as-path-list-")
    || type.startsWith("wireless-")
    || type.startsWith("mpls-")
    || type.startsWith("ldp-")
    || type.startsWith("l3vpn-")
    || type.startsWith("vxlan-")
    || type.startsWith("evpn-");
}

/** Packet-trace protocol filters, in the order the dropdown lists them. */
export const TRACE_PROTOCOL_FILTERS = [
  "ALL", "ARP", "ICMP", "UDP", "TCP", "DNS", "HTTP", "TFTP", "NTP", "SYSLOG",
  "ACL", "NAT", "FIREWALL", "CLOUD", "TRAFFIC",
  "QoS", "Classification", "Marking", "Queue", "Policing", "Shaping",
  "STP", "RSTP", "LACP", "PAGP", "CDP", "LLDP", "OSPF",
  "BGP", "BGP Session", "BGP Updates", "Route Policy",
  "Route Reflection", "Community", "Aggregation",
  "MPLS", "LDP", "VPNv4", "VPNv6", "L3VPN",
  "VXLAN", "EVPN", "BUM", "VTEP", "L3VNI", "IRB", "Type 5",
  "EVPN Multihoming", "Ethernet Segment", "DF Election", "Fast Failover",
  "IPv6", "ICMPv6", "NDP", "SLAAC", "DHCPv6", "OSPFv3", "IPv6 ACL",
  "Wireless", "Beacon", "Probe", "Authentication", "Association", "Roaming",
  "Telnet", "SSH", "AAA", "RADIUS", "TACACS+", "SNMP",
  "VPN", "GRE", "IKE", "IPsec", "ESP",
] as const;

/** Tab descriptors shared by the expanded panel and the minimized strip. */
export function bottomDockTabs(
  traces: SimulationTraceEvent[],
  problems: WorkspaceProblem[],
  terminalTabs: string[],
) {
  const packetEvents = traces.filter(isPacketTraceEvent);
  return {
    packetEvents,
    options: [
      { value: "terminal" as const, label: "Terminal", icon: <TerminalSquare size={13} />, count: terminalTabs.length },
      { value: "events" as const, label: "Events", icon: <List size={13} />, count: traces.length },
      { value: "packet-trace" as const, label: "Packet trace", icon: <Network size={13} />, count: packetEvents.length },
      { value: "problems" as const, label: "Problems", icon: <AlertTriangle size={13} />, count: problems.length },
    ],
  };
}

export function BottomDock(props: BottomDockProps) {
  const { packetEvents, options } = bottomDockTabs(props.traces, props.problems, props.terminalTabs);
  const panelRef = useRef<HTMLElement>(null);
  const onHeight = props.onHeight;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    // Report the resized height so expanded → minimized/hidden → expanded comes
    // back at the same size. Debounced and bounded; never written back here.
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      const height = Math.round(panel.getBoundingClientRect().height);
      if (height <= 0) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => onHeight(height), 120);
    });
    observer.observe(panel);
    return () => {
      observer.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onHeight]);

  return (
    <section ref={panelRef} className="bottom-dock" aria-label="Workspace bottom panel" data-overflow-boundary="hidden">
      <div className="bottom-dock__header">
        <Tabs label="Bottom panel sections" value={props.tab} options={options} onChange={props.onTab} />
        <IconButton label="Minimize Bottom Panel" icon={<Minus size={13} />} onClick={props.onMinimize} />
        <IconButton label="Hide Bottom Panel" icon={<EyeOff size={13} />} onClick={props.onHide} />
      </div>
      <div className="bottom-dock__content" role="tabpanel">
        <div id={TERMINAL_DOCK_SLOT_ID} className="dock-terminal-layer" hidden={props.tab !== "terminal"}>
          {props.terminalTabs.length === 0
            ? <EmptyState icon={<TerminalSquare size={28} />} title="No terminal sessions" description="Open a device context menu, inspector, or device window to start a shared terminal session." />
            : !props.terminalVisible
              ? <EmptyState icon={<TerminalSquare size={26} />} title="Terminal is hidden" description="Use View → Terminal → Show Terminal to restore the existing sessions." />
              : props.terminalPresentationMode !== "docked"
                ? <EmptyState
                    icon={<TerminalSquare size={26} />}
                    title={`Terminal is ${props.terminalPresentationMode}`}
                    description="The same tabs and CLI sessions are open in the terminal window. Use View → Terminal → Dock at Bottom to return them here."
                  />
                : null}
        </div>
        {props.tab === "events" && <EventTable events={props.traces} />}
        {props.tab === "packet-trace" && <div className="packet-trace-view">
          <PacketExecutionControls
            mode={props.executionMode}
            virtualTime={props.snapshot?.virtualTime ?? 0}
            queuedEvents={props.snapshot?.queuedEvents ?? 0}
            onMode={props.onExecutionModeChange}
            onStep={props.onStep}
            onRunAll={props.onRunAll}
            onClear={props.onClearTraces}
          />
          <PacketTable events={packetEvents} />
        </div>}
        {props.tab === "problems" && <Problems problems={props.problems} onClear={props.onClearProblems} />}
      </div>
    </section>
  );
}

interface BottomPanelStripProps {
  tab: DockTab;
  traces: SimulationTraceEvent[];
  problems: WorkspaceProblem[];
  terminalTabs: string[];
  onTab(tab: DockTab): void;
  onExpand(): void;
  onHide(): void;
}

/**
 * The minimized presentation: a compact strip of the same tabs and their live
 * counts. No tab content is rendered, so it occupies only the strip height —
 * and no terminal session, event buffer or filter is discarded.
 */
export function BottomPanelStrip(props: BottomPanelStripProps) {
  const { options } = bottomDockTabs(props.traces, props.problems, props.terminalTabs);
  return (
    <section className="bottom-panel-strip" aria-label="Workspace bottom panel, minimized">
      <div className="bottom-panel-strip__tabs" role="tablist" aria-label="Bottom panel sections">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={props.tab === option.value}
            className={props.tab === option.value ? "is-active" : ""}
            onClick={() => { props.onTab(option.value); props.onExpand(); }}
          >
            <span aria-hidden="true">{option.icon}</span>
            {option.label}
            <small>{option.count}</small>
          </button>
        ))}
      </div>
      <IconButton label="Expand Bottom Panel" icon={<ChevronUp size={13} />} onClick={props.onExpand} />
      <IconButton label="Hide Bottom Panel" icon={<EyeOff size={13} />} onClick={props.onHide} />
    </section>
  );
}

function PacketExecutionControls({
  mode,
  virtualTime,
  queuedEvents,
  onMode,
  onStep,
  onRunAll,
  onClear,
}: {
  mode: ExecutionMode;
  virtualTime: number;
  queuedEvents: number;
  onMode(mode: ExecutionMode): void;
  onStep(): void;
  onRunAll(): void;
  onClear(): void;
}) {
  return <div className="packet-execution" aria-label="Packet execution controls">
    <label>
      <span>Packet Execution</span>
      <select aria-label="Packet Execution" value={mode} onChange={(event) => onMode(event.target.value as ExecutionMode)}>
        <option value="auto">Auto</option>
        <option value="step">Step</option>
      </select>
    </label>
    {mode === "auto"
      ? <p>Events are processed automatically.</p>
      : <div className="packet-execution__step">
        <Button size="sm" variant="primary" disabled={queuedEvents === 0} onClick={onStep}>Step</Button>
        <Button size="sm" variant="ghost" disabled={queuedEvents === 0} onClick={onRunAll}>Run All</Button>
        <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
      </div>}
    <div className="packet-execution__metrics">
      <span>Virtual time: <code>{timeLabel(virtualTime)}</code></span>
      <span>Queued events: <strong>{queuedEvents}</strong></span>
    </div>
  </div>;
}

function EventTable({ events }: { events: SimulationTraceEvent[] }) {
  if (events.length === 0) return <EmptyState icon={<List size={26} />} title="No simulation events" description="Run the lab or issue a CLI packet operation to populate the deterministic event stream." />;
  return <div className="dock-table-wrap"><table className="data-table event-table"><thead><tr><th>Time</th><th>Device</th><th>Interface</th><th>Event</th><th>Details</th></tr></thead><tbody>{events.slice(-300).reverse().map((event, index) => <tr key={`${event.sequence}-${index}`} data-event-type={event.type}><td><code>{timeLabel(event.virtualTime)}</code></td><td>{event.deviceId}</td><td><code>{event.interfaceId ?? "—"}</code></td><td><span className="event-type">{event.type}</span></td><td><code>{event.description}</code></td></tr>)}</tbody></table></div>;
}

/**
 * A compact QoS summary for one trace row: class, policy, DSCP/CoS before and
 * after, queue, drop reason and virtual waiting time — whatever the event
 * actually carries. Nothing is invented when the engine did not report it.
 */
function qosSummary(detail: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  if (typeof detail.class === "string") parts.push(`class ${detail.class}`);
  if (typeof detail.policy === "string") parts.push(`policy ${detail.policy}`);
  if (typeof detail.queue === "string") parts.push(`queue ${detail.queue}`);
  if (typeof detail.dscpBefore === "number" && typeof detail.dscpAfter === "number") {
    parts.push(`dscp ${detail.dscpBefore}→${detail.dscpAfter}`);
  } else if (typeof detail.dscp === "number") parts.push(`dscp ${detail.dscp}`);
  if (typeof detail.cosBefore === "number" || typeof detail.cosAfter === "number") {
    parts.push(`cos ${String(detail.cosBefore ?? "—")}→${String(detail.cosAfter ?? "—")}`);
  }
  if (typeof detail.reason === "string") parts.push(detail.reason);
  if (typeof detail.waitedNs === "number") parts.push(`wait ${timeLabel(detail.waitedNs)}`);
  if (typeof detail.delayNs === "number") parts.push(`delay ${timeLabel(detail.delayNs)}`);
  return parts.join(" · ");
}

function PacketTable({ events }: { events: SimulationTraceEvent[] }) {
  const [filter, setFilter] = useState("ALL");
  if (events.length === 0) return <EmptyState icon={<Network size={26} />} title="No packet trace" description="ARP, ICMP and forwarding events will appear here without inventing protocol data the engine does not expose." />;
  const visible = events.filter((event) => {
    if (filter === "ALL") return true;
    const protocol = traceProtocol(event);
    // "QoS" is the whole family; the narrower filters select one stage.
    if (filter === "QoS") return protocol === "QoS" || qosFamilyOf(event.type) !== undefined;
    // "VPN" is the whole site-to-site family; GRE, IKE, IPsec and ESP each
    // select one stage of it.
    if (filter === "VPN") return isVpnTraceEvent(event.type);
    if (filter === "BGP") return event.type.startsWith("bgp-")
      || event.type.startsWith("prefix-list-") || event.type.startsWith("route-map-") || event.type.startsWith("route-policy-")
      || event.type.startsWith("community-list-") || event.type.startsWith("as-path-list-");
    return protocol === filter;
  });
  return <div className="dock-table-wrap"><div className="trace-filter"><label>Protocol filter <select aria-label="Packet trace protocol filter" value={filter} onChange={(event) => setFilter(event.target.value)}>{TRACE_PROTOCOL_FILTERS.map((protocol) => <option key={protocol}>{protocol}</option>)}</select></label><span>{visible.length} records</span></div><table className="data-table packet-table"><thead><tr><th>Time</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Family</th><th>Ports</th><th>Event</th><th>QoS</th><th>Result</th></tr></thead><tbody>{visible.slice(-300).reverse().map((event, index) => {
    const detail = event.detail ?? {};
    const source = String(detail.src ?? detail.sourceAddress ?? detail.localAddress ?? event.deviceId);
    const destination = String(detail.dst ?? detail.destinationAddress ?? detail.remoteAddress ?? detail.targetIp ?? "—");
    const protocol = traceProtocol(event);
    const sourcePort = detail.sourcePort ?? detail.localPort;
    const destinationPort = detail.destinationPort ?? detail.remotePort;
    const ports = sourcePort === undefined && destinationPort === undefined ? "—" : `${String(sourcePort ?? "*")} → ${String(destinationPort ?? "*")}`;
    const result = event.type.includes("success") || event.type.includes("response") || event.type.includes("received") || event.type.includes("established") || event.type.includes("permitted") || event.type.includes("completed") || event.type.includes("conform") ? "success" : event.type.includes("error") || event.type.includes("timeout") || event.type.includes("reset") || event.type.includes("unreachable") || event.type.includes("denied") || event.type.includes("dropped") || event.type.includes("exceed") || event.type.includes("no-translation") ? "error" : "observed";
    const qos = qosSummary(detail);
    // One BGP session carries several address families, so the row reports the
    // family the engine actually stamped rather than guessing from the event name.
    const addressFamily = typeof detail.addressFamily === "string" ? detail.addressFamily : "—";
    return <tr key={`${event.sequence}-${index}`} data-event-type={event.type} data-address-family={addressFamily}><td><code>{timeLabel(event.virtualTime)}</code></td><td><code>{source}</code></td><td><code>{destination}</code></td><td>{protocol}</td><td>{addressFamily}</td><td><code>{ports}</code></td><td>{event.type}</td><td><code>{qos || "—"}</code></td><td><span className={`trace-result trace-result--${result}`}>{result}</span></td></tr>;
  })}</tbody></table></div>;
}

function isVpnTraceEvent(type: string): boolean {
  return vpnPacketPrefixes.some((prefix) => type.toLowerCase().startsWith(prefix));
}

/** True when a BGP event names the `l2vpn-evpn` address family. */
function evpnFamily(event: SimulationTraceEvent): boolean {
  return (event.detail as { addressFamily?: unknown } | undefined)?.addressFamily === "l2vpn-evpn";
}

/** The one protocol-filter classifier the Packet Trace dropdown selects on. */
export function traceProtocol(event: SimulationTraceEvent): string {
  const type = event.type.toLowerCase();
  // Site-to-site VPN first: GRE encapsulation, IKEv2 negotiation and simulated
  // ESP each get their own filter, and "VPN" selects the whole family.
  if (type.startsWith("gre-")) return "GRE";
  if (type.startsWith("ike-")) return "IKE";
  if (type.startsWith("ipsec-")) return "IPsec";
  if (type.startsWith("esp-")) return "ESP";
  // QoS first: classification, marking, queueing, policing and shaping each get
  // their own filter, and "QoS" selects the whole family.
  const qosFamily = qosFamilyOf(type);
  if (qosFamily) return qosFamily;
  if (type.startsWith("qos-")) return "QoS";
  // Management plane next: its event names are unambiguous prefixes.
  if (type.startsWith("telnet-")) return "Telnet";
  if (type.startsWith("ssh-")) return "SSH";
  if (type.startsWith("radius-")) return "RADIUS";
  if (type.startsWith("tacacs-")) return "TACACS+";
  if (type.startsWith("snmp-")) return "SNMP";
  if (type === "aaa-accounting") return "AAA";
  if (type.startsWith("bgp-vpnv4-")) return "VPNv4";
  if (type.startsWith("bgp-vpnv6-")) return "VPNv6";
  // M10.14 EVPN rides the ordinary BGP events, so the family is carried in the
  // detail rather than in a distinct event name; the filter follows it there.
  // A Type 5 UPDATE carries its route type the same way, so the routed tenant
  // prefix keeps its own filter without a second event name.
  if (type.startsWith("bgp-") && evpnFamily(event)) {
    return (event.detail as { routeType?: unknown } | undefined)?.routeType === 5 ? "Type 5" : "EVPN";
  }
  // M10.12 families come before the generic BGP prefixes so each one keeps its
  // own filter while "BGP" still selects the whole family.
  if (type === "bgp-route-reflected" || type === "bgp-route-reflection-rejected"
    || type === "bgp-originator-loop-rejected" || type === "bgp-cluster-loop-rejected") return "Route Reflection";
  if (type.startsWith("bgp-community-")) return "Community";
  if (type.startsWith("bgp-aggregate-") || type === "bgp-specific-suppressed") return "Aggregation";
  if (type.startsWith("prefix-list-") || type.startsWith("route-map-") || type.startsWith("route-policy-")
    || type.startsWith("community-list-") || type.startsWith("as-path-list-")
    || type.startsWith("bgp-policy-") || type === "bgp-soft-reevaluation" || type === "bgp-default-originated"
    || type === "bgp-attribute-modified") return "Route Policy";
  if (type.startsWith("bgp-update-") || type.startsWith("bgp-route-") || type === "bgp-best-path-selected"
    || type === "bgp-next-hop-unreachable" || type === "bgp-as-loop-rejected") return "BGP Updates";
  if (type.startsWith("bgp-tcp-") || type.startsWith("bgp-state-") || type.startsWith("bgp-open-")
    || type.startsWith("bgp-keepalive-") || type.startsWith("bgp-session-") || type.startsWith("bgp-notification")
    || type.startsWith("bgp-hold-")) return "BGP Session";
  if (type.startsWith("bgp-")) return "BGP";
  // VXLAN families come before the generic prefixes so BUM replication and the
  // tunnel endpoints each keep a filter, while "VXLAN" selects the whole family.
  if (type === "vxlan-bum-replicated" || type === "vxlan-split-horizon-dropped") return "BUM";
  if (type === "vxlan-underlay-unreachable" || type === "vxlan-mac-learned-remote"
    || type === "vxlan-mac-moved-local" || type === "vxlan-vni-not-found") return "VTEP";
  // M10.15 routed EVPN: the transit segment, the routing decision at each end
  // and the tenant prefix each get a filter, so a learner can follow the flow
  // ARP gateway → VRF lookup → Type 5 → L3VNI → underlay → egress lookup.
  // M10.16 multihoming: discovery, the election and the failover each get their
  // own filter, so a learner can walk Type 4 → Type 1 → DF → Type 2 → failover
  // without reading every other overlay event in between.
  if (type === "evpn-es-route-originated" || type === "evpn-es-route-imported"
    || type === "evpn-es-route-withdrawn" || type === "evpn-es-peer-discovered"
    || type === "evpn-es-state-changed") return "Ethernet Segment";
  if (type.startsWith("evpn-df-")) return "DF Election";
  if (type === "evpn-es-mass-withdraw" || type === "evpn-multihoming-failover"
    || type === "evpn-es-unreachable" || type === "evpn-ad-route-withdrawn") return "Fast Failover";
  if (type.startsWith("evpn-ad-route-") || type.startsWith("evpn-multihoming-")
    || type === "evpn-es-split-horizon-drop" || type === "evpn-non-df-egress-drop"
    || type === "evpn-non-df-ingress-drop") return "EVPN Multihoming";
  if (type === "evpn-l3vni-encapsulated" || type === "evpn-l3vni-decapsulated") return "L3VNI";
  if (type === "evpn-irb-routed" || type === "evpn-anycast-gateway-replied"
    || type === "evpn-tenant-isolation-drop") return "IRB";
  if (type.startsWith("evpn-type5-")) return "Type 5";
  if (type.startsWith("evpn-")) return "EVPN";
  if (type.startsWith("vxlan-")) return "VXLAN";
  if (type.startsWith("ldp-")) return "LDP";
  if (type.startsWith("l3vpn-")) return "L3VPN";
  if (type.startsWith("mpls-")) return "MPLS";
  // Control protocols next: their event names are unambiguous prefixes.
  if (type === "wireless-roamed") return "Roaming";
  if (type.startsWith("wireless-beacon-")) return "Beacon";
  if (type.startsWith("wireless-probe-")) return "Probe";
  if (type.startsWith("wireless-authentication-")) return "Authentication";
  if (
    type === "wireless-associated"
    || type === "wireless-disassociated"
    || type === "wireless-deauthenticated"
  ) return "Association";
  if (type.startsWith("wireless-")) return "Wireless";
  if (type.startsWith("ipv6-acl-")) return "IPv6 ACL";
  if (type.startsWith("ospfv3-")) return "OSPFv3";
  if (type.startsWith("dhcpv6-")) return "DHCPv6";
  if (type.startsWith("slaac-") || type === "ipv6-router-advertisement" || type === "ipv6-router-solicitation") return "SLAAC";
  if (type.startsWith("ndp-") || type.startsWith("ipv6-dad-")) return "NDP";
  if (type.startsWith("icmpv6-") || type === "ipv6-ping-success") return "ICMPv6";
  if (type.startsWith("ipv6-")) return "IPv6";
  if (type.startsWith("rstp-")) return "RSTP";
  if (type.startsWith("stp-") || type.startsWith("bpdu")) {
    // A Rapid-PVST BPDU carries its version, so the filter can separate them.
    return event.detail?.version === "rstp" ? "RSTP" : "STP";
  }
  if (type.startsWith("lacp")) return "LACP";
  if (type.startsWith("pagp-")) return "PAGP";
  if (type.startsWith("etherchannel-")) {
    return event.detail?.protocol === "pagp" ? "PAGP" : "LACP";
  }
  if (type.startsWith("cdp-")) return "CDP";
  if (type.startsWith("lldp-")) return "LLDP";
  if (type.startsWith("ospf-")) return "OSPF";
  if (type.startsWith("acl-")) return "ACL";
  if (type.startsWith("nat-")) return "NAT";
  if (type.startsWith("firewall-")) return "FIREWALL";
  if (type.startsWith("cloud-")) return "CLOUD";
  if (type.startsWith("traffic-")) return "TRAFFIC";
  if (type.includes("dns")) return "DNS";
  if (type.includes("http")) return "HTTP";
  if (type.includes("tftp")) return "TFTP";
  if (type.includes("ntp")) return "NTP";
  if (type.includes("syslog")) return "SYSLOG";
  if (type.startsWith("udp")) return "UDP";
  if (type.startsWith("tcp")) return "TCP";
  if (type.startsWith("arp")) return "ARP";
  if (type.includes("icmp") || type.includes("ping")) return "ICMP";
  return "L2/L3";
}

function Problems({ problems, onClear }: { problems: WorkspaceProblem[]; onClear(): void }) {
  if (problems.length === 0) return <EmptyState icon={<Braces size={25} />} title="No problems detected" description="Validation, worker and CLI errors will be listed here without exposing internal stack traces." />;
  return <div className="problems-view"><div className="problems-view__toolbar"><span>{problems.length} diagnostics</span><Button size="sm" variant="ghost" onClick={onClear}>Clear</Button></div><ol>{problems.slice().reverse().map((problem) => <li key={problem.id}><AlertTriangle size={15} /><div><strong>{problem.source}</strong><p>{problem.message}</p></div></li>)}</ol></div>;
}

export default BottomDock;

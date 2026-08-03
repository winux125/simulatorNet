import {
  getDefaultHardwareProfileId,
  getDeviceHardwareProfiles,
  getDeviceProfile,
  type DeviceHardwareProfileId,
  type LabDocument,
} from "@sim/contracts";
import type { BgpStateView, DeviceInspection, LabUiNode, MplsL3VpnView, Ospfv3View } from "@sim/sim-worker";
import {
  AlertTriangle, Clock3, FileDown, Globe2, Network, ScrollText,
  Settings2, TerminalSquare, X, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import type { LabPowerState } from "../../state/workspace-store";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Button, IconButton } from "../../ui";
import { ServerServicesPanel } from "../inspector/ServerServicesPanel";
import { ConsoleAccessPanel } from "./ConsoleAccessPanel";
import { ManagementPanel } from "./ManagementPanel";
import { HostIpConfigurationPanel } from "./HostIpConfigurationPanel";
import { WirelessPanel } from "./WirelessPanel";
import {
  SecurityConfigurationPanel,
  type SecuritySection,
} from "./SecurityConfigurationPanel";
import { QosPanel } from "./QosPanel";
import { VpnPanel } from "./VpnPanel";
import { ConfigurationPanel, ConfigurationStatusBadge } from "./ConfigurationPanel";
import {
  getDeviceWindowDefinition,
  isManagedDeviceWindow,
  type DeviceWindowMainTabId,
  type DeviceWindowSectionDefinition,
  type DeviceWindowSectionId,
} from "./device-window-registry";
import { withDeviceHardwareProfile } from "../lab/document";
type DesktopTool = "ip" | "command" | "web" | "tftp" | "ntp" | "syslog" | "transport";

interface DeviceWindowProps {
  client: SimulatorClient;
  document: LabDocument;
  node: LabUiNode;
  powerState: LabPowerState;
  runtimeAvailable: boolean;
  /** Saved / modified badge, when the lab is running and this device has a config file. */
  configurationDrift?: string;
  onOpenTerminal(deviceId: string): void;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onTopologyChanged?(document: LabDocument): void;
  onError(message: string): void;
  onClose(): void;
}

export function DeviceWindow(props: DeviceWindowProps) {
  const profile = getDeviceProfile(props.node.type);
  const isLaptop = props.node.type === "laptop";
  const isSmartphone = props.node.type === "smartphone";
  const isAccessPoint = props.node.type === "access-point";
  const isWirelessRouter = props.node.type === "wireless-router";
  const definition = useMemo(() => getDeviceWindowDefinition(props.node.type), [props.node.type]);
  const [tab, setTab] = useState<DeviceWindowMainTabId>(definition.mainTabs[0]!.id);
  const [configSection, setConfigSection] = useState<DeviceWindowSectionId>(definition.configSections[0]?.id ?? "interfaces-config");
  const [monitorSection, setMonitorSection] = useState<DeviceWindowSectionId>(definition.monitorSections[0]?.id ?? "runtime-overview");

  useEffect(() => {
    if (!definition.mainTabs.some((entry) => entry.id === tab)) setTab(definition.mainTabs[0]!.id);
    if (!definition.configSections.some((entry) => entry.id === configSection)) {
      setConfigSection(definition.configSections[0]?.id ?? "interfaces-config");
    }
    if (!definition.monitorSections.some((entry) => entry.id === monitorSection)) {
      setMonitorSection(definition.monitorSections[0]?.id ?? "runtime-overview");
    }
  }, [configSection, definition, monitorSection, tab]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [props.onClose]);

  return (
    <div className="device-window-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section className="device-window" role="dialog" aria-modal="true" aria-label={`${props.node.hostname} device window`}>
        <header className="device-window__titlebar">
          <span className="device-window__icon" aria-hidden="true"><DeviceIcon type={props.node.type} size={24} state={props.node.status === "up" ? "running" : "stopped"} /></span>
          <div><strong>{props.node.hostname}</strong><small>{profile.displayName} · {props.node.id}</small></div>
          {props.configurationDrift && (
            <ConfigurationStatusBadge drift={props.configurationDrift} changedLines={0} />
          )}
          <IconButton label="Close device window" icon={<X size={15} />} onClick={props.onClose} />
        </header>
        <nav className="device-window__tabs" role="tablist" aria-label={`${props.node.hostname} sections`}>
          {definition.mainTabs.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "is-active" : ""} onClick={() => setTab(entry.id)}>{entry.label}</button>)}
        </nav>
        <div className="device-window__content" role="tabpanel">
          {tab === "physical" && <PhysicalSummary node={props.node} />}
          {tab === "config" && (isManagedDeviceWindow(props.node.type)
            ? <SectionWorkspace
                label="Configuration"
                sections={definition.configSections}
                selected={configSection}
                onSelect={setConfigSection}
              >
                <ConfigSection {...props} section={configSection} />
              </SectionWorkspace>
            : <ConfigSection {...props} section={definition.configSections[0]?.id ?? "interfaces-config"} />)}
          {tab === "monitor" && <SectionWorkspace
            label="Monitor"
            sections={definition.monitorSections}
            selected={monitorSection}
            onSelect={setMonitorSection}
          >
            <MonitorSection {...props} section={monitorSection} />
          </SectionWorkspace>}
          {(tab === "cli" || tab === "terminal") && (props.runtimeAvailable
            ? <TerminalWorkspaceLauncher node={props.node} onOpen={() => props.onOpenTerminal(props.node.id)} />
            : <DraftRuntimeNotice />)}
          {tab === "desktop" && <Desktop
            client={props.client}
            document={props.document}
            node={props.node}
            powerState={props.powerState}
            runtimeAvailable={props.runtimeAvailable}
            onConfigurationChanged={props.onConfigurationChanged}
            onTerminal={() => props.onOpenTerminal(props.node.id)}
            onError={props.onError}
          />}
          {tab === "wireless" && props.runtimeAvailable && (
            isLaptop || isSmartphone || isAccessPoint || isWirelessRouter
          ) && <WirelessPanel
            client={props.client}
            deviceId={props.node.id}
            deviceType={props.node.type}
            section={isAccessPoint || isWirelessRouter ? "clients" : "wireless"}
            onConfigurationChanged={props.onConfigurationChanged}
            onError={props.onError}
          />}
          {tab === "wireless" && !props.runtimeAvailable && <DraftRuntimeNotice />}
          {tab === "apps" && <SmartphoneApps client={props.client} node={props.node} runtimeAvailable={props.runtimeAvailable} onError={props.onError} />}
          {tab === "services" && (props.runtimeAvailable
            ? <ServerServicesPanel client={props.client} deviceId={props.node.id} refreshKey={props.node.interfaces.length} onError={props.onError} />
            : <DraftRuntimeNotice />)}
          {(tab === "flows" || tab === "run" || tab === "results") && (props.runtimeAvailable
            ? <SecurityConfigurationPanel
                client={props.client}
                deviceId={props.node.id}
                section={tab}
                onConfigurationChanged={props.onConfigurationChanged}
                onError={props.onError}
              />
            : <DraftRuntimeNotice />)}
          {tab === "attributes" && <Attributes
            document={props.document}
            node={props.node}
            description={profile.description}
            capabilities={profile.capabilities}
            powerState={props.powerState}
            onTopologyChanged={props.onTopologyChanged}
            onError={props.onError}
          />}
        </div>
      </section>
    </div>
  );
}

function SectionWorkspace({
  label,
  sections,
  selected,
  onSelect,
  children,
}: {
  label: string;
  sections: readonly DeviceWindowSectionDefinition[];
  selected: DeviceWindowSectionId;
  onSelect(section: DeviceWindowSectionId): void;
  children: ReactNode;
}) {
  return <div className="device-section-workspace">
    <aside className="device-section-workspace__navigation">
      <label className="device-section-workspace__select">
        <span>{label} section</span>
        <select value={selected} onChange={(event) => onSelect(event.target.value as DeviceWindowSectionId)}>
          {sections.map((section) => <option key={section.id} value={section.id}>
            {section.group ? `${section.group} · ` : ""}{section.label}
          </option>)}
        </select>
      </label>
      <nav className="device-section-workspace__rail" aria-label={`${label} sections`}>
        {sections.map((section, index) => <div key={section.id} className="device-section-workspace__item">
          {section.group && section.group !== sections[index - 1]?.group && <small>{section.group}</small>}
          <button
            type="button"
            aria-current={selected === section.id ? "page" : undefined}
            className={selected === section.id ? "is-active" : ""}
            onClick={() => onSelect(section.id)}
          >
            {section.label}
          </button>
        </div>)}
      </nav>
    </aside>
    <div className="device-section-workspace__content" aria-label={`${label} ${sections.find((entry) => entry.id === selected)?.label ?? "section"}`}>
      {children}
    </div>
  </div>;
}

function ConfigSection(props: DeviceWindowProps & { section: DeviceWindowSectionId }) {
  const { section } = props;
  if (section === "host-ip") return <HostIpConfigurationPanel
    client={props.client}
    document={props.document}
    node={props.node}
    powerState={props.powerState}
    runtimeAvailable={props.runtimeAvailable}
    onConfigurationChanged={props.onConfigurationChanged}
    onError={props.onError}
  />;
  if (section === "interfaces-config") return <Interfaces node={props.node} />;
  if (section === "bgp-config") return <BgpConfigurationPanel document={props.document} deviceId={props.node.id} />;
  if (section === "configuration-files") return <ConfigurationPanel
    client={props.client}
    deviceId={props.node.id}
    hostname={props.node.hostname}
    runtimeAvailable={props.runtimeAvailable}
    onConfigurationChanged={props.onConfigurationChanged}
    onError={props.onError}
  />;
  if (section === "console-config") return <ConsoleAccessPanel
    document={props.document}
    node={props.node}
    onConfigurationChanged={props.onConfigurationChanged}
    onError={props.onError}
  />;
  if (section === "wireless-config" && props.runtimeAvailable) return <WirelessPanel
    client={props.client}
    deviceId={props.node.id}
    deviceType={props.node.type}
    section="wireless"
    onConfigurationChanged={props.onConfigurationChanged}
    onError={props.onError}
  />;
  if (section === "qos-config") return props.runtimeAvailable
    ? <QosPanel
        client={props.client}
        deviceId={props.node.id}
        deviceType={props.node.type}
        interfaces={props.node.interfaces}
        onConfigurationChanged={props.onConfigurationChanged}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;
  if (section === "vpn-config") return props.runtimeAvailable
    ? <VpnPanel
        client={props.client}
        deviceId={props.node.id}
        deviceType={props.node.type}
        interfaces={props.node.interfaces}
        onConfigurationChanged={props.onConfigurationChanged}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;

  const securitySection: Partial<Record<DeviceWindowSectionId, SecuritySection>> = {
    "routing-config": "routing",
    "vlans-config": "vlans",
    "svis-config": "svis",
    "acl-config": "acl",
    "nat-config": "nat",
    "zones-config": "zones",
    "policies-config": "policies",
  };
  const security = securitySection[section];
  if (security) return props.runtimeAvailable
    ? <SecurityConfigurationPanel
        client={props.client}
        deviceId={props.node.id}
        section={security}
        onConfigurationChanged={props.onConfigurationChanged}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;

  const projection: Partial<Record<DeviceWindowSectionId, { title: string; keys?: readonly string[] }>> = {
    "ip-config": { title: "IPv4 & IPv6", keys: ["interfaces", "subinterfaces", "svis", "ipv6", "ipv6StaticRoutes"] },
    "stp-config": { title: "Spanning Tree", keys: ["spanningTree", "vlans"] },
    "etherchannel-config": { title: "EtherChannel", keys: ["etherChannels", "interfaces"] },
    "ospf-config": { title: "OSPF", keys: ["ospf", "ospfv3"] },
    "mpls-config": { title: "MPLS & LDP", keys: ["interfaces", "ldp"] },
    "vrfs-config": { title: "VRFs", keys: ["vrfs", "interfaces", "subinterfaces"] },
    "l3vpn-config": { title: "Layer 3 VPN", keys: ["vrfs", "bgp"] },
    "remote-access-config": { title: "Remote Access", keys: ["remoteAccess", "vtyLines"] },
    "aaa-config": { title: "AAA", keys: ["aaa"] },
    "snmp-config": { title: "SNMP", keys: ["snmp"] },
    "services-config": { title: "Services", keys: ["services", "enabledServices"] },
    "wireless-config": { title: "Wireless", keys: ["radio", "accessPoint", "wireless"] },
  };
  const selected = projection[section];
  return <StructuredConfiguration
    document={props.document}
    node={props.node}
    title={selected?.title}
    keys={selected?.keys}
  />;
}

function MonitorSection(props: DeviceWindowProps & { section: DeviceWindowSectionId }) {
  const { section } = props;
  if (section === "runtime-overview") return <Overview node={props.node} description={getDeviceProfile(props.node.type).description} />;
  if (section === "interfaces-runtime") return <Interfaces node={props.node} />;
  if (section === "sessions-runtime" || section === "aaa-runtime" || section === "snmp-runtime") {
    return <ManagementPanel
      client={props.client}
      node={props.node}
      section={section === "sessions-runtime" ? "sessions" : section === "aaa-runtime" ? "aaa" : "snmp"}
      runtimeAvailable={props.runtimeAvailable}
      onError={props.onError}
    />;
  }
  if (section === "routes-runtime") return props.runtimeAvailable
    ? <SecurityConfigurationPanel
        client={props.client}
        deviceId={props.node.id}
        section="routes"
        onConfigurationChanged={props.onConfigurationChanged}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;
  if (section === "nat-runtime" || section === "firewall-runtime") return props.runtimeAvailable
    ? <SecurityConfigurationPanel
        client={props.client}
        deviceId={props.node.id}
        section={section === "nat-runtime" ? "runtime" : "connections"}
        onConfigurationChanged={props.onConfigurationChanged}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;
  if (section === "qos-runtime") return props.runtimeAvailable
    ? <QosPanel
        client={props.client}
        deviceId={props.node.id}
        deviceType={props.node.type}
        interfaces={props.node.interfaces}
        initialSection="queues"
        onConfigurationChanged={props.onConfigurationChanged}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;
  if (section === "vpn-runtime") return props.runtimeAvailable
    ? <VpnPanel
        client={props.client}
        deviceId={props.node.id}
        deviceType={props.node.type}
        interfaces={props.node.interfaces}
        initialSection="sessions"
        onConfigurationChanged={props.onConfigurationChanged}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;
  if (section === "bgp-runtime") return props.runtimeAvailable
    ? <BgpRuntimePanel client={props.client} deviceId={props.node.id} onError={props.onError} />
    : <DraftRuntimeNotice />;
  if (section === "mpls-runtime" || section === "ldp-runtime" || section === "vrf-runtime"
    || section === "vpnv4-runtime" || section === "vpn-label-runtime") return props.runtimeAvailable
    ? <MplsL3VpnRuntimePanel client={props.client} deviceId={props.node.id} section={section} onError={props.onError} />
    : <DraftRuntimeNotice />;
  if (section === "protocols-runtime") return props.runtimeAvailable
    ? <Ipv6RuntimePanel
        client={props.client}
        document={props.document}
        deviceId={props.node.id}
        onError={props.onError}
      />
    : <DraftRuntimeNotice />;
  if (section === "neighbors-runtime" || section === "mac-runtime") {
    return <DeviceInspectionPanel
      client={props.client}
      document={props.document}
      deviceId={props.node.id}
      section={section}
      runtimeAvailable={props.runtimeAvailable}
      onError={props.onError}
    />;
  }
  return <Overview node={props.node} description={getDeviceProfile(props.node.type).description} />;
}

function PhysicalSummary({ node }: { node: LabUiNode }) {
  return <div className="device-window-section">
    <p className="section-eyebrow">Physical placement</p>
    <h2>{node.hostname}</h2>
    <p>Use the workspace Physical view to place this device in a site, room, rack, or on a workbench.</p>
    <dl className="property-list">
      <div><dt>Device</dt><dd>{getDeviceProfile(node.type).displayName}</dd></div>
      <div><dt>Interfaces</dt><dd>{node.interfaces.length}</dd></div>
      <div><dt>Power</dt><dd>{node.status}</dd></div>
    </dl>
  </div>;
}

function DeviceInspectionPanel({
  client,
  document,
  deviceId,
  section,
  runtimeAvailable,
  onError,
}: {
  client: SimulatorClient;
  document: LabDocument;
  deviceId: string;
  section: "neighbors-runtime" | "mac-runtime";
  runtimeAvailable: boolean;
  onError(message: string): void;
}) {
  const [inspection, setInspection] = useState<DeviceInspection>();
  useEffect(() => {
    if (!runtimeAvailable) return;
    let active = true;
    void client.request({ type: "GET_DEVICE_INSPECTION", deviceId }).then((nextInspection) => {
      if (!active) return;
      setInspection(nextInspection);
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : "Unable to inspect device runtime");
    });
    return () => { active = false; };
  }, [client, deviceId, runtimeAvailable, section, onError]);
  if (!runtimeAvailable) return <DraftRuntimeNotice />;
  if (!inspection) return <div className="device-window-section">Loading runtime inspection…</div>;
  const value = section === "mac-runtime"
    ? inspection.macEntries
    : { arp: inspection.arpEntries, ndp: inspection.ipv6?.neighbors ?? [], configured: document.configurations[deviceId] };
  return <div className="device-window-section">
    <p className="section-eyebrow">Transient runtime</p>
    <h2>{section === "mac-runtime" ? "MAC Table" : "ARP / NDP"}</h2>
    <PropertyTree value={value} />
  </div>;
}

function Overview({ node, description }: { node: LabUiNode; description: string }) {
  return <div className="device-window-section"><p className="section-eyebrow">Device overview</p><h2>{node.hostname}</h2><p>{description}</p><dl className="property-list"><div><dt>Type</dt><dd>{node.type}</dd></div><div><dt>Status</dt><dd>{node.status}</dd></div><div><dt>Interfaces</dt><dd>{node.interfaces.length}</dd></div></dl></div>;
}

function StructuredConfiguration({
  document,
  node,
  title = "Structured Configuration",
  keys,
}: {
  document: LabDocument;
  node: LabUiNode;
  title?: string;
  keys?: readonly string[];
}) {
  const configuration = document.configurations[node.id] as Record<string, unknown> | undefined;
  const selected = keys && configuration
    ? Object.fromEntries(keys.filter((key) => key in configuration).map((key) => [key, configuration[key]]))
    : configuration ?? {};
  return <div className="device-window-section">
    <p className="section-eyebrow">Worker-owned configuration</p>
    <h2>{title}</h2>
    <p className="section-note">
      This is one redacted view of the canonical device configuration; it is not an independent copy. The
      canonical JSON itself lives under File ▸ Advanced.
    </p>
    <PropertyTree value={redactCredentialMaterial(selected)} />
  </div>;
}

/**
 * A readable view of structured configuration.
 *
 * The device window deliberately shows no raw JSON: a network engineer reads a
 * configuration, not a serialization format. The canonical document is still
 * exactly what this renders — just spelled out as labelled values.
 */
function PropertyTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span className="property-tree__value">—</span>;
  if (typeof value !== "object") return <span className="property-tree__value"><code>{String(value)}</code></span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="property-tree__value">none</span>;
    return <ol className="property-tree property-tree--list" data-depth={depth}>
      {value.map((entry, index) => <li key={index}><PropertyTree value={entry} depth={depth + 1} /></li>)}
    </ol>;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <span className="property-tree__value">none</span>;
  return <dl className="property-tree" data-depth={depth}>
    {entries.map(([key, entry]) => (
      <div key={key}>
        <dt>{humanizeKey(key)}</dt>
        <dd><PropertyTree value={entry} depth={depth + 1} /></dd>
      </div>
    ))}
  </dl>;
}

/** `dhcpRangeStart` → `Dhcp range start`; ids and acronyms stay readable. */
function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[-_]+/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function redactCredentialMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialMaterial);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(?:password|credential|secret).*verifier|verifier|passphrase|plaintext|fingerprint/iu.test(key)
      ? "Security key configured"
      : redactCredentialMaterial(entry),
  ]));
}

function Interfaces({ node }: { node: LabUiNode }) {
  return <div className="device-window-table"><table className="data-table"><thead><tr><th>Interface</th><th>Admin</th><th>Operational</th><th>Address</th><th>Mode</th></tr></thead><tbody>{node.interfaces.map((iface) => <tr key={iface.id}><td><code>{iface.id}</code></td><td>{iface.adminUp ? "up" : "shutdown"}</td><td>{iface.operationalUp ? "up" : "down"}</td><td><code>{iface.ipAddress ?? "—"}</code></td><td>{iface.mode ?? "—"}</td></tr>)}</tbody></table></div>;
}

function BgpConfigurationPanel({ document, deviceId }: { document: LabDocument; deviceId: string }) {
  const configuration = document.configurations[deviceId];
  const bgp = configuration && "bgp" in configuration ? configuration.bgp : undefined;
  const prefixLists = configuration && "prefixLists" in configuration ? configuration.prefixLists ?? [] : [];
  const routeMaps = configuration && "routeMaps" in configuration ? configuration.routeMaps ?? [] : [];
  if (!bgp) return <div className="device-window-section"><p className="section-eyebrow">Routing · BGP</p><h3>BGP is not configured</h3><p>Use the CLI command <code>router bgp &lt;asn&gt;</code> to create the educational IPv4-unicast process.</p></div>;
  return <div className="device-window-section">
    <p className="section-eyebrow">Routing · BGP configuration</p>
    <h3>Overview</h3><p>Local AS <strong>{bgp.localAs}</strong> · Router ID <code>{bgp.routerId ?? "automatic"}</code> · Keepalive {bgp.keepaliveSeconds ?? 60}s · Hold {bgp.holdTimeSeconds ?? 180}s</p>
    <h3>Neighbors</h3>
    <table className="data-table"><thead><tr><th>Address</th><th>Remote AS</th><th>Update source</th><th>Multihop</th><th>Policies</th></tr></thead><tbody>
      {bgp.neighbors.map((neighbor) => <tr key={neighbor.address}><td><code>{neighbor.address}</code></td><td>{neighbor.remoteAs}</td><td>{neighbor.updateSource ?? "—"}</td><td>{neighbor.ebgpMultihop ?? 1}</td><td>{[neighbor.prefixListIn && `${neighbor.prefixListIn} in`, neighbor.prefixListOut && `${neighbor.prefixListOut} out`, neighbor.routeMapIn && `${neighbor.routeMapIn} in`, neighbor.routeMapOut && `${neighbor.routeMapOut} out`].filter(Boolean).join(", ") || "—"}</td></tr>)}
    </tbody></table>
    <h3>Networks</h3><p>{bgp.networks.length ? bgp.networks.map((network) => `${network.network}/${network.prefixLength}`).join(", ") : "No network statements."}</p>
    <h3>Policies</h3><p>{prefixLists.length} prefix list(s) · {routeMaps.length} route map(s)</p>
    <PropertyTree value={{ prefixLists, routeMaps }} />
  </div>;
}

function BgpRuntimePanel({ client, deviceId, onError }: { client: SimulatorClient; deviceId: string; onError(message: string): void }) {
  const [state, setState] = useState<BgpStateView>();
  const load = () => client.request({ type: "GET_BGP_STATE", deviceId }).then(setState).catch((error) => onError(error instanceof Error ? error.message : "Unable to inspect BGP runtime"));
  useEffect(() => { let active = true; void client.request({ type: "GET_BGP_STATE", deviceId }).then((next) => { if (active) setState(next); }).catch((error) => { if (active) onError(error instanceof Error ? error.message : "Unable to inspect BGP runtime"); }); return () => { active = false; }; }, [client, deviceId, onError]);
  if (!state) return <div className="device-window-section">Loading BGP runtime…</div>;
  return <div className="device-window-section">
    <p className="section-eyebrow">BGP monitor</p><h3>Summary</h3>
    <p>{state.configuration ? `Local AS ${state.configuration.localAs} · ${state.neighbors.filter((neighbor) => neighbor.state === "established").length}/${state.neighbors.length} Established` : "BGP is not configured."}</p>
    <div className="toolbar-row"><button type="button" onClick={() => void client.request({ type: "RESET_BGP_PROCESS", deviceId }).then(setState).catch((error) => onError(error instanceof Error ? error.message : "Unable to reset BGP"))}>Reset process</button><button type="button" onClick={() => void load()}>Refresh</button></div>
    <h3>Neighbors</h3><table className="data-table"><thead><tr><th>Neighbor</th><th>AS</th><th>State</th><th>Prefixes</th><th>Action</th></tr></thead><tbody>{state.neighbors.map((neighbor) => <tr key={neighbor.address}><td><code>{neighbor.address}</code></td><td>{neighbor.remoteAs}</td><td>{neighbor.state}</td><td>{state.adjRibIn.filter((route) => route.neighborAddress === neighbor.address).length}</td><td><button type="button" onClick={() => void client.request({ type: "RESET_BGP_NEIGHBOR", deviceId, neighbor: neighbor.address }).then(setState).catch((error) => onError(error instanceof Error ? error.message : "Unable to reset neighbor"))}>Reset</button></td></tr>)}</tbody></table>
    <h3>BGP Table</h3><table className="data-table"><thead><tr><th>Best</th><th>Prefix</th><th>Next hop</th><th>Weight</th><th>Local pref</th><th>MED</th><th>AS path</th></tr></thead><tbody>{state.routes.map((route) => <tr key={`${route.routeId}:${route.neighborAddress ?? "local"}`}><td>{route.best ? "✓" : ""}</td><td><code>{route.network}/{route.prefixLength}</code></td><td><code>{route.nextHop}</code></td><td>{route.weight}</td><td>{route.localPreference}</td><td>{route.med}</td><td>{route.asPath.join(" ") || "local"}</td></tr>)}</tbody></table>
    <h3>Advertised / Received</h3><p>{state.adjRibOut.length} advertised · {state.adjRibIn.length} received · {state.ribFailures.length} RIB failure(s)</p>
    <h3>Policy Counters</h3><table className="data-table"><thead><tr><th>Policy</th><th>Sequence</th><th>Matches</th><th>Permit</th><th>Deny</th></tr></thead><tbody>{state.policyCounters.map((counter) => <tr key={`${counter.policyType}:${counter.policyId}:${counter.sequence}`}><td>{counter.policyType} {counter.policyId}</td><td>{counter.sequence}</td><td>{counter.matches}</td><td>{counter.permits}</td><td>{counter.denies}</td></tr>)}</tbody></table>
  </div>;
}

function MplsL3VpnRuntimePanel({
  client,
  deviceId,
  section,
  onError,
}: {
  client: SimulatorClient;
  deviceId: string;
  section: "mpls-runtime" | "ldp-runtime" | "vrf-runtime" | "vpnv4-runtime" | "vpn-label-runtime";
  onError(message: string): void;
}) {
  const [state, setState] = useState<MplsL3VpnView>();
  useEffect(() => {
    let active = true;
    void client.request({ type: "GET_MPLS_FORWARDING_TABLE", deviceId }).then((next) => {
      if (active) setState(next);
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : "Unable to inspect MPLS runtime");
    });
    return () => { active = false; };
  }, [client, deviceId, onError]);
  if (!state) return <div className="device-window-section">Loading MPLS and L3VPN runtime…</div>;
  const titles = {
    "mpls-runtime": "MPLS Forwarding",
    "ldp-runtime": "LDP Neighbors & Bindings",
    "vrf-runtime": "VRF Routes",
    "vpnv4-runtime": "VPNv4 Routes",
    "vpn-label-runtime": "VPN Labels",
  } as const;
  const value = section === "mpls-runtime" ? { interfaces: state.interfaces, forwardingTable: state.forwardingTable }
    : section === "ldp-runtime" ? { routerId: state.ldpRouterId, neighbors: state.ldpNeighbors, bindings: state.ldpBindings }
      : section === "vrf-runtime" ? { vrfs: state.vrfs, routes: state.vrfRoutes }
        : section === "vpnv4-runtime" ? state.vpnv4Routes
          : state.vpnLabelBindings;
  return <div className="device-window-section">
    <p className="section-eyebrow">Deterministic provider runtime</p>
    <h2>{titles[section]}</h2>
    <p className="section-note">These tables are rebuilt from structured configuration and are not stored in the LabDocument.</p>
    <PropertyTree value={value} />
  </div>;
}

function Ipv6RuntimePanel({
  client,
  document,
  deviceId,
  onError,
}: {
  client: SimulatorClient;
  document: LabDocument;
  deviceId: string;
  onError(message: string): void;
}) {
  const [inspection, setInspection] = useState<DeviceInspection>();
  const [ospfv3, setOspfv3] = useState<Ospfv3View>();

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.request({ type: "GET_DEVICE_INSPECTION", deviceId }),
      client.request({ type: "GET_OSPFV3_STATE", deviceId }),
    ]).then(([nextInspection, nextOspfv3]) => {
      if (!active) return;
      setInspection(nextInspection);
      setOspfv3(nextOspfv3);
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : "Unable to inspect IPv6 runtime");
    });
    return () => { active = false; };
  }, [client, deviceId, onError]);

  const configuration = document.configurations[deviceId];
  const acls = configuration && "ipv6Acls" in configuration ? configuration.ipv6Acls ?? [] : [];
  if (!inspection?.ipv6) return <div className="device-window-section">Loading IPv6 runtime…</div>;
  const ipv6 = inspection.ipv6;
  return <div className="device-window-section">
    <p className="section-eyebrow">IPv6 runtime</p>
    <h3>IPv6 Interfaces</h3>
    <table className="data-table"><thead><tr><th>Interface</th><th>Address</th><th>Source</th><th>State</th></tr></thead><tbody>
      {ipv6.addresses.map((address) => <tr key={`${address.interfaceId}:${address.address}`}><td>{address.interfaceId}</td><td><code>{address.address}/{address.prefixLength}</code></td><td>{address.source}</td><td>{address.state}</td></tr>)}
    </tbody></table>
    <h3>IPv6 Routes</h3>
    <table className="data-table"><thead><tr><th>Source</th><th>Prefix</th><th>Next hop</th><th>Interface</th></tr></thead><tbody>
      {ipv6.routes.map((route) => <tr key={`${route.kind}:${route.network}/${route.prefixLength}`}><td>{route.kind}</td><td><code>{route.network}/{route.prefixLength}</code></td><td><code>{route.nextHop ?? "—"}</code></td><td>{route.interfaceId}</td></tr>)}
    </tbody></table>
    <h3>NDP</h3>
    <table className="data-table"><thead><tr><th>Address</th><th>MAC</th><th>Interface</th><th>State</th></tr></thead><tbody>
      {ipv6.neighbors.map((neighbor) => <tr key={`${neighbor.interfaceId}:${neighbor.address}`}><td><code>{neighbor.address}</code></td><td><code>{neighbor.macAddress}</code></td><td>{neighbor.interfaceId}</td><td>{neighbor.state}</td></tr>)}
    </tbody></table>
    <h3>OSPFv3</h3>
    <p>{ospfv3?.overview.enabled ? `Process ${ospfv3.overview.processId}, Router ID ${ospfv3.overview.routerId ?? "not configured"}, ${ospfv3.overview.fullNeighbors} Full neighbor(s)` : "OSPFv3 is not enabled."}</p>
    {ospfv3 && ospfv3.neighbors.length > 0 && <table className="data-table"><thead><tr><th>Neighbor</th><th>State</th><th>Address</th><th>Interface</th></tr></thead><tbody>
      {ospfv3.neighbors.map((neighbor) => <tr key={`${neighbor.interfaceId}:${neighbor.neighborRouterId}`}><td>{neighbor.neighborRouterId}</td><td>{neighbor.state}</td><td><code>{neighbor.address}</code></td><td>{neighbor.interfaceId}</td></tr>)}
    </tbody></table>}
    <h3>IPv6 ACL</h3>
    {acls.length === 0
      ? <p>No IPv6 access lists configured.</p>
      : acls.map((acl) => <div key={acl.id}><strong>{acl.id}</strong><PropertyTree value={acl.rules} /></div>)}
    {ipv6.problems.map((problem) => <p className="host-ip-config__warning" key={problem}><AlertTriangle size={14} /> {problem}</p>)}
  </div>;
}

function Attributes({
  document,
  node,
  description,
  capabilities,
  powerState,
  onTopologyChanged,
  onError,
}: {
  document: LabDocument;
  node: LabUiNode;
  description: string;
  capabilities: readonly string[];
  powerState: LabPowerState;
  onTopologyChanged?(document: LabDocument): void;
  onError(message: string): void;
}) {
  const topologyNode = document.topology.nodes.find((candidate) => candidate.id === node.id);
  const hardwareProfiles = getDeviceHardwareProfiles(node.type);
  const selectedHardwareProfile = topologyNode?.hardwareProfileId ?? getDefaultHardwareProfileId(node.type);
  const changeHardwareProfile = (hardwareProfileId: DeviceHardwareProfileId) => {
    const result = withDeviceHardwareProfile(document, node.id, hardwareProfileId);
    if (!result.ok) {
      onError(result.message);
      return;
    }
    onTopologyChanged?.(result.document);
  };

  return <div className="device-window-section"><p className="section-eyebrow">Attributes</p><h2>{node.hostname}</h2><p>{description}</p>
    {hardwareProfiles.length > 0 && <label className="device-attribute-field">
      <span>Hardware profile</span>
      <select
        aria-label="Hardware profile"
        value={selectedHardwareProfile}
        disabled={powerState !== "stopped" || !onTopologyChanged}
        onChange={(event) => changeHardwareProfile(event.target.value as DeviceHardwareProfileId)}
      >
        {hardwareProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
      </select>
      <small>{powerState === "stopped" ? "Changing the chassis is a structural topology edit." : "Stop the lab before changing switch hardware."}</small>
    </label>}
    <dl className="property-list"><div><dt>Device ID</dt><dd><code>{node.id}</code></dd></div><div><dt>Profile</dt><dd>{node.type}</dd></div><div><dt>Interfaces</dt><dd>{topologyNode?.interfaces.length ?? node.interfaces.length}</dd></div><div><dt>Capabilities</dt><dd>{capabilities.join(", ")}</dd></div></dl>
  </div>;
}

function Desktop({
  client,
  document,
  node,
  powerState,
  runtimeAvailable,
  onConfigurationChanged,
  onTerminal,
  onError,
}: {
  client: SimulatorClient;
  document: LabDocument;
  node: LabUiNode;
  powerState: LabPowerState;
  runtimeAvailable: boolean;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onTerminal(): void;
  onError(message: string): void;
}) {
  const [tool, setTool] = useState<DesktopTool>("ip");
  const [output, setOutput] = useState("Choose a desktop utility.");
  const execute = async (command: string) => {
    if (!runtimeAvailable) {
      const message = "Start the lab to use runtime desktop tools.";
      setOutput(message);
      return message;
    }
    try {
      const result = await client.request({ type: "EXECUTE_CLI", sessionId: `desktop:${node.id}`, deviceId: node.id, input: command });
      setOutput(result.output || "Command completed.");
      return result.output;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Desktop tool failed";
      onError(message);
      setOutput(`% ${message}`);
      return "";
    }
  };

  const choose = (next: DesktopTool) => {
    setTool(next);
    if (next === "command") onTerminal();
    if (next === "transport") void Promise.all([execute("sim show udp sockets"), execute("sim show tcp connections")]).then(([udp, tcp]) => setOutput(`${udp}\n\n${tcp}`));
  };

  return (
    <div className="desktop-tools">
      <nav className="desktop-tools__launcher" aria-label="Desktop tools">
        <DesktopButton label="IP Configuration" icon={Settings2} active={tool === "ip"} onClick={() => choose("ip")} />
        <DesktopButton label="Command Prompt" icon={TerminalSquare} active={tool === "command"} onClick={() => choose("command")} />
        <DesktopButton label="Web Browser" icon={Globe2} active={tool === "web"} onClick={() => choose("web")} />
        <DesktopButton label="TFTP Client" icon={FileDown} active={tool === "tftp"} onClick={() => choose("tftp")} />
        <DesktopButton label="NTP Client" icon={Clock3} active={tool === "ntp"} onClick={() => choose("ntp")} />
        <DesktopButton label="Syslog Tool" icon={ScrollText} active={tool === "syslog"} onClick={() => choose("syslog")} />
        <DesktopButton label="Transport Viewer" icon={Network} active={tool === "transport"} onClick={() => choose("transport")} />
      </nav>
      <div className="desktop-tool-surface">
        {tool === "web" && <WebBrowser execute={execute} />}
        {tool === "tftp" && <TwoFieldTool title="TFTP Client" firstLabel="Server IP" secondLabel="Filename" action="Get" onRun={(server, filename) => execute(`sim tftp get ${server} ${filename}`)} />}
        {tool === "ntp" && <OneFieldTool title="NTP Client" label="Server IP" action="Query" onRun={(server) => execute(`sim ntp query ${server}`)} />}
        {tool === "syslog" && <SyslogTool onRun={(server, severity, message) => execute(`sim syslog send ${server} ${severity} ${message}`)} />}
        {tool === "ip" && <HostIpConfigurationPanel
          client={client}
          document={document}
          node={node}
          powerState={powerState}
          runtimeAvailable={runtimeAvailable}
          onConfigurationChanged={onConfigurationChanged}
          onError={onError}
        />}
        {tool === "transport" && <pre className="desktop-tool-output">{output}</pre>}
      </div>
    </div>
  );
}

function SmartphoneApps({
  client,
  node,
  runtimeAvailable,
  onError,
}: {
  client: SimulatorClient;
  node: LabUiNode;
  runtimeAvailable: boolean;
  onError(message: string): void;
}) {
  const [target, setTarget] = useState("192.168.1.1");
  const [output, setOutput] = useState("Choose Ping, DNS lookup, or Web client.");
  const execute = async (input: string) => {
    if (!runtimeAvailable) {
      setOutput("Start the lab to use network apps.");
      return;
    }
    try {
      const result = await client.request({
        type: "EXECUTE_CLI",
        sessionId: `smartphone-apps:${node.id}`,
        deviceId: node.id,
        input,
      });
      setOutput(result.output || "Operation queued in Step mode. Open Packet Trace and use Step or Run All.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Smartphone app failed";
      setOutput(message);
      onError(message);
    }
  };
  return <div className="device-window-section smartphone-apps">
    <p className="section-eyebrow">Network apps</p>
    <h2>Smartphone utilities</h2>
    <label>Address or hostname<input value={target} onChange={(event) => setTarget(event.target.value)} /></label>
    <div>
      <Button onClick={() => void execute(`ping ${target}`)}>Ping</Button>
      <Button onClick={() => void execute(`nslookup ${target}`)}>DNS lookup</Button>
      <Button onClick={() => void execute(`sim http get http://${target}/`)}>Web client</Button>
    </div>
    <pre className="desktop-tool-output">{output}</pre>
  </div>;
}

function DraftRuntimeNotice() {
  return <div className="device-window-section"><p className="section-eyebrow">Pending rebuild</p><h2>Start the lab to open this tool</h2><p>This device exists in the topology draft. Its runtime tools become available after Apply &amp; Rebuild.</p></div>;
}

function TerminalWorkspaceLauncher({ node, onOpen }: { node: LabUiNode; onOpen(): void }) {
  return <div className="device-window-section terminal-workspace-launcher">
    <span className="terminal-workspace-launcher__icon"><TerminalSquare size={28} aria-hidden="true" /></span>
    <p className="section-eyebrow">Unified terminal workspace</p>
    <h2>{node.hostname} {node.type === "pc" || node.type === "laptop" ? "Command Prompt" : "CLI"}</h2>
    <p>Open this device in the shared terminal workspace. Docking, floating, or maximizing keeps the same session, login state, command history, and scrollback.</p>
    <Button variant="primary" onClick={onOpen}>Open in Terminal Workspace</Button>
  </div>;
}

function DesktopButton({ label, icon: ToolIcon, active, onClick }: { label: string; icon: LucideIcon; active: boolean; onClick(): void }) {
  return <button type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={onClick}><ToolIcon size={24} /><span>{label}</span></button>;
}

function WebBrowser({ execute }: { execute(command: string): Promise<string> }) {
  const [address, setAddress] = useState("http://portal.lab/");
  const [result, setResult] = useState("Enter a simulated HTTP address.");
  const go = async () => {
    let requestAddress = address;
    const host = /^http:\/\/([^/:]+)(?::\d+)?(\/.*)?$/i.exec(address)?.[1];
    if (host && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      const dns = await execute(`nslookup ${host}`);
      const resolved = /^Address:\s*(\d{1,3}(?:\.\d{1,3}){3})$/m.exec(dns)?.[1];
      if (!resolved) { setResult(dns || "% DNS resolution failed."); return; }
      requestAddress = address.replace(host, resolved);
    }
    setResult(await execute(`sim http get ${requestAddress}`));
  };
  return <form className="desktop-form" onSubmit={(event) => { event.preventDefault(); void go(); }}><h3>Web Browser</h3><label>Address<div><input aria-label="Web address" value={address} onChange={(event) => setAddress(event.target.value)} /><Button type="submit" variant="primary">Go</Button></div></label><pre aria-label="Web response preview">{result}</pre><p>Rendered as safe text. HTML and JavaScript are never executed.</p></form>;
}

function OneFieldTool({ title, label, action, onRun }: { title: string; label: string; action: string; onRun(value: string): Promise<string> }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState("");
  return <form className="desktop-form" onSubmit={(event) => { event.preventDefault(); void onRun(value).then(setResult); }}><h3>{title}</h3><label>{label}<input value={value} onChange={(event) => setValue(event.target.value)} /></label><Button type="submit" variant="primary">{action}</Button><pre>{result}</pre></form>;
}

function TwoFieldTool({ title, firstLabel, secondLabel, action, onRun }: { title: string; firstLabel: string; secondLabel: string; action: string; onRun(first: string, second: string): Promise<string> }) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [result, setResult] = useState("");
  return <form className="desktop-form" onSubmit={(event) => { event.preventDefault(); void onRun(first, second).then(setResult); }}><h3>{title}</h3><label>{firstLabel}<input value={first} onChange={(event) => setFirst(event.target.value)} /></label><label>{secondLabel}<input value={second} onChange={(event) => setSecond(event.target.value)} /></label><Button type="submit" variant="primary">{action}</Button><pre>{result}</pre></form>;
}

function SyslogTool({ onRun }: { onRun(server: string, severity: string, message: string): Promise<string> }) {
  const [server, setServer] = useState("");
  const [severity, setSeverity] = useState("notice");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  return <form className="desktop-form" onSubmit={(event) => { event.preventDefault(); void onRun(server, severity, message).then(setResult); }}><h3>Syslog Tool</h3><label>Server IP<input value={server} onChange={(event) => setServer(event.target.value)} /></label><label>Severity<select value={severity} onChange={(event) => setSeverity(event.target.value)}>{["emergency", "alert", "critical", "error", "warning", "notice", "informational", "debug"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Message<input value={message} onChange={(event) => setMessage(event.target.value)} /></label><Button type="submit" variant="primary">Send</Button><pre>{result}</pre></form>;
}

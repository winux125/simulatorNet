import { getDeviceProfile, type LabDocument } from "@sim/contracts";
import type { LabUiNode } from "@sim/sim-worker";
import {
  Clock3, FileDown, Globe2, Network, ScrollText,
  Settings2, TerminalSquare, X, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import type { LabPowerState } from "../../state/workspace-store";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Button, IconButton } from "../../ui";
import { ServerServicesPanel } from "../inspector/ServerServicesPanel";
import { CONSOLE_CAPABLE_KINDS } from "../lab/document";
import { ConsoleAccessPanel } from "./ConsoleAccessPanel";
import { HostIpConfigurationPanel } from "./HostIpConfigurationPanel";
import {
  SecurityConfigurationPanel,
  type SecuritySection,
} from "./SecurityConfigurationPanel";

type DeviceWindowTab =
  | "overview" | "desktop" | "config" | "console" | "services" | "terminal" | "interfaces" | "attributes"
  | "routing" | "routes" | "vlans" | "svis" | "acl" | "nat" | "runtime"
  | "zones" | "policies" | "connections" | "impairments" | "flows" | "run" | "results";
type DesktopTool = "ip" | "command" | "web" | "tftp" | "ntp" | "syslog" | "transport";

interface DeviceWindowProps {
  client: SimulatorClient;
  document: LabDocument;
  node: LabUiNode;
  powerState: LabPowerState;
  runtimeAvailable: boolean;
  onOpenTerminal(deviceId: string): void;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
  onClose(): void;
}

export function DeviceWindow(props: DeviceWindowProps) {
  const profile = getDeviceProfile(props.node.type);
  const isServer = props.node.type === "server";
  const isPc = props.node.type === "pc";
  const tabs = useMemo<Array<{ id: DeviceWindowTab; label: string }>>(() => {
    const base = ((): Array<{ id: DeviceWindowTab; label: string }> => {
    if (isServer) return [
      { id: "config", label: "Config" },
      { id: "services", label: "Services" },
      { id: "desktop", label: "Desktop" },
      { id: "terminal", label: "Terminal" },
      { id: "attributes", label: "Attributes" },
    ];
    if (isPc) return [
      { id: "desktop", label: "Desktop" },
      { id: "config", label: "Config" },
      { id: "terminal", label: "Terminal" },
      { id: "attributes", label: "Attributes" },
    ];
    if (props.node.type === "router") return [
      { id: "interfaces", label: "Interfaces" },
      { id: "routing", label: "Routing" },
      { id: "acl", label: "ACL" },
      { id: "nat", label: "NAT" },
      { id: "terminal", label: "CLI" },
      { id: "runtime", label: "Runtime" },
    ];
    if (props.node.type === "l3-switch") return [
      { id: "interfaces", label: "Interfaces" },
      { id: "vlans", label: "VLANs" },
      { id: "svis", label: "SVI" },
      { id: "routing", label: "Routing" },
      { id: "acl", label: "ACL" },
      { id: "terminal", label: "CLI" },
      { id: "runtime", label: "Runtime" },
    ];
    if (props.node.type === "firewall") return [
      { id: "overview", label: "Overview" },
      { id: "interfaces", label: "Interfaces" },
      { id: "zones", label: "Zones" },
      { id: "policies", label: "Policies" },
      { id: "nat", label: "NAT" },
      { id: "routes", label: "Routes" },
      { id: "connections", label: "Connections" },
      { id: "terminal", label: "CLI" },
    ];
    if (props.node.type === "cloud") return [
      { id: "overview", label: "Overview" },
      { id: "interfaces", label: "Interfaces" },
      { id: "routes", label: "Routes" },
      { id: "impairments", label: "Impairments" },
    ];
    if (props.node.type === "traffic-generator") return [
      { id: "flows", label: "Flows" },
      { id: "run", label: "Run" },
      { id: "results", label: "Results" },
    ];
    return [
      { id: "overview", label: "Overview" },
      { id: "config", label: "Config" },
      ...(profile.cliProfile ? [{ id: "terminal" as const, label: "CLI" }] : []),
      { id: "interfaces", label: "Interfaces" },
      { id: "attributes", label: "Attributes" },
    ];
    })();
    return CONSOLE_CAPABLE_KINDS.has(props.node.type)
      ? [...base, { id: "console" as const, label: "Console Access" }]
      : base;
  }, [isPc, isServer, profile.cliProfile, props.node.type]);
  const [tab, setTab] = useState<DeviceWindowTab>(tabs[0]!.id);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [props.onClose]);

  return (
    <div className="device-window-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section className="device-window" role="dialog" aria-modal="true" aria-label={`${props.node.hostname} device window`}>
        <header className="device-window__titlebar">
          <span className="device-window__icon" aria-hidden="true"><DeviceIcon type={props.node.type} size={18} state={props.node.status === "up" ? "running" : "stopped"} /></span>
          <div><strong>{props.node.hostname}</strong><small>{profile.displayName} · {props.node.id}</small></div>
          <IconButton label="Close device window" icon={<X size={15} />} onClick={props.onClose} />
        </header>
        <nav className="device-window__tabs" role="tablist" aria-label={`${props.node.hostname} sections`}>
          {tabs.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "is-active" : ""} onClick={() => setTab(entry.id)}>{entry.label}</button>)}
        </nav>
        <div className="device-window__content" role="tabpanel">
          {tab === "overview" && <Overview node={props.node} description={profile.description} />}
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
          {tab === "config" && <StructuredConfiguration document={props.document} node={props.node} />}
          {tab === "console" && <ConsoleAccessPanel
            document={props.document}
            node={props.node}
            onConfigurationChanged={props.onConfigurationChanged}
            onError={props.onError}
          />}
          {tab === "services" && (props.runtimeAvailable
            ? <ServerServicesPanel client={props.client} deviceId={props.node.id} refreshKey={props.node.interfaces.length} onError={props.onError} />
            : <DraftRuntimeNotice />)}
          {tab === "terminal" && (props.runtimeAvailable
            ? <TerminalWorkspaceLauncher
                node={props.node}
                onOpen={() => props.onOpenTerminal(props.node.id)}
              />
            : <DraftRuntimeNotice />)}
          {tab === "interfaces" && <Interfaces node={props.node} />}
          {isSecuritySection(tab) && (props.runtimeAvailable
            ? <SecurityConfigurationPanel
                client={props.client}
                deviceId={props.node.id}
                section={tab}
                onConfigurationChanged={props.onConfigurationChanged}
                onError={props.onError}
              />
            : <DraftRuntimeNotice />)}
          {tab === "attributes" && <Attributes node={props.node} description={profile.description} capabilities={profile.capabilities} />}
        </div>
      </section>
    </div>
  );
}

function isSecuritySection(tab: DeviceWindowTab): tab is SecuritySection {
  return [
    "routing", "routes", "vlans", "svis", "acl", "nat", "runtime", "zones",
    "policies", "connections", "impairments", "flows", "run", "results",
  ].includes(tab);
}

function Overview({ node, description }: { node: LabUiNode; description: string }) {
  return <div className="device-window-section"><p className="section-eyebrow">Device overview</p><h2>{node.hostname}</h2><p>{description}</p><dl className="property-list"><div><dt>Type</dt><dd>{node.type}</dd></div><div><dt>Status</dt><dd>{node.status}</dd></div><div><dt>Interfaces</dt><dd>{node.interfaces.length}</dd></div></dl></div>;
}

function StructuredConfiguration({ document, node }: { document: LabDocument; node: LabUiNode }) {
  return <div className="device-window-section"><p className="section-eyebrow">Worker-owned configuration</p><p className="section-note">This is one view of the canonical device configuration; it is not an independent copy.</p><pre className="configuration-view">{JSON.stringify(document.configurations[node.id] ?? {}, null, 2)}</pre></div>;
}

function Interfaces({ node }: { node: LabUiNode }) {
  return <div className="device-window-table"><table className="data-table"><thead><tr><th>Interface</th><th>Admin</th><th>Operational</th><th>Address</th><th>Mode</th></tr></thead><tbody>{node.interfaces.map((iface) => <tr key={iface.id}><td><code>{iface.id}</code></td><td>{iface.adminUp ? "up" : "shutdown"}</td><td>{iface.operationalUp ? "up" : "down"}</td><td><code>{iface.ipAddress ?? "—"}</code></td><td>{iface.mode ?? "—"}</td></tr>)}</tbody></table></div>;
}

function Attributes({ node, description, capabilities }: { node: LabUiNode; description: string; capabilities: readonly string[] }) {
  return <div className="device-window-section"><p className="section-eyebrow">Attributes</p><h2>{node.hostname}</h2><p>{description}</p><dl className="property-list"><div><dt>Device ID</dt><dd><code>{node.id}</code></dd></div><div><dt>Profile</dt><dd>{node.type}</dd></div><div><dt>Capabilities</dt><dd>{capabilities.join(", ")}</dd></div></dl></div>;
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

function DraftRuntimeNotice() {
  return <div className="device-window-section"><p className="section-eyebrow">Pending rebuild</p><h2>Start the lab to open this tool</h2><p>This device exists in the topology draft. Its runtime tools become available after Apply &amp; Rebuild.</p></div>;
}

function TerminalWorkspaceLauncher({ node, onOpen }: { node: LabUiNode; onOpen(): void }) {
  return <div className="device-window-section terminal-workspace-launcher">
    <span className="terminal-workspace-launcher__icon"><TerminalSquare size={28} aria-hidden="true" /></span>
    <p className="section-eyebrow">Unified terminal workspace</p>
    <h2>{node.hostname} {node.type === "pc" ? "Command Prompt" : "CLI"}</h2>
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

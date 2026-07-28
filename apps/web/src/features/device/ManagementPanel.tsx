import type { LabUiNode, RemoteSessionsView, AaaStatusResponse, SnmpAgentStatusView } from "@sim/sim-worker";
import { useCallback, useEffect, useState } from "react";
import type { SimulatorClient } from "../../app/simulator-client";
import { Button, EmptyState } from "../../ui";
import { KeyRound, ShieldCheck, Radio, Users } from "lucide-react";

export type ManagementSection = "remote-access" | "aaa" | "snmp" | "sessions";

interface ManagementPanelProps {
  client: SimulatorClient;
  node: LabUiNode;
  section: ManagementSection;
  runtimeAvailable: boolean;
  onError(message: string): void;
}

/**
 * Read-only management inspection for a Router, Switch or Firewall.
 *
 * Everything shown here is runtime state recomputed from the worker on demand —
 * it never enters a `LabDocument`, a submission or the database. No secret is
 * rendered: a community, shared key or password appears only as "configured".
 */
export function ManagementPanel(props: ManagementPanelProps) {
  const [sessions, setSessions] = useState<RemoteSessionsView>();
  const [aaa, setAaa] = useState<AaaStatusResponse>();
  const [snmp, setSnmp] = useState<SnmpAgentStatusView>();
  const [busy, setBusy] = useState(false);

  const { client, node, section, runtimeAvailable, onError } = props;

  const refresh = useCallback(() => {
    if (!runtimeAvailable) return;
    setBusy(true);
    const requests: Array<Promise<unknown>> = [];
    if (section === "remote-access" || section === "sessions") {
      requests.push(client.request({ type: "GET_REMOTE_SESSIONS", deviceId: node.id })
        .then(setSessions)
        .catch(() => setSessions(undefined)));
    }
    if (section === "aaa") {
      requests.push(client.request({ type: "GET_AAA_STATUS", deviceId: node.id })
        .then(setAaa)
        .catch(() => setAaa(undefined)));
    }
    if (section === "snmp") {
      requests.push(client.request({ type: "GET_SNMP_AGENT_STATUS", deviceId: node.id })
        .then(setSnmp)
        .catch(() => setSnmp(undefined)));
    }
    void Promise.all(requests).finally(() => setBusy(false));
  }, [client, node.id, runtimeAvailable, section]);

  useEffect(refresh, [refresh]);

  if (!runtimeAvailable) {
    return <EmptyState
      icon={<ShieldCheck size={26} />}
      title="Start the lab to inspect management state"
      description="Remote sessions, AAA status and SNMP values are runtime state. They are recomputed from the worker and never saved into the lab document."
    />;
  }

  const clearLine = (line: number) => {
    void client.request({ type: "CLEAR_REMOTE_LINE", deviceId: node.id, line })
      .then(setSessions)
      .catch((error: unknown) => onError(error instanceof Error ? error.message : "Could not clear the line"));
  };

  return (
    <section className="device-window-section" aria-label={`${node.hostname} management`}>
      <p className="section-eyebrow">Management · {SECTION_LABEL[section]}</p>

      {section === "remote-access" && <RemoteAccess view={sessions} />}
      {section === "sessions" && <Sessions view={sessions} onClear={clearLine} />}
      {section === "aaa" && <Aaa view={aaa} />}
      {section === "snmp" && <Snmp view={snmp} />}

      <Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>Refresh</Button>
    </section>
  );
}

const SECTION_LABEL: Record<ManagementSection, string> = {
  "remote-access": "Remote Access",
  aaa: "AAA",
  snmp: "SNMP",
  sessions: "Sessions",
};

function RemoteAccess({ view }: { view: RemoteSessionsView | undefined }) {
  if (!view) return <p className="section-note">This device has no management plane.</p>;
  return (
    <>
      <p className="section-note">
        Simulated Telnet and SSH. SSH here is an educational model: a derived host-key fingerprint,
        no key exchange and no encryption. Telnet always warns that it carries credentials in the clear.
      </p>
      <dl className="device-window-facts">
        <div><dt>Telnet</dt><dd>{view.telnetEnabled ? "enabled" : "disabled"}</dd></div>
        <div><dt>SSH</dt><dd>{view.sshEnabled ? "enabled (v2, simulated)" : "disabled"}</dd></div>
        <div><dt>Host key</dt><dd><code>{view.hostKeyFingerprint ?? "not generated"}</code></dd></div>
      </dl>
      <table className="data-table">
        <caption className="visually-hidden">VTY lines</caption>
        <thead><tr><th>Line</th><th>State</th><th>Login</th><th>Transports</th><th>Timeout</th></tr></thead>
        <tbody>
          {view.lines.map((line) => (
            <tr key={line.index}>
              <td><code>vty {line.index}</code></td>
              <td>{line.state}</td>
              <td>{line.loginMode}</td>
              <td>{line.transports.length === 0 ? "none" : line.transports.join(" ")}</td>
              <td>{line.execTimeoutSeconds}s</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.lines.length === 0 && <p className="section-note">No VTY lines are configured.</p>}
    </>
  );
}

function Sessions({
  view,
  onClear,
}: {
  view: RemoteSessionsView | undefined;
  onClear(line: number): void;
}) {
  if (!view || view.sessions.length === 0) {
    return <EmptyState icon={<Users size={26} />} title="No remote sessions" description="Open a Telnet or SSH session from a PC, Laptop or Server terminal." />;
  }
  return (
    <table className="data-table">
      <caption className="visually-hidden">Active remote sessions</caption>
      <thead><tr><th>Line</th><th>Protocol</th><th>User</th><th>From</th><th>Idle</th><th /></tr></thead>
      <tbody>
        {view.sessions.map((session) => (
          <tr key={session.id}>
            <td><code>vty {session.line}</code></td>
            <td>{session.protocol}</td>
            <td>{session.username ?? "—"}</td>
            <td><code>{session.clientHostname} ({session.peerAddress})</code></td>
            <td>{Math.floor(session.idleForNs / 1_000_000_000)}s</td>
            <td><Button size="sm" variant="ghost" onClick={() => onClear(session.line)}>Clear line</Button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Aaa({ view }: { view: AaaStatusResponse | undefined }) {
  if (!view) return <p className="section-note">This device has no AAA plane.</p>;
  if (!view.enabled) {
    return <EmptyState
      icon={<KeyRound size={26} />}
      title="AAA is not enabled"
      description="Run 'aaa new-model' in the CLI, then configure authentication, authorization and accounting method lists."
    />;
  }
  const lists = [
    ...view.configuration.authenticationLogin.map((list) => ["authentication login", list.name, list.methods.join(", ")]),
    ...view.configuration.authorizationExec.map((list) => ["authorization exec", list.name, list.methods.join(", ")]),
    ...view.configuration.authorizationCommands.map((list) => [`authorization commands ${list.privilegeLevel}`, list.name, list.methods.join(", ")]),
    ...view.configuration.accountingExec.map((list) => [`accounting exec (${list.mode})`, list.name, list.methods.join(", ")]),
    ...view.configuration.accountingCommands.map((list) => [`accounting commands ${list.privilegeLevel ?? "*"} (${list.mode})`, list.name, list.methods.join(", ")]),
  ];
  return (
    <>
      <p className="section-note">
        A method list stops at the first conclusive result: accept succeeds, an explicit reject fails,
        and only an unavailable server falls through to the next method.
      </p>
      <table className="data-table">
        <caption className="visually-hidden">AAA method lists</caption>
        <thead><tr><th>Type</th><th>List</th><th>Methods</th></tr></thead>
        <tbody>{lists.map((row, index) => <tr key={`${row[0]}-${index}`}><td>{row[0]}</td><td><code>{row[1]}</code></td><td>{row[2]}</td></tr>)}</tbody>
      </table>
      <table className="data-table">
        <caption className="visually-hidden">AAA servers</caption>
        <thead><tr><th>Server</th><th>Protocol</th><th>Address</th><th>Reachable</th><th>Failures</th></tr></thead>
        <tbody>
          {view.servers.map((server) => (
            <tr key={`${server.protocol}-${server.name}`}>
              <td><code>{server.name}</code></td>
              <td>{server.protocol}</td>
              <td><code>{server.address}</code></td>
              <td>{server.reachable === undefined ? "not contacted" : server.reachable ? "yes" : "no"}</td>
              <td>{server.failures}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.lastAuthentication && (
        <p className="section-note">
          Last authentication: <code>{view.lastAuthentication.username || "(line password)"}</code>{" "}
          via <code>{view.lastAuthentication.method}</code> — {view.lastAuthentication.result}.
        </p>
      )}
    </>
  );
}

function Snmp({ view }: { view: SnmpAgentStatusView | undefined }) {
  if (!view) return <p className="section-note">This device has no SNMP agent.</p>;
  if (!view.configuration.enabled) {
    return <EmptyState
      icon={<Radio size={26} />}
      title="SNMP agent is not enabled"
      description="Configure a read-only community to enable the SNMPv2c agent. The community value is never displayed after it is saved."
    />;
  }
  return (
    <>
      <p className="section-note">
        SNMPv2c educational subset. Values come from the built-in SimulatorNet MIB, which reports only
        state the engine models — there is no CPU or memory object.
      </p>
      <dl className="device-window-facts">
        <div><dt>Communities</dt><dd>{view.configuration.communities.length} configured</dd></div>
        <div><dt>Location</dt><dd>{view.configuration.location ?? "not configured"}</dd></div>
        <div><dt>Contact</dt><dd>{view.configuration.contact ?? "not configured"}</dd></div>
        <div><dt>Traps</dt><dd>{view.configuration.trapsEnabled ? `enabled (${view.configuration.trapDestinations.length} destination(s))` : "disabled"}</dd></div>
      </dl>
      <table className="data-table">
        <caption className="visually-hidden">Built-in MIB values</caption>
        <thead><tr><th>OID</th><th>Type</th><th>Value</th></tr></thead>
        <tbody>
          {view.mib.map((bind) => (
            <tr key={bind.oid}>
              <td><code>{bind.oid}</code></td>
              <td>{bind.type}</td>
              <td><code>{String(bind.value)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function isManagementSection(tab: string): tab is ManagementSection {
  return tab === "remote-access" || tab === "aaa" || tab === "snmp" || tab === "sessions";
}

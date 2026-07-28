import {
  MANAGEMENT_LIMITS,
  SSH_PORT,
  TELNET_PLAINTEXT_WARNING,
  TELNET_PORT,
  type ConsoleAccessConfiguration,
  type RemoteAccessConfiguration,
  type RemoteProtocol,
  type VtyLineConfig,
} from "@sim/contracts";
import { managementCredentialScope } from "@sim/console-auth";
import type { CliSession } from "@sim/cli-engine";
import type { IpAddress, TcpConnection } from "@sim/sim-core";
import {
  LocalAuthenticationProvider,
  PRIVILEGED_EXEC_LEVEL,
  type AuthenticationProvider,
  type AuthenticationResult,
} from "./authentication";
import { boundedRemoteText } from "./limits";
import type { ManagedDevice } from "./managed-device";
import { deriveHostKeyFingerprint } from "./managed-device";
import {
  decodeRemoteCli,
  remoteCliPayload,
  remoteCloseMessage,
  type RemoteCloseReason,
  type RemoteCliOpenMessage,
} from "./messages";
import { VtyLinePool, type VtyLineRuntime } from "./vty";

const NS_PER_SECOND = 1_000_000_000;

/** A session terminated by this device. Runtime only: never serialized. */
export interface RemoteSessionSummary {
  readonly id: string;
  readonly line: number;
  readonly protocol: RemoteProtocol;
  readonly clientDeviceId: string;
  readonly clientHostname: string;
  readonly peerAddress: IpAddress;
  readonly username: string | undefined;
  readonly privilegeLevel: number;
  readonly authenticated: boolean;
  readonly openedAtNs: number;
  readonly idleForNs: number;
}

type LoginStage = "awaiting-username" | "awaiting-password" | "authenticated";

interface RemoteSession {
  readonly id: string;
  readonly line: number;
  readonly protocol: RemoteProtocol;
  readonly connection: TcpConnection;
  readonly peerAddress: IpAddress;
  readonly clientDeviceId: string;
  readonly clientHostname: string;
  readonly openedAtNs: number;
  cli: CliSession | undefined;
  stage: LoginStage;
  pendingUsername: string;
  username: string | undefined;
  privilegeLevel: number;
  attempts: number;
  lastActivityNs: number;
  idleGeneration: number;
  closed: boolean;
  /** True while an `enable` escalation is waiting for the enable secret. */
  awaitingEnable: boolean;
}

/**
 * The management-plane remote CLI service of one managed device.
 *
 * It owns the Telnet and SSH listeners, VTY line allocation, authentication and
 * the dedicated `CliSession` each login gets. It executes nothing itself: a
 * command reaches the same `cli-engine` parser and the same device
 * configuration API as the local console, so remote and local behaviour cannot
 * drift. Nothing here turns a router or switch into a general-purpose server.
 */
export class RemoteCliService {
  private readonly lines = new VtyLinePool();
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly pending = new Map<TcpConnection, true>();
  private access: ConsoleAccessConfiguration | undefined;
  private configuration: RemoteAccessConfiguration | undefined;
  private authenticator: AuthenticationProvider;
  private listeningTelnet = false;
  private listeningSsh = false;
  private sessionCounter = 0;
  private closeListener: ((session: RemoteSessionSummary, reason: RemoteCloseReason) => void) | undefined;

  constructor(
    private readonly host: ManagedDevice,
    /** Bounds shared with the lab so a single lab cannot exhaust memory. */
    private readonly labCapacity: () => boolean = () => true,
  ) {
    this.authenticator = new LocalAuthenticationProvider(
      () => this.access,
      (index) => this.lines.lineConfig(index),
    );
  }

  /** Replace the authentication decision layer (AAA method lists in M10.7b). */
  useAuthenticationProvider(provider: AuthenticationProvider): void {
    this.authenticator = provider;
  }

  onSessionClosed(listener: (session: RemoteSessionSummary, reason: RemoteCloseReason) => void): void {
    this.closeListener = listener;
  }

  /** Apply persisted configuration and (re)arm the listeners. */
  configure(
    remote: RemoteAccessConfiguration | undefined,
    access: ConsoleAccessConfiguration | undefined,
  ): void {
    this.access = access;
    this.configuration = remote;
    this.lines.configure(remote?.vtyLines ?? []);
    this.rearmListeners();
  }

  get telnetEnabled(): boolean {
    return (this.configuration?.telnetEnabled ?? false) && this.lines.permitsTransport("telnet");
  }

  get sshEnabled(): boolean {
    return (this.configuration?.ssh.enabled ?? false)
      && this.hostKeyFingerprint !== undefined
      && this.lines.permitsTransport("ssh");
  }

  get hostKeyFingerprint(): string | undefined {
    return this.configuration?.ssh.hostKeyFingerprint;
  }

  get sshVersion(): number {
    return this.configuration?.ssh.version ?? 2;
  }

  get domainName(): string | undefined {
    return this.configuration?.ssh.domainName;
  }

  vtyRows(): VtyLineRuntime[] {
    return this.lines.rows(this.host.engine().now());
  }

  sessionSummaries(): RemoteSessionSummary[] {
    const now = this.host.engine().now();
    return [...this.sessions.values()]
      .map((session) => ({
        id: session.id,
        line: session.line,
        protocol: session.protocol,
        clientDeviceId: session.clientDeviceId,
        clientHostname: session.clientHostname,
        peerAddress: session.peerAddress,
        username: session.username,
        privilegeLevel: session.privilegeLevel,
        authenticated: session.stage === "authenticated",
        openedAtNs: session.openedAtNs,
        idleForNs: now - session.lastActivityNs,
      }))
      .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
  }

  /** `clear line vty <n>`: drop whatever is on that line. */
  clearLine(index: number): boolean {
    const session = [...this.sessions.values()].find((candidate) => candidate.line === index);
    if (!session) return false;
    this.closeSession(session, "cleared-by-administrator");
    return true;
  }

  /** Close every session, e.g. because the lab stopped or the device was removed. */
  closeAll(reason: RemoteCloseReason): void {
    for (const session of [...this.sessions.values()]) this.closeSession(session, reason);
    this.lines.releaseAll();
  }

  /**
   * Push the output of a Step-mode operation that finished after its command
   * returned. Called once the shared event queue has been drained.
   */
  completeDeferredOperations(): void {
    for (const session of [...this.sessions.values()]) {
      const output = session.cli?.completePendingOperation();
      if (output === undefined) continue;
      this.sendOutput(session, output);
    }
  }

  // --- listeners ----------------------------------------------------------

  private rearmListeners(): void {
    const transport = this.host.transport();
    if (this.listeningTelnet) {
      transport.tcp.unlisten(TELNET_PORT);
      this.listeningTelnet = false;
    }
    if (this.listeningSsh) {
      transport.tcp.unlisten(SSH_PORT);
      this.listeningSsh = false;
    }
    if (this.telnetEnabled) {
      transport.tcp.listen(TELNET_PORT, (connection) => this.acceptConnection(connection, "telnet"), "telnet");
      this.listeningTelnet = true;
    }
    if (this.sshEnabled) {
      transport.tcp.listen(SSH_PORT, (connection) => this.acceptConnection(connection, "ssh"), "ssh");
      this.listeningSsh = true;
    }
  }

  private acceptConnection(connection: TcpConnection, protocol: RemoteProtocol): void {
    this.pending.set(connection, true);
    connection.setHandlers({
      onMessage: (payload) => this.onMessage(connection, protocol, payload),
      onClosed: () => this.onTransportClosed(connection),
      onReset: () => this.onTransportClosed(connection),
    });
    this.trace("tcp-connection", { protocol, port: protocol === "ssh" ? SSH_PORT : TELNET_PORT });
  }

  private onMessage(connection: TcpConnection, protocol: RemoteProtocol, payload: unknown): void {
    const message = decodeRemoteCli(payload);
    if (!message) return;
    if (message.type === "open") {
      this.openSession(connection, protocol, message);
      return;
    }
    if (message.type !== "input") return;
    const session = this.sessionOf(connection);
    if (!session) return;
    this.handleInput(session, message.text, message.credential);
  }

  private sessionOf(connection: TcpConnection): RemoteSession | undefined {
    return [...this.sessions.values()].find((session) => session.connection === connection);
  }

  private openSession(
    connection: TcpConnection,
    protocol: RemoteProtocol,
    message: RemoteCliOpenMessage,
  ): void {
    this.pending.delete(connection);
    const enabled = protocol === "ssh" ? this.sshEnabled : this.telnetEnabled;
    if (!enabled) {
      this.refuse(connection, "service-disabled");
      return;
    }
    if (!this.lines.permitsTransport(protocol)) {
      this.refuse(connection, "transport-not-permitted");
      return;
    }
    if (this.sessions.size >= MANAGEMENT_LIMITS.maximumRemoteSessionsPerDevice || !this.labCapacity()) {
      this.refuse(connection, "session-limit");
      return;
    }
    const now = this.host.engine().now();
    const line = this.lines.allocate(protocol, now);
    if (line === undefined) {
      this.refuse(connection, "no-vty-line");
      return;
    }
    const id = `${this.host.deviceId}:vty${line}:${++this.sessionCounter}`;
    const session: RemoteSession = {
      id,
      line,
      protocol,
      connection,
      peerAddress: connection.remoteAddress,
      clientDeviceId: message.clientDeviceId,
      clientHostname: message.clientHostname,
      openedAtNs: now,
      cli: undefined,
      stage: "awaiting-username",
      pendingUsername: message.username?.trim() ?? "",
      username: undefined,
      privilegeLevel: 0,
      attempts: 0,
      lastActivityNs: now,
      idleGeneration: 0,
      closed: false,
      awaitingEnable: false,
    };
    this.sessions.set(id, session);
    this.lines.bindPeer(line, session.peerAddress, id);
    this.trace(`${protocol}-session-opened`, {
      line,
      client: message.clientDeviceId,
      peer: session.peerAddress,
    });
    connection.send(remoteCliPayload({
      type: "accept",
      protocol,
      line,
      hostKeyFingerprint: protocol === "ssh" ? this.hostKeyFingerprint : undefined,
      warning: protocol === "telnet" ? TELNET_PLAINTEXT_WARNING : undefined,
    }));
    this.beginLogin(session);
  }

  private refuse(connection: TcpConnection, reason: RemoteCloseReason): void {
    this.pending.delete(connection);
    connection.send(remoteCliPayload({ type: "close", reason, message: remoteCloseMessage(reason) }));
    connection.close();
    this.trace("remote-session-refused", { reason });
  }

  // --- login --------------------------------------------------------------

  private lineConfigOf(session: RemoteSession): VtyLineConfig | undefined {
    return this.lines.lineConfig(session.line);
  }

  private beginLogin(session: RemoteSession): void {
    const line = this.lineConfigOf(session);
    if (!line) {
      this.closeSession(session, "authentication-failed");
      return;
    }
    if (line.loginMode === "none") {
      this.completeLogin(session, {
        status: "accept",
        username: session.pendingUsername,
        privilegeLevel: 1,
        method: "none",
      });
      return;
    }
    if (line.loginMode === "password") {
      session.stage = "awaiting-password";
      this.sendPrompt(session, "", "Password:", managementCredentialScope.line("vty"));
      return;
    }
    if (session.pendingUsername.length > 0) {
      session.stage = "awaiting-password";
      this.sendPrompt(session, "", "Password:", managementCredentialScope.user(session.pendingUsername));
      return;
    }
    session.stage = "awaiting-username";
    this.sendPrompt(session, "", "Username:");
  }

  private handleInput(session: RemoteSession, text: string, credential: string | undefined): void {
    if (session.closed) return;
    session.lastActivityNs = this.host.engine().now();
    this.lines.touch(session.line, session.lastActivityNs);
    if (session.stage === "awaiting-username") {
      session.pendingUsername = text.trim().slice(0, 64);
      session.stage = "awaiting-password";
      this.sendPrompt(session, "", "Password:", managementCredentialScope.user(session.pendingUsername));
      return;
    }
    if (session.stage === "awaiting-password") {
      this.submitCredential(session, credential ?? "");
      return;
    }
    if (session.awaitingEnable) {
      this.submitEnable(session, credential ?? "");
      return;
    }
    this.runCommand(session, text);
  }

  private submitCredential(session: RemoteSession, credentialFingerprint: string): void {
    const line = this.lineConfigOf(session);
    if (!line) {
      this.closeSession(session, "authentication-failed");
      return;
    }
    this.trace(`${session.protocol}-login-attempt`, {
      line: session.line,
      username: line.loginMode === "local" ? session.pendingUsername : undefined,
      peer: session.peerAddress,
    });
    this.authenticator.authenticate(
      {
        listName: line.authenticationListName,
        username: session.pendingUsername,
        credentialFingerprint,
        protocol: session.protocol,
        line: session.line,
        peerAddress: session.peerAddress,
      },
      (result) => {
        if (session.closed) return;
        if (result.status === "accept") {
          this.completeLogin(session, result);
          return;
        }
        this.failLogin(session, result);
      },
    );
  }

  private completeLogin(session: RemoteSession, result: Extract<AuthenticationResult, { status: "accept" }>): void {
    session.stage = "authenticated";
    session.username = result.username || session.pendingUsername || undefined;
    session.privilegeLevel = result.privilegeLevel;
    session.attempts = 0;
    const cli = this.host.createSession();
    if (result.privilegeLevel >= PRIVILEGED_EXEC_LEVEL) cli.enter("privileged");
    session.cli = cli;
    this.lines.activate(session.line, session.username, session.peerAddress, session.id, session.lastActivityNs);
    this.trace(`${session.protocol}-login-succeeded`, {
      line: session.line,
      username: session.username,
      method: result.method,
      privilege: result.privilegeLevel,
    });
    this.sendOutput(session, "");
  }

  private failLogin(session: RemoteSession, result: Extract<AuthenticationResult, { status: "reject" }>): void {
    session.attempts++;
    this.trace(`${session.protocol}-login-failed`, {
      line: session.line,
      method: result.method,
      reason: result.reason,
      attempt: session.attempts,
    });
    if (session.attempts >= MANAGEMENT_LIMITS.maximumLoginAttempts) {
      this.closeSession(session, "authentication-failed");
      return;
    }
    const line = this.lineConfigOf(session);
    session.pendingUsername = "";
    if (line?.loginMode === "local") {
      session.stage = "awaiting-username";
      this.sendPrompt(session, "% Login invalid", "Username:");
      return;
    }
    session.stage = "awaiting-password";
    this.sendPrompt(session, "% Login invalid", "Password:", managementCredentialScope.line("vty"));
  }

  private submitEnable(session: RemoteSession, credentialFingerprint: string): void {
    session.awaitingEnable = false;
    const expected = this.access?.enableCredentialFingerprint;
    if (expected && expected === credentialFingerprint) {
      session.privilegeLevel = PRIVILEGED_EXEC_LEVEL;
      session.cli?.enter("privileged");
      this.sendOutput(session, "");
      return;
    }
    this.trace(`${session.protocol}-enable-denied`, { line: session.line, username: session.username });
    this.sendOutput(session, "% Access denied");
  }

  // --- command execution ---------------------------------------------------

  private runCommand(session: RemoteSession, text: string): void {
    const cli = session.cli;
    if (!cli) return;
    const command = boundedRemoteText(text, MANAGEMENT_LIMITS.maximumRemoteCommandChars).trim();
    if (isCommand(command, "exit") || isCommand(command, "logout") || isCommand(command, "quit")) {
      if (cli.mode === "exec" || cli.mode === "privileged") {
        this.closeSession(session, "logout");
        return;
      }
    }
    if (isCommand(command, "enable") && cli.mode === "exec") {
      if (session.privilegeLevel >= PRIVILEGED_EXEC_LEVEL) {
        cli.enter("privileged");
        this.sendOutput(session, "");
        return;
      }
      if (this.access?.enableCredentialFingerprint) {
        session.awaitingEnable = true;
        this.sendPrompt(session, "", "Password:", managementCredentialScope.enable());
        return;
      }
      this.sendOutput(session, "% No password set");
      return;
    }
    // Command text is traced, never its credential arguments: the CLI has no
    // secret-setting commands, and any credential arrives as a fingerprint.
    this.trace(`${session.protocol}-command`, {
      line: session.line,
      username: session.username,
      command: command.slice(0, 120),
    });
    const output = cli.execute(command);
    this.sendOutput(session, output);
  }

  // --- transport helpers ---------------------------------------------------

  private sendPrompt(session: RemoteSession, text: string, prompt: string, credentialScope?: string): void {
    if (session.closed) return;
    session.connection.send(remoteCliPayload({
      type: "output",
      text,
      prompt,
      secret: credentialScope !== undefined,
      credentialScope,
      authenticated: session.stage === "authenticated",
      deferred: false,
    }));
  }

  private sendOutput(session: RemoteSession, output: string): void {
    if (session.closed) return;
    const cli = session.cli;
    session.connection.send(remoteCliPayload({
      type: "output",
      text: boundedRemoteText(output, MANAGEMENT_LIMITS.maximumRemoteOutputChars),
      prompt: cli?.prompt() ?? "",
      secret: false,
      authenticated: session.stage === "authenticated",
      deferred: cli?.hasPendingOperation() ?? false,
    }));
  }

  private onTransportClosed(connection: TcpConnection): void {
    this.pending.delete(connection);
    const session = this.sessionOf(connection);
    if (session && !session.closed) this.finishSession(session, "connection-reset", false);
  }

  private closeSession(session: RemoteSession, reason: RemoteCloseReason): void {
    if (session.closed) return;
    session.connection.send(remoteCliPayload({
      type: "close",
      reason,
      message: remoteCloseMessage(reason),
    }));
    this.finishSession(session, reason, true);
  }

  private finishSession(session: RemoteSession, reason: RemoteCloseReason, closeTransport: boolean): void {
    session.closed = true;
    this.lines.markClosing(session.line);
    this.sessions.delete(session.id);
    this.lines.release(session.line);
    if (closeTransport) session.connection.close();
    this.trace(`${session.protocol}-session-closed`, {
      line: session.line,
      username: session.username,
      reason,
    });
    this.closeListener?.(
      {
        id: session.id,
        line: session.line,
        protocol: session.protocol,
        clientDeviceId: session.clientDeviceId,
        clientHostname: session.clientHostname,
        peerAddress: session.peerAddress,
        username: session.username,
        privilegeLevel: session.privilegeLevel,
        authenticated: false,
        openedAtNs: session.openedAtNs,
        idleForNs: 0,
      },
      reason,
    );
  }

  /**
   * Drop sessions that have been idle past their `exec-timeout`.
   *
   * This is evaluated lazily rather than from a self-scheduled timer: Auto
   * drains every queued event regardless of its virtual timestamp, so a
   * repeating timer would push virtual time forward on its own and close
   * healthy sessions. The runtime calls this after an explicit time advance,
   * which is exactly when an idle timeout becomes observable.
   */
  enforceIdleTimeouts(): void {
    const now = this.host.engine().now();
    for (const session of [...this.sessions.values()]) {
      const line = this.lineConfigOf(session);
      const timeoutSeconds = line?.execTimeoutSeconds ?? 0;
      if (timeoutSeconds <= 0) continue;
      const idleNs = now - session.lastActivityNs;
      if (idleNs < timeoutSeconds * NS_PER_SECOND) {
        if (idleNs > 0) this.lines.markIdle(session.line);
        continue;
      }
      this.closeSession(session, "idle-timeout");
    }
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.host.engine();
    engine.trace({ time: engine.now(), type, device: this.host.deviceId, detail });
  }
}

/** Cisco-style unique-prefix match for the few commands the service intercepts. */
function isCommand(input: string, command: string): boolean {
  const value = input.trim().toLowerCase();
  return value.length > 0 && command.startsWith(value);
}

export { deriveHostKeyFingerprint };

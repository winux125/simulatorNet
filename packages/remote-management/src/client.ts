import {
  MANAGEMENT_LIMITS,
  SSH_PORT,
  TELNET_PORT,
  sshHostKeyPrompt,
  type RemoteProtocol,
} from "@sim/contracts";
import type { EndHost, IpAddress, TcpConnection } from "@sim/sim-core";
import { boundedRemoteText, REMOTE_COMMAND_TIMEOUT_NS, REMOTE_CONNECT_TIMEOUT_NS } from "./limits";
import {
  decodeRemoteCli,
  remoteCliPayload,
  remoteCloseMessage,
  type RemoteCliOutputMessage,
  type RemoteCloseReason,
} from "./messages";

export type RemoteClientState =
  | "connecting"
  | "host-key-confirmation"
  | "authenticating"
  | "open"
  | "closed";

export interface RemoteClientView {
  readonly sessionId: string;
  readonly protocol: RemoteProtocol;
  readonly targetAddress: IpAddress;
  readonly targetPort: number;
  readonly state: RemoteClientState;
  /** Prompt the remote device wants shown before the next input. */
  readonly prompt: string;
  /** The next input is a credential and must never be echoed or recorded. */
  readonly secret: boolean;
  /** Scope the terminal must derive its credential fingerprint against. */
  readonly credentialScope: string | undefined;
  readonly username: string | undefined;
  readonly hostKeyFingerprint: string | undefined;
  readonly closeReason: RemoteCloseReason | undefined;
}

/** Accepted SSH host keys, bounded and workspace-local. Never graded, never saved. */
export class KnownHostStore {
  private readonly entries = new Map<string, string>();

  isTrusted(host: IpAddress, fingerprint: string): boolean {
    return this.entries.get(host) === fingerprint;
  }

  /** Returns false when the host is known with a *different* fingerprint. */
  remember(host: IpAddress, fingerprint: string): boolean {
    const existing = this.entries.get(host);
    if (existing !== undefined && existing !== fingerprint) return false;
    if (existing === undefined && this.entries.size >= MANAGEMENT_LIMITS.maximumKnownHostsPerClient) {
      // Drop the oldest entry: the store is bounded, never unbounded history.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(host, fingerprint);
    return true;
  }

  forget(host: IpAddress): void {
    this.entries.delete(host);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

export interface RemoteClientOptions {
  readonly protocol: RemoteProtocol;
  readonly targetAddress: IpAddress;
  readonly port?: number;
  readonly username?: string;
  readonly knownHosts: KnownHostStore;
}

/**
 * The originating side of a simulated remote CLI session.
 *
 * It runs on a PC, Laptop or Server and speaks over the *host's own* TCP stack,
 * so reachability, ACLs, NAT, firewall policy, interface state and TCP port
 * availability all decide whether management succeeds. Output is delivered
 * through a bounded queue that the terminal drains, so a Step-mode session
 * still shows the learner what is queued.
 */
export class RemoteCliClient {
  readonly sessionId: string;
  readonly protocol: RemoteProtocol;
  readonly targetAddress: IpAddress;
  readonly targetPort: number;
  private state: RemoteClientState = "connecting";
  private prompt = "";
  private secret = false;
  private credentialScope: string | undefined;
  private hostKeyFingerprint: string | undefined;
  /** Server output withheld until the learner accepts the host key. */
  private deferredLogin: RemoteCliOutputMessage | undefined;
  private awaiting = false;
  private closeReason: RemoteCloseReason | undefined;
  private connection: TcpConnection | undefined;
  private readonly output: string[] = [];
  private readonly knownHosts: KnownHostStore;
  private username: string | undefined;
  private generation = 0;

  constructor(
    private readonly host: EndHost,
    sessionId: string,
    options: RemoteClientOptions,
  ) {
    this.sessionId = sessionId;
    this.protocol = options.protocol;
    this.targetAddress = options.targetAddress;
    this.targetPort = options.port ?? (options.protocol === "ssh" ? SSH_PORT : TELNET_PORT);
    this.username = options.username;
    this.knownHosts = options.knownHosts;
  }

  view(): RemoteClientView {
    return {
      sessionId: this.sessionId,
      protocol: this.protocol,
      targetAddress: this.targetAddress,
      targetPort: this.targetPort,
      state: this.state,
      prompt: this.prompt,
      secret: this.secret,
      credentialScope: this.credentialScope,
      username: this.username,
      hostKeyFingerprint: this.hostKeyFingerprint,
      closeReason: this.closeReason,
    };
  }

  get isClosed(): boolean {
    return this.state === "closed";
  }

  /** Drain everything the session has produced since the last call. */
  drainOutput(): string {
    const text = this.output.join("\n");
    this.output.length = 0;
    return text;
  }

  hasOutput(): boolean {
    return this.output.length > 0;
  }

  /** True while the managed device still owes this session a reply. */
  awaitingResponse(): boolean {
    return this.awaiting && this.state !== "closed";
  }

  /** Start the TCP connection. Failure surfaces as a closed session with a reason. */
  connect(): void {
    this.awaiting = true;
    const generation = ++this.generation;
    let connection: TcpConnection;
    try {
      connection = this.host.connectTcp(
        this.targetAddress,
        this.targetPort,
        {
          onEstablished: () => {
            if (generation !== this.generation) return;
            connection.send(remoteCliPayload({
              type: "open",
              protocol: this.protocol,
              clientDeviceId: this.host.id,
              clientHostname: this.host.name,
              username: this.username,
            }));
          },
          onMessage: (payload) => {
            if (generation !== this.generation) return;
            this.onMessage(payload);
          },
          onClosed: () => {
            if (generation !== this.generation) return;
            this.finish(this.closeReason ?? "logout");
          },
          onReset: () => {
            if (generation !== this.generation) return;
            this.emit("% Connection refused by remote host.");
            this.finish("connection-reset");
          },
        },
        this.protocol,
      );
    } catch {
      this.emit(`% Unable to reach ${this.targetAddress}.`);
      this.finish("connection-reset");
      return;
    }
    this.connection = connection;
    this.host.engine.scheduleIn(REMOTE_CONNECT_TIMEOUT_NS, () => {
      if (generation !== this.generation) return;
      if (this.state !== "connecting") return;
      this.emit(`% Connection to ${this.targetAddress} timed out.`);
      this.close("connection-reset");
    });
  }

  /**
   * Submit one line. A credential is supplied as an opaque fingerprint that the
   * caller derived outside the engine; the plaintext never gets this far.
   */
  submit(text: string, credential?: string): void {
    if (this.state === "closed") return;
    if (this.state === "host-key-confirmation") {
      this.answerHostKey(text);
      return;
    }
    const connection = this.connection;
    if (!connection) return;
    const line = boundedRemoteText(text, MANAGEMENT_LIMITS.maximumRemoteCommandChars);
    this.awaiting = true;
    connection.send(remoteCliPayload({ type: "input", text: line, credential }));
    const generation = this.generation;
    this.host.engine.scheduleIn(REMOTE_COMMAND_TIMEOUT_NS, () => {
      if (generation !== this.generation || !this.awaiting || this.state === "closed") return;
      this.emit("% Remote device did not respond.");
      this.close("connection-reset");
    });
  }

  /** Close the session locally (terminal tab closed, device stopped, link lost). */
  close(reason: RemoteCloseReason = "logout"): void {
    if (this.state === "closed") return;
    this.closeReason = reason;
    this.connection?.close();
    this.finish(reason);
  }

  private onMessage(payload: unknown): void {
    const message = decodeRemoteCli(payload);
    if (!message) return;
    if (message.type === "accept") {
      this.hostKeyFingerprint = message.hostKeyFingerprint;
      if (message.warning) this.emit(message.warning);
      if (
        this.protocol === "ssh"
        && message.hostKeyFingerprint
        && !this.knownHosts.isTrusted(this.targetAddress, message.hostKeyFingerprint)
      ) {
        // The learner answers locally, before any credential is derived; the
        // device's login prompt is held back until the key is accepted.
        this.state = "host-key-confirmation";
        this.emit(sshHostKeyPrompt(this.targetAddress, message.hostKeyFingerprint));
        this.prompt = "";
        this.secret = false;
        this.awaiting = false;
        return;
      }
      this.state = "authenticating";
      return;
    }
    if (message.type === "output") {
      if (this.state === "host-key-confirmation") {
        this.deferredLogin = message;
        return;
      }
      this.applyOutput(message);
      return;
    }
    if (message.type === "close") {
      this.emit(message.message);
      this.closeReason = message.reason;
      this.connection?.close();
      this.finish(message.reason);
    }
  }

  private applyOutput(message: RemoteCliOutputMessage): void {
    if (message.text) this.emit(message.text);
    this.prompt = message.prompt;
    this.secret = message.secret;
    this.credentialScope = message.credentialScope;
    this.state = message.authenticated ? "open" : "authenticating";
    this.awaiting = false;
  }

  private answerHostKey(text: string): void {
    const answer = text.trim().toLowerCase();
    if (answer !== "yes" && answer !== "y") {
      this.emit("Host key verification aborted.");
      this.close("logout");
      return;
    }
    const fingerprint = this.hostKeyFingerprint;
    if (!fingerprint) {
      this.close("connection-reset");
      return;
    }
    if (!this.knownHosts.remember(this.targetAddress, fingerprint)) {
      this.emit("% Remote host identification has changed. Connection aborted.");
      this.close("connection-reset");
      return;
    }
    this.emit(`Warning: Permanently added '${this.targetAddress}' to the list of known hosts.`);
    this.state = "authenticating";
    // The device already sent its login prompt while the key was unconfirmed;
    // replay it now instead of sending an empty line it would read as input.
    const deferred = this.deferredLogin;
    this.deferredLogin = undefined;
    if (deferred) this.applyOutput(deferred);
  }

  private emit(text: string): void {
    if (this.output.length >= MANAGEMENT_LIMITS.maximumQueuedTerminalLines) this.output.shift();
    this.output.push(text);
  }

  private finish(reason: RemoteCloseReason): void {
    if (this.state === "closed") return;
    this.generation++;
    this.state = "closed";
    this.closeReason = reason;
    this.prompt = "";
    this.secret = false;
    this.credentialScope = undefined;
    this.connection = undefined;
    this.deferredLogin = undefined;
    this.awaiting = false;
  }
}

export { remoteCloseMessage };

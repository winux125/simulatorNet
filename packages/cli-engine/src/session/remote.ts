/**
 * The seam between a local CLI session and a *remote* one.
 *
 * `cli-engine` owns parsing, modes, prompts and formatting; it must not know
 * how a Telnet or SSH session is carried. So it depends only on these two tiny
 * structural interfaces, and `@sim/remote-management` implements them on top of
 * the deterministic TCP transport. That keeps the dependency direction
 * one-way: remote-management -> cli-engine, never the reverse.
 */
export type RemoteSessionProtocol = "telnet" | "ssh";

export interface RemoteSessionRequest {
  readonly protocol: RemoteSessionProtocol;
  /** Destination exactly as the learner typed it: IPv4, IPv6 or a hostname. */
  readonly target: string;
  readonly port?: number;
  readonly username?: string;
}

/** A live remote session attached to the originating host's CLI session. */
export interface RemoteSessionBridge {
  /** Begin the connection. Its result arrives through `drain`. */
  connect(): void;
  /** Send one line; a credential is always an opaque, pre-derived fingerprint. */
  submit(line: string, credential?: string): void;
  /** Everything the remote side produced since the last call. */
  drain(): string;
  /**
   * True while the remote device still owes this session a reply. The CLI keeps
   * draining the deterministic event queue until it turns false, so Auto
   * completes a whole round trip and Step keeps the events observable.
   */
  awaitingResponse(): boolean;
  /** The prompt the remote device wants shown before the next input. */
  prompt(): string;
  /** True while the remote device is asking for a credential. */
  expectsSecret(): boolean;
  /** Scope the terminal must derive the credential fingerprint against. */
  credentialScope(): string | undefined;
  /** True once the remote session has ended for any reason. */
  isClosed(): boolean;
  /** Close from this side (terminal tab closed, `exit`, device stopped). */
  close(): void;
  /** Label for the terminal tab, e.g. "SSH R1". */
  readonly label: string;
}

/**
 * Creates remote sessions for a host device. Injected into a `CliSession` by
 * whoever owns the runtime (the browser worker or the verifier), so the CLI
 * itself never reaches into the management plane.
 */
export interface RemoteSessionOpener {
  open(deviceId: string, request: RemoteSessionRequest): RemoteSessionBridge;
}

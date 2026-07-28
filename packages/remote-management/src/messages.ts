import type { RemoteProtocol } from "@sim/contracts";
import type { TcpApplicationPayload } from "@sim/sim-core";

/**
 * The structured messages a simulated Telnet/SSH session exchanges over the
 * deterministic TCP transport. There is no byte-level Telnet option negotiation
 * and no SSH binary packet protocol: this is an educational management channel
 * carried by `TcpApplicationPayload`, so the packet path, ACLs, NAT, interface
 * state and TCP itself are all real simulated behaviour.
 *
 * A credential never travels as plaintext. When the device asks for a secret it
 * publishes a `credentialScope`; the client derives the opaque fingerprint for
 * that scope with Web Crypto *before* the network operation and sends only the
 * fingerprint.
 */
export const REMOTE_CLI_PROTOCOL = "remote-cli";

export type RemoteCloseReason =
  | "logout"
  | "idle-timeout"
  | "authentication-failed"
  | "authorization-failed"
  | "no-vty-line"
  | "service-disabled"
  | "transport-not-permitted"
  | "session-limit"
  | "connection-reset"
  | "cleared-by-administrator"
  | "management-interface-down";

export interface RemoteCliOpenMessage {
  readonly type: "open";
  readonly protocol: RemoteProtocol;
  readonly clientDeviceId: string;
  readonly clientHostname: string;
  /** Supplied by `ssh -l <user>` / `ssh user@host`; Telnet prompts instead. */
  readonly username?: string;
}

export interface RemoteCliAcceptMessage {
  readonly type: "accept";
  readonly protocol: RemoteProtocol;
  /** The VTY line this session was allocated. */
  readonly line: number;
  /** Simulated SSH host-key fingerprint; never a private key. */
  readonly hostKeyFingerprint?: string;
  /** Educational transport warning, e.g. the Telnet plaintext notice. */
  readonly warning?: string;
}

export interface RemoteCliInputMessage {
  readonly type: "input";
  readonly text: string;
  /** Opaque credential fingerprint answering a `credentialScope` prompt. */
  readonly credential?: string;
}

export interface RemoteCliOutputMessage {
  readonly type: "output";
  readonly text: string;
  readonly prompt: string;
  /** The next input is a secret: do not echo, record, log or trace it. */
  readonly secret: boolean;
  /** Scope the client must derive its credential fingerprint against. */
  readonly credentialScope?: string;
  readonly authenticated: boolean;
  /** A queued Step-mode network operation still owes this session its output. */
  readonly deferred: boolean;
}

export interface RemoteCliCloseMessage {
  readonly type: "close";
  readonly reason: RemoteCloseReason;
  readonly message: string;
}

export type RemoteCliMessage =
  | RemoteCliOpenMessage
  | RemoteCliAcceptMessage
  | RemoteCliInputMessage
  | RemoteCliOutputMessage
  | RemoteCliCloseMessage;

export function remoteCliPayload(message: RemoteCliMessage): TcpApplicationPayload {
  return { kind: "tcp-application", protocol: REMOTE_CLI_PROTOCOL, data: message };
}

/** Narrow an arbitrary TCP payload to a remote-CLI message. */
export function decodeRemoteCli(payload: unknown): RemoteCliMessage | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = payload as { kind?: unknown; protocol?: unknown; data?: unknown };
  if (candidate.kind !== "tcp-application" || candidate.protocol !== REMOTE_CLI_PROTOCOL) return undefined;
  const data = candidate.data;
  if (typeof data !== "object" || data === null) return undefined;
  const type = (data as { type?: unknown }).type;
  if (type !== "open" && type !== "accept" && type !== "input" && type !== "output" && type !== "close") {
    return undefined;
  }
  return data as RemoteCliMessage;
}

const CLOSE_MESSAGES: Record<RemoteCloseReason, string> = {
  logout: "Connection closed by foreign host.",
  "idle-timeout": "Connection closed: idle session timeout.",
  "authentication-failed": "% Authentication failed.",
  "authorization-failed": "% Authorization failed.",
  "no-vty-line": "% All remote terminal lines are in use.",
  "service-disabled": "% Connection refused by remote host.",
  "transport-not-permitted": "% Connection refused by remote host.",
  "session-limit": "% Remote session limit reached.",
  "connection-reset": "Connection reset by peer.",
  "cleared-by-administrator": "Connection closed by remote host.",
  "management-interface-down": "Connection closed: the management interface went down.",
};

export function remoteCloseMessage(reason: RemoteCloseReason): string {
  return CLOSE_MESSAGES[reason];
}

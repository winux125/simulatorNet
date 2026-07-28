import type { IpAddress } from "../util/ip-address";

export interface DnsMessage {
  readonly kind: "dns";
  readonly messageType: "query" | "response";
  readonly transactionId: number;
  readonly name: string;
  readonly responseCode?: "NOERROR" | "NXDOMAIN" | "FORMERR";
  readonly address?: IpAddress;
}

export interface HttpMessage {
  readonly kind: "http";
  readonly messageType: "request" | "response";
  readonly method?: "GET" | "HEAD";
  readonly host?: string;
  readonly path?: string;
  readonly status?: 200 | 400 | 404;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface TftpMessage {
  readonly kind: "tftp";
  readonly opcode: "RRQ" | "DATA" | "ACK" | "ERROR";
  readonly transferId: number;
  readonly filename?: string;
  readonly block?: number;
  readonly data?: string;
  readonly final?: boolean;
  readonly errorCode?: "not-found" | "malformed" | "limit-exceeded";
  readonly message?: string;
}

export interface NtpMessage {
  readonly kind: "ntp";
  readonly messageType: "query" | "response";
  readonly requestId: number;
  readonly clientTimeNs: number;
  readonly serverTimeNs?: number;
}

export type SyslogSeverity =
  | "emergency"
  | "alert"
  | "critical"
  | "error"
  | "warning"
  | "notice"
  | "informational"
  | "debug";

export interface SyslogMessage {
  readonly kind: "syslog";
  readonly facility: string;
  readonly severity: SyslogSeverity;
  readonly source: string;
  readonly timestampNs: number;
  readonly message: string;
}

/**
 * Educational RADIUS model carried by UDP. There is no Request Authenticator,
 * no MD5 construction and no attribute encoding: the shared key travels as an
 * opaque, scope-bound fingerprint and the payload is structured data.
 */
export type RadiusCode =
  | "Access-Request"
  | "Access-Accept"
  | "Access-Reject"
  | "Accounting-Request"
  | "Accounting-Response";

export interface RadiusMessage {
  readonly kind: "radius";
  readonly code: RadiusCode;
  readonly identifier: number;
  readonly username?: string;
  /** Opaque fingerprint of the user's password; never a plaintext secret. */
  readonly credentialFingerprint?: string;
  /** Opaque fingerprint of the client/server shared key. */
  readonly sharedKeyFingerprint?: string;
  /** Reply attribute: the privilege level an accepted user receives. */
  readonly privilegeLevel?: number;
  readonly replyMessage?: string;
  /** Accounting only. */
  readonly accountingStatus?: "start" | "stop";
  readonly sessionId?: string;
  readonly deviceName?: string;
  readonly detail?: string;
}

/** Educational TACACS+ model carried by TCP. No body obfuscation is simulated. */
export type TacacsMessageType =
  | "authentication-request"
  | "authentication-reply"
  | "authorization-request"
  | "authorization-reply"
  | "accounting-request"
  | "accounting-reply";

export interface TacacsMessage {
  readonly kind: "tacacs";
  readonly messageType: TacacsMessageType;
  readonly sequence: number;
  readonly username?: string;
  readonly credentialFingerprint?: string;
  readonly sharedKeyFingerprint?: string;
  readonly status?: "pass" | "fail" | "error";
  readonly privilegeLevel?: number;
  /** Authorization only: `exec` or the command being authorized. */
  readonly service?: "exec" | "command";
  readonly command?: string;
  readonly replyMessage?: string;
  /** Accounting only. */
  readonly accountingStatus?: "start" | "stop" | "command";
  readonly sessionId?: string;
  readonly deviceName?: string;
  readonly detail?: string;
}

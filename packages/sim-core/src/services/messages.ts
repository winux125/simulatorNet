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

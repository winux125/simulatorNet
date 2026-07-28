import {
  AAA_LIMITS,
  type AaaCommandRule,
  type AaaServerClient,
  type AaaServerUser,
  type RadiusServiceConfig,
  type TacacsServiceConfig,
} from "@sim/contracts";
import type { IpAddress } from "../util/ip-address";
import type { RadiusMessage, TacacsMessage } from "./messages";

/**
 * Deterministic decision logic for the educational RADIUS and TACACS+ services.
 *
 * These are *pure* functions over structured configuration so browser and
 * verifier reach the same answer, and so nothing here can accidentally reach
 * the network, the clock or a random source. Credentials are compared only as
 * opaque fingerprints; there is no plaintext secret to leak.
 */

export interface AaaServerDecision {
  readonly status: "accept" | "reject";
  readonly privilegeLevel: number;
  readonly username?: string;
  readonly reason?: "unknown-user" | "invalid-credentials" | "client-rejected" | "key-mismatch";
}

/** One accounting record kept by a AAA service. Runtime only: never serialized. */
export interface AaaAccountingEntry {
  readonly sequence: number;
  readonly receivedAtNs: number;
  readonly protocol: "radius" | "tacacs+";
  readonly event: "start" | "stop" | "command";
  readonly deviceName: string;
  readonly deviceAddress: IpAddress;
  readonly username: string;
  readonly sessionId: string;
  /** Redacted command text, or a short status string. Never a secret. */
  readonly detail: string;
}

export interface AaaServiceRuntimeSnapshot {
  readonly accessAccepted: number;
  readonly accessRejected: number;
  readonly authorizationPermitted: number;
  readonly authorizationDenied: number;
  readonly accounting: AaaAccountingEntry[];
}

/** A client address is accepted only when configured (unless restriction is off). */
export function authorizeClient(
  clients: readonly AaaServerClient[],
  restrictToConfiguredClients: boolean,
  address: IpAddress,
  sharedKeyFingerprint: string | undefined,
): { readonly ok: boolean; readonly reason?: AaaServerDecision["reason"] } {
  const client = clients.find((candidate) => candidate.enabled && candidate.address === address);
  if (!client) {
    return restrictToConfiguredClients ? { ok: false, reason: "client-rejected" } : { ok: true };
  }
  if (client.sharedKeyFingerprint && client.sharedKeyFingerprint !== sharedKeyFingerprint) {
    return { ok: false, reason: "key-mismatch" };
  }
  return { ok: true };
}

export function authenticateAaaUser(
  users: readonly AaaServerUser[],
  username: string | undefined,
  credentialFingerprint: string | undefined,
): AaaServerDecision {
  const wanted = username?.trim() ?? "";
  const user = users.find((candidate) => candidate.enabled && candidate.username === wanted);
  if (!user) return { status: "reject", privilegeLevel: 0, reason: "unknown-user" };
  if (!credentialFingerprint || user.credentialFingerprint !== credentialFingerprint) {
    return { status: "reject", privilegeLevel: 0, reason: "invalid-credentials" };
  }
  return { status: "accept", privilegeLevel: user.privilegeLevel, username: user.username };
}

/**
 * Bounded, declarative command matching. Only exact text, a prefix, or a prefix
 * with one explicit trailing `*` is supported: a LabDocument never supplies a
 * regular expression and nothing is compiled or executed.
 */
export function commandRuleMatches(
  rule: AaaCommandRule,
  username: string,
  privilegeLevel: number,
  command: string,
): boolean {
  if (rule.username !== undefined && rule.username !== username) return false;
  if (rule.privilegeLevel !== undefined && rule.privilegeLevel !== privilegeLevel) return false;
  const normalizedCommand = command.trim().toLowerCase().replace(/\s+/gu, " ");
  const pattern = rule.command.trim().toLowerCase().replace(/\s+/gu, " ");
  if (pattern.endsWith("*")) {
    const head = pattern.slice(0, -1).trimEnd();
    return head.length === 0 || normalizedCommand === head || normalizedCommand.startsWith(`${head} `);
  }
  if (rule.match === "exact") return normalizedCommand === pattern;
  return normalizedCommand === pattern || normalizedCommand.startsWith(`${pattern} `);
}

export function authorizeCommand(
  config: Pick<TacacsServiceConfig, "commandRules" | "commandDefault">,
  username: string,
  privilegeLevel: number,
  command: string,
): { readonly action: "permit" | "deny"; readonly ruleId?: string } {
  const ordered = [...config.commandRules].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  for (const rule of ordered) {
    if (!commandRuleMatches(rule, username, privilegeLevel, command)) continue;
    return { action: rule.action, ruleId: rule.id };
  }
  return { action: config.commandDefault };
}

/**
 * Strip credential-bearing arguments before a command is recorded.
 *
 * Accounting must never store a plaintext secret, so a command that *sets* a
 * secret keeps its shape and loses its argument.
 */
export function redactAccountedCommand(command: string): string {
  const trimmed = command.trim();
  const redactions: Array<[RegExp, string]> = [
    [/^(username\s+\S+(?:\s+privilege\s+\d+)?\s+(?:secret|password))\s+.*$/iu, "$1 <redacted>"],
    [/^(enable\s+(?:secret|password))\s+.*$/iu, "$1 <redacted>"],
    [/^(password)\s+.*$/iu, "$1 <redacted>"],
    [/^(key)\s+.*$/iu, "$1 <redacted>"],
    [/^(snmp-server\s+community)\s+\S+(.*)$/iu, "$1 <redacted>$2"],
    [/^(snmp-server\s+host\s+\S+\s+version\s+\S+)\s+\S+(.*)$/iu, "$1 <redacted>$2"],
  ];
  for (const [pattern, replacement] of redactions) {
    if (pattern.test(trimmed)) return trimmed.replace(pattern, replacement);
  }
  return trimmed.slice(0, AAA_LIMITS.maximumCommandPatternChars);
}

export function radiusAccept(
  request: RadiusMessage,
  decision: AaaServerDecision,
): RadiusMessage {
  return decision.status === "accept"
    ? {
        kind: "radius",
        code: "Access-Accept",
        identifier: request.identifier,
        username: decision.username,
        privilegeLevel: decision.privilegeLevel,
      }
    : {
        kind: "radius",
        code: "Access-Reject",
        identifier: request.identifier,
        username: request.username,
        replyMessage: "Authentication failed",
      };
}

export function tacacsAuthenticationReply(
  request: TacacsMessage,
  decision: AaaServerDecision,
): TacacsMessage {
  return {
    kind: "tacacs",
    messageType: "authentication-reply",
    sequence: request.sequence + 1,
    username: request.username,
    status: decision.status === "accept" ? "pass" : "fail",
    privilegeLevel: decision.status === "accept" ? decision.privilegeLevel : undefined,
    replyMessage: decision.status === "accept" ? undefined : "Authentication failed",
  };
}

export function tacacsAuthorizationReply(
  request: TacacsMessage,
  action: "permit" | "deny",
  privilegeLevel: number,
): TacacsMessage {
  return {
    kind: "tacacs",
    messageType: "authorization-reply",
    sequence: request.sequence + 1,
    username: request.username,
    service: request.service,
    command: request.command,
    status: action === "permit" ? "pass" : "fail",
    privilegeLevel,
    replyMessage: action === "permit" ? undefined : "Authorization failed",
  };
}

/** Bounded accounting log shared by both services. */
export class AaaAccountingLog {
  private readonly entries: AaaAccountingEntry[] = [];
  private sequence = 0;

  record(entry: Omit<AaaAccountingEntry, "sequence">): AaaAccountingEntry {
    const recorded: AaaAccountingEntry = { ...entry, sequence: ++this.sequence };
    this.entries.push(recorded);
    if (this.entries.length > AAA_LIMITS.maximumAccountingEntries) {
      this.entries.splice(0, this.entries.length - AAA_LIMITS.maximumAccountingEntries);
    }
    return recorded;
  }

  snapshot(): AaaAccountingEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries.length = 0;
    this.sequence = 0;
  }
}

export type { RadiusServiceConfig, TacacsServiceConfig };

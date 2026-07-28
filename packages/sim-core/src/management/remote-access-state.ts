import {
  DEFAULT_REMOTE_ACCESS_CONFIGURATION,
  MANAGEMENT_LIMITS,
  type PasswordVerifier,
  type RemoteAccessConfiguration,
  type RemoteProtocol,
  type SshServerConfig,
  type VtyLineConfig,
  type VtyLoginMode,
} from "@sim/contracts";

export interface VtyLineSelection {
  readonly first: number;
  readonly last: number;
}

/**
 * Persistent remote-management configuration of one managed device.
 *
 * It lives in sim-core beside the other device configuration (ACLs, NAT,
 * spanning tree) so `lab-format` serializes it uniformly and the CLI reaches it
 * exactly like any other device API. Protocol *behaviour* stays in
 * `@sim/remote-management`; this class only holds structured configuration and
 * notifies its owner when something changed.
 *
 * Simulated SSH is educational: `hostKeyFingerprint` is a deterministic
 * identity string, never a private key, and no cryptographic material is
 * generated, stored or transmitted.
 */
export class RemoteAccessState {
  private telnet = true;
  private ssh: SshServerConfig = { enabled: false, version: 2 };
  private lines: VtyLineConfig[] = [];
  private changeListener: (() => void) | undefined;

  constructor(private readonly deviceId: string) {}

  onChanged(listener: () => void): void {
    this.changeListener = listener;
  }

  configure(config: RemoteAccessConfiguration | undefined): void {
    const source = config ?? DEFAULT_REMOTE_ACCESS_CONFIGURATION;
    this.telnet = source.telnetEnabled;
    this.ssh = { ...source.ssh };
    this.lines = normalizeVtyLines(source.vtyLines);
    this.changed();
  }

  snapshot(): RemoteAccessConfiguration {
    return {
      telnetEnabled: this.telnet,
      ssh: { ...this.ssh },
      vtyLines: this.lines.map((line) => ({ ...line, transports: [...line.transports] })),
    };
  }

  get telnetEnabled(): boolean {
    return this.telnet;
  }

  get sshConfig(): SshServerConfig {
    return { ...this.ssh };
  }

  get vtyLines(): readonly VtyLineConfig[] {
    return this.lines;
  }

  /** True when any configured VTY line accepts this transport. */
  permitsTransport(protocol: RemoteProtocol): boolean {
    return this.lines.some((line) => line.transports.includes(protocol));
  }

  setTelnetEnabled(enabled: boolean): void {
    this.telnet = enabled;
    this.changed();
  }

  setSshEnabled(enabled: boolean): void {
    this.ssh = { ...this.ssh, enabled };
    this.changed();
  }

  setSshVersion(version: 2): void {
    this.ssh = { ...this.ssh, version, enabled: this.ssh.hostKeyFingerprint !== undefined };
    this.changed();
  }

  setDomainName(domainName: string | undefined): void {
    this.ssh = { ...this.ssh, domainName };
    this.changed();
  }

  /**
   * `crypto key generate rsa`: derive the simulated host-key fingerprint that
   * identifies this device to an SSH client. Requires a domain name, exactly
   * like IOS, and enables the SSH server.
   */
  generateHostKey(modulusBits: number): string {
    if (!this.ssh.domainName) {
      throw new Error("% Please define a domain-name first.");
    }
    const hostKeyFingerprint = deriveHostKeyFingerprint(this.deviceId, this.ssh.domainName, modulusBits);
    this.ssh = { ...this.ssh, hostKeyFingerprint, modulusBits, enabled: true };
    this.changed();
    return hostKeyFingerprint;
  }

  clearHostKey(): void {
    this.ssh = { ...this.ssh, hostKeyFingerprint: undefined, modulusBits: undefined, enabled: false };
    this.changed();
  }

  /** `line vty <first> <last>`: create the block if it does not exist yet. */
  selectRange(selection: VtyLineSelection): void {
    if (
      !Number.isInteger(selection.first)
      || !Number.isInteger(selection.last)
      || selection.first < 0
      || selection.last > MANAGEMENT_LIMITS.maximumVtyLineIndex
      || selection.first > selection.last
    ) {
      throw new Error(`VTY line numbers range from 0 to ${MANAGEMENT_LIMITS.maximumVtyLineIndex}`);
    }
    const existing = this.lines.find((line) => line.first === selection.first && line.last === selection.last);
    if (existing) return;
    this.lines = normalizeVtyLines([
      ...this.lines,
      {
        first: selection.first,
        last: selection.last,
        loginMode: "none",
        transports: ["telnet", "ssh"],
        execTimeoutSeconds: 600,
      },
    ]);
    this.changed();
  }

  /** Apply an update to every line covered by the selected range. */
  updateRange(selection: VtyLineSelection, update: (line: VtyLineConfig) => VtyLineConfig): void {
    this.selectRange(selection);
    this.lines = normalizeVtyLines(this.lines.map((line) =>
      line.first === selection.first && line.last === selection.last ? update(line) : line));
    this.changed();
  }

  setLogin(selection: VtyLineSelection, loginMode: VtyLoginMode): void {
    this.updateRange(selection, (line) => ({ ...line, loginMode }));
  }

  setLinePassword(selection: VtyLineSelection, passwordVerifier: PasswordVerifier | undefined): void {
    this.updateRange(selection, (line) => ({ ...line, passwordVerifier }));
  }

  setTransports(selection: VtyLineSelection, transports: readonly RemoteProtocol[]): void {
    this.updateRange(selection, (line) => ({ ...line, transports: [...transports] }));
  }

  setExecTimeout(selection: VtyLineSelection, seconds: number): void {
    this.updateRange(selection, (line) => ({ ...line, execTimeoutSeconds: seconds }));
  }

  setAuthenticationList(selection: VtyLineSelection, listName: string | undefined): void {
    this.updateRange(selection, (line) => ({ ...line, authenticationListName: listName }));
  }

  setAuthorizationList(selection: VtyLineSelection, listName: string | undefined): void {
    this.updateRange(selection, (line) => ({ ...line, authorizationListName: listName }));
  }

  removeRange(selection: VtyLineSelection): void {
    this.lines = this.lines.filter((line) => !(line.first === selection.first && line.last === selection.last));
    this.changed();
  }

  private changed(): void {
    this.changeListener?.();
  }
}

/**
 * True when nothing about remote management has been configured.
 *
 * Canonicalization and serialization both treat this as "absent", so a lab that
 * never touched Telnet/SSH round-trips byte-identically and existing schema-v1
 * documents do not grow an empty block.
 */
export function isDefaultRemoteAccess(config: RemoteAccessConfiguration | undefined): boolean {
  if (!config) return true;
  return config.telnetEnabled
    && config.vtyLines.length === 0
    && !config.ssh.enabled
    && config.ssh.version === 2
    && config.ssh.domainName === undefined
    && config.ssh.hostKeyFingerprint === undefined
    && config.ssh.modulusBits === undefined;
}

/** Canonical order and bounded count: lowest first line, then lowest last line. */
export function normalizeVtyLines(lines: readonly VtyLineConfig[]): VtyLineConfig[] {
  const unique = new Map<string, VtyLineConfig>();
  for (const line of lines) unique.set(`${line.first}:${line.last}`, line);
  return [...unique.values()]
    .sort((a, b) => a.first - b.first || a.last - b.last)
    .slice(0, MANAGEMENT_LIMITS.maximumVtyLineIndex + 1)
    .map((line) => ({ ...line, transports: [...line.transports] }));
}

/**
 * Deterministic educational SSH host-key fingerprint. It identifies a simulated
 * device; it is not derived from, and never implies, real key material.
 */
export function deriveHostKeyFingerprint(
  deviceId: string,
  domainName: string | undefined,
  modulusBits: number,
): string {
  let hash = 2_166_136_261;
  for (const char of `${deviceId}|${domainName ?? ""}|${modulusBits}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
  }
  const bytes: string[] = [];
  let state = hash;
  for (let index = 0; index < 16; index++) {
    state = Math.imul(state ^ (index + 0x9e37_79b9), 16_777_619) >>> 0;
    bytes.push(((state >>> 16) & 0xff).toString(16).padStart(2, "0"));
  }
  return `SHA256:${bytes.join("")}`;
}

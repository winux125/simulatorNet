import type {
  ConsoleAccessConfiguration,
  ConsoleUserConfiguration,
  RemoteProtocol,
  VtyLineConfig,
} from "@sim/contracts";
import { managementCredentialScope } from "@sim/console-auth";
import type { IpAddress } from "@sim/sim-core";
import { findLocalUser } from "./managed-device";

/**
 * One shared authentication decision layer.
 *
 * There is deliberately **no** second local-user implementation for console,
 * VTY, Telnet, SSH or AAA fallback: every path resolves through this module and
 * the one device user database in `ConsoleAccessConfiguration`. A provider is
 * callback-based because a network method (RADIUS/TACACS+) answers only after a
 * deterministic round trip through the engine.
 */
export type AuthenticationMethodName = "local" | "line" | "none" | "group radius" | "group tacacs+";

export interface AuthenticationRequest {
  /** `login authentication <list>` on the line, when configured. */
  readonly listName: string | undefined;
  readonly username: string;
  /** Opaque fingerprint of the submitted secret; never a plaintext password. */
  readonly credentialFingerprint: string;
  readonly protocol: RemoteProtocol;
  readonly line: number;
  readonly peerAddress: IpAddress;
}

export type AuthenticationResult =
  | {
      readonly status: "accept";
      readonly username: string;
      readonly privilegeLevel: number;
      readonly method: AuthenticationMethodName;
    }
  | {
      readonly status: "reject";
      readonly method: AuthenticationMethodName;
      readonly reason: "invalid-credentials" | "no-method" | "unavailable" | "authorization-denied";
    };

export interface AuthenticationProvider {
  /** Resolve a login. `done` may be called synchronously or after engine events. */
  authenticate(request: AuthenticationRequest, done: (result: AuthenticationResult) => void): void;
  /** Whether a privilege escalation (`enable`) is permitted for this session. */
  authorizeExec?(request: AuthenticationRequest, done: (result: AuthenticationResult) => void): void;
}

/**
 * Whether the line asks for a credential at all, and which one.
 *
 * - `none`: the line has no `login` command; the session opens straight away.
 * - `password`: `login` plus a line `password`; username is not requested.
 * - `local`: `login local`; the device's shared user database decides.
 */
export function credentialScopeFor(line: VtyLineConfig, username: string): string | undefined {
  if (line.loginMode === "none") return undefined;
  if (line.loginMode === "password") return managementCredentialScope.line("vty");
  return managementCredentialScope.user(username);
}

/** The default privilege a `login`-only (line password) session receives. */
export const LINE_PASSWORD_PRIVILEGE_LEVEL = 1;
export const PRIVILEGED_EXEC_LEVEL = 15;

/**
 * Local authentication against the shared device user database and the VTY line
 * password. Comparison is a constant-time-free string equality of opaque
 * fingerprints: no secret is present to leak.
 */
export class LocalAuthenticationProvider implements AuthenticationProvider {
  constructor(
    private readonly access: () => ConsoleAccessConfiguration | undefined,
    private readonly lineConfig: (index: number) => VtyLineConfig | undefined,
  ) {}

  authenticate(request: AuthenticationRequest, done: (result: AuthenticationResult) => void): void {
    done(this.resolve(request));
  }

  private resolve(request: AuthenticationRequest): AuthenticationResult {
    const line = this.lineConfig(request.line);
    if (!line) return { status: "reject", method: "none", reason: "no-method" };
    if (line.loginMode === "none") {
      return { status: "accept", username: "", privilegeLevel: LINE_PASSWORD_PRIVILEGE_LEVEL, method: "none" };
    }
    if (line.loginMode === "password") {
      const expected = line.passwordVerifier?.hashBase64;
      if (!expected) return { status: "reject", method: "line", reason: "no-method" };
      return expected === request.credentialFingerprint
        ? { status: "accept", username: "", privilegeLevel: LINE_PASSWORD_PRIVILEGE_LEVEL, method: "line" }
        : { status: "reject", method: "line", reason: "invalid-credentials" };
    }
    const user = findLocalUser(this.access(), request.username);
    return acceptLocalUser(user, request.credentialFingerprint);
  }
}

/** Shared by local login and by AAA's `local` fallback method. */
export function acceptLocalUser(
  user: ConsoleUserConfiguration | undefined,
  credentialFingerprint: string,
): AuthenticationResult {
  if (!user?.credentialFingerprint) {
    return { status: "reject", method: "local", reason: "invalid-credentials" };
  }
  return user.credentialFingerprint === credentialFingerprint
    ? { status: "accept", username: user.username, privilegeLevel: user.privilegeLevel, method: "local" }
    : { status: "reject", method: "local", reason: "invalid-credentials" };
}

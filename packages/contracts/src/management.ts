import { z } from "zod";
import { PasswordVerifierSchema } from "./console";
import { Ipv4Schema, PrefixLengthSchema, VlanIdSchema } from "./primitives";

/**
 * Management-plane configuration: remote CLI access (simulated Telnet/SSH), the
 * L2 management SVI and the VTY line model.
 *
 * Everything here is *educational*. Simulated SSH is not a cryptographic
 * implementation: there is no real key exchange, no packet encryption and no
 * public-key user authentication. Simulated Telnet carries no option
 * negotiation. Both exist so a learner can practise device management over a
 * real simulated TCP path, through routing, ACLs, NAT and interface state.
 *
 * Secrets are never stored in the clear: every password is a PBKDF2 verifier,
 * exactly like the console credentials in `./console`.
 */

/** Centralized, finite management-plane limits. Nothing here may be unbounded. */
export const MANAGEMENT_LIMITS = Object.freeze({
  /** Highest configurable `line vty` index (`line vty 0 15`). */
  maximumVtyLineIndex: 15,
  /** Concurrent remote sessions terminated by one managed device. */
  maximumRemoteSessionsPerDevice: 16,
  /** Concurrent remote sessions across the whole lab. */
  maximumRemoteSessionsPerLab: 64,
  /** Failed logins before a VTY line is dropped. */
  maximumLoginAttempts: 3,
  minimumExecTimeoutSeconds: 0,
  maximumExecTimeoutSeconds: 3_600,
  /** Accepted host-key fingerprints remembered by one client host. */
  maximumKnownHostsPerClient: 32,
  /** Remote lines buffered for one originating terminal. */
  maximumQueuedTerminalLines: 256,
  maximumRemoteCommandChars: 512,
  maximumRemoteOutputChars: 16_384,
});

export const VTY_LINE_STATES = ["free", "authenticating", "active", "idle", "closing"] as const;
export const VtyLineStateSchema = z.enum(VTY_LINE_STATES);
export type VtyLineState = z.infer<typeof VtyLineStateSchema>;

export const RemoteProtocolSchema = z.enum(["telnet", "ssh"]);
export type RemoteProtocol = z.infer<typeof RemoteProtocolSchema>;

/** Well-known ports for the simulated management protocols. */
export const TELNET_PORT = 23;
export const SSH_PORT = 22;

export const VtyLoginModeSchema = z.enum(["none", "password", "local"]);
export type VtyLoginMode = z.infer<typeof VtyLoginModeSchema>;

/**
 * One `line vty <first> <last>` block. Ranges never overlap after
 * canonicalization: a later block replaces the lines it covers.
 */
export const VtyLineConfigSchema = z.object({
  first: z.number().int().min(0).max(MANAGEMENT_LIMITS.maximumVtyLineIndex),
  last: z.number().int().min(0).max(MANAGEMENT_LIMITS.maximumVtyLineIndex),
  /** `login` (password), `login local` (username database), or no login. */
  loginMode: VtyLoginModeSchema.default("none"),
  /** Verifier for `password <secret>` under the line. Never a plaintext value. */
  passwordVerifier: PasswordVerifierSchema.optional(),
  /** `transport input` — an empty list is `transport input none`. */
  transports: z.array(RemoteProtocolSchema).max(2).default(["telnet", "ssh"]),
  /** `exec-timeout <minutes> <seconds>` flattened to seconds; 0 disables it. */
  execTimeoutSeconds: z
    .number()
    .int()
    .min(MANAGEMENT_LIMITS.minimumExecTimeoutSeconds)
    .max(MANAGEMENT_LIMITS.maximumExecTimeoutSeconds)
    .default(600),
  /** `login authentication <list>`: an AAA method list name (M10.7b). */
  authenticationListName: z.string().min(1).max(64).optional(),
  /** `authorization exec <list>`: an AAA exec authorization list (M10.7b). */
  authorizationListName: z.string().min(1).max(64).optional(),
}).strict().refine((line) => line.first <= line.last, {
  message: "VTY line range must start at or before it ends",
});
export type VtyLineConfig = z.infer<typeof VtyLineConfigSchema>;

/**
 * Simulated SSH server settings. `hostKeyFingerprint` is a deterministic,
 * SSID-free identity string derived from stable device identity — it is *not* a
 * private key and no real RSA/ECDSA material is ever generated or stored.
 */
export const SshServerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  version: z.literal(2).default(2),
  domainName: z.string().min(1).max(128).optional(),
  /** Present once `crypto key generate rsa` has run. */
  hostKeyFingerprint: z.string().min(1).max(128).optional(),
  /** Educational modulus size; recorded for `show ip ssh` only. */
  modulusBits: z.number().int().min(360).max(4_096).optional(),
}).strict();
export type SshServerConfig = z.infer<typeof SshServerConfigSchema>;

export const RemoteAccessConfigurationSchema = z.object({
  /**
   * Device-level Telnet master switch. `transport input` on a VTY line is the
   * primary control; this exists so a security lab can disable Telnet outright
   * without editing every line.
   */
  telnetEnabled: z.boolean().default(true),
  ssh: SshServerConfigSchema.default({}),
  vtyLines: z
    .array(VtyLineConfigSchema)
    .max(MANAGEMENT_LIMITS.maximumVtyLineIndex + 1)
    .default([]),
}).strict();
export type RemoteAccessConfiguration = z.infer<typeof RemoteAccessConfigurationSchema>;

/**
 * The L2 switch management interface. It terminates management traffic for this
 * switch only: it never enables IP routing and never forwards transit packets.
 */
export const ManagementSviConfigSchema = z.object({
  vlanId: VlanIdSchema,
  ipAddress: Ipv4Schema.optional(),
  prefixLength: PrefixLengthSchema.optional(),
  adminUp: z.boolean().default(true),
  description: z.string().min(1).max(240).optional(),
}).strict();
export type ManagementSviConfig = z.infer<typeof ManagementSviConfigSchema>;

export const DEFAULT_REMOTE_ACCESS_CONFIGURATION: RemoteAccessConfiguration = Object.freeze({
  telnetEnabled: true,
  ssh: Object.freeze({ enabled: false, version: 2 as const }),
  vtyLines: [] as VtyLineConfig[],
});

/** Educational warning shown whenever a Telnet session opens. */
export const TELNET_PLAINTEXT_WARNING =
  "Warning: Telnet transmits credentials without encryption.";

/** Shown once per unknown SSH host key, before the login prompt. */
export function sshHostKeyPrompt(host: string, fingerprint: string): string {
  return [
    `The authenticity of host '${host}' cannot be established.`,
    `Fingerprint: ${fingerprint}`,
    "Continue connecting (yes/no)?",
  ].join("\n");
}

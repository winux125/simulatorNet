import { z } from "zod";

/**
 * Simulated device-console authentication. This is an *educational* login for a
 * simulated device — NOT SimulatorNet account/platform auth (Keycloak/session),
 * NOT an SSH security boundary, and NOT tied to any organization role. New
 * passwords are never stored in the clear: only a PBKDF2-SHA-256 verifier is
 * kept. Authentication state never affects packet determinism or grading.
 */

/** Cross-runtime password verifier (Web Crypto in browser + Node). */
export const PasswordVerifierSchema = z.object({
  algorithm: z.literal("pbkdf2-sha256"),
  iterations: z.number().int().min(1).max(1_000_000),
  saltBase64: z.string().min(4).max(256),
  hashBase64: z.string().min(4).max(256),
}).strict();
export type PasswordVerifier = z.infer<typeof PasswordVerifierSchema>;

export const ConsoleAuthenticationModeSchema = z.enum(["none", "press-return", "password-only", "local-user"]);
export type ConsoleAuthenticationMode = z.infer<typeof ConsoleAuthenticationModeSchema>;

export const MAX_CONSOLE_USERS = 16;

/**
 * An opaque, scope-bound credential fingerprint (see
 * `createManagementCredentialVerifier` in `@sim/console-auth`). It exists so a
 * credential can be compared *synchronously inside the deterministic engine* —
 * remote CLI, AAA and SNMP all need that — without a plaintext secret ever
 * reaching sim-core, a trace, a log or a grading result. It is never a password
 * and is never rendered.
 */
export const ManagementCredentialFingerprintSchema = z.string().min(4).max(256);

export const ConsoleUserConfigurationSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1).max(64),
  passwordVerifier: PasswordVerifierSchema,
  /** Set when this user may also authenticate over the management plane. */
  credentialFingerprint: ManagementCredentialFingerprintSchema.optional(),
  privilegeLevel: z.number().int().min(0).max(15).default(1),
  enabled: z.boolean().default(true),
}).strict();
export type ConsoleUserConfiguration = z.infer<typeof ConsoleUserConfigurationSchema>;

export const ConsoleAccessConfigurationSchema = z.object({
  mode: ConsoleAuthenticationModeSchema.default("none"),
  users: z.array(ConsoleUserConfigurationSchema).max(MAX_CONSOLE_USERS).default([]),
  consolePasswordVerifier: PasswordVerifierSchema.optional(),
  enableSecretVerifier: PasswordVerifierSchema.optional(),
  /** Engine-comparable form of the enable secret, for remote `enable`. */
  enableCredentialFingerprint: ManagementCredentialFingerprintSchema.optional(),
  maximumAttempts: z.number().int().min(1).max(10).default(3),
  loginBanner: z.string().max(1_024).optional(),
  motdBanner: z.string().max(1_024).optional(),
  /** Set when an imported credential could not be verified and must be reset. */
  credentialResetRequired: z.boolean().default(false),
}).strict();
export type ConsoleAccessConfiguration = z.infer<typeof ConsoleAccessConfigurationSchema>;

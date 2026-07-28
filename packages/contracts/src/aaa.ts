import { z } from "zod";
import { ManagementCredentialFingerprintSchema, PasswordVerifierSchema } from "./console";
import { IpAddressSchema } from "./primitives";

/**
 * AAA: one shared authentication, authorization and accounting model.
 *
 * There is deliberately no second local-user implementation. Console, VTY,
 * Telnet, SSH, RADIUS and TACACS+ all resolve through the same method lists and
 * the same device user database, so a lab cannot end up with two different
 * ideas of who `admin` is.
 *
 * RADIUS and TACACS+ here are *educational protocol models*. There is no real
 * RADIUS Authenticator/MD5 construction, no TACACS+ body obfuscation, no EAP
 * and no 802.1X. Shared keys are stored and compared only as opaque,
 * scope-bound fingerprints, exactly like every other management credential.
 */

/** Centralized, finite AAA limits. */
export const AAA_LIMITS = Object.freeze({
  maximumMethodLists: 16,
  maximumMethodsPerList: 4,
  maximumServersPerDevice: 8,
  maximumUsersPerServer: 64,
  maximumClientsPerServer: 32,
  maximumCommandRulesPerServer: 128,
  maximumAccountingEntries: 500,
  maximumAuthenticationRetries: 2,
  maximumServerTimeoutSeconds: 30,
  /** Longest command prefix a TACACS+ authorization rule may match. */
  maximumCommandPatternChars: 120,
});

/** Well-known ports for the simulated AAA protocols. */
export const RADIUS_AUTHENTICATION_PORT = 1812;
export const RADIUS_ACCOUNTING_PORT = 1813;
export const TACACS_PORT = 49;

export const AaaMethodSchema = z.enum(["local", "group radius", "group tacacs+", "none"]);
export type AaaMethod = z.infer<typeof AaaMethodSchema>;

/**
 * A named method list. Methods are tried in order and the **first conclusive**
 * result wins:
 *
 * - accept  -> success, stop;
 * - reject  -> failure, stop (never fall through to the next method);
 * - unavailable / timeout -> try the next method.
 */
export const AaaMethodListSchema = z.object({
  /** `default` or a named list referenced by `login authentication <name>`. */
  name: z.string().min(1).max(64),
  methods: z.array(AaaMethodSchema).min(1).max(AAA_LIMITS.maximumMethodsPerList),
}).strict();
export type AaaMethodList = z.infer<typeof AaaMethodListSchema>;

export const AaaCommandMethodListSchema = AaaMethodListSchema.extend({
  /** Privilege level whose commands this list authorizes (`commands 15`). */
  privilegeLevel: z.number().int().min(0).max(15),
}).strict();
export type AaaCommandMethodList = z.infer<typeof AaaCommandMethodListSchema>;

export const AaaAccountingModeSchema = z.enum(["start-stop", "stop-only", "none"]);
export type AaaAccountingMode = z.infer<typeof AaaAccountingModeSchema>;

export const AaaAccountingListSchema = AaaMethodListSchema.extend({
  mode: AaaAccountingModeSchema.default("start-stop"),
  /** Present for `aaa accounting commands <level>`. */
  privilegeLevel: z.number().int().min(0).max(15).optional(),
}).strict();
export type AaaAccountingList = z.infer<typeof AaaAccountingListSchema>;

export const AaaServerProtocolSchema = z.enum(["radius", "tacacs+"]);
export type AaaServerProtocol = z.infer<typeof AaaServerProtocolSchema>;

/**
 * A AAA server as configured on a network device. The shared key is stored as a
 * scope-bound fingerprint: the plaintext key is never persisted, traced,
 * rendered or graded.
 */
export const AaaServerConfigSchema = z.object({
  /** `radius server RAD1` / `tacacs server TAC1`. */
  name: z.string().min(1).max(64),
  protocol: AaaServerProtocolSchema,
  address: IpAddressSchema,
  authenticationPort: z.number().int().min(1).max(65_535).optional(),
  accountingPort: z.number().int().min(1).max(65_535).optional(),
  sharedKeyFingerprint: ManagementCredentialFingerprintSchema.optional(),
  timeoutSeconds: z.number().int().min(1).max(AAA_LIMITS.maximumServerTimeoutSeconds).default(5),
  retries: z.number().int().min(0).max(AAA_LIMITS.maximumAuthenticationRetries).default(1),
}).strict();
export type AaaServerConfig = z.infer<typeof AaaServerConfigSchema>;

export const AaaConfigurationSchema = z.object({
  /** `aaa new-model`. Without it the device authenticates locally only. */
  enabled: z.boolean().default(false),
  authenticationLogin: z.array(AaaMethodListSchema).max(AAA_LIMITS.maximumMethodLists).default([]),
  authorizationExec: z.array(AaaMethodListSchema).max(AAA_LIMITS.maximumMethodLists).default([]),
  authorizationCommands: z.array(AaaCommandMethodListSchema).max(AAA_LIMITS.maximumMethodLists).default([]),
  accountingExec: z.array(AaaAccountingListSchema).max(AAA_LIMITS.maximumMethodLists).default([]),
  accountingCommands: z.array(AaaAccountingListSchema).max(AAA_LIMITS.maximumMethodLists).default([]),
  servers: z.array(AaaServerConfigSchema).max(AAA_LIMITS.maximumServersPerDevice).default([]),
}).strict();
export type AaaConfiguration = z.infer<typeof AaaConfigurationSchema>;

export const DEFAULT_AAA_CONFIGURATION: AaaConfiguration = Object.freeze({
  enabled: false,
  authenticationLogin: [],
  authorizationExec: [],
  authorizationCommands: [],
  accountingExec: [],
  accountingCommands: [],
  servers: [],
});

// --- Server-side AAA services ------------------------------------------------

export const AaaServerUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1).max(64),
  /** Engine-comparable credential; the plaintext password is never stored. */
  credentialFingerprint: ManagementCredentialFingerprintSchema,
  /** Optional PBKDF2 verifier so an operator UI can re-verify out of band. */
  passwordVerifier: PasswordVerifierSchema.optional(),
  /** Privilege level returned on Access-Accept / TACACS+ authorization. */
  privilegeLevel: z.number().int().min(0).max(15).default(1),
  role: z.string().min(1).max(64).optional(),
  enabled: z.boolean().default(true),
}).strict();
export type AaaServerUser = z.infer<typeof AaaServerUserSchema>;

/** Which network devices may talk to this AAA service, and with which key. */
export const AaaServerClientSchema = z.object({
  id: z.string().min(1),
  address: IpAddressSchema,
  name: z.string().min(1).max(64).optional(),
  sharedKeyFingerprint: ManagementCredentialFingerprintSchema.optional(),
  enabled: z.boolean().default(true),
}).strict();
export type AaaServerClient = z.infer<typeof AaaServerClientSchema>;

/**
 * A bounded, declarative TACACS+ command-authorization rule.
 *
 * Matching is exact, prefix, or prefix plus an explicit trailing `*` wildcard.
 * A LabDocument never supplies a regular expression and no pattern is compiled
 * or executed.
 */
export const AaaCommandRuleSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  /** Omitted means "any authenticated user". */
  username: z.string().min(1).max(64).optional(),
  /** Omitted means "any privilege level". */
  privilegeLevel: z.number().int().min(0).max(15).optional(),
  match: z.enum(["exact", "prefix"]).default("prefix"),
  /** Command text; a single trailing `*` is the only wildcard token. */
  command: z.string().min(1).max(AAA_LIMITS.maximumCommandPatternChars),
  action: z.enum(["permit", "deny"]),
}).strict();
export type AaaCommandRule = z.infer<typeof AaaCommandRuleSchema>;

const AaaServiceBaseShape = {
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  users: z.array(AaaServerUserSchema).max(AAA_LIMITS.maximumUsersPerServer).default([]),
  clients: z.array(AaaServerClientSchema).max(AAA_LIMITS.maximumClientsPerServer).default([]),
  /** Reject requests from a client address that is not configured. */
  restrictToConfiguredClients: z.boolean().default(true),
};

export const RadiusServiceConfigSchema = z.object({
  type: z.literal("radius"),
  ...AaaServiceBaseShape,
  port: z.number().int().min(1).max(65_535).default(RADIUS_AUTHENTICATION_PORT),
  accountingPort: z.number().int().min(1).max(65_535).default(RADIUS_ACCOUNTING_PORT),
}).strict();
export type RadiusServiceConfig = z.infer<typeof RadiusServiceConfigSchema>;

export const TacacsServiceConfigSchema = z.object({
  type: z.literal("tacacs"),
  ...AaaServiceBaseShape,
  port: z.number().int().min(1).max(65_535).default(TACACS_PORT),
  /** Exec authorization: may an authenticated user open a CLI at all. */
  execAuthorizationDefault: z.enum(["permit", "deny"]).default("permit"),
  commandRules: z.array(AaaCommandRuleSchema).max(AAA_LIMITS.maximumCommandRulesPerServer).default([]),
  /** Applied when no rule matches. */
  commandDefault: z.enum(["permit", "deny"]).default("deny"),
}).strict();
export type TacacsServiceConfig = z.infer<typeof TacacsServiceConfigSchema>;

export const AAA_AUTHORIZATION_FAILED = "% Authorization failed.";

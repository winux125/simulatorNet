import { z } from "zod";
import { ManagementCredentialFingerprintSchema } from "./console";
import { IpAddressSchema } from "./primitives";

/**
 * SNMPv2c, as an educational subset.
 *
 * Not implemented, deliberately: SNMPv1, SNMPv3, USM, VACM, real BER/ASN.1
 * encoding, dynamic MIB loading, arbitrary OID scripting, SET, and any access
 * to a real device. Messages are structured data over the simulated UDP stack,
 * and the MIB is a fixed, built-in tree that reports only state the engine
 * actually models — no invented CPU or memory figures.
 *
 * A community string is a shared secret and is stored, compared and reported
 * exactly like every other management credential: as an opaque, scope-bound
 * fingerprint that is never rendered.
 */

export const SNMP_LIMITS = Object.freeze({
  maximumCommunitiesPerAgent: 8,
  maximumTrapDestinationsPerAgent: 8,
  maximumManagersPerAgent: 8,
  maximumOidsPerRequest: 16,
  /** Longest GETNEXT chain one WALK may follow. */
  maximumWalkLength: 256,
  /** Traps a single operation may emit before further ones are suppressed. */
  maximumTrapsPerOperation: 16,
  maximumStoredTraps: 200,
  maximumPollingTargets: 16,
  maximumOidLength: 128,
});

/** UDP ports for the simulated SNMP agent and trap receiver. */
export const SNMP_AGENT_PORT = 161;
export const SNMP_TRAP_PORT = 162;

/**
 * SimulatorNet's own enterprise subtree. It is an *educational* MIB: the
 * numbers below are internal to this simulator and are not registered with
 * IANA, so nothing here should be pointed at real equipment.
 */
export const SIMULATORNET_ENTERPRISE_OID = "1.3.6.1.4.1.53535";
export const SIMULATORNET_MIB_OID = `${SIMULATORNET_ENTERPRISE_OID}.1`;

export const SnmpAccessSchema = z.enum(["read-only"]);
export type SnmpAccess = z.infer<typeof SnmpAccessSchema>;

export const SnmpCommunityConfigSchema = z.object({
  id: z.string().min(1),
  /** Opaque fingerprint; the community string itself is never persisted. */
  fingerprint: ManagementCredentialFingerprintSchema,
  /** Read-write and SET are out of scope for this milestone. */
  access: SnmpAccessSchema.default("read-only"),
  /** Optional source restriction: only this manager may use the community. */
  managerAddress: IpAddressSchema.optional(),
  enabled: z.boolean().default(true),
}).strict();
export type SnmpCommunityConfig = z.infer<typeof SnmpCommunityConfigSchema>;

export const SNMP_TRAP_TYPES = [
  "coldStart",
  "warmStart",
  "linkUp",
  "linkDown",
  "authenticationFailure",
  "stpRootChange",
  "ospfNeighborDown",
  "wirelessClientAssociated",
  "wirelessClientDisassociated",
] as const;
export const SnmpTrapTypeSchema = z.enum(SNMP_TRAP_TYPES);
export type SnmpTrapType = z.infer<typeof SnmpTrapTypeSchema>;

export const SnmpTrapDestinationConfigSchema = z.object({
  id: z.string().min(1),
  address: IpAddressSchema,
  port: z.number().int().min(1).max(65_535).default(SNMP_TRAP_PORT),
  version: z.literal("2c").default("2c"),
  /** Community used when sending; stored as a fingerprint only. */
  communityFingerprint: ManagementCredentialFingerprintSchema.optional(),
  enabled: z.boolean().default(true),
}).strict();
export type SnmpTrapDestinationConfig = z.infer<typeof SnmpTrapDestinationConfigSchema>;

export const SnmpAgentConfigurationSchema = z.object({
  enabled: z.boolean().default(false),
  communities: z.array(SnmpCommunityConfigSchema).max(SNMP_LIMITS.maximumCommunitiesPerAgent).default([]),
  location: z.string().max(255).optional(),
  contact: z.string().max(255).optional(),
  /** `snmp-server enable traps`. */
  trapsEnabled: z.boolean().default(false),
  trapDestinations: z
    .array(SnmpTrapDestinationConfigSchema)
    .max(SNMP_LIMITS.maximumTrapDestinationsPerAgent)
    .default([]),
  /** Trap types this agent may emit; empty means every supported type. */
  enabledTrapTypes: z.array(SnmpTrapTypeSchema).max(SNMP_TRAP_TYPES.length).default([]),
}).strict();
export type SnmpAgentConfiguration = z.infer<typeof SnmpAgentConfigurationSchema>;

export const DEFAULT_SNMP_AGENT_CONFIGURATION: SnmpAgentConfiguration = Object.freeze({
  enabled: false,
  communities: [],
  trapsEnabled: false,
  trapDestinations: [],
  enabledTrapTypes: [],
});

/** A device the NMS polls, plus the community profile it uses. */
export const NmsTargetConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  address: IpAddressSchema,
  port: z.number().int().min(1).max(65_535).default(SNMP_AGENT_PORT),
  version: z.literal("2c").default("2c"),
  communityFingerprint: ManagementCredentialFingerprintSchema.optional(),
  enabled: z.boolean().default(true),
}).strict();
export type NmsTargetConfig = z.infer<typeof NmsTargetConfigSchema>;

/** The Server "Network Management" service: an NMS plus a trap receiver. */
export const NetworkManagementServiceConfigSchema = z.object({
  type: z.literal("network-management"),
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  /** UDP port the trap receiver listens on. */
  port: z.number().int().min(1).max(65_535).default(SNMP_TRAP_PORT),
  targets: z.array(NmsTargetConfigSchema).max(SNMP_LIMITS.maximumPollingTargets).default([]),
  /** Accept traps only from a configured target address. */
  restrictTrapsToTargets: z.boolean().default(false),
}).strict();
export type NetworkManagementServiceConfig = z.infer<typeof NetworkManagementServiceConfigSchema>;

/** Message shown after a community is saved; the value itself is never echoed. */
export const SNMP_COMMUNITY_CONFIGURED_MESSAGE = "Community configured";

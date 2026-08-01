import { z } from "zod";
import { PasswordVerifierSchema } from "./console";
import {
  Ipv4InterfaceConfigSchema,
  Ipv4Schema,
  Ipv6InterfaceAddressSchema,
} from "./primitives";

/**
 * Serializable site-to-site VPN configuration: logical GRE tunnel interfaces,
 * IKEv2 peers, proposals, IPsec profiles and the tunnel→profile binding.
 *
 * **Only configuration lives here.** IKE state, security associations, SPIs,
 * sequence numbers, replay windows, packet/byte counters, rekey timers and peer
 * reachability are runtime and never reach a `LabDocument`, a submission, a
 * grading result or the database.
 *
 * SimulatorNet models deterministic educational GRE and site-to-site IPsec
 * behaviour. Its simulated ESP/IKE implementation does not provide real
 * cryptographic protection — the `sim-` algorithm names make that explicit.
 * Lifetimes are whole seconds because that is what a learner types; the engine
 * converts them to virtual nanoseconds when the lab is built.
 */

export const MAXIMUM_TUNNELS_PER_DEVICE = 16;
export const MAXIMUM_IKE_PEERS_PER_DEVICE = 16;
export const MAXIMUM_IPSEC_PROPOSALS_PER_DEVICE = 8;
export const MAXIMUM_IPSEC_PROFILES_PER_DEVICE = 16;

export const MINIMUM_TUNNEL_MTU = 576;
export const MAXIMUM_TUNNEL_MTU = 9_000;
export const DEFAULT_TUNNEL_MTU_VALUE = 1_476;
export const DEFAULT_TUNNEL_TTL_VALUE = 255;

export const MINIMUM_VPN_LIFETIME_SECONDS = 60;
export const MAXIMUM_VPN_LIFETIME_SECONDS = 86_400;
export const DEFAULT_VPN_LIFETIME_SECONDS = 3_600;

/** Where a tunnel's outer (underlay) source address comes from. */
export const TunnelSourceConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interface"), interfaceId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal("address"), address: Ipv4Schema }).strict(),
]);
export type TunnelSourceConfig = z.infer<typeof TunnelSourceConfigSchema>;

/**
 * `interface Tunnel<id>`: a logical interface with no cable and no cable
 * handle. It never appears in the connection modal and never becomes a
 * `topology.links` entry — a VPN overlay is derived presentation, not a link.
 */
export const TunnelInterfaceConfigSchema = z.object({
  id: z.number().int().min(0).max(2_147_483_647),
  description: z.string().min(1).max(255).optional(),
  shutdown: z.boolean().default(false),
  source: TunnelSourceConfigSchema,
  destinationAddress: Ipv4Schema,
  /** Only GRE over an IPv4 underlay is modelled; mGRE and NHRP are not. */
  mode: z.literal("gre-ipv4").default("gre-ipv4"),
  ipv4: Ipv4InterfaceConfigSchema.optional(),
  ipv6: z.array(Ipv6InterfaceAddressSchema).max(16).optional(),
  mtu: z.number().int().min(MINIMUM_TUNNEL_MTU).max(MAXIMUM_TUNNEL_MTU).default(DEFAULT_TUNNEL_MTU_VALUE),
  ttl: z.number().int().min(1).max(255).default(DEFAULT_TUNNEL_TTL_VALUE),
  /** `tunnel protection ipsec profile <id>`; absent means plain GRE. */
  ipsecProfileId: z.string().min(1).max(64).optional(),
}).strict();
export type TunnelInterfaceConfig = z.infer<typeof TunnelInterfaceConfigSchema>;

/**
 * A simulated transform set. The `sim-` prefix is deliberate: these names do
 * not identify real cryptographic algorithms and nothing here encrypts.
 */
export const SimulatedEncryptionSchema = z.enum(["sim-aes128", "sim-aes256"]);
export const SimulatedIntegritySchema = z.literal("sim-sha256");

export const Ikev2ProposalConfigSchema = z.object({
  id: z.string().min(1).max(64),
  encryption: SimulatedEncryptionSchema,
  integrity: SimulatedIntegritySchema,
}).strict();
export type Ikev2ProposalConfig = z.infer<typeof Ikev2ProposalConfigSchema>;

/**
 * An IKEv2 peer. Only an opaque, scope-bound pre-shared-key *verifier* is ever
 * stored — never a plaintext key, and never a vendor password hash.
 */
export const Ikev2PeerConfigSchema = z.object({
  id: z.string().min(1).max(64),
  address: Ipv4Schema,
  localIdentity: z.string().min(1).max(64).optional(),
  remoteIdentity: z.string().min(1).max(64).optional(),
  preSharedKeyVerifier: PasswordVerifierSchema.optional(),
  proposalId: z.string().min(1).max(64),
  lifetimeSeconds: z.number().int()
    .min(MINIMUM_VPN_LIFETIME_SECONDS)
    .max(MAXIMUM_VPN_LIFETIME_SECONDS)
    .default(DEFAULT_VPN_LIFETIME_SECONDS),
  /** Set when an imported peer's key could not be carried over and must be reset. */
  credentialResetRequired: z.boolean().default(false),
}).strict();
export type Ikev2PeerConfig = z.infer<typeof Ikev2PeerConfigSchema>;

export const IpsecProfileConfigSchema = z.object({
  id: z.string().min(1).max(64),
  ikePeerId: z.string().min(1).max(64),
  proposalId: z.string().min(1).max(64),
  lifetimeSeconds: z.number().int()
    .min(MINIMUM_VPN_LIFETIME_SECONDS)
    .max(MAXIMUM_VPN_LIFETIME_SECONDS)
    .default(DEFAULT_VPN_LIFETIME_SECONDS),
}).strict();
export type IpsecProfileConfig = z.infer<typeof IpsecProfileConfigSchema>;

export const VpnConfigurationSchema = z.object({
  tunnels: z.array(TunnelInterfaceConfigSchema).max(MAXIMUM_TUNNELS_PER_DEVICE).default([]),
  proposals: z.array(Ikev2ProposalConfigSchema).max(MAXIMUM_IPSEC_PROPOSALS_PER_DEVICE).default([]),
  ikePeers: z.array(Ikev2PeerConfigSchema).max(MAXIMUM_IKE_PEERS_PER_DEVICE).default([]),
  ipsecProfiles: z.array(IpsecProfileConfigSchema).max(MAXIMUM_IPSEC_PROFILES_PER_DEVICE).default([]),
}).strict();
export type VpnConfiguration = z.infer<typeof VpnConfigurationSchema>;

export const DEFAULT_VPN_CONFIGURATION: VpnConfiguration = Object.freeze({
  tunnels: [],
  proposals: [],
  ikePeers: [],
  ipsecProfiles: [],
});

/** True when nothing is configured, so an untouched lab round-trips unchanged. */
export function isDefaultVpnConfiguration(configuration: VpnConfiguration | undefined): boolean {
  if (!configuration) return true;
  return configuration.tunnels.length === 0
    && configuration.proposals.length === 0
    && configuration.ikePeers.length === 0
    && configuration.ipsecProfiles.length === 0;
}

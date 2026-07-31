/**
 * A **simulated** IKEv2-like negotiation message.
 *
 * This is an educational state-machine model, not an implementation: there is
 * no real IKE packet encoding, no Diffie-Hellman exchange, no certificate
 * handling and no encryption of the exchange itself. What it models is the
 * observable shape of a negotiation — offer a proposal, prove a pre-shared key,
 * agree on child SAs, rekey before the lifetime expires — carried over ordinary
 * simulated UDP so an ACL or a firewall can block it exactly like real IKE.
 *
 * The only credential that ever crosses the simulated wire is an opaque,
 * scope-bound fingerprint (see `createVpnPreSharedKeyVerifier`). A plaintext
 * pre-shared key never reaches this structure, a trace, a log or a result.
 */
export type IkeExchange =
  | "sa-init"
  | "sa-init-response"
  | "auth"
  | "auth-response"
  | "rekey"
  | "rekey-response"
  | "delete";

export type IkeFailureReason =
  | "proposal-mismatch"
  | "authentication-failed"
  | "identity-mismatch"
  | "peer-unreachable"
  | "no-pre-shared-key"
  | "lifetime-expired"
  | "rekey-failed"
  | "profile-removed";

export interface IkeProposalOffer {
  readonly encryption: string;
  readonly integrity: string;
}

export interface IkeMessage {
  readonly kind: "ike";
  readonly exchange: IkeExchange;
  readonly initiatorSpi: number;
  readonly responderSpi: number;
  /** The offer an initiator makes, or the selection a responder confirms. */
  readonly proposal?: IkeProposalOffer;
  readonly identity?: string;
  /**
   * Opaque, scope-bound pre-shared-key fingerprint. It is compared and then
   * discarded: it is never traced, rendered, logged or graded.
   */
  readonly authFingerprint?: string;
  readonly accepted?: boolean;
  readonly reason?: IkeFailureReason;
  /** Child-SA generation, so a rekey installs a distinct, deterministic SPI pair. */
  readonly generation?: number;
  /** Deterministic child SPIs for this generation, in each direction. */
  readonly childSpiInitiatorToResponder?: number;
  readonly childSpiResponderToInitiator?: number;
}

/** The well-known IKE UDP port. NAT traversal (UDP 4500) is not modelled. */
export const IKE_PORT = 500;

export function isIkeMessage(payload: { kind: string }): payload is IkeMessage {
  return payload.kind === "ike";
}

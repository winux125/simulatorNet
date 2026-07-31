import type { PasswordVerifier } from "@sim/contracts";
import type { GrePacket } from "../packets/gre";
import type {
  IkeFailureReason,
  IkeMessage,
  IkeProposalOffer,
} from "../packets/ike";
import type { SimulatedEspPacket } from "../packets/esp";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import { DEFAULT_VPN_LIMITS, VpnConfigurationError } from "./limits";

/**
 * SimulatorNet models deterministic educational IKEv2 and IPsec behaviour. Its
 * simulated ESP/IKE implementation does not provide real cryptographic
 * protection: there is no encryption, no key exchange, no certificate handling
 * and no message authentication code. The `sim-` algorithm names below exist to
 * make that impossible to mistake.
 */
export const SIMULATED_ENCRYPTION_ALGORITHMS = ["sim-aes128", "sim-aes256"] as const;
export type SimulatedEncryption = (typeof SIMULATED_ENCRYPTION_ALGORITHMS)[number];

export const SIMULATED_INTEGRITY_ALGORITHMS = ["sim-sha256"] as const;
export type SimulatedIntegrity = (typeof SIMULATED_INTEGRITY_ALGORITHMS)[number];

export interface IkePeerConfiguration {
  readonly id: string;
  readonly remoteAddress: Ipv4;
  readonly localIdentity?: string;
  readonly remoteIdentity?: string;
  /** Opaque scope-bound verifier. A plaintext key never reaches sim-core. */
  readonly preSharedKeyVerifier?: PasswordVerifier;
  readonly proposalId: string;
  readonly lifetimeNs: number;
}

export interface IpsecProposalConfiguration {
  readonly id: string;
  readonly encryption: SimulatedEncryption;
  readonly integrity: SimulatedIntegrity;
}

export interface IpsecProfileConfiguration {
  readonly id: string;
  readonly ikePeerId: string;
  readonly proposalId: string;
  readonly lifetimeNs: number;
}

export type IkeState =
  | "DOWN"
  | "INITIATING"
  | "NEGOTIATING"
  | "ESTABLISHED"
  | "REKEYING"
  | "FAILED"
  | "EXPIRED";

export type SecurityAssociationState = "active" | "rekeying" | "expired";

/**
 * Runtime security association. It is deliberately *not* serializable state:
 * SPIs, sequence numbers, counters and lifetimes are rebuilt by negotiation
 * every time a lab is built, in the browser worker and the verifier alike.
 */
export interface IpsecSecurityAssociation {
  readonly id: string;
  readonly direction: "inbound" | "outbound";
  readonly peerAddress: Ipv4;
  readonly spi: number;
  readonly proposalId: string;
  sequenceNumber: number;
  readonly createdAtNs: number;
  expiresAtNs: number;
  packetCount: number;
  byteCount: number;
  state: SecurityAssociationState;
  /** Child-SA generation; a rekey installs the next one. */
  readonly generation: number;
  /** Highest accepted inbound sequence number, for the bounded replay window. */
  highestSequence: number;
  /** Recently accepted sequence numbers inside the window. */
  readonly seen: Set<number>;
}

export interface IkeSessionSummary {
  readonly peerId: string;
  readonly localAddress: Ipv4 | undefined;
  readonly remoteAddress: Ipv4;
  readonly state: IkeState;
  readonly role: "initiator" | "responder" | undefined;
  readonly proposalId: string;
  readonly localSpi: number;
  readonly remoteSpi: number;
  readonly generation: number;
  readonly establishedAtNs: number | undefined;
  readonly expiresAtNs: number | undefined;
  readonly failureReason: IkeFailureReason | undefined;
  readonly tunnelId: string | undefined;
}

export type EspRejection = "invalid-spi" | "replay" | "integrity-mismatch";

interface IkeSession {
  peerId: string;
  state: IkeState;
  role: "initiator" | "responder" | undefined;
  localSpi: number;
  remoteSpi: number;
  generation: number;
  establishedAtNs: number | undefined;
  expiresAtNs: number | undefined;
  failureReason: IkeFailureReason | undefined;
  /** Virtual time at which this generation should be rekeyed. */
  rekeyAtNs: number | undefined;
}

/**
 * Deterministic FNV-1a over the parts that identify one security association.
 * Both peers derive the same number from the same tuple, which is what lets an
 * outbound SA on one router match the inbound SA on the other without ever
 * exchanging a key.
 */
export function deriveSpi(source: Ipv4, destination: Ipv4, generation: number, scope: string): number {
  let hash = 2_166_136_261;
  for (const character of `${scope}|${source}|${destination}|${generation}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  }
  // Keep it inside the reserved-SPI-free range so a lab never shows 0-255.
  return (hash % 0xfffff000) + 256;
}

/**
 * A deterministic logical fingerprint of a protected payload. It proves nothing
 * cryptographically; it exists so a lab can observe that protection was applied
 * and that both ends agree on what was protected.
 */
export function deriveIntegrityTag(
  spi: number,
  sequenceNumber: number,
  proposalId: string,
  payload: GrePacket,
): string {
  const inner = payload.innerPacket;
  let hash = 2_166_136_261;
  const material = [
    spi,
    sequenceNumber,
    proposalId,
    payload.tunnelId,
    payload.protocol,
    inner.src,
    inner.dst,
  ].join("|");
  for (const character of material) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return `sim-${hash.toString(16).padStart(8, "0")}`;
}

/** Everything the engine needs from its host device, injected explicitly. */
export interface IpsecRuntimeHooks {
  nowNs(): number;
  scheduleIn(delayNs: number, run: () => void): void;
  trace(type: string, detail: Record<string, unknown>): void;
  /** Resolved outer source address of the tunnel bound to `profileId`. */
  localAddressFor(peerId: string): Ipv4 | undefined;
  /** Send one IKE message over the ordinary underlay path (UDP 500). */
  sendIke(localAddress: Ipv4, remoteAddress: Ipv4, message: IkeMessage): void;
  /** True when the underlay currently has a route to the peer. */
  peerReachable(remoteAddress: Ipv4): boolean;
  /** Tunnel that binds this peer through an IPsec profile, if any. */
  tunnelForPeer(peerId: string): string | undefined;
}

/**
 * Owns IKEv2-like negotiation and the resulting IPsec security associations for
 * one device. Configuration is persistent; every SA, SPI, sequence number,
 * counter and timer here is runtime and is never serialized.
 */
export class IpsecEngine {
  private readonly peers = new Map<string, IkePeerConfiguration>();
  private readonly proposals = new Map<string, IpsecProposalConfiguration>();
  private readonly profiles = new Map<string, IpsecProfileConfiguration>();
  private readonly sessions = new Map<string, IkeSession>();
  private readonly associations = new Map<string, IpsecSecurityAssociation>();
  private hooks: IpsecRuntimeHooks | undefined;
  private armed = false;

  useHooks(hooks: IpsecRuntimeHooks): void {
    this.hooks = hooks;
  }

  // --- configuration -------------------------------------------------------

  defineProposal(proposal: IpsecProposalConfiguration): void {
    requireId(proposal.id, "IKEv2 proposal name");
    if (!SIMULATED_ENCRYPTION_ALGORITHMS.includes(proposal.encryption)) {
      throw new VpnConfigurationError(
        "VPN_INVALID_CONFIGURATION",
        `Unsupported encryption '${proposal.encryption}'; use ${SIMULATED_ENCRYPTION_ALGORITHMS.join(" or ")}.`,
      );
    }
    if (!SIMULATED_INTEGRITY_ALGORITHMS.includes(proposal.integrity)) {
      throw new VpnConfigurationError(
        "VPN_INVALID_CONFIGURATION",
        `Unsupported integrity '${proposal.integrity}'; use ${SIMULATED_INTEGRITY_ALGORITHMS.join(" or ")}.`,
      );
    }
    if (!this.proposals.has(proposal.id) && this.proposals.size >= DEFAULT_VPN_LIMITS.maximumProposalsPerDevice) {
      throw new VpnConfigurationError(
        "VPN_PROPOSAL_LIMIT",
        `IKEv2 proposal limit exceeded (${DEFAULT_VPN_LIMITS.maximumProposalsPerDevice}).`,
      );
    }
    this.proposals.set(proposal.id, { ...proposal });
    this.arm();
  }

  removeProposal(id: string): void {
    this.proposals.delete(id);
  }

  proposalConfigurations(): IpsecProposalConfiguration[] {
    return [...this.proposals.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ ...entry }));
  }

  definePeer(peer: IkePeerConfiguration): void {
    requireId(peer.id, "IKEv2 peer name");
    requireIpv4(peer.remoteAddress, "IKEv2 peer address");
    requireLifetime(peer.lifetimeNs, "IKEv2 peer lifetime");
    if (!this.peers.has(peer.id) && this.peers.size >= DEFAULT_VPN_LIMITS.maximumIkePeersPerDevice) {
      throw new VpnConfigurationError(
        "VPN_PEER_LIMIT",
        `IKEv2 peer limit exceeded (${DEFAULT_VPN_LIMITS.maximumIkePeersPerDevice}).`,
      );
    }
    this.peers.set(peer.id, { ...peer });
    // A changed peer invalidates whatever it had negotiated.
    this.resetPeer(peer.id, "profile-removed", { silent: true });
    this.arm();
  }

  /** Merge one field into an existing peer, or create it from safe defaults. */
  updatePeer(id: string, patch: Partial<Omit<IkePeerConfiguration, "id">>): IkePeerConfiguration {
    const existing = this.peers.get(id) ?? {
      id,
      remoteAddress: "0.0.0.0",
      proposalId: "",
      lifetimeNs: DEFAULT_IKE_LIFETIME_NS,
    };
    const next = { ...existing, ...patch, id };
    this.definePeer(next);
    return next;
  }

  removePeer(id: string): void {
    this.peers.delete(id);
    this.resetPeer(id, "profile-removed", { silent: true });
    this.sessions.delete(id);
  }

  peerConfigurations(): IkePeerConfiguration[] {
    return [...this.peers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ ...entry }));
  }

  peer(id: string): IkePeerConfiguration | undefined {
    return this.peers.get(id);
  }

  defineProfile(profile: IpsecProfileConfiguration): void {
    requireId(profile.id, "IPsec profile name");
    requireLifetime(profile.lifetimeNs, "IPsec profile lifetime");
    if (!this.profiles.has(profile.id) && this.profiles.size >= DEFAULT_VPN_LIMITS.maximumIpsecProfilesPerDevice) {
      throw new VpnConfigurationError(
        "VPN_PROFILE_LIMIT",
        `IPsec profile limit exceeded (${DEFAULT_VPN_LIMITS.maximumIpsecProfilesPerDevice}).`,
      );
    }
    this.profiles.set(profile.id, { ...profile });
    this.arm();
  }

  updateProfile(id: string, patch: Partial<Omit<IpsecProfileConfiguration, "id">>): IpsecProfileConfiguration {
    const existing = this.profiles.get(id)
      ?? { id, ikePeerId: "", proposalId: "", lifetimeNs: DEFAULT_IPSEC_LIFETIME_NS };
    const next = { ...existing, ...patch, id };
    this.defineProfile(next);
    return next;
  }

  removeProfile(id: string): void {
    const profile = this.profiles.get(id);
    this.profiles.delete(id);
    if (profile) this.resetPeer(profile.ikePeerId, "profile-removed");
  }

  profileConfigurations(): IpsecProfileConfiguration[] {
    return [...this.profiles.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ ...entry }));
  }

  profile(id: string): IpsecProfileConfiguration | undefined {
    return this.profiles.get(id);
  }

  /** True when a profile names an existing peer and an existing proposal. */
  profileResolvable(profileId: string): boolean {
    const profile = this.profiles.get(profileId);
    if (!profile) return false;
    const peer = this.peers.get(profile.ikePeerId);
    return peer !== undefined && this.proposals.has(profile.proposalId);
  }

  // --- runtime inspection --------------------------------------------------

  sessionSummaries(): IkeSessionSummary[] {
    this.checkLifetimes();
    return [...this.peers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((peer) => {
        const session = this.sessions.get(peer.id);
        return {
          peerId: peer.id,
          localAddress: this.hooks?.localAddressFor(peer.id),
          remoteAddress: peer.remoteAddress,
          state: session?.state ?? "DOWN",
          role: session?.role,
          proposalId: peer.proposalId,
          localSpi: session?.localSpi ?? 0,
          remoteSpi: session?.remoteSpi ?? 0,
          generation: session?.generation ?? 0,
          establishedAtNs: session?.establishedAtNs,
          expiresAtNs: session?.expiresAtNs,
          failureReason: session?.failureReason,
          tunnelId: this.hooks?.tunnelForPeer(peer.id),
        };
      });
  }

  securityAssociations(): IpsecSecurityAssociation[] {
    this.checkLifetimes();
    return [...this.associations.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ ...entry, seen: new Set(entry.seen) }));
  }

  /** The newest usable outbound SA for a peer, or undefined when unprotected. */
  outboundAssociation(peerId: string): IpsecSecurityAssociation | undefined {
    this.checkLifetimes();
    let best: IpsecSecurityAssociation | undefined;
    for (const association of this.associations.values()) {
      if (association.direction !== "outbound" || association.state !== "active") continue;
      if (this.peerOf(association) !== peerId) continue;
      if (!best || association.generation > best.generation) best = association;
    }
    return best;
  }

  hasActiveProtection(peerId: string): boolean {
    return this.outboundAssociation(peerId) !== undefined;
  }

  /** Drop every negotiated SA and session; configuration is untouched. */
  resetRuntime(): void {
    this.associations.clear();
    this.sessions.clear();
    this.armed = false;
  }

  /** `clear crypto ikev2 sa` / `clear crypto ipsec sa` for one peer, or all. */
  clearPeer(peerId?: string): void {
    for (const peer of this.peers.values()) {
      if (peerId !== undefined && peer.id !== peerId) continue;
      this.resetPeer(peer.id, undefined, { silent: true });
      this.sessions.delete(peer.id);
    }
    this.arm();
  }

  // --- negotiation ---------------------------------------------------------

  /**
   * Schedule one bounded negotiation pass. Arming is idempotent, so an
   * interface flap or a configuration change can never queue unbounded work.
   */
  arm(): void {
    const hooks = this.hooks;
    if (!hooks || this.armed) return;
    this.armed = true;
    hooks.scheduleIn(DEFAULT_VPN_LIMITS.negotiationStartDelayNs, () => {
      this.armed = false;
      this.startPending();
    });
  }

  /** Begin negotiation for every protected tunnel that has no usable SA yet. */
  private startPending(): void {
    const hooks = this.hooks;
    if (!hooks) return;
    this.checkLifetimes();
    for (const profile of this.profileConfigurations()) {
      const peer = this.peers.get(profile.ikePeerId);
      if (!peer) continue;
      if (hooks.tunnelForPeer(peer.id) === undefined) continue;
      const session = this.sessions.get(peer.id);
      if (session && session.state !== "DOWN" && session.state !== "EXPIRED") continue;
      this.beginNegotiation(peer);
    }
  }

  private beginNegotiation(peer: IkePeerConfiguration): void {
    const hooks = this.hooks!;
    const localAddress = hooks.localAddressFor(peer.id);
    if (localAddress === undefined) return;
    const proposal = this.proposals.get(peer.proposalId);
    const session = this.sessionFor(peer.id);
    session.role = "initiator";
    session.state = "INITIATING";
    session.failureReason = undefined;
    session.generation = 1;
    session.localSpi = deriveSpi(localAddress, peer.remoteAddress, session.generation, "ike-initiator");
    hooks.trace("ike-negotiation-started", {
      peer: peer.id,
      local: localAddress,
      remote: peer.remoteAddress,
      proposal: peer.proposalId,
      role: "initiator",
    });
    if (!proposal) {
      this.failSession(session, "proposal-mismatch", peer, localAddress);
      return;
    }
    if (!peer.preSharedKeyVerifier) {
      this.failSession(session, "no-pre-shared-key", peer, localAddress);
      return;
    }
    if (!hooks.peerReachable(peer.remoteAddress)) {
      hooks.trace("ike-peer-unreachable", { peer: peer.id, remote: peer.remoteAddress });
      this.failSession(session, "peer-unreachable", peer, localAddress);
      return;
    }
    hooks.sendIke(localAddress, peer.remoteAddress, {
      kind: "ike",
      exchange: "sa-init",
      initiatorSpi: session.localSpi,
      responderSpi: 0,
      proposal: { encryption: proposal.encryption, integrity: proposal.integrity },
      generation: session.generation,
    });
    // If nothing answers before the lifetime, the attempt fails deterministically.
    this.scheduleNegotiationTimeout(peer.id, session.generation);
  }

  private scheduleNegotiationTimeout(peerId: string, generation: number): void {
    const hooks = this.hooks!;
    hooks.scheduleIn(DEFAULT_VPN_LIMITS.negotiationTimeoutNs, () => {
      const session = this.sessions.get(peerId);
      const peer = this.peers.get(peerId);
      if (!session || !peer || session.generation !== generation) return;
      // A session that got as far as ESTABLISHED (or already failed) ignores it.
      if (session.state !== "INITIATING" && session.state !== "NEGOTIATING") return;
      this.failSession(session, "peer-unreachable", peer, hooks.localAddressFor(peerId));
    });
  }

  /**
   * Handle one received IKE message. `localAddress` is the address it arrived
   * on, which is also the address any reply is sourced from.
   */
  onIkeMessage(message: IkeMessage, remoteAddress: Ipv4, localAddress: Ipv4): void {
    const hooks = this.hooks;
    if (!hooks) return;
    const peer = [...this.peers.values()].find((entry) => entry.remoteAddress === remoteAddress);
    if (!peer) return;
    const profile = this.profileConfigurations().find((entry) => entry.ikePeerId === peer.id);
    if (!profile) return;
    switch (message.exchange) {
      case "sa-init":
        this.onSaInit(message, peer, localAddress);
        return;
      case "sa-init-response":
        this.onSaInitResponse(message, peer, localAddress);
        return;
      case "auth":
        this.onAuth(message, peer, profile, localAddress);
        return;
      case "auth-response":
        this.onAuthResponse(message, peer, profile, localAddress);
        return;
      case "rekey":
        this.onRekey(message, peer, profile, localAddress);
        return;
      case "rekey-response":
        this.onRekeyResponse(message, peer, profile, localAddress);
        return;
      case "delete":
        this.resetPeer(peer.id, undefined);
        this.arm();
        return;
    }
  }

  private onSaInit(
    message: IkeMessage,
    peer: IkePeerConfiguration,
    localAddress: Ipv4,
  ): void {
    const hooks = this.hooks!;
    const session = this.sessionFor(peer.id);
    // Simultaneous initiation: the numerically higher address yields and
    // becomes the responder, so exactly one negotiation survives.
    if (session.state === "INITIATING" && ipToInt(localAddress) < ipToInt(peer.remoteAddress)) return;
    session.role = "responder";
    session.state = "NEGOTIATING";
    session.failureReason = undefined;
    session.generation = message.generation ?? 1;
    session.remoteSpi = message.initiatorSpi;
    session.localSpi = deriveSpi(localAddress, peer.remoteAddress, session.generation, "ike-responder");
    hooks.trace("ike-negotiation-started", {
      peer: peer.id,
      local: localAddress,
      remote: peer.remoteAddress,
      proposal: peer.proposalId,
      role: "responder",
    });
    const selected = this.selectProposal(message.proposal, peer);
    if (!selected) {
      hooks.sendIke(localAddress, peer.remoteAddress, {
        kind: "ike",
        exchange: "sa-init-response",
        initiatorSpi: message.initiatorSpi,
        responderSpi: session.localSpi,
        accepted: false,
        reason: "proposal-mismatch",
      });
      this.failSession(session, "proposal-mismatch", peer, localAddress);
      return;
    }
    hooks.trace("ike-proposal-selected", {
      peer: peer.id,
      proposal: peer.proposalId,
      encryption: selected.encryption,
      integrity: selected.integrity,
    });
    hooks.sendIke(localAddress, peer.remoteAddress, {
      kind: "ike",
      exchange: "sa-init-response",
      initiatorSpi: message.initiatorSpi,
      responderSpi: session.localSpi,
      accepted: true,
      proposal: { encryption: selected.encryption, integrity: selected.integrity },
      generation: session.generation,
    });
    this.scheduleNegotiationTimeout(peer.id, session.generation);
  }

  private onSaInitResponse(message: IkeMessage, peer: IkePeerConfiguration, localAddress: Ipv4): void {
    const hooks = this.hooks!;
    const session = this.sessions.get(peer.id);
    if (!session || session.state !== "INITIATING") return;
    if (message.accepted === false) {
      this.failSession(session, message.reason ?? "proposal-mismatch", peer, localAddress);
      return;
    }
    const selected = this.selectProposal(message.proposal, peer);
    if (!selected) {
      this.failSession(session, "proposal-mismatch", peer, localAddress);
      return;
    }
    session.state = "NEGOTIATING";
    session.remoteSpi = message.responderSpi;
    hooks.trace("ike-proposal-selected", {
      peer: peer.id,
      proposal: peer.proposalId,
      encryption: selected.encryption,
      integrity: selected.integrity,
    });
    hooks.sendIke(localAddress, peer.remoteAddress, {
      kind: "ike",
      exchange: "auth",
      initiatorSpi: session.localSpi,
      responderSpi: session.remoteSpi,
      identity: peer.localIdentity,
      authFingerprint: peer.preSharedKeyVerifier?.hashBase64,
      generation: session.generation,
      childSpiInitiatorToResponder: deriveSpi(localAddress, peer.remoteAddress, session.generation, "child"),
      childSpiResponderToInitiator: deriveSpi(peer.remoteAddress, localAddress, session.generation, "child"),
    });
  }

  private onAuth(
    message: IkeMessage,
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    localAddress: Ipv4,
  ): void {
    const hooks = this.hooks!;
    const session = this.sessionFor(peer.id);
    if (session.state !== "NEGOTIATING") return;
    const rejection = this.authenticate(message, peer);
    if (rejection) {
      hooks.trace("ike-authentication-failed", { peer: peer.id, reason: rejection });
      hooks.sendIke(localAddress, peer.remoteAddress, {
        kind: "ike",
        exchange: "auth-response",
        initiatorSpi: message.initiatorSpi,
        responderSpi: session.localSpi,
        accepted: false,
        reason: rejection,
      });
      this.failSession(session, rejection, peer, localAddress);
      return;
    }
    hooks.trace("ike-authentication-succeeded", { peer: peer.id, remote: peer.remoteAddress });
    hooks.sendIke(localAddress, peer.remoteAddress, {
      kind: "ike",
      exchange: "auth-response",
      initiatorSpi: message.initiatorSpi,
      responderSpi: session.localSpi,
      accepted: true,
      identity: peer.localIdentity,
      generation: session.generation,
    });
    // The responder's outbound SA is the initiator's inbound SA and vice versa.
    this.installAssociations(peer, profile, session, {
      outboundSpi: message.childSpiResponderToInitiator
        ?? deriveSpi(localAddress, peer.remoteAddress, session.generation, "child"),
      inboundSpi: message.childSpiInitiatorToResponder
        ?? deriveSpi(peer.remoteAddress, localAddress, session.generation, "child"),
    });
  }

  private onAuthResponse(
    message: IkeMessage,
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    localAddress: Ipv4,
  ): void {
    const hooks = this.hooks!;
    const session = this.sessions.get(peer.id);
    if (!session || session.state !== "NEGOTIATING") return;
    if (message.accepted === false) {
      hooks.trace("ike-authentication-failed", { peer: peer.id, reason: message.reason ?? "authentication-failed" });
      this.failSession(session, message.reason ?? "authentication-failed", peer, localAddress);
      return;
    }
    if (peer.remoteIdentity !== undefined && message.identity !== undefined
      && peer.remoteIdentity !== message.identity) {
      hooks.trace("ike-authentication-failed", { peer: peer.id, reason: "identity-mismatch" });
      this.failSession(session, "identity-mismatch", peer, localAddress);
      return;
    }
    hooks.trace("ike-authentication-succeeded", { peer: peer.id, remote: peer.remoteAddress });
    this.installAssociations(peer, profile, session, {
      outboundSpi: deriveSpi(localAddress, peer.remoteAddress, session.generation, "child"),
      inboundSpi: deriveSpi(peer.remoteAddress, localAddress, session.generation, "child"),
    });
  }

  private onRekey(
    message: IkeMessage,
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    localAddress: Ipv4,
  ): void {
    const hooks = this.hooks!;
    const session = this.sessionFor(peer.id);
    if (session.state === "FAILED") return;
    const rejection = this.authenticate(message, peer);
    if (rejection) {
      hooks.sendIke(localAddress, peer.remoteAddress, {
        kind: "ike",
        exchange: "rekey-response",
        initiatorSpi: message.initiatorSpi,
        responderSpi: session.localSpi,
        accepted: false,
        reason: rejection,
      });
      this.failSession(session, "rekey-failed", peer, localAddress);
      return;
    }
    const generation = message.generation ?? session.generation + 1;
    session.generation = generation;
    hooks.sendIke(localAddress, peer.remoteAddress, {
      kind: "ike",
      exchange: "rekey-response",
      initiatorSpi: message.initiatorSpi,
      responderSpi: session.localSpi,
      accepted: true,
      generation,
    });
    this.rolloverAssociations(peer, profile, session, {
      outboundSpi: deriveSpi(localAddress, peer.remoteAddress, generation, "child"),
      inboundSpi: deriveSpi(peer.remoteAddress, localAddress, generation, "child"),
    });
  }

  private onRekeyResponse(
    message: IkeMessage,
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    localAddress: Ipv4,
  ): void {
    const session = this.sessions.get(peer.id);
    if (!session || session.state !== "REKEYING") return;
    if (message.accepted === false) {
      this.failSession(session, "rekey-failed", peer, localAddress);
      return;
    }
    const generation = message.generation ?? session.generation;
    session.generation = generation;
    this.rolloverAssociations(peer, profile, session, {
      outboundSpi: deriveSpi(localAddress, peer.remoteAddress, generation, "child"),
      inboundSpi: deriveSpi(peer.remoteAddress, localAddress, generation, "child"),
    });
  }

  /** Compare the offered fingerprint with ours. Neither value is ever traced. */
  private authenticate(message: IkeMessage, peer: IkePeerConfiguration): IkeFailureReason | undefined {
    const expected = peer.preSharedKeyVerifier?.hashBase64;
    if (!expected) return "no-pre-shared-key";
    if (!message.authFingerprint) return "authentication-failed";
    if (message.authFingerprint !== expected) return "authentication-failed";
    if (peer.remoteIdentity !== undefined && message.identity !== undefined
      && peer.remoteIdentity !== message.identity) {
      return "identity-mismatch";
    }
    return undefined;
  }

  private selectProposal(
    offer: IkeProposalOffer | undefined,
    peer: IkePeerConfiguration,
  ): IpsecProposalConfiguration | undefined {
    const local = this.proposals.get(peer.proposalId);
    if (!local || !offer) return undefined;
    return local.encryption === offer.encryption && local.integrity === offer.integrity ? local : undefined;
  }

  // --- security associations ----------------------------------------------

  private installAssociations(
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    session: IkeSession,
    spis: { outboundSpi: number; inboundSpi: number },
  ): void {
    const hooks = this.hooks!;
    const nowNs = hooks.nowNs();
    session.state = "ESTABLISHED";
    session.failureReason = undefined;
    // A fresh establishment replaces everything this peer had before. Without
    // this, an aborted rekey could leave a higher-generation SA behind on one
    // side only, and the two ends would then disagree about which SPI is live.
    this.dropAssociations(peer.id);
    this.createAssociationPair(peer, profile, session.generation, spis, nowNs);
    this.recordLifetime(peer, profile, session, nowNs);
    hooks.trace("ipsec-sa-established", {
      peer: peer.id,
      profile: profile.id,
      generation: session.generation,
      inboundSpi: spis.inboundSpi,
      outboundSpi: spis.outboundSpi,
      lifetimeNs: profile.lifetimeNs,
    });
  }

  private rolloverAssociations(
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    session: IkeSession,
    spis: { outboundSpi: number; inboundSpi: number },
  ): void {
    const hooks = this.hooks!;
    const nowNs = hooks.nowNs();
    // The previous generation keeps accepting inbound packets for a bounded
    // overlap, so a successful rekey never loses traffic in flight.
    for (const association of this.associations.values()) {
      if (this.peerOf(association) !== peer.id) continue;
      if (association.generation >= session.generation) continue;
      association.state = "rekeying";
      association.expiresAtNs = Math.min(
        association.expiresAtNs,
        nowNs + DEFAULT_VPN_LIMITS.rekeyOverlapNs,
      );
    }
    this.createAssociationPair(peer, profile, session.generation, spis, nowNs);
    session.state = "ESTABLISHED";
    session.failureReason = undefined;
    this.recordLifetime(peer, profile, session, nowNs);
    hooks.trace("ipsec-sa-rekeyed", {
      peer: peer.id,
      profile: profile.id,
      generation: session.generation,
      inboundSpi: spis.inboundSpi,
      outboundSpi: spis.outboundSpi,
    });
  }

  private createAssociationPair(
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    generation: number,
    spis: { outboundSpi: number; inboundSpi: number },
    nowNs: number,
  ): void {
    if (this.associations.size + 2 > DEFAULT_VPN_LIMITS.maximumSecurityAssociationsPerDevice) {
      this.pruneExpiredAssociations();
    }
    for (const direction of ["outbound", "inbound"] as const) {
      const spi = direction === "outbound" ? spis.outboundSpi : spis.inboundSpi;
      const association: IpsecSecurityAssociation = {
        id: `${peer.id}:${direction}:${generation}`,
        direction,
        peerAddress: peer.remoteAddress,
        spi,
        proposalId: profile.proposalId,
        sequenceNumber: 0,
        createdAtNs: nowNs,
        expiresAtNs: nowNs + profile.lifetimeNs,
        packetCount: 0,
        byteCount: 0,
        state: "active",
        generation,
        highestSequence: 0,
        seen: new Set<number>(),
      };
      this.associations.set(association.id, association);
    }
  }

  /**
   * Record when this generation must rekey and when it expires. Nothing is
   * scheduled: a *periodic* IPsec timer would keep the deterministic event queue
   * permanently non-empty, so `runUntilIdle()` — and therefore Auto execution
   * and headless grading — would never return. Lifetimes are instead evaluated
   * against `VirtualClock` by `checkLifetimes`, which every protected operation
   * and every runtime inspection calls. Advancing virtual time and then sending
   * a packet (or opening the VPN panel) produces exactly the same deterministic
   * rekey a timer would have, with a bounded event queue.
   */
  private recordLifetime(
    peer: IkePeerConfiguration,
    profile: IpsecProfileConfiguration,
    session: IkeSession,
    nowNs: number,
  ): void {
    session.establishedAtNs = nowNs;
    session.expiresAtNs = nowNs + profile.lifetimeNs;
    session.rekeyAtNs = nowNs
      + Math.max(1, Math.floor(profile.lifetimeNs * DEFAULT_VPN_LIMITS.rekeyLifetimeFraction));
    void peer;
  }

  /**
   * Deterministically apply everything virtual time has made due: rekey a
   * generation that has reached its rekey point, and expire one that has
   * outlived its lifetime.
   */
  checkLifetimes(): void {
    const hooks = this.hooks;
    if (!hooks) return;
    const nowNs = hooks.nowNs();
    this.expireDueAssociations(nowNs);
    for (const session of this.sessions.values()) {
      const peer = this.peers.get(session.peerId);
      if (!peer) continue;
      if (session.state === "ESTABLISHED"
        && session.rekeyAtNs !== undefined
        && session.rekeyAtNs <= nowNs) {
        this.beginRekey(peer, session);
        continue;
      }
      // A rekey that never completed leaves the session without protection.
      if (session.expiresAtNs !== undefined && session.expiresAtNs <= nowNs
        && (session.state === "ESTABLISHED" || session.state === "REKEYING")) {
        session.state = "EXPIRED";
        session.failureReason = session.state === "EXPIRED" ? "rekey-failed" : session.failureReason;
        session.establishedAtNs = undefined;
        session.rekeyAtNs = undefined;
      }
    }
  }

  private beginRekey(peer: IkePeerConfiguration, session: IkeSession): void {
    const hooks = this.hooks!;
    // Only the initiator drives the rekey, so exactly one exchange happens.
    if (session.role !== "initiator") {
      // The responder simply waits; clear the trigger so it is not re-evaluated.
      session.rekeyAtNs = undefined;
      return;
    }
    const localAddress = hooks.localAddressFor(peer.id);
    if (localAddress === undefined) return;
    session.rekeyAtNs = undefined;
    session.state = "REKEYING";
    session.generation += 1;
    hooks.sendIke(localAddress, peer.remoteAddress, {
      kind: "ike",
      exchange: "rekey",
      initiatorSpi: session.localSpi,
      responderSpi: session.remoteSpi,
      authFingerprint: peer.preSharedKeyVerifier?.hashBase64,
      identity: peer.localIdentity,
      generation: session.generation,
    });
  }

  private expireDueAssociations(nowNs = this.hooks?.nowNs() ?? 0): void {
    if (!this.hooks) return;
    for (const association of this.associations.values()) {
      if (association.state === "expired" || association.expiresAtNs > nowNs) continue;
      association.state = "expired";
      this.hooks.trace("ipsec-sa-expired", {
        peer: this.peerOf(association),
        generation: association.generation,
        direction: association.direction,
        spi: association.spi,
      });
    }
  }

  private pruneExpiredAssociations(): void {
    for (const [id, association] of [...this.associations.entries()]) {
      if (association.state === "expired") this.associations.delete(id);
    }
  }

  private peerOf(association: IpsecSecurityAssociation): string {
    return association.id.slice(0, association.id.indexOf(":"));
  }

  // --- ESP protection ------------------------------------------------------

  /**
   * Wrap a GRE packet in a simulated ESP envelope. Returns undefined when the
   * peer has no active outbound SA — a protected tunnel never sends in the
   * clear just because negotiation has not finished.
   */
  protect(peerId: string, payload: GrePacket, wireSizeBytes: number): SimulatedEspPacket | undefined {
    const association = this.outboundAssociation(peerId);
    if (!association) return undefined;
    association.sequenceNumber += 1;
    association.packetCount += 1;
    association.byteCount += wireSizeBytes;
    const packet: SimulatedEspPacket = {
      kind: "esp",
      spi: association.spi,
      sequenceNumber: association.sequenceNumber,
      protectedProtocol: "gre",
      protectedPayload: payload,
      integrityTag: deriveIntegrityTag(
        association.spi,
        association.sequenceNumber,
        association.proposalId,
        payload,
      ),
    };
    this.hooks?.trace("esp-packet-protected", {
      peer: peerId,
      spi: association.spi,
      sequence: association.sequenceNumber,
      generation: association.generation,
      bytes: wireSizeBytes,
    });
    return packet;
  }

  /**
   * Validate a received ESP envelope against its inbound SA and the bounded
   * replay window. This is not RFC 4303 anti-replay parity: it is a small,
   * deterministic window that makes duplicates and stale packets observable.
   */
  unprotect(
    packet: SimulatedEspPacket,
    remoteAddress: Ipv4,
    wireSizeBytes: number,
  ): { payload: GrePacket; peerId: string } | { rejection: EspRejection; peerId?: string } {
    const hooks = this.hooks;
    this.checkLifetimes();
    const association = [...this.associations.values()].find((entry) =>
      entry.direction === "inbound"
      && entry.spi === packet.spi
      && entry.peerAddress === remoteAddress
      && entry.state !== "expired");
    if (!association) {
      hooks?.trace("esp-invalid-spi", { spi: packet.spi, remote: remoteAddress });
      return { rejection: "invalid-spi" };
    }
    const peerId = this.peerOf(association);
    const window = DEFAULT_VPN_LIMITS.replayWindowPackets;
    if (packet.sequenceNumber <= association.highestSequence - window) {
      hooks?.trace("esp-replay-dropped", {
        peer: peerId,
        spi: packet.spi,
        sequence: packet.sequenceNumber,
        reason: "outside-window",
      });
      return { rejection: "replay", peerId };
    }
    if (association.seen.has(packet.sequenceNumber)) {
      hooks?.trace("esp-replay-dropped", {
        peer: peerId,
        spi: packet.spi,
        sequence: packet.sequenceNumber,
        reason: "duplicate",
      });
      return { rejection: "replay", peerId };
    }
    const expectedTag = deriveIntegrityTag(
      packet.spi,
      packet.sequenceNumber,
      association.proposalId,
      packet.protectedPayload,
    );
    if (expectedTag !== packet.integrityTag) {
      hooks?.trace("esp-invalid-spi", { spi: packet.spi, remote: remoteAddress, reason: "integrity-mismatch" });
      return { rejection: "integrity-mismatch", peerId };
    }
    association.seen.add(packet.sequenceNumber);
    association.highestSequence = Math.max(association.highestSequence, packet.sequenceNumber);
    for (const sequence of association.seen) {
      if (sequence <= association.highestSequence - window) association.seen.delete(sequence);
    }
    association.packetCount += 1;
    association.byteCount += wireSizeBytes;
    hooks?.trace("esp-packet-received", {
      peer: peerId,
      spi: packet.spi,
      sequence: packet.sequenceNumber,
      bytes: wireSizeBytes,
    });
    hooks?.trace("esp-packet-unprotected", {
      peer: peerId,
      spi: packet.spi,
      sequence: packet.sequenceNumber,
      tunnel: packet.protectedPayload.tunnelId,
    });
    return { payload: packet.protectedPayload, peerId };
  }

  // --- internals -----------------------------------------------------------

  private sessionFor(peerId: string): IkeSession {
    const existing = this.sessions.get(peerId);
    if (existing) return existing;
    const session: IkeSession = {
      peerId,
      state: "DOWN",
      role: undefined,
      localSpi: 0,
      remoteSpi: 0,
      generation: 0,
      establishedAtNs: undefined,
      expiresAtNs: undefined,
      failureReason: undefined,
      rekeyAtNs: undefined,
    };
    this.sessions.set(peerId, session);
    return session;
  }

  private failSession(
    session: IkeSession,
    reason: IkeFailureReason,
    peer: IkePeerConfiguration,
    _localAddress: Ipv4 | undefined,
  ): void {
    session.state = "FAILED";
    session.failureReason = reason;
    session.establishedAtNs = undefined;
    session.expiresAtNs = undefined;
    this.resetPeer(peer.id, reason, { silent: true, keepSession: true });
  }

  /** Forget every security association belonging to one peer. */
  private dropAssociations(peerId: string): boolean {
    let removed = false;
    for (const [id, association] of [...this.associations.entries()]) {
      if (this.peerOf(association) !== peerId) continue;
      this.associations.delete(id);
      removed = true;
    }
    return removed;
  }

  private resetPeer(
    peerId: string,
    reason: IkeFailureReason | undefined,
    options: { silent?: boolean; keepSession?: boolean } = {},
  ): void {
    const removed = this.dropAssociations(peerId);
    if (removed && !options.silent) {
      this.hooks?.trace("ipsec-sa-expired", { peer: peerId, reason: reason ?? "cleared" });
    }
    if (options.keepSession) return;
    const session = this.sessions.get(peerId);
    if (session) {
      session.state = reason === undefined ? "DOWN" : "FAILED";
      session.failureReason = reason;
      session.establishedAtNs = undefined;
      session.expiresAtNs = undefined;
    }
  }
}

export const DEFAULT_IKE_LIFETIME_NS = 3_600 * 1_000_000_000;
export const DEFAULT_IPSEC_LIFETIME_NS = 3_600 * 1_000_000_000;

function requireId(value: string, label: string): void {
  if (!value.trim()) throw new VpnConfigurationError("VPN_INVALID_CONFIGURATION", `${label} is required.`);
}

function requireIpv4(value: Ipv4, label: string): void {
  try {
    ipToInt(value);
  } catch {
    throw new VpnConfigurationError("VPN_INVALID_CONFIGURATION", `${label} must be a valid IPv4 address.`);
  }
}

function requireLifetime(lifetimeNs: number, label: string): void {
  const seconds = lifetimeNs / 1_000_000_000;
  if (
    !Number.isFinite(lifetimeNs)
    || seconds < DEFAULT_VPN_LIMITS.minimumLifetimeSeconds
    || seconds > DEFAULT_VPN_LIMITS.maximumLifetimeSeconds
  ) {
    throw new VpnConfigurationError(
      "VPN_INVALID_CONFIGURATION",
      `${label} must be between ${DEFAULT_VPN_LIMITS.minimumLifetimeSeconds}`
      + ` and ${DEFAULT_VPN_LIMITS.maximumLifetimeSeconds} seconds.`,
    );
  }
}

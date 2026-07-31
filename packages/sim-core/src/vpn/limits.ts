/**
 * Centralized, finite resource limits for the site-to-site VPN model.
 *
 * Like every other SimulatorNet subsystem, VPN state is bounded twice: by a
 * *structural* limit (how much a lab may describe) and by a *per-operation*
 * event budget (how much work one Auto run or one grading check may perform).
 * Both are deterministic and identical in the browser worker and the verifier.
 */
export const DEFAULT_VPN_LIMITS = Object.freeze({
  /** Logical `Tunnel<n>` interfaces on one device. */
  maximumTunnelsPerDevice: 16,
  maximumTunnelsPerLab: 64,
  /** Smallest and largest deterministic tunnel MTU a lab may configure. */
  minimumTunnelMtu: 576,
  maximumTunnelMtu: 9_000,
  minimumTunnelTtl: 1,
  maximumTunnelTtl: 255,
  /** IKEv2 peers, proposals and IPsec profiles per device. */
  maximumIkePeersPerDevice: 16,
  maximumProposalsPerDevice: 8,
  maximumIpsecProfilesPerDevice: 16,
  /** One child SA pair per tunnel; a rekey may briefly double that. */
  maximumSecurityAssociationsPerDevice: 64,
  /** Anti-replay window, in packets. Not a claim of RFC 4303 parity. */
  replayWindowPackets: 64,
  /** Lifetime bounds, in whole seconds, for both IKE and IPsec. */
  minimumLifetimeSeconds: 60,
  maximumLifetimeSeconds: 86_400,
  /** Fraction of the lifetime after which a deterministic rekey is attempted. */
  rekeyLifetimeFraction: 0.9,
  /** How long a rekeyed SA still accepts inbound packets, in virtual ns. */
  rekeyOverlapNs: 2_000_000_000,
  /** Virtual delay before an armed peer starts negotiating, in ns. */
  negotiationStartDelayNs: 1_000_000,
  /**
   * How long an attempt waits for its peer before failing, in virtual ns. It is
   * deliberately a small fixed window rather than a fraction of the lifetime: a
   * one-hour lifetime must not drag the virtual clock forward by six minutes
   * every time the event queue drains.
   */
  negotiationTimeoutNs: 5_000_000_000,
  /** Bounded work one Auto run or grading check may spend on VPN events. */
  maximumVpnEventsPerOperation: 20_000,
});

export type VpnLimits = typeof DEFAULT_VPN_LIMITS;

export type VpnErrorCode =
  | "VPN_INVALID_CONFIGURATION"
  | "VPN_TUNNEL_LIMIT"
  | "VPN_PEER_LIMIT"
  | "VPN_PROPOSAL_LIMIT"
  | "VPN_PROFILE_LIMIT"
  | "VPN_UNSUPPORTED_DEVICE";

/** A typed, structured error that may cross a package or API boundary. */
export class VpnConfigurationError extends Error {
  override readonly name = "VpnConfigurationError";

  constructor(
    readonly code: VpnErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Shared deterministic accounting for every tunnel in one lab, so a headless
 * verifier enforces exactly the same bound as the browser worker.
 */
export class VpnTunnelBudget {
  private allocated = 0;

  constructor(readonly maximumTunnels = DEFAULT_VPN_LIMITS.maximumTunnelsPerLab) {}

  get usedTunnels(): number {
    return this.allocated;
  }

  reserve(count = 1): void {
    if (count <= 0) return;
    if (this.allocated + count > this.maximumTunnels) {
      throw new VpnConfigurationError(
        "VPN_TUNNEL_LIMIT",
        `Lab tunnel interface limit exceeded (${this.maximumTunnels}).`,
      );
    }
    this.allocated += count;
  }

  release(count = 1): void {
    if (count <= 0) return;
    this.allocated = Math.max(0, this.allocated - count);
  }
}

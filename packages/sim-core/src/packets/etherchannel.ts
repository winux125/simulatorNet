import type { Mac } from "../util/mac";

/**
 * Structured EtherChannel negotiation messages.
 *
 * LACP (IEEE 802.3ad-like) and PAgP (Cisco-like) are modelled as structured
 * control payloads, never as raw bytes. This is an educational subset: there is
 * no multi-chassis aggregation, no LACP fast rate, no configurable system
 * priority beyond the deterministic default, and no PAgP silent/non-silent
 * distinction.
 */

export const DEFAULT_LACP_SYSTEM_PRIORITY = 32_768;
export const DEFAULT_LACP_PORT_PRIORITY = 32_768;

/** `channel-group <n> mode active|passive`. */
export type LacpActivity = "active" | "passive";

/** `channel-group <n> mode desirable|auto`. */
export type PagpMode = "desirable" | "auto";

export interface LacpPortState {
  readonly activity: LacpActivity;
  readonly aggregation: boolean;
  readonly synchronization: boolean;
  readonly collecting: boolean;
  readonly distributing: boolean;
}

export interface LacpPacket {
  readonly kind: "lacp";
  readonly actorSystemId: Mac;
  readonly actorSystemPriority: number;
  /** The administrative key; SimulatorNet uses the channel group number. */
  readonly actorKey: number;
  readonly actorPortId: number;
  readonly actorPortPriority: number;
  readonly actorState: LacpPortState;
  readonly partnerSystemId?: Mac;
  readonly partnerKey?: number;
  readonly partnerPortId?: number;
  readonly partnerState?: LacpPortState;
}

export interface PagpPacket {
  readonly kind: "pagp";
  readonly deviceId: Mac;
  readonly mode: PagpMode;
  /** Sending port name, shown by `show pagp neighbor`. */
  readonly portName: string;
  /** Group capability; SimulatorNet uses the channel group number. */
  readonly groupCapability: number;
  readonly learnCapability: "aggregation-capable";
}

export function lacpStateOf(
  activity: LacpActivity,
  synchronization: boolean,
  collecting: boolean,
  distributing: boolean,
): LacpPortState {
  return { activity, aggregation: true, synchronization, collecting, distributing };
}

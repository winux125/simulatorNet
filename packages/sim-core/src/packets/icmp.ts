import type { IcmpType } from "@sim/contracts";

export interface IcmpMessage {
  readonly kind: "icmp";
  readonly type: IcmpType;
  readonly code: number;
  readonly identifier: number;
  readonly sequence: number;
  /** Data length used by the deterministic wire-size model; defaults when unset. */
  readonly payloadBytes?: number;
  /**
   * Largest payload the next hop accepts, reported with
   * `DestinationUnreachable / FragmentationNeeded`. SimulatorNet does not model
   * fragmentation, so a tunnel reports this instead of splitting the packet.
   */
  readonly nextHopMtu?: number;
}

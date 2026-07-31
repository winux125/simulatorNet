import type { GrePacket } from "./gre";

/**
 * A **simulated** Encapsulating Security Payload envelope.
 *
 * SimulatorNet models deterministic educational IPsec behaviour: an SPI, a
 * sequence number for anti-replay, and a logical integrity label. It performs
 * no encryption and no cryptographic authentication whatsoever, so this
 * structure never provides real protection — it only makes protected transport
 * observable and teachable.
 *
 * What it *does* model faithfully is opacity: an intermediate device sees the
 * outer addresses, the ESP protocol, the size and the QoS fields, and nothing
 * of the inner transport. That falls out of the type: the protected payload is
 * reachable only after an SA lookup unwraps it.
 */
export interface SimulatedEspPacket {
  readonly kind: "esp";
  /** Security Parameter Index of the SA that produced this packet. */
  readonly spi: number;
  /** Monotonic per-SA counter driving the bounded replay window. */
  readonly sequenceNumber: number;
  /** Only GRE-over-IPsec is modelled; transport mode is out of scope. */
  readonly protectedProtocol: "gre";
  readonly protectedPayload: GrePacket;
  /**
   * Deterministic logical fingerprint of the protected payload. It exists so a
   * lab can *see* that protection was applied and detect a mismatch; it is
   * explicitly not a security guarantee.
   */
  readonly integrityTag: string;
}

/** Simulated ESP SPI and sequence number. */
export const ESP_HEADER_BYTES = 8;
/** Simulated ESP padding, pad length and next-header trailer. */
export const ESP_TRAILER_BYTES = 2;
/** Simulated ESP integrity value. A label, never a cryptographic tag. */
export const ESP_INTEGRITY_BYTES = 12;

/** Total per-packet overhead the simulated ESP envelope adds. */
export const ESP_OVERHEAD_BYTES = ESP_HEADER_BYTES + ESP_TRAILER_BYTES + ESP_INTEGRITY_BYTES;

export function isEspPacket(payload: { kind: string }): payload is SimulatedEspPacket {
  return payload.kind === "esp";
}

/** Generic structured application message carried by the simplified TCP model. */
export interface TcpApplicationPayload {
  readonly kind: "tcp-application";
  readonly protocol: string;
  readonly data: unknown;
}

export type TcpPayload = TcpApplicationPayload | HttpMessage | TacacsMessage;

/**
 * A deterministic, message-oriented TCP segment. Sequence numbers advance by
 * one per SYN, FIN, or application message; byte-level windows are out of scope.
 */
export interface TcpSegment {
  readonly kind: "tcp";
  readonly srcPort: number;
  readonly dstPort: number;
  readonly sequence: number;
  readonly acknowledgment: number;
  readonly syn?: boolean;
  readonly ack?: boolean;
  readonly fin?: boolean;
  readonly rst?: boolean;
  readonly payload?: TcpPayload;
}
import type { HttpMessage, TacacsMessage } from "../services/messages";

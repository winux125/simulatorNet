import type { SnmpTrapType } from "@sim/contracts";
import type { SnmpVarBind } from "./snmp-mib";

/**
 * Structured SNMPv2c messages carried by the simulated UDP stack.
 *
 * There is no BER/ASN.1 byte encoding: the payload is data, exactly like the
 * DNS, TFTP, NTP and RADIUS models. A community string never travels here in
 * the clear — only its opaque, scope-bound fingerprint does.
 */
export type SnmpPdu = "GET" | "GETNEXT" | "RESPONSE" | "ERROR" | "TRAP";

export type SnmpErrorStatus = "noSuchName" | "authorizationError" | "genErr" | "tooBig";

export interface SnmpMessage {
  readonly kind: "snmp";
  readonly pdu: SnmpPdu;
  readonly version: "2c";
  readonly requestId: number;
  readonly communityFingerprint?: string;
  readonly errorStatus?: SnmpErrorStatus;
  readonly varBinds: readonly SnmpVarBind[];
  /** TRAP only. */
  readonly trapType?: SnmpTrapType;
  readonly sysUpTime?: number;
  readonly sourceDeviceId?: string;
  readonly sourceName?: string;
}

/**
 * DSCP, IP precedence and 802.1p CoS values.
 *
 * SimulatorNet models the marking *fields*, not a vendor's per-hop behaviour
 * implementation: a DSCP value is a number the classifier can match and the
 * scheduler can act on, nothing more.
 */

export const MAXIMUM_DSCP = 63;
export const MAXIMUM_IP_PRECEDENCE = 7;
export const MAXIMUM_COS = 7;

/** The symbolic DSCP names the CLI and importer accept, in canonical order. */
export const DSCP_NAMES: Readonly<Record<string, number>> = Object.freeze({
  default: 0,
  cs0: 0,
  cs1: 8,
  cs2: 16,
  cs3: 24,
  cs4: 32,
  cs5: 40,
  cs6: 48,
  cs7: 56,
  af11: 10,
  af12: 12,
  af13: 14,
  af21: 18,
  af22: 20,
  af23: 22,
  af31: 26,
  af32: 28,
  af33: 30,
  af41: 34,
  af42: 36,
  af43: 38,
  ef: 46,
});

/** Preferred name per value, so `show` output is stable and unambiguous. */
const CANONICAL_DSCP_NAME: Readonly<Record<number, string>> = Object.freeze({
  0: "default",
  8: "cs1",
  10: "af11",
  12: "af12",
  14: "af13",
  16: "cs2",
  18: "af21",
  20: "af22",
  22: "af23",
  24: "cs3",
  26: "af31",
  28: "af32",
  30: "af33",
  32: "cs4",
  34: "af41",
  36: "af42",
  38: "af43",
  40: "cs5",
  46: "ef",
  48: "cs6",
  56: "cs7",
});

export type QosMarkingErrorCode = "QOS_INVALID_MARKING";

export class QosMarkingError extends Error {
  override readonly name = "QosMarkingError";
  readonly code: QosMarkingErrorCode = "QOS_INVALID_MARKING";
}

/** Accept `ef`, `af31`, `cs5`, `default` or a numeric 0-63 token. */
export function parseDscp(token: string): number {
  const normalized = token.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new QosMarkingError("A DSCP value is required. Use 0-63, default, cs0-cs7, af11-af43 or ef.");
  }
  const named = DSCP_NAMES[normalized];
  if (named !== undefined) return named;
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= MAXIMUM_DSCP) return numeric;
  throw new QosMarkingError(`Invalid DSCP value '${token}'. Use 0-63, default, cs0-cs7, af11-af43 or ef.`);
}

/** The canonical symbolic name of a DSCP value, or its number when unnamed. */
export function dscpName(value: number): string {
  return CANONICAL_DSCP_NAME[value] ?? String(value);
}

export function requireDscp(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_DSCP) {
    throw new QosMarkingError(`DSCP must be an integer between 0 and ${MAXIMUM_DSCP}.`);
  }
  return value;
}

export function requireIpPrecedence(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_IP_PRECEDENCE) {
    throw new QosMarkingError(`IP precedence must be an integer between 0 and ${MAXIMUM_IP_PRECEDENCE}.`);
  }
  return value;
}

export function requireCos(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_COS) {
    throw new QosMarkingError(`802.1p CoS must be an integer between 0 and ${MAXIMUM_COS}.`);
  }
  return value;
}

/** The three most significant DSCP bits, which is what IP precedence is. */
export function precedenceOfDscp(dscp: number): number {
  return (dscp >> 3) & 0b111;
}

/** Setting precedence keeps the low DSCP bits at zero, exactly like IOS. */
export function dscpFromPrecedence(precedence: number): number {
  return (requireIpPrecedence(precedence) << 3) & MAXIMUM_DSCP;
}

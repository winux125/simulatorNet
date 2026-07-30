import {
  DSCP_NAMES,
  MAXIMUM_COS,
  MAXIMUM_DSCP,
  MAXIMUM_IP_PRECEDENCE,
  dscpName,
  parseDscpToken,
  precedenceOfDscp,
} from "@sim/contracts";

/**
 * DSCP, IP precedence and 802.1p CoS values.
 *
 * The symbolic vocabulary itself is serializable data and lives in
 * `@sim/contracts`, so the CLI, the importer and the UI all read the same
 * table. This module adds the engine-side validation that turns an invalid
 * value into a typed error instead of an unmarked packet. SimulatorNet models
 * the marking *fields*, not a vendor's per-hop behaviour implementation.
 */

export { DSCP_NAMES, MAXIMUM_COS, MAXIMUM_DSCP, MAXIMUM_IP_PRECEDENCE, dscpName, precedenceOfDscp };

export type QosMarkingErrorCode = "QOS_INVALID_MARKING";

export class QosMarkingError extends Error {
  override readonly name = "QosMarkingError";
  readonly code: QosMarkingErrorCode = "QOS_INVALID_MARKING";
}

/** Accept `ef`, `af31`, `cs5`, `default` or a numeric 0-63 token. */
export function parseDscp(token: string): number {
  const parsed = parseDscpToken(token);
  if (parsed === undefined) {
    throw new QosMarkingError(`Invalid DSCP value '${token}'. Use 0-63, default, cs0-cs7, af11-af43 or ef.`);
  }
  return parsed;
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

/** Setting precedence keeps the low DSCP bits at zero, exactly like IOS. */
export function dscpFromPrecedence(precedence: number): number {
  return (requireIpPrecedence(precedence) << 3) & MAXIMUM_DSCP;
}

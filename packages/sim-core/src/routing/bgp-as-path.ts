import { ControlProtocolConfigurationError } from "../protocols/limits";

/**
 * A bounded, structured AS-path matcher.
 *
 * Cisco expresses these as regular expressions. SimulatorNet deliberately does
 * not: a configuration-supplied pattern is parsed once into one of these
 * variants and the *variant* is what runs, so no user text ever reaches a
 * regular-expression engine and no match can backtrack. An unsupported pattern
 * is reported, never approximated.
 */
export type AsPathMatcher =
  | { readonly kind: "empty" }
  | { readonly kind: "contains"; readonly asn: number }
  | { readonly kind: "starts-with"; readonly asn: number }
  | { readonly kind: "ends-with"; readonly asn: number }
  | { readonly kind: "exact"; readonly asPath: readonly number[] }
  | { readonly kind: "length"; readonly operator: "eq" | "le" | "ge"; readonly length: number };

export const MAXIMUM_AS_PATH_MATCH_LENGTH = 32;

function validateAsn(value: number, field = "asPathList.asn"): number {
  if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new ControlProtocolConfigurationError(`AS number '${value}' must be between 1 and 4294967295`, field);
  }
  return value;
}

/** Validate a structured matcher that did not come from pattern text. */
export function validateAsPathMatcher(matcher: AsPathMatcher, field = "asPathList.matcher"): AsPathMatcher {
  switch (matcher.kind) {
    case "empty":
      return matcher;
    case "contains":
    case "starts-with":
    case "ends-with":
      validateAsn(matcher.asn, field);
      return matcher;
    case "exact":
      if (!matcher.asPath.length || matcher.asPath.length > MAXIMUM_AS_PATH_MATCH_LENGTH) {
        throw new ControlProtocolConfigurationError(
          `An exact AS-path match holds 1-${MAXIMUM_AS_PATH_MATCH_LENGTH} AS numbers`,
          field,
        );
      }
      for (const asn of matcher.asPath) validateAsn(asn, field);
      return matcher;
    case "length":
      if (!Number.isInteger(matcher.length) || matcher.length < 0 || matcher.length > 256) {
        throw new ControlProtocolConfigurationError("An AS-path length match must be between 0 and 256", field);
      }
      return matcher;
    default: {
      const exhaustive: never = matcher;
      throw new ControlProtocolConfigurationError(`Unsupported AS-path matcher ${JSON.stringify(exhaustive)}`, field);
    }
  }
}

/**
 * The educational Cisco-like subset: `^$`, `_65001_`, `^65001_`, `_65001$`,
 * `^65001$` and `^65001 65002$`. Everything else is rejected with a message
 * that names the supported forms rather than silently doing something else.
 */
export function parseAsPathPattern(pattern: string, field = "asPathList.pattern"): AsPathMatcher {
  const text = pattern.trim();
  if (text === "^$") return { kind: "empty" };
  const asn = (value: string | undefined): number => validateAsn(Number(value), field);
  let match = /^_(\d{1,10})_$/u.exec(text);
  if (match) return { kind: "contains", asn: asn(match[1]) };
  match = /^\^(\d{1,10})_$/u.exec(text);
  if (match) return { kind: "starts-with", asn: asn(match[1]) };
  match = /^_(\d{1,10})\$$/u.exec(text);
  if (match) return { kind: "ends-with", asn: asn(match[1]) };
  match = /^\^(\d{1,10}(?: \d{1,10})*)\$$/u.exec(text);
  if (match) return { kind: "exact", asPath: match[1]!.split(" ").map((value) => asn(value)) };
  throw new ControlProtocolConfigurationError(
    `AS-path pattern '${pattern}' is not supported; use ^$, _<asn>_, ^<asn>_, _<asn>$ or ^<asn> <asn>$`,
    field,
  );
}

/** Render a matcher back to the canonical pattern a configuration shows. */
export function formatAsPathMatcher(matcher: AsPathMatcher): string {
  switch (matcher.kind) {
    case "empty": return "^$";
    case "contains": return `_${matcher.asn}_`;
    case "starts-with": return `^${matcher.asn}_`;
    case "ends-with": return `_${matcher.asn}$`;
    case "exact": return `^${matcher.asPath.join(" ")}$`;
    case "length": return `length ${matcher.operator} ${matcher.length}`;
  }
}

export function matchesAsPath(asPath: readonly number[], matcher: AsPathMatcher): boolean {
  switch (matcher.kind) {
    case "empty": return asPath.length === 0;
    case "contains": return asPath.includes(matcher.asn);
    case "starts-with": return asPath[0] === matcher.asn;
    case "ends-with": return asPath[asPath.length - 1] === matcher.asn;
    case "exact":
      return asPath.length === matcher.asPath.length && asPath.every((value, index) => value === matcher.asPath[index]);
    case "length":
      return matcher.operator === "eq" ? asPath.length === matcher.length
        : matcher.operator === "le" ? asPath.length <= matcher.length
          : asPath.length >= matcher.length;
  }
}

/**
 * `set as-path prepend <asn>...` — a bounded, explicit list. AS 0 is reserved
 * and an over-long prepend would distort best-path selection, so both are
 * rejected instead of being clamped.
 */
export function validateAsPathPrepend(asns: readonly number[], maximum: number, field = "routeMap.prependAsns"): void {
  if (!asns.length) throw new ControlProtocolConfigurationError("AS-path prepend needs at least one AS number", field);
  if (asns.length > maximum) {
    throw new ControlProtocolConfigurationError(`AS-path prepend accepts at most ${maximum} AS numbers`, field);
  }
  for (const asn of asns) validateAsn(asn, field);
}

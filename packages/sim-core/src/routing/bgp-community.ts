import { ControlProtocolConfigurationError, enforceStructuralLimit } from "../protocols/limits";

/**
 * Standard BGP communities as a deterministic, serializable educational model.
 *
 * A community is stored canonically as text — `65000:100` or a well-known name
 * — because that is what a `LabDocument`, a rendered configuration and a trace
 * all have to carry. The 32-bit value exists only to give the canonical sort a
 * stable total order, so the same input always produces byte-identical RIBs.
 *
 * Route-target extended communities are a *separate* attribute owned by the
 * VPNv4 address family. They are deliberately never mixed into this list: a
 * `set community` action can therefore never delete a route target.
 */
export type BgpCommunity = string;

export const BGP_WELL_KNOWN_COMMUNITIES = Object.freeze({
  internet: 0x0000_0000,
  "no-export": 0xffff_ff01,
  "no-advertise": 0xffff_ff02,
});

export type BgpWellKnownCommunity = keyof typeof BGP_WELL_KNOWN_COMMUNITIES;

const WELL_KNOWN_BY_VALUE: ReadonlyMap<number, BgpWellKnownCommunity> = new Map(
  (Object.entries(BGP_WELL_KNOWN_COMMUNITIES) as [BgpWellKnownCommunity, number][])
    .map(([name, value]) => [value, name]),
);

/** `65000:100` or a well-known name; anything else is rejected, never guessed. */
export function parseBgpCommunity(value: string, field = "community"): BgpCommunity {
  const text = value.trim().toLowerCase();
  if (text in BGP_WELL_KNOWN_COMMUNITIES) return text;
  const match = /^(\d{1,10}):(\d{1,10})$/u.exec(text);
  if (!match) {
    throw new ControlProtocolConfigurationError(
      `Community '${value}' must be <0-65535>:<0-65535>, 'internet', 'no-export' or 'no-advertise'`,
      field,
    );
  }
  const [asn, assigned] = [Number(match[1]), Number(match[2])];
  if (asn > 65_535 || assigned > 65_535) {
    throw new ControlProtocolConfigurationError(`Community '${value}' parts must be between 0 and 65535`, field);
  }
  const canonical = `${asn}:${assigned}`;
  // 65535:65281 and no-export name the same attribute; keep exactly one form.
  return WELL_KNOWN_BY_VALUE.get(bgpCommunityValue(canonical)) ?? canonical;
}

/** The 32-bit attribute value, used only for the canonical ordering. */
export function bgpCommunityValue(community: BgpCommunity): number {
  const wellKnown = BGP_WELL_KNOWN_COMMUNITIES[community as BgpWellKnownCommunity];
  if (wellKnown !== undefined) return wellKnown;
  const [asn, assigned] = community.split(":").map(Number);
  return (((asn ?? 0) << 16) >>> 0) + (assigned ?? 0);
}

/** Deduplicate, validate and sort — the one canonical community-set builder. */
export function normalizeBgpCommunities(
  values: readonly string[] | undefined,
  field = "communities",
): BgpCommunity[] {
  if (!values?.length) return [];
  const unique = new Set<BgpCommunity>();
  for (const value of values) unique.add(parseBgpCommunity(value, field));
  enforceStructuralLimit("maximumBgpCommunitiesPerRoute", unique.size);
  return [...unique].sort((a, b) => bgpCommunityValue(a) - bgpCommunityValue(b));
}

export function hasBgpCommunity(communities: readonly string[], community: BgpWellKnownCommunity): boolean {
  return communities.includes(community);
}

/** `no-advertise` suppresses every peer; `no-export` only leaves the local AS. */
export function communityBlocksAdvertisement(
  communities: readonly string[],
  peerIsIbgp: boolean,
): BgpWellKnownCommunity | undefined {
  if (hasBgpCommunity(communities, "no-advertise")) return "no-advertise";
  if (!peerIsIbgp && hasBgpCommunity(communities, "no-export")) return "no-export";
  return undefined;
}

export function formatBgpCommunities(communities: readonly string[]): string {
  return communities.join(" ");
}

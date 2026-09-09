/**
 * Reads the `<PACKETTRACER5_ACTIVITY>` wrapper that a `.pka` uses to carry
 * several networks at once — typically the state the student starts from, the
 * state they are working in, and the completed answer.
 *
 * Role inference is deliberately conservative. Packet Tracer names the wrapper
 * element around each network rather than tagging the network itself, and those
 * wrapper names have moved between releases, so a role is only claimed when a
 * wrapper name clearly says so. Everything else stays `unknown` and is offered
 * to the user by position instead. This matters because an answer network must
 * never be selected without the user choosing it: guessing "current" wrong and
 * silently importing the solved topology would hand a student the answers.
 */
import type { PacketTracerLimits } from "../config/limits";
import type {
  PacketTracerActivity,
  PacketTracerActivityNetwork,
  PacketTracerNetworkRole,
  PacketTracerParseWarning,
} from "./packet-tracer-document";
import { childText, descendantsNamed, type XmlLike } from "./tree";
import { NETWORK_ROOT } from "../container/detect";

const MAX_INSTRUCTION_CHARS = 20_000;

/** Wrapper-name fragments that identify a role, most specific first. */
const ROLE_HINTS: readonly (readonly [PacketTracerNetworkRole, readonly string[]])[] = [
  ["answer", ["ANSWER", "SOLUTION", "COMPLETED"]],
  ["initial", ["INITIAL", "START", "BEGIN"]],
  ["current", ["CURRENT", "USER", "WORKING", "SAVED"]],
];

/** Infer a role from the chain of element names enclosing a network. */
export function inferNetworkRole(ancestorNames: readonly string[]): PacketTracerNetworkRole {
  const haystack = ancestorNames.join(" ").toUpperCase();
  for (const [role, fragments] of ROLE_HINTS) {
    if (fragments.some((fragment) => haystack.includes(fragment))) return role;
  }
  return "unknown";
}

const ROLE_LABELS: Readonly<Record<PacketTracerNetworkRole, string>> = {
  initial: "Initial Network",
  answer: "Answer Network",
  current: "Current Network",
  unknown: "Network",
};

export interface LocatedNetwork {
  readonly node: XmlLike;
  readonly role: PacketTracerNetworkRole;
  readonly name: string;
}

const upperName = (node: XmlLike): string => {
  const colon = node.name.lastIndexOf(":");
  return (colon >= 0 ? node.name.slice(colon + 1) : node.name).toUpperCase();
};

/**
 * Find every network document inside an activity, remembering the wrapper names
 * above each one so a role can be inferred. Walks iteratively with an explicit
 * ancestor trail rather than recursing, so depth stays bounded.
 */
export function locateActivityNetworks(
  root: XmlLike,
  limits: PacketTracerLimits,
): { readonly networks: readonly LocatedNetwork[]; readonly warnings: readonly PacketTracerParseWarning[] } {
  const warnings: PacketTracerParseWarning[] = [];
  const found: LocatedNetwork[] = [];
  const stack: { node: XmlLike; trail: string[] }[] = [{ node: root, trail: [upperName(root)] }];
  const roleCounts = new Map<PacketTracerNetworkRole, number>();

  while (stack.length > 0) {
    const { node, trail } = stack.pop()!;
    if (found.length >= limits.maxSnapshots) break;

    if (node !== root && upperName(node) === NETWORK_ROOT) {
      const role = inferNetworkRole(trail);
      const seen = (roleCounts.get(role) ?? 0) + 1;
      roleCounts.set(role, seen);
      const label = ROLE_LABELS[role];
      found.push({ node, role, name: seen > 1 ? `${label} ${seen}` : label });
      continue;
    }
    // A NETWORK element directly under the activity root is the activity's own
    // working copy when no PACKETTRACER5 wrapper is present.
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index]!;
      stack.push({ node: child, trail: [...trail, upperName(child)] });
    }
  }

  if (found.length === 0) {
    const bare = descendantsNamed(root, "NETWORK", 1);
    if (bare.length > 0) {
      warnings.push({
        code: "activity-network-unwrapped",
        message: "The activity carries a network with no recognisable role wrapper; it is offered as an unnamed network.",
      });
    }
  }

  const unknowns = found.filter((network) => network.role === "unknown").length;
  if (unknowns > 0 && found.length > 1) {
    warnings.push({
      code: "activity-role-unknown",
      message: `${unknowns} of ${found.length} networks in this activity do not declare a recognisable role. `
        + "Check the device and link counts before importing.",
    });
  }

  return { networks: found, warnings };
}

/**
 * Activity metadata. Only a title and plain-text instructions are read: Packet
 * Tracer's own grading rules are a different model from ours and are reported
 * as unsupported rather than translated into something that merely resembles
 * them.
 */
export function readActivityMetadata(
  root: XmlLike,
  networks: readonly PacketTracerActivityNetwork[],
): PacketTracerActivity {
  const title = childText(root, "TITLE")
    ?? descendantsNamed(root, "ACTIVITY_TITLE", 1)[0]?.text.trim();
  const rawInstructions = descendantsNamed(root, "INSTRUCTIONS", 1)[0]?.text.trim()
    ?? descendantsNamed(root, "DESCRIPTION", 1)[0]?.text.trim();
  const instructions = rawInstructions !== undefined && rawInstructions.length > 0
    ? rawInstructions.slice(0, MAX_INSTRUCTION_CHARS)
    : undefined;

  return {
    title: title !== undefined && title.length > 0 ? title : undefined,
    instructions,
    networks,
  };
}

/**
 * Reads `<LINK>` elements into `PacketTracerLink`s.
 *
 * A `<CABLE>` names its two endpoints with *four* sibling elements in document
 * order — `FROM`, `PORT`, `TO`, `PORT` — so the two `PORT`s are distinguished
 * by position alone. Rather than index blindly into `children[1]` and
 * `children[3]`, which a single extra sibling in some other release would break
 * silently, this walks the children in order and binds each `PORT` to whichever
 * endpoint was named most recently. An unbound or ambiguous endpoint is
 * reported, never guessed.
 */
import type { PacketTracerLimits } from "../config/limits";
import type { PacketTracerLink, PacketTracerParseWarning } from "./packet-tracer-document";
import { childNamed, childNamedAny, childText, childrenNamed, descendantsNamed, type XmlLike } from "./tree";

const upperName = (node: XmlLike): string => {
  const colon = node.name.lastIndexOf(":");
  return (colon >= 0 ? node.name.slice(colon + 1) : node.name).toUpperCase();
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value.trim() : undefined;

interface CableEndpoints {
  readonly sourceDeviceId?: string;
  readonly sourceInterface?: string;
  readonly targetDeviceId?: string;
  readonly targetInterface?: string;
  /** A `PORT` appeared with no preceding `FROM`/`TO` to attach it to. */
  readonly strayPorts: number;
}

/** Bind each `PORT` to the endpoint named immediately before it. */
function readCableEndpoints(cable: XmlLike): CableEndpoints {
  let sourceDeviceId: string | undefined;
  let sourceInterface: string | undefined;
  let targetDeviceId: string | undefined;
  let targetInterface: string | undefined;
  let pending: "source" | "target" | undefined;
  let strayPorts = 0;

  for (const child of cable.children) {
    const name = upperName(child);
    if (name === "FROM") {
      sourceDeviceId = nonEmpty(child.text);
      pending = "source";
      continue;
    }
    if (name === "TO") {
      targetDeviceId = nonEmpty(child.text);
      pending = "target";
      continue;
    }
    if (name !== "PORT") continue;

    const value = nonEmpty(child.text);
    if (pending === "source" && sourceInterface === undefined) sourceInterface = value;
    else if (pending === "target" && targetInterface === undefined) targetInterface = value;
    else strayPorts++;
    pending = undefined;
  }

  return { sourceDeviceId, sourceInterface, targetDeviceId, targetInterface, strayPorts };
}

export interface ParsedLinks {
  readonly links: readonly PacketTracerLink[];
  readonly warnings: readonly PacketTracerParseWarning[];
}

/**
 * Parse a `<LINKS>` container. `knownDeviceIds` lets a cable pointing at a
 * device that was dropped (or never existed) be reported rather than producing
 * a dangling link the importer would have to discard later without explanation.
 */
export function parseLinks(
  linksNode: XmlLike,
  knownDeviceIds: ReadonlySet<string>,
  limits: PacketTracerLimits,
): ParsedLinks {
  const warnings: PacketTracerParseWarning[] = [];
  const links: PacketTracerLink[] = [];
  const all = childrenNamed(linksNode, "LINK");

  if (all.length > limits.maxLinks) {
    warnings.push({
      code: "link-limit",
      message: `The network declares ${all.length} links; only the first ${limits.maxLinks} were read.`,
    });
  }

  for (const [index, link] of all.slice(0, limits.maxLinks).entries()) {
    const cable = childNamed(link, "CABLE");
    if (!cable) {
      warnings.push({ code: "link-without-cable", message: `Link ${index + 1} has no CABLE block and was skipped.` });
      continue;
    }

    const endpoints = readCableEndpoints(cable);
    const id = `pt-link-${index + 1}`;

    if (endpoints.strayPorts > 0) {
      warnings.push({
        code: "link-port-ambiguous",
        message: `Link ${index + 1} lists ${endpoints.strayPorts} port name(s) that could not be attached to an endpoint.`,
      });
    }

    if (endpoints.sourceDeviceId === undefined || endpoints.targetDeviceId === undefined) {
      warnings.push({
        code: "link-endpoint-missing",
        message: `Link ${index + 1} does not name both of its devices and was skipped.`,
      });
      continue;
    }
    for (const deviceId of [endpoints.sourceDeviceId, endpoints.targetDeviceId]) {
      if (!knownDeviceIds.has(deviceId)) {
        warnings.push({
          code: "link-endpoint-unknown",
          message: `Link ${index + 1} refers to device ${deviceId}, which is not in this network.`,
          deviceId,
        });
      }
    }
    if (!knownDeviceIds.has(endpoints.sourceDeviceId) || !knownDeviceIds.has(endpoints.targetDeviceId)) continue;

    if (endpoints.sourceInterface === undefined || endpoints.targetInterface === undefined) {
      warnings.push({
        code: "link-interface-missing",
        message: `Link ${index + 1} does not name both of its interfaces; it will need manual mapping.`,
      });
    }

    links.push({
      id,
      sourceDeviceId: endpoints.sourceDeviceId,
      sourceInterface: endpoints.sourceInterface,
      targetDeviceId: endpoints.targetDeviceId,
      targetInterface: endpoints.targetInterface,
      // The inner CABLE TYPE is the connector (eStraightThrough); the outer
      // LINK TYPE is the medium (eCopper).
      packetTracerCableType: nonEmpty(childText(cable, "TYPE")),
      packetTracerMediaType: nonEmpty(childText(link, "TYPE")),
    });
  }

  return { links, warnings };
}

/** Locate the `<LINKS>` container beneath a network, tolerating wrappers. */
export function findLinksContainer(network: XmlLike): XmlLike | undefined {
  return childNamedAny(network, "LINKS") ?? descendantsNamed(network, "LINKS", 1)[0];
}

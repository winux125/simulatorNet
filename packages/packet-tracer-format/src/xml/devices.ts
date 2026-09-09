/**
 * Reads `<DEVICE>` elements into `PacketTracerDevice`s.
 *
 * Two things about the real format shape this code:
 *
 * A `<PORT>` carries no name. Packet Tracer derives interface names from the
 * chassis model and slot order at load time, so the file's only authoritative
 * statement of "this interface is called FastEthernet0/1" is a `<CABLE>`
 * endpoint. Ports are therefore counted (to size a hardware profile and to
 * prove a link's interface really exists) while names come from links — see
 * `links.ts`. Inventing names from slot arithmetic would risk attaching a cable
 * to the wrong port, which the importer must never do silently.
 *
 * Addressing lives in two places: the per-port `IP`/`SUBNET`/`PORT_DHCP_ENABLE`
 * and the device-level `GATEWAY`/`GATEWAYV6`. Both are read, because a host
 * with DHCP on still records the gateway it was given.
 */
import type { PacketTracerLimits } from "../config/limits";
import type {
  PacketTracerDevice,
  PacketTracerHostConfiguration,
  PacketTracerParseWarning,
} from "./packet-tracer-document";
import {
  childNamed,
  childNamedAny,
  childText,
  childrenNamed,
  descendantsNamed,
  type XmlLike,
} from "./tree";

const MAX_CONFIG_CHARS = 512 * 1_024;

/** Every `<PORT>` under the chassis module tree, in document order. */
function collectPorts(engine: XmlLike, limit: number): XmlLike[] {
  const module = childNamed(engine, "MODULE");
  return module ? descendantsNamed(module, "PORT", limit) : [];
}

/** Join `<RUNNINGCONFIG><LINE>` children back into configuration text. */
function readConfigLines(engine: XmlLike, elementName: string): string | undefined {
  const block = childNamed(engine, elementName);
  if (!block) return undefined;
  const lines = childrenNamed(block, "LINE").map((line) => line.text);
  if (lines.length === 0) return undefined;
  const text = lines.join("\n");
  return text.length > MAX_CONFIG_CHARS ? text.slice(0, MAX_CONFIG_CHARS) : text;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value.trim() : undefined;

function readBoolean(node: XmlLike, name: string): boolean | undefined {
  const value = childText(node, name)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** IPv6 addresses are stored as repeated children under `IPV6_ADDRESSES`. */
function readIpv6Addresses(port: XmlLike): string[] {
  const container = childNamed(port, "IPV6_ADDRESSES");
  if (!container) return [];
  const values = container.children
    .map((child) => child.text.trim())
    .filter((value) => value.length > 0);
  // Some releases store a single address as the container's own text.
  const own = container.text.trim();
  if (values.length === 0 && own.length > 0) return [own];
  return values;
}

/**
 * Host addressing, taken from the first port that actually declares any. A
 * chassis lists every physical port including ones that were never configured,
 * so picking the first port unconditionally would report an empty address for a
 * host whose second interface is the configured one.
 */
function readHostConfiguration(
  engine: XmlLike,
  ports: readonly XmlLike[],
): PacketTracerHostConfiguration | undefined {
  const gateway = nonEmpty(childText(engine, "GATEWAY"));
  const ipv6Gateway = nonEmpty(childText(engine, "GATEWAYV6"));

  for (const port of ports) {
    const ipv4 = nonEmpty(childText(port, "IP"));
    const subnetMask = nonEmpty(childText(port, "SUBNET"));
    const dhcpEnabled = readBoolean(port, "PORT_DHCP_ENABLE");
    const ipv6 = readIpv6Addresses(port);
    const dns = [nonEmpty(childText(port, "PORT_DNS"))].filter((value): value is string => value !== undefined);
    const portGateway = nonEmpty(childText(port, "PORT_GATEWAY"));

    const declaresSomething = ipv4 !== undefined
      || dhcpEnabled === true
      || ipv6.length > 0
      || dns.length > 0;
    if (!declaresSomething) continue;

    return {
      ipv4,
      subnetMask,
      gateway: portGateway ?? gateway,
      dhcpEnabled,
      ipv6: ipv6.length > 0 ? ipv6 : undefined,
      ipv6Gateway,
      dns: dns.length > 0 ? dns : undefined,
    };
  }

  // No port declared addressing, but a device-level gateway is still worth
  // preserving rather than dropping on the floor.
  if (gateway !== undefined || ipv6Gateway !== undefined) {
    return { gateway, ipv6Gateway };
  }
  return undefined;
}

function readCoordinates(device: XmlLike): { x?: number; y?: number } {
  const logical = childNamed(childNamed(device, "WORKSPACE") ?? device, "LOGICAL")
    ?? childNamed(device, "LOGICAL");
  if (!logical) return {};
  const parse = (name: string): number | undefined => {
    const raw = childText(logical, name);
    if (raw === undefined) return undefined;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  return { x: parse("X"), y: parse("Y") };
}

export interface ParsedDevices {
  readonly devices: readonly PacketTracerDevice[];
  readonly warnings: readonly PacketTracerParseWarning[];
}

/** Parse a `<DEVICES>` container. Interface names are attached later. */
export function parseDevices(
  devicesNode: XmlLike,
  limits: PacketTracerLimits,
): ParsedDevices {
  const warnings: PacketTracerParseWarning[] = [];
  const devices: PacketTracerDevice[] = [];
  const seenIds = new Set<string>();
  const all = childrenNamed(devicesNode, "DEVICE");

  if (all.length > limits.maxDevices) {
    warnings.push({
      code: "device-limit",
      message: `The network declares ${all.length} devices; only the first ${limits.maxDevices} were read.`,
    });
  }

  for (const [index, device] of all.slice(0, limits.maxDevices).entries()) {
    const engine = childNamed(device, "ENGINE");
    if (!engine) {
      warnings.push({ code: "device-without-engine", message: `Device ${index + 1} has no ENGINE block and was skipped.` });
      continue;
    }

    const typeNode = childNamed(engine, "TYPE");
    const hostname = nonEmpty(childText(engine, "NAME"));
    // A device without a save-ref-id cannot be a link endpoint, but it is still
    // a real device: give it a stable synthetic id rather than dropping it.
    const declaredId = nonEmpty(childText(engine, "SAVE_REF_ID"));
    let id = declaredId ?? `pt-device-${index + 1}`;
    if (seenIds.has(id)) {
      warnings.push({
        code: "duplicate-device-id",
        message: `Two devices share the reference ${id}; the second was given a distinct id.`,
        deviceId: id,
      });
      id = `${id}#${index + 1}`;
    }
    seenIds.add(id);

    const ports = collectPorts(engine, limits.maxDevices * 64);
    const { x, y } = readCoordinates(device);

    devices.push({
      id,
      hostname,
      packetTracerType: nonEmpty(typeNode?.text),
      packetTracerModel: nonEmpty(typeNode?.attributes.model),
      x,
      y,
      interfaces: [],
      portCount: ports.length,
      runningConfig: readConfigLines(engine, "RUNNINGCONFIG")
        ?? readConfigLines(engine, "STARTUPCONFIG"),
      hostConfiguration: readHostConfiguration(engine, ports),
    });
  }

  return { devices, warnings };
}

/** Locate the `<DEVICES>` container beneath a network, tolerating wrappers. */
export function findDevicesContainer(network: XmlLike): XmlLike | undefined {
  return childNamedAny(network, "DEVICES") ?? descendantsNamed(network, "DEVICES", 1)[0];
}

import { normalizeInterfaceName } from "@sim/contracts";
import {
  type Device,
  EndHost,
  EthernetBridge,
  L2Switch,
  Laptop,
  Layer3Switch,
  Pc,
  Router,
  Server,
  normalizeIpv6,
  validateIpv6PrefixLength,
  supportsCdp,
} from "@sim/sim-core";
import { ValidationError } from "../errors/errors";
import type { DeviceFilter } from "../types";

export function isSwitch(d: Device): d is L2Switch {
  return d instanceof L2Switch;
}
export function isRouter(d: Device): d is Router {
  return d instanceof Router;
}
export function isLayer3Switch(d: Device): d is Layer3Switch {
  return d instanceof Layer3Switch;
}
export function isRoutingDevice(d: Device): d is Router | Layer3Switch {
  return isRouter(d) || isLayer3Switch(d);
}
export function isBridge(d: Device): d is EthernetBridge {
  return d instanceof EthernetBridge;
}
export function isEndHost(d: Device): d is EndHost {
  return d instanceof EndHost;
}
export function isPc(d: Device): d is Pc | Laptop {
  return d instanceof Pc || d instanceof Laptop;
}
export function isServer(d: Device): d is Server {
  return d instanceof Server;
}

/** Router and L3 Switch: the two devices that can run an OSPF process. */
export function isOspfDevice(d: Device): d is Router | Layer3Switch {
  return (isRouter(d) && d.deviceType === "router") || isLayer3Switch(d);
}

/**
 * Devices that have a management plane: Router, L2 Switch, L3 Switch and
 * Firewall. A Hub, Cloud, Access Point or end host deliberately has none.
 */
export function isManagedDevice(d: Device): d is Router | L2Switch {
  if (isSwitch(d)) return true;
  return isRouter(d) && (d.deviceType === "router" || d.deviceType === "firewall");
}

/** Devices that speak the Cisco-like CDP subset. */
export function isCdpDevice(d: Device): boolean {
  return supportsCdp(d.deviceType) && (isRouter(d) || isSwitch(d));
}

/** Devices that speak LLDP: every CDP speaker plus the vendor-neutral Server. */
export function isLldpDevice(d: Device): boolean {
  return isCdpDevice(d) || isServer(d);
}

export function deviceMatches(filter: DeviceFilter | undefined, device: Device): boolean {
  if (!filter || filter === "any") return true;
  if (filter === "switch") return isSwitch(device);
  if (filter === "router") return isRoutingDevice(device);
  if (filter === "l3-switch") return isLayer3Switch(device);
  if (filter === "l2-switch") return isSwitch(device) && !isLayer3Switch(device);
  if (filter === "managed") return isManagedDevice(device);
  if (filter === "bridge") return isBridge(device);
  if (filter === "pc") return isPc(device);
  if (filter === "server") return isServer(device);
  if (filter === "host") return isEndHost(device);
  if (filter === "ospf") return isOspfDevice(device);
  if (filter === "cdp") return isCdpDevice(device);
  if (filter === "lldp") return isLldpDevice(device);
  return !isEndHost(device);
}

/** Every port a range command must touch; a single interface is a range of one. */
export function contextPorts(ctx: { physical: string; range: string[] | undefined }): string[] {
  return ctx.range ?? [ctx.physical];
}

/**
 * Expand `Gi0/1 - 4` / `Gi0/1 - Gi0/4` into concrete interface names. Every name
 * must resolve, so a range is validated before anything is configured.
 */
export function expandInterfaceRange(device: Device, spec: string): string[] {
  const ports: string[] = [];
  for (const segment of spec.split(",")) {
    const match = /^(.+?\d)\s*-\s*(\d+|[a-z]+\d+(?:\/\d+)*)$/i.exec(segment.trim());
    const startToken = match?.[1] ?? segment.trim();
    const start = resolveInterface(device, startToken);
    if (!start || start.subNumber !== undefined) throw new ValidationError(`Interface ${startToken} not found.`);
    if (!match) { ports.push(start.physical); continue; }
    const [, prefix, firstText] = /^(.*?)(\d+)$/.exec(start.physical)!;
    const endToken = match[2]!;
    const end = /^\d+$/.test(endToken) ? `${prefix}${endToken}` : resolveInterface(device, endToken)?.physical;
    const last = end && /^(.*?)(\d+)$/.exec(end);
    if (!last || last[1] !== prefix || Number(last[2]) < Number(firstText)
     ) {
      throw new ValidationError(`Invalid interface range '${segment}'.`);
    }
    for (let n = Number(firstText); n <= Number(last[2]); n++) {
      const name = `${prefix}${n}`;
      if (!device.interfaces.has(name)) throw new ValidationError(`Interface ${name} not found.`);
      ports.push(name);
    }
  }
  return [...new Set(ports)];
}

/**
 * Resolve a typed interface name to an actual physical port on the device,
 * accepting abbreviations ("gi0/1" == "GigabitEthernet0/1") and an optional
 * `.sub` suffix (stripped; returned separately).
 */
export function resolveInterface(
  device: Device,
  typed: string,
): { physical: string; subLabel: string; subNumber: number | undefined } | undefined {
  const dot = typed.indexOf(".");
  const base = dot >= 0 ? typed.slice(0, dot) : typed;
  const subPart = dot >= 0 ? typed.slice(dot + 1) : undefined;
  const subNumber = subPart !== undefined ? Number(subPart) : undefined;
  if (subPart !== undefined && (!/^\d+$/.test(subPart) || !Number.isSafeInteger(subNumber))) return undefined;

  const wanted = normalizeInterfaceName(base);
  for (const real of device.interfaces.keys()) {
    if (normalizeInterfaceName(real) === wanted) {
      return {
        physical: real,
        subLabel: subPart !== undefined ? `${real}.${subPart}` : real,
        subNumber,
      };
    }
  }
  return undefined;
}

export function parseVlanId(token: string): number {
  const id = Number(token);
  if (!Number.isInteger(id) || id < 1 || id > 4094) {
    throw new ValidationError("VLAN ID must be between 1 and 4094.");
  }
  return id;
}

/** Parse a comma/space list like "10,20,30" into sorted unique VLAN ids. */
export function parseVlanList(text: string): number[] {
  const ids = text
    .split(/[,\s]+/)
    .filter((t) => t.length > 0)
    .map(parseVlanId);
  return [...new Set(ids)].sort((a, b) => a - b);
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export function parseIpv4(token: string): string {
  const m = IPV4_RE.exec(token);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) {
    throw new ValidationError(`Invalid IP address ${token}`);
  }
  return token;
}

export function parseIpv6(token: string): string {
  try {
    return normalizeIpv6(token);
  } catch {
    throw new ValidationError(`Invalid IPv6 address ${token}`);
  }
}

export function parseIpv6Prefix(token: string): { network: string; prefixLength: number } {
  const slash = token.lastIndexOf("/");
  if (slash <= 0) throw new ValidationError(`IPv6 prefix must use address/length notation: ${token}`);
  const network = parseIpv6(token.slice(0, slash));
  const prefixLength = Number(token.slice(slash + 1));
  try {
    validateIpv6PrefixLength(prefixLength);
  } catch {
    throw new ValidationError("IPv6 prefix length must be between 0 and 128.");
  }
  return { network, prefixLength };
}

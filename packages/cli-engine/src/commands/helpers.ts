import {
  type Device,
  EndHost,
  EthernetBridge,
  L2Switch,
  Layer3Switch,
  Pc,
  Router,
  Server,
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
export function isPc(d: Device): d is Pc {
  return d instanceof Pc;
}
export function isServer(d: Device): d is Server {
  return d instanceof Server;
}

export function deviceMatches(filter: DeviceFilter | undefined, device: Device): boolean {
  if (!filter || filter === "any") return true;
  if (filter === "switch") return isSwitch(device);
  if (filter === "router") return isRoutingDevice(device);
  if (filter === "l3-switch") return isLayer3Switch(device);
  if (filter === "bridge") return isBridge(device);
  if (filter === "pc") return isPc(device);
  if (filter === "server") return isServer(device);
  if (filter === "host") return isEndHost(device);
  return !isEndHost(device);
}

/** Normalize a typed interface token for comparison (lowercase, no spaces). */
function ifaceKey(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/** Expand common Cisco interface abbreviations at the start of a key. */
function expandAbbrev(key: string): string {
  return key
    .replace(/^gi(?!gabitethernet)/, "gigabitethernet")
    .replace(/^fa(?!stethernet)/, "fastethernet")
    .replace(/^eth(?!ernet)/, "ethernet");
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
  if (subPart !== undefined && !Number.isInteger(subNumber)) return undefined;

  const wanted = expandAbbrev(ifaceKey(base));
  for (const real of device.interfaces.keys()) {
    if (expandAbbrev(ifaceKey(real)) === wanted) {
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

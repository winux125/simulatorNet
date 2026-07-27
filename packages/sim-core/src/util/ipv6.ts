import type { Mac } from "./mac";
import { normalizeMac } from "./mac";

/** Canonical, compressed lowercase IPv6 text. */
export type Ipv6 = string;

const MAX_IPV6 = (1n << 128n) - 1n;

export const IPV6_UNSPECIFIED: Ipv6 = "::";
export const IPV6_LOOPBACK: Ipv6 = "::1";
export const IPV6_ALL_NODES: Ipv6 = "ff02::1";
export const IPV6_ALL_ROUTERS: Ipv6 = "ff02::2";

export function ipv6ToBigInt(input: string): bigint {
  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.includes("%")) throw new Error(`Invalid IPv6 address: ${input}`);
  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && doubleColon !== value.lastIndexOf("::")) {
    throw new Error(`Invalid IPv6 address: ${input}`);
  }

  const [rawLeft, rawRight] = doubleColon === -1
    ? [value, ""]
    : [value.slice(0, doubleColon), value.slice(doubleColon + 2)];
  const left = parseIpv6Side(rawLeft, input);
  const right = parseIpv6Side(rawRight, input);
  const missing = 8 - left.length - right.length;
  if ((doubleColon === -1 && missing !== 0) || (doubleColon !== -1 && missing < 1)) {
    throw new Error(`Invalid IPv6 address: ${input}`);
  }
  const words = doubleColon === -1
    ? left
    : [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) throw new Error(`Invalid IPv6 address: ${input}`);
  return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
}

export function bigIntToIpv6(value: bigint): Ipv6 {
  if (value < 0n || value > MAX_IPV6) throw new Error(`Invalid IPv6 integer: ${value}`);
  const words = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & 0xffffn));

  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < words.length;) {
    if (words[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < words.length && words[end] === 0) end++;
    const length = end - start;
    if (length >= 2 && length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
    start = end;
  }

  if (bestStart === -1) return words.map((word) => word.toString(16)).join(":");
  const left = words.slice(0, bestStart).map((word) => word.toString(16)).join(":");
  const right = words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(":");
  return `${left}::${right}`;
}

export function normalizeIpv6(value: string): Ipv6 {
  return bigIntToIpv6(ipv6ToBigInt(value));
}

export function validateIpv6PrefixLength(prefixLength: number): number {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
    throw new Error(`Invalid IPv6 prefix length: ${prefixLength}`);
  }
  return prefixLength;
}

export function ipv6PrefixMask(prefixLength: number): bigint {
  validateIpv6PrefixLength(prefixLength);
  return prefixLength === 0 ? 0n : (MAX_IPV6 << BigInt(128 - prefixLength)) & MAX_IPV6;
}

export function ipv6Network(address: Ipv6, prefixLength: number): Ipv6 {
  return bigIntToIpv6(ipv6ToBigInt(address) & ipv6PrefixMask(prefixLength));
}

export function ipv6InPrefix(address: Ipv6, network: Ipv6, prefixLength: number): boolean {
  const mask = ipv6PrefixMask(prefixLength);
  return (ipv6ToBigInt(address) & mask) === (ipv6ToBigInt(network) & mask);
}

export function ipv6SameSubnet(left: Ipv6, right: Ipv6, prefixLength: number): boolean {
  return ipv6InPrefix(left, right, prefixLength);
}

export function isIpv6Unspecified(address: Ipv6): boolean {
  return ipv6ToBigInt(address) === 0n;
}

export function isIpv6Loopback(address: Ipv6): boolean {
  return ipv6ToBigInt(address) === 1n;
}

export function isIpv6LinkLocal(address: Ipv6): boolean {
  return ipv6InPrefix(address, "fe80::", 10);
}

export function isIpv6Multicast(address: Ipv6): boolean {
  return ipv6InPrefix(address, "ff00::", 8);
}

export function isIpv6GlobalUnicast(address: Ipv6): boolean {
  return ipv6InPrefix(address, "2000::", 3);
}

export function ipv6MulticastMac(address: Ipv6): Mac {
  if (!isIpv6Multicast(address)) throw new Error(`${address} is not an IPv6 multicast address`);
  const low = Number(ipv6ToBigInt(address) & 0xffffffffn);
  return `33:33:${((low >>> 24) & 0xff).toString(16).padStart(2, "0")}:${((low >>> 16) & 0xff)
    .toString(16).padStart(2, "0")}:${((low >>> 8) & 0xff).toString(16).padStart(2, "0")}:${(low & 0xff)
    .toString(16).padStart(2, "0")}`;
}

export function solicitedNodeMulticast(address: Ipv6): Ipv6 {
  const low24 = ipv6ToBigInt(address) & 0xffffffn;
  return bigIntToIpv6(ipv6ToBigInt("ff02::1:ff00:0") | low24);
}

export function deterministicInterfaceIdentifier(mac: Mac): bigint {
  const octets = normalizeMac(mac).split(":").map((part) => Number.parseInt(part, 16));
  const eui = [
    octets[0]! ^ 0x02,
    octets[1]!,
    octets[2]!,
    0xff,
    0xfe,
    octets[3]!,
    octets[4]!,
    octets[5]!,
  ];
  return eui.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
}

export function deterministicLinkLocalAddress(mac: Mac): Ipv6 {
  return bigIntToIpv6(ipv6ToBigInt("fe80::") | deterministicInterfaceIdentifier(mac));
}

export function combineIpv6Prefix(prefix: Ipv6, prefixLength: number, interfaceIdentifier: bigint): Ipv6 {
  validateIpv6PrefixLength(prefixLength);
  if (prefixLength > 64) throw new Error("SLAAC prefixes longer than /64 are not supported");
  const network = ipv6ToBigInt(prefix) & ipv6PrefixMask(prefixLength);
  const hostBits = 128 - prefixLength;
  const hostMask = (1n << BigInt(hostBits)) - 1n;
  return bigIntToIpv6(network | (interfaceIdentifier & hostMask));
}

function parseIpv6Side(side: string, original: string): number[] {
  if (side === "") return [];
  const parts = side.split(":");
  const words: number[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.includes(".")) {
      if (index !== parts.length - 1) throw new Error(`Invalid IPv6 address: ${original}`);
      const octets = part.split(".");
      if (octets.length !== 4 || octets.some((octet) =>
        !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
        throw new Error(`Invalid IPv6 address: ${original}`);
      }
      words.push((Number(octets[0]) << 8) | Number(octets[1]));
      words.push((Number(octets[2]) << 8) | Number(octets[3]));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) throw new Error(`Invalid IPv6 address: ${original}`);
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

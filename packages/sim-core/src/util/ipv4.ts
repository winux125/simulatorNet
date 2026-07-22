/** An IPv4 address in dotted-decimal form: "192.168.1.1". */
export type Ipv4 = string;

export function ipToInt(ip: Ipv4): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${ip}`);
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function intToIp(value: number): Ipv4 {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

/** Accepts a prefix length (0-32) or a dotted mask; returns the 32-bit mask. */
export function maskToInt(mask: Ipv4 | number): number {
  if (typeof mask === "number") {
    if (!Number.isInteger(mask) || mask < 0 || mask > 32) {
      throw new Error(`Invalid prefix length: ${mask}`);
    }
    return mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
  }
  return ipToInt(mask);
}

/** Do two addresses share a network, given an already-resolved 32-bit mask? */
export function ipsShareNetwork(a: Ipv4, b: Ipv4, maskInt: number): boolean {
  return ((ipToInt(a) & maskInt) >>> 0) === ((ipToInt(b) & maskInt) >>> 0);
}

/** Convenience wrapper accepting a prefix length or dotted mask. */
export function sameSubnet(a: Ipv4, b: Ipv4, mask: Ipv4 | number): boolean {
  return ipsShareNetwork(a, b, maskToInt(mask));
}

export function networkAddress(ip: Ipv4, mask: Ipv4 | number): number {
  return (ipToInt(ip) & maskToInt(mask)) >>> 0;
}

import { z } from "zod";

/**
 * Primitive value schemas shared by the lab document, the protocol
 * configuration and the grading spec. They live in their own module so those
 * modules stay acyclic.
 */

export const Ipv4Schema = z.string().refine((value) => {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}, "Invalid IPv4 address");

export const PrefixLengthSchema = z.number().int().min(0).max(32);
export const Ipv6PrefixLengthSchema = z.number().int().min(0).max(128);
export const VlanIdSchema = z.number().int().min(1).max(4094);

export const Ipv6Schema = z.string().refine(isIpv6Text, "Invalid IPv6 address");
export const IpAddressSchema = z.union([Ipv4Schema, Ipv6Schema]);

export const Ipv4InterfaceConfigSchema = z.object({
  address: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
});
export type Ipv4InterfaceConfig = z.infer<typeof Ipv4InterfaceConfigSchema>;

export const Ipv6InterfaceAddressSchema = z.object({
  address: Ipv6Schema,
  prefixLength: Ipv6PrefixLengthSchema,
}).strict();
export type Ipv6InterfaceAddress = z.infer<typeof Ipv6InterfaceAddressSchema>;

/**
 * Address and port matchers shared by ACLs, NAT, firewall policies and QoS
 * class maps. They live in primitives so `qos.ts` and `lab.ts` stay acyclic.
 */
export const Ipv4AddressMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("host"), address: Ipv4Schema }).strict(),
  z.object({
    kind: z.literal("network"),
    address: Ipv4Schema,
    wildcard: Ipv4Schema,
  }).strict(),
]);

export const Ipv6AddressMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("host"), address: Ipv6Schema }).strict(),
  z.object({
    kind: z.literal("prefix"),
    address: Ipv6Schema,
    prefixLength: Ipv6PrefixLengthSchema,
  }).strict(),
]);

export const PortMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("eq"), port: z.number().int().min(1).max(65_535) }).strict(),
  z.object({
    kind: z.literal("range"),
    start: z.number().int().min(1).max(65_535),
    end: z.number().int().min(1).max(65_535),
  }).strict(),
]);

export const Ipv6CidrSchema = z.string().refine((value) => {
  const separator = value.lastIndexOf("/");
  if (separator <= 0) return false;
  return Ipv6Schema.safeParse(value.slice(0, separator)).success
    && Ipv6PrefixLengthSchema.safeParse(Number(value.slice(separator + 1))).success;
}, "Invalid IPv6 CIDR");

function isIpv6Text(input: string): boolean {
  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.includes("%")) return false;
  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && doubleColon !== value.lastIndexOf("::")) return false;
  const [leftText, rightText] = doubleColon === -1
    ? [value, ""]
    : [value.slice(0, doubleColon), value.slice(doubleColon + 2)];
  const left = ipv6Words(leftText);
  const right = ipv6Words(rightText);
  if (left === undefined || right === undefined) return false;
  const words = left + right;
  return doubleColon === -1 ? words === 8 : words < 8;
}

function ipv6Words(side: string): number | undefined {
  if (side === "") return 0;
  const parts = side.split(":");
  let words = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.includes(".")) {
      if (index !== parts.length - 1 || !Ipv4Schema.safeParse(part).success) return undefined;
      words += 2;
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
      words++;
    }
  }
  return words;
}

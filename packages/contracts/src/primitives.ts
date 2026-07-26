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
export const VlanIdSchema = z.number().int().min(1).max(4094);

export const Ipv4InterfaceConfigSchema = z.object({
  address: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
});
export type Ipv4InterfaceConfig = z.infer<typeof Ipv4InterfaceConfigSchema>;

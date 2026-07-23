import { z } from "zod";
import { Ipv4Schema, PrefixLengthSchema } from "./lab";

/**
 * Vendor-neutral, reusable host addressing contract. It is shared by the
 * browser worker, headless verifier and LabDocument adapters; transient DHCP
 * lease/runtime state is intentionally not represented here.
 */
export const HostStaticConfigurationSchema = z.object({
  address: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
  defaultGateway: Ipv4Schema.optional(),
  dnsServer: Ipv4Schema.optional(),
}).strict();
export type HostStaticConfiguration = z.infer<typeof HostStaticConfigurationSchema>;

export const HostIpConfigurationSchema = z.object({
  mode: z.enum(["static", "dhcp"]),
  address: Ipv4Schema.optional(),
  prefixLength: PrefixLengthSchema,
  defaultGateway: Ipv4Schema.optional(),
  dnsServer: Ipv4Schema.optional(),
}).strict();
export type HostIpConfiguration = z.infer<typeof HostIpConfigurationSchema>;

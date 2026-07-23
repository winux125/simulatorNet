import { z } from "zod";
import { DeviceTypeSchema } from "./devices";

/**
 * Serializable topology document. This is the vendor-neutral description of a
 * lab's wiring — shared by the browser topology editor, the API (stored as
 * JSONB) and the headless verifier. It contains no live simulation state.
 */

export const InterfaceSpecSchema = z.object({
  /** Interface name as shown in the CLI, e.g. "GigabitEthernet0/1". */
  id: z.string().min(1),
  /** Optional fixed MAC; if omitted the engine assigns one deterministically. */
  mac: z.string().optional(),
});
export type InterfaceSpec = z.infer<typeof InterfaceSpecSchema>;

export const NodeSpecSchema = z.object({
  id: z.string().min(1),
  kind: DeviceTypeSchema,
  name: z.string().optional(),
  /** Editor canvas position; irrelevant to simulation. */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  interfaces: z.array(InterfaceSpecSchema).default([]),
});
export type NodeSpec = z.infer<typeof NodeSpecSchema>;

export const LinkEndpointSchema = z.object({
  node: z.string().min(1),
  iface: z.string().min(1),
});
export type LinkEndpoint = z.infer<typeof LinkEndpointSchema>;

export const LinkSpecSchema = z.object({
  id: z.string().min(1),
  a: LinkEndpointSchema,
  b: LinkEndpointSchema,
  /** Optional deterministic propagation delay override, in nanoseconds. */
  propagationDelayNs: z.number().int().nonnegative().optional(),
});
export type LinkSpec = z.infer<typeof LinkSpecSchema>;

export const TopologySchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(NodeSpecSchema).default([]),
  links: z.array(LinkSpecSchema).default([]),
});
export type Topology = z.infer<typeof TopologySchema>;

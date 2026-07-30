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

/**
 * Documented deterministic link defaults. A link that omits them behaves like a
 * 100 Mbps cable with a 0.5 ms propagation delay and a 256-packet egress queue
 * per direction — an educational model, not a hardware measurement.
 */
export const DEFAULT_LINK_CAPACITY_BPS = 100_000_000;
export const DEFAULT_LINK_PROPAGATION_DELAY_NS = 500_000;
export const DEFAULT_LINK_QUEUE_LIMIT_PACKETS = 256;

export const LinkSpecSchema = z.object({
  id: z.string().min(1),
  a: LinkEndpointSchema,
  b: LinkEndpointSchema,
  /** Optional deterministic propagation delay override, in nanoseconds. */
  propagationDelayNs: z.number().int().nonnegative().optional(),
  /**
   * Deterministic link capacity in bits per second. It drives the educational
   * serialization delay, not a hardware throughput claim. Omitted = 100 Mbps.
   */
  capacityBps: z.number().int().min(1_000).max(100_000_000_000).optional(),
  /** Tail-drop depth of each egress direction. Omitted = 256 packets. */
  queueLimitPackets: z.number().int().min(1).max(4_096).optional(),
});
export type LinkSpec = z.infer<typeof LinkSpecSchema>;

export const TopologySchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(NodeSpecSchema).default([]),
  links: z.array(LinkSpecSchema).default([]),
});
export type Topology = z.infer<typeof TopologySchema>;

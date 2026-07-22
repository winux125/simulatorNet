import { z } from "zod";
import { TopologySchema } from "./topology";

/**
 * The saved lab document. Small and cheap to store: topology + per-device
 * configuration + the simulation seed. The server never stores VM memory —
 * it re-derives everything from this document during verification.
 */

export const DeviceConfigSchema = z.object({
  startupConfig: z.string().default(""),
  runningConfig: z.string().default(""),
});
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;

export const LabDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  topology: TopologySchema,
  /** Device id -> its startup/running configuration. */
  configurations: z.record(z.string(), DeviceConfigSchema).default({}),
  simulation: z.object({
    /** Seed for the deterministic PRNG; identical seed -> identical run. */
    seed: z.number().int().nonnegative(),
    /** Simulated time in nanoseconds at the moment of save. */
    time: z.number().nonnegative().default(0),
  }),
});
export type LabDocument = z.infer<typeof LabDocumentSchema>;

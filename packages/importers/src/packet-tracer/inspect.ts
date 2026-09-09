/**
 * The Packet Tracer entry point the import wizard uses.
 *
 * Split from `native.ts` purely so the dependency graph stays acyclic:
 * `plan.ts` needs the decoder+mapper, this needs both the mapper and the
 * planner, and nothing needs this.
 */
import { planFromParsed } from "../plan/plan";
import type { ImportPlan, ImportSource } from "../types";
import {
  readPacketTracerSource,
  type PacketTracerInspectOptions,
  type PacketTracerSourceRead,
} from "./native";

export interface PacketTracerInspection extends PacketTracerSourceRead {
  readonly plan: ImportPlan;
}

/**
 * Decode and inspect a Packet Tracer file. Produces a plan for the selected
 * network plus the summaries needed to offer a different one; re-run with
 * `networkId` when the user picks another.
 */
export async function inspectPacketTracerFile(
  source: ImportSource,
  options: PacketTracerInspectOptions = {},
): Promise<PacketTracerInspection> {
  const read = await readPacketTracerSource(source, options);
  return { ...read, plan: planFromParsed(read.parsed, source.filename) };
}

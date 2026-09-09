/**
 * Locates *real* Packet Tracer containers — files genuinely written by Cisco
 * Packet Tracer, as opposed to the synthetic-format fixtures the round-trip
 * tests build.
 *
 * They are never committed: their provenance is third-party and redistribution
 * is not established, so they live in an ignored directory (or wherever
 * `PACKET_TRACER_REAL_FIXTURES_DIR` points) and the suites that use them report
 * honestly when they are absent. Synthetic fixtures prove the crypto, the
 * container and the parser; only these prove compatibility with Cisco's own
 * XML.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_FIXTURE_ENV = "PACKET_TRACER_REAL_FIXTURES_DIR";

const DEFAULT_DIRECTORY = fileURLToPath(
  new URL("../../../../.local-fixtures/packet-tracer/", import.meta.url),
);

export interface RealPacketTracerFixture {
  readonly path: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

function fixtureDirectory(): string {
  const configured = process.env[REAL_FIXTURE_ENV];
  return configured !== undefined && configured.trim() !== "" ? configured : DEFAULT_DIRECTORY;
}

/**
 * The first real fixture with the requested extension, or undefined when none
 * is available. Never throws for a missing directory: absence is a reportable
 * state, not a broken test run.
 */
export function findRealPacketTracerFixture(
  extension: "pkt" | "pka",
): RealPacketTracerFixture | undefined {
  const directory = fixtureDirectory();
  let entries: string[];
  try {
    if (!statSync(directory).isDirectory()) return undefined;
    entries = readdirSync(directory);
  } catch {
    return undefined;
  }
  const match = entries
    .filter((entry) => entry.toLowerCase().endsWith(`.${extension}`))
    .sort()[0];
  if (match === undefined) return undefined;
  const path = join(directory, match);
  const bytes = new Uint8Array(readFileSync(path));
  return {
    path,
    filename: match,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * A sibling artifact next to the real fixtures, such as an independent
 * decoder's reference XML used as a compatibility oracle.
 */
export function readRealFixtureArtifact(filename: string): string | undefined {
  try {
    return readFileSync(join(fixtureDirectory(), filename), "utf8");
  } catch {
    return undefined;
  }
}

export function realFixtureDirectoryForReport(): string {
  return fixtureDirectory();
}

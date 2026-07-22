import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index";
import type { DatabaseOptions } from "./types/index";

export type SimulatorDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: SimulatorDatabase;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): DatabaseClient {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "simulatornet",
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}

import type { SimulatorDatabase } from "../database";

export function inTransaction<T>(
  database: SimulatorDatabase,
  work: (transaction: SimulatorDatabase) => Promise<T>,
): Promise<T> {
  return database.transaction((transaction) => work(transaction as unknown as SimulatorDatabase));
}

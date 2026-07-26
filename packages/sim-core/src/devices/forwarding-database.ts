import type { Mac } from "../util/mac";
import { normalizeMac } from "../util/mac";

export interface ForwardingDatabaseEntry<Scope extends string | number> {
  readonly scope: Scope;
  readonly mac: Mac;
  readonly port: string;
  readonly learnedAt: number;
}

/** Small deterministic MAC learning component shared by bridges and switches. */
export class ForwardingDatabase<Scope extends string | number> {
  private readonly table = new Map<string, ForwardingDatabaseEntry<Scope>>();

  constructor(private readonly agingTimeNs = Number.POSITIVE_INFINITY) {}

  learn(scope: Scope, mac: Mac, port: string, now: number): ForwardingDatabaseEntry<Scope> {
    const entry = { scope, mac: normalizeMac(mac), port, learnedAt: now };
    this.table.set(this.key(scope, entry.mac), entry);
    return entry;
  }

  lookup(scope: Scope, mac: Mac, now: number): ForwardingDatabaseEntry<Scope> | undefined {
    const key = this.key(scope, normalizeMac(mac));
    const entry = this.table.get(key);
    if (!entry) return undefined;
    if (now - entry.learnedAt >= this.agingTimeNs) {
      this.table.delete(key);
      return undefined;
    }
    return entry;
  }

  entries(now: number): ForwardingDatabaseEntry<Scope>[] {
    const rows: ForwardingDatabaseEntry<Scope>[] = [];
    for (const entry of this.table.values()) {
      if (now - entry.learnedAt >= this.agingTimeNs) {
        this.table.delete(this.key(entry.scope, entry.mac));
      } else {
        rows.push(entry);
      }
    }
    return rows.sort((a, b) => String(a.scope).localeCompare(String(b.scope)) || a.mac.localeCompare(b.mac));
  }

  clear(): void {
    this.table.clear();
  }

  /** Scoped ageing: discard only the entries learned inside one VLAN/bridge. */
  clearScope(scope: Scope): void {
    for (const entry of [...this.table.values()]) {
      if (entry.scope === scope) this.table.delete(this.key(entry.scope, entry.mac));
    }
  }

  private key(scope: Scope, mac: Mac): string {
    return `${String(scope)}\u0000${mac}`;
  }
}

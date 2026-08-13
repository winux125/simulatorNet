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

  /**
   * Discard the entries one port learned inside one scope.
   *
   * A Single-Active attachment that just lost the Designated Forwarder role is
   * exactly this case: its addresses are no longer reachable through it, but
   * every other port's entries in the same VLAN are still perfectly valid.
   */
  /** Discard everything one port learned, in every scope. */
  clearPort(port: string): number {
    let removed = 0;
    for (const entry of [...this.table.values()]) {
      if (entry.port !== port) continue;
      this.table.delete(this.key(entry.scope, entry.mac));
      removed++;
    }
    return removed;
  }

  /**
   * Discard exactly one address inside one scope.
   *
   * MAC Mobility is what needs this: a leaf that learns the fabric has moved an
   * address elsewhere must stop claiming *that* address, while every other
   * entry the same port learned is still perfectly valid.
   */
  forget(scope: Scope, mac: Mac): boolean {
    return this.table.delete(this.key(scope, mac));
  }

  clearPortInScope(scope: Scope, port: string): number {
    let removed = 0;
    for (const entry of [...this.table.values()]) {
      if (entry.scope !== scope || entry.port !== port) continue;
      this.table.delete(this.key(entry.scope, entry.mac));
      removed++;
    }
    return removed;
  }

  private key(scope: Scope, mac: Mac): string {
    return `${String(scope)}\u0000${mac}`;
  }
}

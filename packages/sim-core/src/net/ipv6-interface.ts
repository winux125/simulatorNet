import {
  isIpv6GlobalUnicast,
  isIpv6LinkLocal,
  normalizeIpv6,
  type Ipv6,
} from "../util/ipv6";

export type Ipv6AddressSource = "link-local" | "static" | "slaac" | "dhcpv6";
export type Ipv6AddressState = "tentative" | "preferred" | "deprecated" | "duplicate";

export interface Ipv6AddressAssignment {
  readonly address: Ipv6;
  readonly prefixLength: number;
  readonly source: Ipv6AddressSource;
  state: Ipv6AddressState;
  preferredUntilNs?: number;
  validUntilNs?: number;
}

export const MAXIMUM_IPV6_ADDRESSES_PER_INTERFACE = 16;

/**
 * Address-family state attached to one logical network interface. Persistent
 * configuration is supplied by lab-format; DAD state and lifetimes remain
 * transient and are rebuilt on every simulation start.
 */
export class Ipv6InterfaceState {
  private readonly assignments = new Map<Ipv6, Ipv6AddressAssignment>();

  add(input: Ipv6AddressAssignment): Ipv6AddressAssignment {
    const address = normalizeIpv6(input.address);
    if (!this.assignments.has(address) && this.assignments.size >= MAXIMUM_IPV6_ADDRESSES_PER_INTERFACE) {
      throw new Error(`IPv6 address limit exceeded (${MAXIMUM_IPV6_ADDRESSES_PER_INTERFACE})`);
    }
    const assignment = { ...input, address };
    this.assignments.set(address, assignment);
    return assignment;
  }

  remove(address: Ipv6): boolean {
    return this.assignments.delete(normalizeIpv6(address));
  }

  get(address: Ipv6): Ipv6AddressAssignment | undefined {
    return this.assignments.get(normalizeIpv6(address));
  }

  setState(address: Ipv6, state: Ipv6AddressState): void {
    const assignment = this.get(address);
    if (assignment) assignment.state = state;
  }

  owns(address: Ipv6, includeTentative = false): boolean {
    const state = this.get(address)?.state;
    return state === "preferred" || state === "deprecated" || (includeTentative && state === "tentative");
  }

  sourceFor(destination: Ipv6): Ipv6 | undefined {
    const usable = this.summaries().filter((entry) => entry.state === "preferred" || entry.state === "deprecated");
    if (isIpv6LinkLocal(destination)) {
      return usable.find((entry) => isIpv6LinkLocal(entry.address))?.address;
    }
    if (isIpv6GlobalUnicast(destination)) {
      return usable.find((entry) => isIpv6GlobalUnicast(entry.address) && entry.state === "preferred")?.address
        ?? usable.find((entry) => isIpv6GlobalUnicast(entry.address))?.address;
    }
    return usable.find((entry) => isIpv6GlobalUnicast(entry.address))?.address
      ?? usable.find((entry) => isIpv6LinkLocal(entry.address))?.address;
  }

  summaries(): Ipv6AddressAssignment[] {
    return [...this.assignments.values()]
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.assignments.clear();
  }
}

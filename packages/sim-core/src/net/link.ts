import type { EthernetInterface } from "./interface";

/** A point-to-point cable joining two interfaces, with a propagation delay. */
export class Link {
  constructor(
    readonly a: EthernetInterface,
    readonly b: EthernetInterface,
    readonly propagationDelayNs: number,
  ) {}
}

import type { Device } from "../devices/device";
import { frameTraversalBudget, nextFrameTraversal, type EthernetFrame } from "../packets/ethernet";
import type { Mac } from "../util/mac";
import type { Link } from "./link";

/**
 * A physical Ethernet port on a device. Sending a frame schedules its delivery
 * to the peer interface after the link's propagation delay — the single place
 * where "the wire" is modelled.
 */
export class EthernetInterface {
  link: Link | undefined;
  /** Administrative state: `no shutdown` (true) vs `shutdown` (false). */
  adminUp = true;
  /** Free-text `description` set from the CLI; undefined when unset. */
  description: string | undefined;

  constructor(
    readonly device: Device,
    readonly name: string,
    public mac: Mac,
  ) {}

  /** `shutdown`: administratively disable the port. */
  shutdown(): void {
    this.adminUp = false;
  }

  /** `no shutdown`: administratively enable the port. */
  noShutdown(): void {
    this.adminUp = true;
  }

  setDescription(text: string): void {
    this.description = text;
  }

  peer(): EthernetInterface | undefined {
    if (!this.link) return undefined;
    return this.link.a === this ? this.link.b : this.link.a;
  }

  /** Usable only when cabled and both ends are administratively up. */
  get operationalUp(): boolean {
    const peer = this.peer();
    return this.adminUp && peer !== undefined && peer.adminUp;
  }

  /** Transmit a frame onto the wire; delivery to the peer is scheduled. */
  transmit(frame: EthernetFrame): void {
    const peer = this.peer();
    const link = this.link;
    if (!link || !peer || !this.operationalUp) return; // link down: frame dropped
    const engine = this.device.engine;
    const traversed = nextFrameTraversal(frame);
    if (!traversed) {
      engine.trace({
        time: engine.now(),
        type: "frame-traversal-limit",
        device: this.device.id,
        detail: { interface: this.name, remaining: frameTraversalBudget(frame) },
      });
      throw new FrameTraversalLimitError(this.device.id, this.name);
    }
    engine.scheduleIn(link.propagationDelayNs, () => {
      peer.device.onReceive(traversed, peer);
    });
  }
}

export class FrameTraversalLimitError extends Error {
  readonly code = "frame-traversal-limit";

  constructor(readonly deviceId: string, readonly interfaceId: string) {
    super(`Ethernet frame traversal budget exhausted at ${deviceId}/${interfaceId}`);
    this.name = "FrameTraversalLimitError";
  }
}

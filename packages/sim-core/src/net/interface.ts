import type { Device } from "../devices/device";
import { frameTraversalBudget, nextFrameTraversal, type EthernetFrame } from "../packets/ethernet";
import type { Mac } from "../util/mac";
import { InterfaceEgressQueue, type QueuedPacket, type QueueDropReason } from "./egress-queue";
import type { Link } from "./link";
import {
  DEFAULT_LINK_QUEUE_LIMIT_PACKETS,
  serializationDelayNs,
} from "./link-performance";
import { estimatePacketWireSizeBytes } from "./packet-size";

/**
 * A physical Ethernet port on a device.
 *
 * Sending a frame no longer teleports it to the peer: the frame is estimated,
 * queued on this port's egress queue, clocked out at the link's capacity
 * (serialization delay) and only then propagated across the cable. Every step
 * uses `VirtualClock` and the deterministic event queue, so the browser worker
 * and the verifier observe the same queue depths, drops and delivery order.
 */
export class EthernetInterface {
  link: Link | undefined;
  /** Administrative state: `no shutdown` (true) vs `shutdown` (false). */
  adminUp = true;
  /** Free-text `description` set from the CLI; undefined when unset. */
  description: string | undefined;
  /** This port's transmit queue — the A→B direction of its link. Runtime only. */
  readonly egress = new InterfaceEgressQueue(DEFAULT_LINK_QUEUE_LIMIT_PACKETS);

  /** True while a packet is clocking onto the wire; guards the drain loop. */
  private serializing = false;

  constructor(
    readonly device: Device,
    readonly name: string,
    public mac: Mac,
  ) {}

  /** `shutdown`: administratively disable the port. */
  shutdown(): void {
    if (!this.adminUp) return;
    this.adminUp = false;
    this.flushEgress("interface-down");
    this.notifyStateChanged();
  }

  /** `no shutdown`: administratively enable the port. */
  noShutdown(): void {
    if (this.adminUp) return;
    this.adminUp = true;
    this.notifyStateChanged();
  }

  /**
   * Tell both ends that this port's operational state may have changed, so a
   * control protocol can reconverge. Both sides are notified because
   * `operationalUp` depends on the peer's administrative state too.
   */
  notifyStateChanged(): void {
    this.device.onInterfaceStateChanged(this);
    const peer = this.peer();
    if (peer) peer.device.onInterfaceStateChanged(peer);
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

  /**
   * Release everything waiting to be transmitted. Queued packets are dropped
   * with an explicit reason rather than delivered late — the one documented rule
   * for interface shutdown, link removal, device removal and Stop Lab.
   */
  flushEgress(reason: QueueDropReason): number {
    const released = this.egress.clear(reason);
    if (released.length === 0) return 0;
    this.traceQueue("queue-cleared", {
      interface: this.name,
      reason,
      packets: released.length,
    });
    return released.length;
  }

  /** Transmit a frame onto the wire; queueing, serialization and propagation follow. */
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
    const wireSizeBytes = estimatePacketWireSizeBytes(traversed);
    const queued = this.egress.enqueue(traversed, wireSizeBytes, engine.now());
    if (!queued) {
      this.traceQueue("packet-tail-dropped", {
        interface: this.name,
        bytes: wireSizeBytes,
        depth: this.egress.depthPackets,
        limit: this.egress.limitPacketsOf("class-default"),
      });
      return;
    }
    this.traceQueue("packet-enqueued", {
      interface: this.name,
      bytes: wireSizeBytes,
      depth: this.egress.depthPackets,
      queue: queued.className,
    });
    this.pumpEgress();
  }

  /**
   * Start the next transmission when the wire is free. Serialization always
   * consumes at least one virtual nanosecond, so a bounded queue always drains
   * in a bounded number of events.
   */
  protected pumpEgress(): void {
    if (this.serializing) return;
    const link = this.link;
    if (!link) return;
    const engine = this.device.engine;
    const packet = this.selectNextPacket(engine.now());
    if (!packet) return;
    this.serializing = true;
    const capacityBps = link.capacityBps;
    const propagationDelayNs = link.propagationDelayNs;
    const serializationNs = serializationDelayNs(packet.wireSizeBytes, capacityBps);
    this.traceQueue("packet-dequeued", {
      interface: this.name,
      bytes: packet.wireSizeBytes,
      waitedNs: engine.now() - packet.enqueuedAtNs,
      queue: packet.className,
    });
    this.traceQueue("packet-serialization-started", {
      interface: this.name,
      bytes: packet.wireSizeBytes,
      capacityBps,
      serializationNs,
    });
    engine.scheduleIn(serializationNs, () => {
      this.serializing = false;
      this.traceQueue("packet-serialization-completed", {
        interface: this.name,
        bytes: packet.wireSizeBytes,
        serializationNs,
      });
      this.deliver(packet, propagationDelayNs);
      this.pumpEgress();
    });
  }

  /**
   * Which packet leaves next. The base port is a single FIFO; an interface with
   * an attached output QoS policy overrides this with its scheduler.
   */
  protected selectNextPacket(nowNs: number): QueuedPacket | undefined {
    return this.egress.dequeueFifo(nowNs);
  }

  private deliver(packet: QueuedPacket, propagationDelayNs: number): void {
    const engine = this.device.engine;
    engine.scheduleIn(propagationDelayNs, () => {
      const peer = this.peer();
      // The cable may have been pulled or a port shut down while the bits were
      // on the wire: a packet is never resurrected onto a topology that changed.
      if (!peer || !this.operationalUp) {
        this.egress.recordExternalDrop("link-removed", packet.className);
        this.traceQueue("queue-cleared", {
          interface: this.name,
          reason: "link-removed",
          packets: 1,
        });
        return;
      }
      peer.device.onReceive(packet.frame, peer);
    });
  }

  protected traceQueue(type: string, detail: Record<string, unknown>): void {
    const engine = this.device.engine;
    engine.trace({ time: engine.now(), type, device: this.device.id, detail });
  }
}

export class FrameTraversalLimitError extends Error {
  readonly code = "frame-traversal-limit";

  constructor(readonly deviceId: string, readonly interfaceId: string) {
    super(`Ethernet frame traversal budget exhausted at ${deviceId}/${interfaceId}`);
    this.name = "FrameTraversalLimitError";
  }
}

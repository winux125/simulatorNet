import {
  MANAGEMENT_LIMITS,
  type RemoteProtocol,
  type VtyLineConfig,
  type VtyLineState,
} from "@sim/contracts";
import type { IpAddress } from "@sim/sim-core";

/** Runtime state of one VTY line. It is never serialized into a LabDocument. */
export interface VtyLineRuntime {
  readonly index: number;
  readonly state: VtyLineState;
  readonly protocol?: RemoteProtocol;
  readonly username?: string;
  readonly peerAddress?: IpAddress;
  readonly connectedAtNs?: number;
  readonly idleForNs?: number;
  readonly sessionId?: string;
}

interface LineSlot {
  state: VtyLineState;
  protocol?: RemoteProtocol;
  username?: string;
  peerAddress?: IpAddress;
  connectedAtNs?: number;
  lastActivityNs?: number;
  sessionId?: string;
}

/**
 * The configured `line vty` range and its runtime allocation.
 *
 * A line is only usable when its configuration permits the requested transport.
 * When every eligible line is busy the caller reports
 * `% All remote terminal lines are in use.` — sessions are finite by design.
 */
export class VtyLinePool {
  private configs = new Map<number, VtyLineConfig>();
  private readonly slots = new Map<number, LineSlot>();

  constructor(lines: readonly VtyLineConfig[] = []) {
    this.configure(lines);
  }

  /** Replace the configured ranges. Later blocks win over earlier overlaps. */
  configure(lines: readonly VtyLineConfig[]): void {
    const next = new Map<number, VtyLineConfig>();
    for (const line of lines) {
      for (let index = line.first; index <= line.last; index++) {
        if (index > MANAGEMENT_LIMITS.maximumVtyLineIndex) break;
        next.set(index, line);
      }
    }
    this.configs = next;
    for (const index of [...this.slots.keys()]) {
      if (!next.has(index)) this.slots.delete(index);
    }
  }

  configuredLines(): number[] {
    return [...this.configs.keys()].sort((a, b) => a - b);
  }

  lineConfig(index: number): VtyLineConfig | undefined {
    return this.configs.get(index);
  }

  /** True when at least one configured line accepts this transport. */
  permitsTransport(protocol: RemoteProtocol): boolean {
    return [...this.configs.values()].some((line) => line.transports.includes(protocol));
  }

  /** Lowest free line that accepts `protocol`, or undefined when exhausted. */
  allocate(protocol: RemoteProtocol, nowNs: number): number | undefined {
    for (const index of this.configuredLines()) {
      const config = this.configs.get(index)!;
      if (!config.transports.includes(protocol)) continue;
      const slot = this.slots.get(index);
      if (slot && slot.state !== "free") continue;
      this.slots.set(index, {
        state: "authenticating",
        protocol,
        connectedAtNs: nowNs,
        lastActivityNs: nowNs,
      });
      return index;
    }
    return undefined;
  }

  activate(index: number, username: string | undefined, peerAddress: IpAddress, sessionId: string, nowNs: number): void {
    const slot = this.slots.get(index);
    if (!slot) return;
    slot.state = "active";
    slot.username = username;
    slot.peerAddress = peerAddress;
    slot.sessionId = sessionId;
    slot.lastActivityNs = nowNs;
  }

  bindPeer(index: number, peerAddress: IpAddress, sessionId: string): void {
    const slot = this.slots.get(index);
    if (!slot) return;
    slot.peerAddress = peerAddress;
    slot.sessionId = sessionId;
  }

  touch(index: number, nowNs: number): void {
    const slot = this.slots.get(index);
    if (!slot) return;
    slot.lastActivityNs = nowNs;
    if (slot.state === "idle") slot.state = "active";
  }

  markIdle(index: number): void {
    const slot = this.slots.get(index);
    if (slot?.state === "active") slot.state = "idle";
  }

  markClosing(index: number): void {
    const slot = this.slots.get(index);
    if (slot) slot.state = "closing";
  }

  release(index: number): void {
    this.slots.delete(index);
  }

  releaseAll(): void {
    this.slots.clear();
  }

  idleForNs(index: number, nowNs: number): number {
    const slot = this.slots.get(index);
    return slot?.lastActivityNs === undefined ? 0 : nowNs - slot.lastActivityNs;
  }

  sessionIdOf(index: number): string | undefined {
    return this.slots.get(index)?.sessionId;
  }

  activeCount(): number {
    return [...this.slots.values()].filter((slot) => slot.state !== "free").length;
  }

  rows(nowNs: number): VtyLineRuntime[] {
    return this.configuredLines().map((index) => {
      const slot = this.slots.get(index);
      if (!slot) return { index, state: "free" as const };
      return {
        index,
        state: slot.state,
        protocol: slot.protocol,
        username: slot.username,
        peerAddress: slot.peerAddress,
        connectedAtNs: slot.connectedAtNs,
        idleForNs: slot.lastActivityNs === undefined ? undefined : nowNs - slot.lastActivityNs,
        sessionId: slot.sessionId,
      };
    });
  }
}

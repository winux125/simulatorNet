import { DEFAULT_BRIDGE_AGING_TIME_NS } from "@sim/contracts";
import type { EthernetInterface } from "../net/interface";
import type { EthernetFrame } from "../packets/ethernet";
import { isBroadcastMac, normalizeMac } from "../util/mac";
import { ConsoleAccessState } from "../management/console-access-state";
import { Device } from "./device";
import { ForwardingDatabase } from "./forwarding-database";

export interface BridgeMacEntry {
  readonly mac: string;
  readonly port: string;
  readonly learnedAt: number;
}

/** Two-segment learning bridge without VLANs or spanning tree. */
export class EthernetBridge extends Device {
  readonly deviceType = "bridge" as const;
  /** The one shared local-user database, for the simulated bridge console. */
  readonly consoleAccess = new ConsoleAccessState();
  private forwardingDatabase: ForwardingDatabase<"bridge">;

  constructor(id: string, name: string, public agingTimeNs = DEFAULT_BRIDGE_AGING_TIME_NS) {
    super(id, name);
    this.forwardingDatabase = new ForwardingDatabase(agingTimeNs);
  }

  setAgingTimeNs(agingTimeNs: number): void {
    if (!Number.isFinite(agingTimeNs) || agingTimeNs <= 0) throw new Error("Bridge aging time must be positive");
    this.agingTimeNs = agingTimeNs;
    this.forwardingDatabase = new ForwardingDatabase(agingTimeNs);
  }

  macAddressTable(): BridgeMacEntry[] {
    return this.forwardingDatabase.entries(this.engine.now()).map(({ mac, port, learnedAt }) => ({ mac, port, learnedAt }));
  }

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    const now = this.engine.now();
    const source = normalizeMac(frame.src);
    this.forwardingDatabase.learn("bridge", source, ingress.name, now);
    this.engine.trace({ time: now, type: "bridge-mac-learn", device: this.id, detail: { mac: source, port: ingress.name } });

    const destination = normalizeMac(frame.dst);
    const learned = isBroadcastMac(destination)
      ? undefined
      : this.forwardingDatabase.lookup("bridge", destination, now);
    if (learned?.port === ingress.name) {
      this.engine.trace({ time: now, type: "bridge-filter", device: this.id, detail: { dst: destination, port: ingress.name } });
      return;
    }

    const candidates = learned
      ? [this.interfaces.get(learned.port)].filter((iface): iface is EthernetInterface => iface !== undefined)
      : [...this.interfaces.values()].filter((iface) => iface !== ingress);
    for (const egress of candidates) {
      if (!egress.operationalUp) continue;
      egress.transmit(frame);
      this.engine.trace({
        time: now,
        type: learned ? "bridge-forward" : "bridge-flood",
        device: this.id,
        detail: { dst: destination, ingress: ingress.name, egress: egress.name },
      });
    }
  }
}

export { EthernetBridge as Bridge };

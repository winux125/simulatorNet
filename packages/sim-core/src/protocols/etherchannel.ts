import { NS_PER_S } from "../engine/constants";
import type { SimulationEngine } from "../engine/simulation-engine";
import {
  DEFAULT_LACP_PORT_PRIORITY,
  DEFAULT_LACP_SYSTEM_PRIORITY,
  type LacpActivity,
  type LacpPacket,
  type LacpPortState,
  lacpStateOf,
  type PagpMode,
  type PagpPacket,
} from "../packets/etherchannel";
import { hashFlowKey } from "../util/hash";
import type { Mac } from "../util/mac";
import { ControlProtocolConfigurationError, enforceStructuralLimit } from "./limits";
import { ProtocolActivity } from "./protocol-activity";

/**
 * Deterministic Layer-2 EtherChannel with static, LACP and PAgP negotiation.
 *
 * The bundle is a logical interface inside the device: the topology keeps every
 * physical cable, and no fake link is invented for `Port-channel1`. Spanning
 * tree sees the bundle as a single logical port, and one flow always leaves
 * through the same member because member selection is a pure hash — never a
 * random or insertion-order choice.
 *
 * This is an educational subset. Multi-chassis EtherChannel, StackWise/VSS/vPC,
 * LACP fast rate and PAgP silent modes are deliberately out of scope.
 */

export type EtherChannelProtocol = "static" | "lacp" | "pagp";
export type EtherChannelMode = "on" | "active" | "passive" | "desirable" | "auto";

/** IEEE 802.3ad-like mux machine states, plus a suspended (incompatible) state. */
export type EtherChannelMemberState =
  | "detached"
  | "waiting"
  | "attached"
  | "collecting"
  | "distributing"
  | "suspended";

export const ETHERCHANNEL_NEGOTIATION_INTERVAL_NS = NS_PER_S;
const ETHERCHANNEL_QUIESCENCE_ROUNDS = 4;
const ETHERCHANNEL_MAXIMUM_TICKS = 2_048;

export const PORT_CHANNEL_PREFIX = "Port-channel";

export function portChannelName(channelId: number): string {
  return `${PORT_CHANNEL_PREFIX}${channelId}`;
}

export function parsePortChannelName(name: string): number | undefined {
  if (!name.toLowerCase().startsWith(PORT_CHANNEL_PREFIX.toLowerCase())) return undefined;
  const id = Number(name.slice(PORT_CHANNEL_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export function protocolOfMode(mode: EtherChannelMode): EtherChannelProtocol {
  if (mode === "on") return "static";
  return mode === "active" || mode === "passive" ? "lacp" : "pagp";
}

export interface EtherChannelMemberConfiguration {
  readonly port: string;
  readonly mode: EtherChannelMode;
}

export interface EtherChannelConfiguration {
  readonly channelId: number;
  readonly protocol: EtherChannelProtocol;
  readonly mode: EtherChannelMode;
  readonly members: readonly string[];
  /** Bundle stays down below this many distributing members; default 1. */
  readonly minimumLinks?: number;
  /**
   * `interface Port-channel<n>` → `description`. Pure metadata that never
   * reaches negotiation, selection or forwarding: the bundle's administrative
   * state stays derived from its members, exactly as it was before M10.17.
   */
  readonly description?: string;
}

export interface EtherChannelMemberSummary {
  readonly port: string;
  readonly mode: EtherChannelMode;
  readonly state: EtherChannelMemberState;
  readonly bundled: boolean;
  readonly operationalUp: boolean;
  readonly reason?: string;
  readonly partnerSystemId?: Mac;
  readonly partnerPortId?: number;
  readonly partnerMode?: LacpActivity | PagpMode;
  readonly lastMessageAtNs?: number;
  readonly selectedFrames: number;
}

export interface EtherChannelSummary {
  readonly channelId: number;
  readonly name: string;
  readonly protocol: EtherChannelProtocol;
  readonly mode: EtherChannelMode;
  readonly status: "up" | "down";
  readonly minimumLinks: number;
  readonly description?: string;
  readonly members: readonly EtherChannelMemberSummary[];
  readonly activeMembers: readonly string[];
  readonly suspendedMembers: readonly string[];
}

/** The device surface the EtherChannel stack needs; `L2Switch` implements it. */
export interface EtherChannelHost {
  readonly id: string;
  readonly name: string;
  readonly engine: SimulationEngine;
  etherChannelSystemId(): Mac;
  etherChannelPortNumber(port: string): number;
  etherChannelMemberAdminUp(port: string): boolean;
  etherChannelMemberOperationalUp(port: string): boolean;
  etherChannelHasPort(port: string): boolean;
  etherChannelSend(port: string, payload: LacpPacket | PagpPacket): void;
  /**
   * A stable string describing every switchport attribute members must share.
   * Members whose signature differs from the bundle's are suspended rather than
   * silently rewritten.
   */
  etherChannelSwitchportSignature(port: string): string;
  /** True when this exact interface has explicit switchport configuration. */
  etherChannelSwitchportConfigured(port: string): boolean;
  /** Membership changed: rebuild spanning tree and forwarding views. */
  etherChannelTopologyChanged(): void;
}

interface MemberRuntime {
  readonly port: string;
  mode: EtherChannelMode;
  state: EtherChannelMemberState;
  reason: string | undefined;
  partnerSystemId: Mac | undefined;
  partnerKey: number | undefined;
  partnerPortId: number | undefined;
  partnerMode: LacpActivity | PagpMode | undefined;
  partnerSynchronized: boolean;
  lastMessageAtNs: number | undefined;
  selectedFrames: number;
}

interface ChannelRuntime {
  readonly channelId: number;
  protocol: EtherChannelProtocol;
  mode: EtherChannelMode;
  minimumLinks: number;
  description: string | undefined;
  up: boolean;
  readonly members: Map<string, MemberRuntime>;
}

export class EtherChannelStack {
  private readonly channels = new Map<number, ChannelRuntime>();
  private readonly memberIndex = new Map<string, number>();
  private readonly activity: ProtocolActivity;

  constructor(private readonly host: EtherChannelHost) {
    this.activity = new ProtocolActivity(
      () => this.engineOrUndefined(),
      {
        name: "etherchannel",
        intervalNs: ETHERCHANNEL_NEGOTIATION_INTERVAL_NS,
        quiescenceRounds: ETHERCHANNEL_QUIESCENCE_ROUNDS,
        maximumTicks: ETHERCHANNEL_MAXIMUM_TICKS,
      },
      () => this.tick(),
    );
  }

  // --- configuration -----------------------------------------------------

  /** `interface <port>` + `channel-group <id> mode <mode>`. */
  addMember(channelId: number, port: string, mode: EtherChannelMode): void {
    if (!Number.isInteger(channelId) || channelId < 1) {
      throw new ControlProtocolConfigurationError("Channel group must be a positive integer", "channelId");
    }
    if (!this.host.etherChannelHasPort(port)) {
      throw new ControlProtocolConfigurationError(`Unknown interface '${port}'`, "port");
    }
    const existing = this.memberIndex.get(port);
    if (existing !== undefined && existing !== channelId) {
      throw new ControlProtocolConfigurationError(
        `Interface '${port}' already belongs to ${portChannelName(existing)}`,
        "port",
      );
    }
    const protocol = protocolOfMode(mode);
    let channel = this.channels.get(channelId);
    if (!channel) {
      enforceStructuralLimit("maximumPortChannelsPerDevice", this.channels.size + 1);
      channel = {
        channelId,
        protocol,
        mode,
        minimumLinks: 1,
        description: undefined,
        up: false,
        members: new Map(),
      };
      this.channels.set(channelId, channel);
    } else if (channel.protocol !== protocol) {
      throw new ControlProtocolConfigurationError(
        `${portChannelName(channelId)} already negotiates with ${channel.protocol}`,
        "mode",
      );
    }
    enforceStructuralLimit("maximumMembersPerPortChannel", channel.members.size + (channel.members.has(port) ? 0 : 1));
    channel.mode = mode;
    const member = channel.members.get(port);
    if (member) member.mode = mode;
    else channel.members.set(port, newMember(port, mode));
    this.memberIndex.set(port, channelId);
    this.host.etherChannelTopologyChanged();
    this.arm();
  }

  /** `no channel-group`. */
  removeMember(port: string): void {
    const channelId = this.memberIndex.get(port);
    if (channelId === undefined) return;
    const channel = this.channels.get(channelId);
    channel?.members.delete(port);
    this.memberIndex.delete(port);
    if (channel && channel.members.size === 0) this.channels.delete(channelId);
    this.host.etherChannelTopologyChanged();
    this.arm();
  }

  removeChannel(channelId: number): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    for (const port of channel.members.keys()) this.memberIndex.delete(port);
    this.channels.delete(channelId);
    this.host.etherChannelTopologyChanged();
    this.arm();
  }

  setMinimumLinks(channelId: number, minimumLinks: number): void {
    const channel = this.requireChannel(channelId);
    if (!Number.isInteger(minimumLinks) || minimumLinks < 1 || minimumLinks > 8) {
      throw new ControlProtocolConfigurationError("Minimum links must be between 1 and 8", "minimumLinks");
    }
    channel.minimumLinks = minimumLinks;
    this.arm();
  }

  /**
   * `interface Port-channel<n>` → `description <text>`.
   *
   * Metadata only: nothing in negotiation, member selection or forwarding reads
   * it, so setting one can never change how a bundle behaves.
   */
  setDescription(channelId: number, description: string | undefined): void {
    const channel = this.requireChannel(channelId);
    const trimmed = description?.trim();
    if (trimmed !== undefined && trimmed.length > 200) {
      throw new ControlProtocolConfigurationError("A description may be at most 200 characters", "description");
    }
    channel.description = trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  }

  descriptionOf(channelId: number): string | undefined {
    return this.channels.get(channelId)?.description;
  }

  /** Persistent configuration only; negotiation runtime is never included. */
  configurations(): EtherChannelConfiguration[] {
    return [...this.channels.values()]
      .sort((a, b) => a.channelId - b.channelId)
      .map((channel) => ({
        channelId: channel.channelId,
        protocol: channel.protocol,
        mode: channel.mode,
        members: [...channel.members.keys()].sort((a, b) => a.localeCompare(b)),
        minimumLinks: channel.minimumLinks === 1 ? undefined : channel.minimumLinks,
        description: channel.description,
      }));
  }

  get channelIds(): number[] {
    return [...this.channels.keys()].sort((a, b) => a - b);
  }

  channelOf(port: string): number | undefined {
    return this.memberIndex.get(port);
  }

  isMember(port: string): boolean {
    return this.memberIndex.has(port);
  }

  hasChannel(channelId: number): boolean {
    return this.channels.has(channelId);
  }

  memberModeOf(port: string): EtherChannelMode | undefined {
    const channelId = this.memberIndex.get(port);
    if (channelId === undefined) return undefined;
    return this.channels.get(channelId)?.members.get(port)?.mode;
  }

  /** True while the member actually carries user data through its bundle. */
  isBundled(port: string): boolean {
    const channelId = this.memberIndex.get(port);
    if (channelId === undefined) return false;
    const channel = this.channels.get(channelId);
    if (!channel?.up) return false;
    return channel.members.get(port)?.state === "distributing";
  }

  isSuspended(port: string): boolean {
    const channelId = this.memberIndex.get(port);
    if (channelId === undefined) return false;
    return this.channels.get(channelId)?.members.get(port)?.state === "suspended";
  }

  /** Members currently forwarding for a channel, in stable interface order. */
  activeMembers(channelId: number): string[] {
    const channel = this.channels.get(channelId);
    if (!channel?.up) return [];
    return [...channel.members.values()]
      .filter((member) => member.state === "distributing")
      .map((member) => member.port)
      .sort((a, b) => a.localeCompare(b));
  }

  channelUp(channelId: number): boolean {
    return this.channels.get(channelId)?.up === true;
  }

  // --- deterministic member selection ------------------------------------

  /**
   * Pick the member that carries one flow. The hash is a pure function of the
   * addresses in the frame, so every frame of a flow takes the same member and
   * frames are never reordered inside a flow.
   */
  selectMember(channelId: number, flowKey: string): string | undefined {
    const members = this.activeMembers(channelId);
    if (members.length === 0) return undefined;
    const selected = members[hashFlowKey(flowKey) % members.length]!;
    const runtime = this.channels.get(channelId)?.members.get(selected);
    if (runtime) runtime.selectedFrames++;
    return selected;
  }

  // --- runtime -----------------------------------------------------------

  onPortStateChanged(port: string): void {
    if (!this.memberIndex.has(port)) return;
    const channelId = this.memberIndex.get(port)!;
    const member = this.channels.get(channelId)?.members.get(port);
    if (member && !this.host.etherChannelMemberOperationalUp(port)) {
      member.partnerSystemId = undefined;
      member.partnerKey = undefined;
      member.partnerPortId = undefined;
      member.partnerMode = undefined;
      member.partnerSynchronized = false;
      member.lastMessageAtNs = undefined;
    }
    this.arm();
  }

  resetRuntime(): void {
    for (const channel of this.channels.values()) {
      channel.up = false;
      for (const member of channel.members.values()) {
        member.state = "detached";
        member.reason = undefined;
        member.partnerSystemId = undefined;
        member.partnerKey = undefined;
        member.partnerPortId = undefined;
        member.partnerMode = undefined;
        member.partnerSynchronized = false;
        member.lastMessageAtNs = undefined;
        member.selectedFrames = 0;
      }
    }
    this.activity.resetBudget();
    this.arm();
  }

  arm(): void {
    if (this.channels.size === 0) return;
    this.evaluate();
    this.activity.arm();
  }

  get active(): boolean {
    return this.activity.active;
  }

  private tick(): void {
    this.evaluate();
    this.advertise();
  }

  // --- message reception --------------------------------------------------

  onLacpdu(packet: LacpPacket, port: string): void {
    const context = this.memberContext(port);
    if (!context) return;
    const { channel, member } = context;
    this.charge();
    this.trace("lacpdu-received", {
      interface: port,
      channel: channel.channelId,
      actor: packet.actorSystemId,
      actorKey: packet.actorKey,
      actorPort: packet.actorPortId,
      activity: packet.actorState.activity,
    });
    if (channel.protocol !== "lacp") {
      this.suspend(channel, member, `protocol-mismatch: ${channel.protocol} port received an LACPDU`);
      return;
    }
    const engine = this.engineOrUndefined();
    member.partnerSystemId = packet.actorSystemId;
    member.partnerKey = packet.actorKey;
    member.partnerPortId = packet.actorPortId;
    member.partnerMode = packet.actorState.activity;
    member.partnerSynchronized = packet.actorState.synchronization;
    member.lastMessageAtNs = engine?.now();
    const changed = this.evaluate();
    this.answer(channel, member);
    if (changed) this.arm();
  }

  onPagp(packet: PagpPacket, port: string): void {
    const context = this.memberContext(port);
    if (!context) return;
    const { channel, member } = context;
    this.charge();
    this.trace("pagp-message-received", {
      interface: port,
      channel: channel.channelId,
      device: packet.deviceId,
      remotePort: packet.portName,
      mode: packet.mode,
    });
    if (channel.protocol !== "pagp") {
      this.suspend(channel, member, `protocol-mismatch: ${channel.protocol} port received a PAgP message`);
      return;
    }
    const engine = this.engineOrUndefined();
    member.partnerSystemId = packet.deviceId;
    member.partnerKey = packet.groupCapability;
    member.partnerPortId = undefined;
    member.partnerMode = packet.mode;
    member.partnerSynchronized = true;
    member.lastMessageAtNs = engine?.now();
    const changed = this.evaluate();
    this.answer(channel, member);
    if (changed) this.arm();
  }

  /**
   * Only a passive/auto member answers a received message. An active/desirable
   * member already advertises on its own tick, so replying to every reply would
   * keep two neighbours talking for ever and Auto execution would never finish.
   */
  private answer(channel: ChannelRuntime, member: MemberRuntime): void {
    if (member.mode === "active" || member.mode === "desirable") return;
    this.advertiseMember(channel, member);
  }

  // --- negotiation --------------------------------------------------------

  private evaluate(): boolean {
    let changed = false;
    for (const channel of this.channels.values()) {
      const signature = this.bundleSignature(channel);
      for (const member of channel.members.values()) {
        const next = this.memberState(channel, member, signature);
        if (next.state !== member.state || next.reason !== member.reason) {
          const previous = member.state;
          member.state = next.state;
          member.reason = next.reason;
          changed = true;
          // "selected" and "suspended" mark the two decisions a learner cares
          // about; every other mux transition still shows up in Step mode.
          this.trace(
            next.state === "suspended"
              ? "lacp-member-suspended"
              : next.state === "distributing"
                ? "lacp-member-selected"
                : "etherchannel-member-state-changed",
            {
              interface: member.port,
              channel: channel.channelId,
              protocol: channel.protocol,
              previousState: previous,
              state: next.state,
              reason: next.reason ?? null,
            },
          );
        }
      }
      const distributing = [...channel.members.values()].filter((member) => member.state === "distributing");
      const up = distributing.length >= channel.minimumLinks;
      if (up !== channel.up) {
        channel.up = up;
        changed = true;
        this.trace(up ? "etherchannel-formed" : "etherchannel-down", {
          channel: channel.channelId,
          name: portChannelName(channel.channelId),
          protocol: channel.protocol,
          mode: channel.mode,
          members: distributing.map((member) => member.port),
        });
        this.host.etherChannelTopologyChanged();
      }
    }
    return changed;
  }

  private memberState(
    channel: ChannelRuntime,
    member: MemberRuntime,
    signature: string | undefined,
  ): { state: EtherChannelMemberState; reason: string | undefined } {
    if (!this.host.etherChannelMemberAdminUp(member.port)) {
      return { state: "detached", reason: "administratively down" };
    }
    // A member that was never configured on its own simply inherits the
    // bundle. Only a member carrying its own conflicting switchport
    // configuration is suspended, and its configuration is left untouched.
    if (signature !== undefined && this.host.etherChannelSwitchportConfigured(member.port)) {
      const memberSignature = this.host.etherChannelSwitchportSignature(member.port);
      if (memberSignature !== signature) {
        return {
          state: "suspended",
          reason: `incompatible switchport configuration (${memberSignature} != ${signature})`,
        };
      }
    }
    if (member.reason?.startsWith("protocol-mismatch")) {
      return { state: "suspended", reason: member.reason };
    }
    if (!this.host.etherChannelMemberOperationalUp(member.port)) {
      return { state: "detached", reason: "link down" };
    }
    if (channel.protocol === "static") {
      return { state: "distributing", reason: undefined };
    }
    if (member.partnerSystemId === undefined) {
      const initiates = member.mode === "active" || member.mode === "desirable";
      return {
        state: initiates ? "waiting" : "detached",
        reason: initiates
          ? "waiting for partner"
          : `${member.mode} mode never initiates negotiation`,
      };
    }
    if (channel.protocol === "lacp") {
      // active+active and active+passive aggregate; passive+passive cannot,
      // because neither end ever sends the first LACPDU.
      if (member.mode === "passive" && member.partnerMode === "passive") {
        return { state: "attached", reason: "passive/passive does not aggregate" };
      }
      return { state: "distributing", reason: undefined };
    }
    if (member.mode === "auto" && member.partnerMode === "auto") {
      return { state: "attached", reason: "auto/auto does not aggregate" };
    }
    return { state: "distributing", reason: undefined };
  }

  /**
   * The switchport signature every member of a channel must match: the
   * Port-channel's own configuration when one was entered, otherwise the first
   * member's. Mismatching members are suspended, never silently rewritten.
   */
  private bundleSignature(channel: ChannelRuntime): string | undefined {
    const logical = portChannelName(channel.channelId);
    if (this.host.etherChannelSwitchportConfigured(logical)) {
      return this.host.etherChannelSwitchportSignature(logical);
    }
    const reference = [...channel.members.keys()].sort((a, b) => a.localeCompare(b))[0];
    return reference === undefined ? undefined : this.host.etherChannelSwitchportSignature(reference);
  }

  private suspend(channel: ChannelRuntime, member: MemberRuntime, reason: string): void {
    if (member.state === "suspended" && member.reason === reason) return;
    member.state = "suspended";
    member.reason = reason;
    this.trace("lacp-member-suspended", {
      interface: member.port,
      channel: channel.channelId,
      protocol: channel.protocol,
      state: "suspended",
      reason,
    });
    this.evaluate();
    this.arm();
  }

  // --- advertisement ------------------------------------------------------

  private advertise(): void {
    for (const channel of this.channels.values()) {
      if (channel.protocol === "static") continue;
      for (const member of channel.members.values()) {
        // Only active/desirable members initiate; passive/auto answer instead.
        if (member.mode !== "active" && member.mode !== "desirable") continue;
        this.advertiseMember(channel, member);
      }
    }
  }

  private advertiseMember(channel: ChannelRuntime, member: MemberRuntime): void {
    if (channel.protocol === "static") return;
    if (!this.host.etherChannelMemberOperationalUp(member.port)) return;
    if (member.state === "suspended") return;
    this.charge();
    if (channel.protocol === "lacp") {
      const activity: LacpActivity = member.mode === "active" ? "active" : "passive";
      const distributing = member.state === "distributing";
      const packet: LacpPacket = {
        kind: "lacp",
        actorSystemId: this.host.etherChannelSystemId(),
        actorSystemPriority: DEFAULT_LACP_SYSTEM_PRIORITY,
        actorKey: channel.channelId,
        actorPortId: this.host.etherChannelPortNumber(member.port),
        actorPortPriority: DEFAULT_LACP_PORT_PRIORITY,
        actorState: lacpStateOf(activity, distributing, distributing, distributing),
        partnerSystemId: member.partnerSystemId,
        partnerKey: member.partnerKey,
        partnerPortId: member.partnerPortId,
        partnerState: member.partnerSystemId === undefined
          ? undefined
          : partnerStateOf(member.partnerMode, member.partnerSynchronized),
      };
      this.trace("lacpdu-sent", {
        interface: member.port,
        channel: channel.channelId,
        activity,
        state: member.state,
      });
      this.host.etherChannelSend(member.port, packet);
      return;
    }
    const packet: PagpPacket = {
      kind: "pagp",
      deviceId: this.host.etherChannelSystemId(),
      mode: member.mode === "desirable" ? "desirable" : "auto",
      portName: member.port,
      groupCapability: channel.channelId,
      learnCapability: "aggregation-capable",
    };
    this.trace("pagp-message-sent", {
      interface: member.port,
      channel: channel.channelId,
      mode: packet.mode,
      state: member.state,
    });
    this.host.etherChannelSend(member.port, packet);
  }

  // --- inspection ---------------------------------------------------------

  summaries(): EtherChannelSummary[] {
    return [...this.channels.values()]
      .sort((a, b) => a.channelId - b.channelId)
      .map((channel): EtherChannelSummary => {
        const members = [...channel.members.values()]
          .sort((a, b) => a.port.localeCompare(b.port))
          .map((member): EtherChannelMemberSummary => ({
            port: member.port,
            mode: member.mode,
            state: member.state,
            bundled: channel.up && member.state === "distributing",
            operationalUp: this.host.etherChannelMemberOperationalUp(member.port),
            reason: member.reason,
            partnerSystemId: member.partnerSystemId,
            partnerPortId: member.partnerPortId,
            partnerMode: member.partnerMode,
            lastMessageAtNs: member.lastMessageAtNs,
            selectedFrames: member.selectedFrames,
          }));
        return {
          channelId: channel.channelId,
          name: portChannelName(channel.channelId),
          protocol: channel.protocol,
          mode: channel.mode,
          status: channel.up ? "up" : "down",
          minimumLinks: channel.minimumLinks,
          description: channel.description,
          members,
          activeMembers: members.filter((member) => member.bundled).map((member) => member.port),
          suspendedMembers: members.filter((member) => member.state === "suspended").map((member) => member.port),
        };
      });
  }

  // --- helpers ------------------------------------------------------------

  private memberContext(port: string): { channel: ChannelRuntime; member: MemberRuntime } | undefined {
    const channelId = this.memberIndex.get(port);
    if (channelId === undefined) return undefined;
    const channel = this.channels.get(channelId);
    const member = channel?.members.get(port);
    return channel && member ? { channel, member } : undefined;
  }

  private requireChannel(channelId: number): ChannelRuntime {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new ControlProtocolConfigurationError(`${portChannelName(channelId)} does not exist`, "channelId");
    }
    return channel;
  }

  private engineOrUndefined(): SimulationEngine | undefined {
    return (this.host as { engine?: SimulationEngine }).engine;
  }

  private charge(): void {
    this.engineOrUndefined()?.controlProtocolBudget.consume("negotiationEvents");
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    engine.trace({ time: engine.now(), type, device: this.host.id, detail });
  }
}

function newMember(port: string, mode: EtherChannelMode): MemberRuntime {
  return {
    port,
    mode,
    state: "detached",
    reason: undefined,
    partnerSystemId: undefined,
    partnerKey: undefined,
    partnerPortId: undefined,
    partnerMode: undefined,
    partnerSynchronized: false,
    lastMessageAtNs: undefined,
    selectedFrames: 0,
  };
}

function partnerStateOf(mode: LacpActivity | PagpMode | undefined, synchronized: boolean): LacpPortState {
  const activity: LacpActivity = mode === "active" ? "active" : "passive";
  return lacpStateOf(activity, synchronized, synchronized, synchronized);
}

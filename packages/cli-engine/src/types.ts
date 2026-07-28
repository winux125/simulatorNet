import type { DeviceCapability } from "@sim/contracts";
import type { Device, SimulationEngine } from "@sim/sim-core";
import type { Params } from "./parser/matcher";
import type { CliMode } from "./session/mode";

/** Which device kind a command applies to. */
export type DeviceFilter =
  | "switch"
  | "router"
  | "pc"
  | "server"
  | "host"
  | "network"
  | "bridge"
  | "l3-switch"
  /** A plain L2 switch: excludes the L3 switch, which routes instead. */
  | "l2-switch"
  /** Devices with a management plane: Router, L2/L3 Switch and Firewall. */
  | "managed"
  /** Devices that run an OSPF process: Router and L3 Switch. */
  | "ospf"
  /** Devices that speak the Cisco-like CDP subset. */
  | "cdp"
  /** Devices that speak LLDP: every network device plus the Server. */
  | "lldp"
  | "any";

/** The interface-configuration context (`config-if`). */
export interface InterfaceContext {
  /** The physical port being configured (e.g. "Gi0/0"). */
  physical: string;
  /** True when a subinterface (`Gi0/0.10`) is being configured. */
  isSubinterface: boolean;
  /** The typed subinterface label, for messages/prompt (e.g. "Gi0/0.10"). */
  label: string;
  /** VLAN set by `encapsulation dot1Q`; undefined until then. */
  subVlan: number | undefined;
  /** True once the router subinterface L3 has been created. */
  subCreated: boolean;
  /** Present when `interface vlan <id>` selected an SVI. */
  sviVlan: number | undefined;
  /** Present when `interface loopback <id>` selected a logical loopback. */
  loopback: number | undefined;
  /**
   * Every port selected by `interface range`. A range command validates all of
   * them before it changes any, so a range is never half-applied.
   */
  range: string[] | undefined;
}

export interface AclContext {
  id: string;
  type: "standard" | "extended" | "ipv6";
}

/** The `router ospf <process-id>` configuration context. */
export interface RouterProcessContext {
  processId: number;
  family: "ipv4" | "ipv6";
}

/** The `line vty <first> <last>` configuration context. */
export interface VtyLineContext {
  first: number;
  last: number;
}

/**
 * The surface a command handler is given. Implemented by `CliSession`; commands
 * depend on this interface (not the class) so there is no import cycle.
 */
export interface SessionApi {
  readonly device: Device;
  readonly engine: SimulationEngine;
  mode: CliMode;
  ifaceCtx: InterfaceContext | undefined;
  vlanId: number | undefined;
  aclCtx: AclContext | undefined;
  routerCtx: RouterProcessContext | undefined;
  lineCtx: VtyLineContext | undefined;
  /** Transition to another mode (clears context as appropriate). */
  enter(mode: CliMode): void;
  /**
   * Schedule a deterministic network operation. Automatic execution drains
   * the engine before `complete`; step execution defers `complete` until the
   * worker has processed the shared event queue. A staged operation may return
   * `undefined` after scheduling its next bounded phase.
   */
  runNetworkOperation(start: () => void, complete: () => string | undefined): string;
  /**
   * Ask before a destructive runtime action. The next line the learner types is
   * consumed as the answer; anything other than an explicit yes cancels.
   */
  requestConfirmation(prompt: string, onConfirm: () => string): string;
}

export interface CommandSpec {
  /** Literal + `{hole}` pattern; see `matchPattern`. */
  pattern: string;
  /** Modes this command is valid in. */
  modes: CliMode[];
  /** Restrict to a device kind; defaults to "any". */
  device?: DeviceFilter;
  /** Functional requirements, evaluated through the registered device profile. */
  capabilities?: readonly DeviceCapability[];
  /** Learner-facing syntax used when a known command is incomplete. */
  usage?: string;
  run(session: SessionApi, params: Params): string | void;
}

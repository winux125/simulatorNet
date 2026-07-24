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
}

export interface AclContext {
  id: string;
  type: "standard" | "extended";
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
  /** Transition to another mode (clears context as appropriate). */
  enter(mode: CliMode): void;
  /**
   * Schedule a deterministic network operation. Automatic execution drains
   * the engine before `complete`; step execution defers `complete` until the
   * worker has processed the shared event queue. A staged operation may return
   * `undefined` after scheduling its next bounded phase.
   */
  runNetworkOperation(start: () => void, complete: () => string | undefined): string;
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

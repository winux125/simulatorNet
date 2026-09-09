/**
 * The normalized Packet Tracer model.
 *
 * This is the seam between the file format and SimulatorNet: everything above
 * it reads these plain structures, and no XML node travels past this point. It
 * is deliberately Packet Tracer's vocabulary, not ours — `packetTracerModel`
 * stays "2960-24TT" and the mapping to a SimulatorNet device type happens in
 * the importer, so a wrong mapping is a mapping bug and never a parse bug.
 */

export type PacketTracerDocumentFormat = "pkt" | "pka";

export interface PacketTracerParseWarning {
  readonly code: string;
  readonly message: string;
  readonly deviceId?: string;
}

export interface PacketTracerInterface {
  /** Packet Tracer's own name, e.g. "FastEthernet0/1". */
  readonly name: string;
  /** Port kind, e.g. "eCopperFastEthernet". Absent for a cable-derived port. */
  readonly portType?: string;
  /** True when this interface was seen only as a cable endpoint. */
  readonly derivedFromCable: boolean;
}

export interface PacketTracerHostConfiguration {
  readonly ipv4?: string;
  readonly subnetMask?: string;
  readonly gateway?: string;
  readonly dhcpEnabled?: boolean;
  readonly ipv6?: readonly string[];
  readonly ipv6Gateway?: string;
  readonly dns?: readonly string[];
}

export interface PacketTracerDevice {
  /** `save-ref-id:…`, or a synthesized stable id when the file omits one. */
  readonly id: string;
  readonly hostname?: string;
  /** Engine class as Packet Tracer names it, e.g. "Pc", "Switch", "Router". */
  readonly packetTracerType?: string;
  /** Catalogue model, e.g. "PC-PT", "2960-24TT", "1941". */
  readonly packetTracerModel?: string;
  readonly x?: number;
  readonly y?: number;
  readonly interfaces: readonly PacketTracerInterface[];
  /** Count of physical ports the chassis declares, including unconnected ones. */
  readonly portCount: number;
  /** Joined `<RUNNINGCONFIG><LINE>` text, when the device has one. */
  readonly runningConfig?: string;
  readonly hostConfiguration?: PacketTracerHostConfiguration;
}

export interface PacketTracerLink {
  readonly id: string;
  readonly sourceDeviceId: string;
  readonly sourceInterface?: string;
  readonly targetDeviceId: string;
  readonly targetInterface?: string;
  /** Inner cable kind, e.g. "eStraightThrough", "eCrossOver", "eFiber". */
  readonly packetTracerCableType?: string;
  /** Outer media kind, e.g. "eCopper", "eFiber", "eSerial". */
  readonly packetTracerMediaType?: string;
}

export interface PacketTracerNetwork {
  readonly id: string;
  readonly name?: string;
  readonly devices: readonly PacketTracerDevice[];
  readonly links: readonly PacketTracerLink[];
}

/**
 * Which role a network plays inside an activity. `kind` is inferred from the
 * element the network was found under; anything unrecognised stays "unknown"
 * rather than being guessed into a role the user might then import by mistake.
 */
export type PacketTracerNetworkRole = "initial" | "answer" | "current" | "unknown";

export interface PacketTracerActivityNetwork {
  readonly kind: PacketTracerNetworkRole;
  /** Display name, from the file when it has one, else derived from the role. */
  readonly name: string;
  readonly networkId: string;
}

export interface PacketTracerActivity {
  readonly title?: string;
  /** Plain-text instructions, when present and safely bounded. */
  readonly instructions?: string;
  readonly networks: readonly PacketTracerActivityNetwork[];
}

export interface PacketTracerDocument {
  readonly format: PacketTracerDocumentFormat;
  readonly version?: string;
  readonly networks: readonly PacketTracerNetwork[];
  readonly activity?: PacketTracerActivity;
  readonly warnings: readonly PacketTracerParseWarning[];
}

import type { OspfNeighborState, OspfNetworkType } from "./ospf";
import type { Ipv4 } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";

export const OSPFV3_ALL_ROUTERS: Ipv6 = "ff02::5";
export const OSPFV3_ALL_DESIGNATED_ROUTERS: Ipv6 = "ff02::6";

export interface Ospfv3Prefix {
  readonly network: Ipv6;
  readonly prefixLength: number;
  readonly cost: number;
}

export interface Ospfv3Link {
  readonly routerId: Ipv4;
  readonly cost: number;
}

export interface Ospfv3RouterLsa {
  readonly advertisingRouter: Ipv4;
  readonly sequence: number;
  readonly originatedAtNs: number;
  readonly checksum: number;
  readonly prefixes: readonly Ospfv3Prefix[];
  readonly links: readonly Ospfv3Link[];
}

interface Ospfv3PacketBase {
  readonly kind: "ospfv3";
  readonly routerId: Ipv4;
  readonly areaId: 0;
}

export interface Ospfv3HelloPacket extends Ospfv3PacketBase {
  readonly type: "hello";
  readonly interfaceId: number;
  readonly helloIntervalNs: number;
  readonly deadIntervalNs: number;
  readonly priority: number;
  readonly networkType: OspfNetworkType;
  readonly designatedRouter?: Ipv4;
  readonly backupDesignatedRouter?: Ipv4;
  readonly neighbors: readonly Ipv4[];
}

export interface Ospfv3LinkStateUpdatePacket extends Ospfv3PacketBase {
  readonly type: "lsu";
  readonly updateId: number;
  readonly lsas: readonly Ospfv3RouterLsa[];
}

export interface Ospfv3LinkStateAckPacket extends Ospfv3PacketBase {
  readonly type: "lsack";
  readonly updateId: number;
  readonly advertisingRouters: readonly Ipv4[];
}

export type Ospfv3Packet =
  | Ospfv3HelloPacket
  | Ospfv3LinkStateUpdatePacket
  | Ospfv3LinkStateAckPacket;

export interface Ospfv3NeighborStateRecord {
  readonly routerId: Ipv4;
  readonly state: OspfNeighborState;
}

/** Stable checksum for structured LSAs; it is diagnostic, not a wire CRC. */
export function ospfv3LsaChecksum(input: Omit<Ospfv3RouterLsa, "checksum">): number {
  const canonical = JSON.stringify({
    advertisingRouter: input.advertisingRouter,
    sequence: input.sequence,
    originatedAtNs: input.originatedAtNs,
    prefixes: [...input.prefixes].sort((left, right) =>
      left.network.localeCompare(right.network) || left.prefixLength - right.prefixLength),
    links: [...input.links].sort((left, right) => left.routerId.localeCompare(right.routerId)),
  });
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index++) {
    hash = Math.imul(hash ^ canonical.charCodeAt(index), 16_777_619) >>> 0;
  }
  return hash & 0xffff;
}

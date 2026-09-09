/**
 * Typed protocol for the Packet Tracer decode worker.
 *
 * A `.pkt` container is a block cipher, an inflate and an XML parse deep before
 * anything at all can be shown, so it never runs on the React thread. Only
 * plain serializable data crosses this boundary: bytes in, an inspection out.
 *
 * The file itself is never uploaded anywhere. The worker is a thread in the
 * same browser tab, so the whole conversion stays offline exactly as every
 * other import does.
 */
import type { PacketTracerDecodeStage, PacketTracerFailure, PacketTracerInspection } from "@sim/importers";

/** Decode a container and plan one of its networks. */
export interface PacketTracerInspectRequest {
  readonly kind: "inspect";
  readonly requestId: string;
  readonly filename?: string;
  /** Transferred, so the decode does not begin by copying the whole upload. */
  readonly bytes: ArrayBuffer;
  /** Which contained network to plan. Omitted for the file's own default. */
  readonly networkId?: string;
}

/** Abandon an in-flight decode. The worker aborts and answers `failed`. */
export interface PacketTracerCancelRequest {
  readonly kind: "cancel";
  readonly requestId: string;
}

export type PacketTracerWorkerRequest = PacketTracerInspectRequest | PacketTracerCancelRequest;

/**
 * Progress as a named stage, never a percentage: the decoder cannot know how
 * much work is left until it has done it, and an invented bar would be a lie.
 */
export interface PacketTracerStageMessage {
  readonly kind: "stage";
  readonly requestId: string;
  readonly stage: PacketTracerDecodeStage;
}

export interface PacketTracerInspectedMessage {
  readonly kind: "inspected";
  readonly requestId: string;
  readonly inspection: PacketTracerInspection;
}

/** A refusal, classified by `describePacketTracerFailure` before it is posted. */
export interface PacketTracerFailedMessage extends PacketTracerFailure {
  readonly kind: "failed";
  readonly requestId: string;
}

export type PacketTracerWorkerResponse =
  | PacketTracerStageMessage
  | PacketTracerInspectedMessage
  | PacketTracerFailedMessage;

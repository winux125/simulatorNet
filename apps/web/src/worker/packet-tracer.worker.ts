/// <reference lib="webworker" />

/**
 * Packet Tracer decode worker.
 *
 * Owns nothing: it decodes the bytes it is handed and answers. All the format
 * knowledge lives in `@sim/packet-tracer-format` and `@sim/importers`, so this
 * file is only the thread boundary and the cancellation bookkeeping.
 */
import { describePacketTracerFailure, inspectPacketTracerFile } from "@sim/importers";
import type { PacketTracerWorkerRequest, PacketTracerWorkerResponse } from "./packet-tracer-protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** In-flight decodes, so a cancel can reach the one it names. */
const running = new Map<string, AbortController>();

function respond(message: PacketTracerWorkerResponse): void {
  scope.postMessage(message);
}

async function inspect(request: Extract<PacketTracerWorkerRequest, { kind: "inspect" }>): Promise<void> {
  const controller = new AbortController();
  running.set(request.requestId, controller);
  try {
    const inspection = await inspectPacketTracerFile(
      { filename: request.filename, bytes: new Uint8Array(request.bytes) },
      {
        networkId: request.networkId,
        signal: controller.signal,
        onStage: (stage) => respond({ kind: "stage", requestId: request.requestId, stage }),
      },
    );
    respond({ kind: "inspected", requestId: request.requestId, inspection });
  } catch (cause) {
    respond({ kind: "failed", requestId: request.requestId, ...describePacketTracerFailure(cause) });
  } finally {
    running.delete(request.requestId);
  }
}

scope.onmessage = (event: MessageEvent<PacketTracerWorkerRequest>) => {
  const request = event.data;
  if (request.kind === "cancel") {
    running.get(request.requestId)?.abort();
    return;
  }
  void inspect(request);
};

export {};

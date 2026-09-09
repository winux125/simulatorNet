/**
 * Main-thread client for the Packet Tracer decode worker.
 *
 * Where a `Worker` exists the decode runs on its own thread; where it does not
 * — a jsdom test, an environment that blocks workers — the very same
 * `inspectPacketTracerFile` runs in process. Both paths report the same stages
 * and refuse in the same typed way, so nothing downstream can tell them apart
 * except by how long the tab stays responsive.
 */
import {
  describePacketTracerFailure,
  inspectPacketTracerFile,
  type PacketTracerDecodeErrorCode,
  type PacketTracerDecodeStage,
  type PacketTracerFailure,
  type PacketTracerInspection,
} from "@sim/importers";
import type { PacketTracerWorkerRequest, PacketTracerWorkerResponse } from "./packet-tracer-protocol";

export interface PacketTracerInspectRequest {
  readonly filename?: string;
  readonly bytes: Uint8Array;
  /** Which contained network to plan. Omitted for the file's own default. */
  readonly networkId?: string;
  readonly onStage?: (stage: PacketTracerDecodeStage) => void;
  readonly signal?: AbortSignal;
}

/** A refused decode, carrying the reason the wizard needs to explain itself. */
export class PacketTracerInspectError extends Error implements PacketTracerFailure {
  readonly reason?: PacketTracerDecodeErrorCode;
  readonly suggestsCompanionFallback: boolean;
  readonly cancelled: boolean;

  constructor(failure: PacketTracerFailure) {
    super(failure.message);
    this.name = "PacketTracerInspectError";
    this.reason = failure.reason;
    this.suggestsCompanionFallback = failure.suggestsCompanionFallback;
    this.cancelled = failure.cancelled;
  }
}

export interface PacketTracerImportClient {
  inspect(request: PacketTracerInspectRequest): Promise<PacketTracerInspection>;
  /** Cancel everything in flight and release the thread. */
  dispose(): void;
}

interface Pending {
  readonly onStage?: (stage: PacketTracerDecodeStage) => void;
  readonly settle: (response: PacketTracerInspectedMessageOrFailure) => void;
  readonly release: () => void;
}

type PacketTracerInspectedMessageOrFailure =
  | { readonly ok: true; readonly inspection: PacketTracerInspection }
  | { readonly ok: false; readonly failure: PacketTracerFailure };

class WorkerBackedClient implements PacketTracerImportClient {
  private worker: Worker | undefined;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private disposed = false;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./packet-tracer.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<PacketTracerWorkerResponse>) => {
      this.receive(event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      // A crashed worker leaves every caller waiting for ever otherwise.
      this.failAll(event.message || "The Packet Tracer decoder crashed");
    });
    this.worker = worker;
    return worker;
  }

  private receive(message: PacketTracerWorkerResponse): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    if (message.kind === "stage") {
      entry.onStage?.(message.stage);
      return;
    }
    this.pending.delete(message.requestId);
    entry.release();
    entry.settle(message.kind === "inspected"
      ? { ok: true, inspection: message.inspection }
      : { ok: false, failure: message });
  }

  private failAll(message: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      this.pending.delete(requestId);
      entry.release();
      entry.settle({ ok: false, failure: { message, suggestsCompanionFallback: false, cancelled: false } });
    }
  }

  private post(request: PacketTracerWorkerRequest, transfer: Transferable[] = []): void {
    this.ensureWorker().postMessage(request, transfer);
  }

  async inspect(request: PacketTracerInspectRequest): Promise<PacketTracerInspection> {
    if (this.disposed) throw new PacketTracerInspectError({ message: "The import wizard was closed", suggestsCompanionFallback: false, cancelled: true });
    const requestId = `pt-${++this.nextId}`;
    // Detached by the transfer below, so it is a copy rather than the caller's
    // own buffer: a wizard that has to re-inspect for another network would
    // otherwise find its bytes gone.
    const bytes = request.bytes.buffer.slice(
      request.bytes.byteOffset,
      request.bytes.byteOffset + request.bytes.byteLength,
    ) as ArrayBuffer;

    const result = await new Promise<PacketTracerInspectedMessageOrFailure>((resolve) => {
      const cancel = () => this.post({ kind: "cancel", requestId });
      request.signal?.addEventListener("abort", cancel);
      this.pending.set(requestId, {
        onStage: request.onStage,
        settle: resolve,
        release: () => request.signal?.removeEventListener("abort", cancel),
      });
      this.post({ kind: "inspect", requestId, filename: request.filename, bytes, networkId: request.networkId }, [bytes]);
    });

    if (!result.ok) throw new PacketTracerInspectError(result.failure);
    return result.inspection;
  }

  dispose(): void {
    this.disposed = true;
    this.failAll("The import wizard was closed");
    this.worker?.terminate();
    this.worker = undefined;
  }
}

/**
 * Same contract, no thread. Used only where `Worker` is unavailable; it is not
 * a lighter path, so the tab does block for the length of the decode.
 */
class InProcessClient implements PacketTracerImportClient {
  private readonly controllers = new Set<AbortController>();

  async inspect(request: PacketTracerInspectRequest): Promise<PacketTracerInspection> {
    const controller = new AbortController();
    if (request.signal?.aborted === true) controller.abort();
    const forward = () => controller.abort();
    request.signal?.addEventListener("abort", forward);
    this.controllers.add(controller);
    try {
      return await inspectPacketTracerFile(
        { filename: request.filename, bytes: request.bytes },
        { networkId: request.networkId, signal: controller.signal, onStage: request.onStage },
      );
    } catch (cause) {
      throw new PacketTracerInspectError(describePacketTracerFailure(cause));
    } finally {
      request.signal?.removeEventListener("abort", forward);
      this.controllers.delete(controller);
    }
  }

  dispose(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

export function createPacketTracerImportClient(): PacketTracerImportClient {
  return typeof Worker === "function" ? new WorkerBackedClient() : new InProcessClient();
}

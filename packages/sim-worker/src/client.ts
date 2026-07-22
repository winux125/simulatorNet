import { SimulationWorkerError, WorkerRequestTimeoutError, WorkerTerminatedError } from "./errors";
import type {
  SerializedWorkerError,
  SimWorkerEvent,
  SimWorkerOutboundMessage,
  SimWorkerPayload,
  SimWorkerPayloadByType,
  SimWorkerRequest,
  SimWorkerRequestInputOf,
} from "./protocol";

export interface WorkerTransport {
  postMessage(message: SimWorkerRequest): void;
  subscribe(onMessage: (message: unknown) => void, onError: (error: unknown) => void): () => void;
  terminate(): void;
}

export interface TimeoutScheduler {
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(handle: unknown): void;
}

export interface SimWorkerClientOptions {
  timeoutMs?: number;
  scheduler: TimeoutScheduler;
}

interface PendingRequest {
  resolve(payload: SimWorkerPayload): void;
  reject(error: Error): void;
  timeoutHandle: unknown;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function isOutbound(value: unknown): value is SimWorkerOutboundMessage {
  return typeof recordOf(value)?.type === "string";
}

function errorFromSerialized(error: SerializedWorkerError): SimulationWorkerError {
  const result = new SimulationWorkerError(error.code, error.message, error.path, error.context);
  result.name = error.name;
  return result;
}

export class SimWorkerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: SimWorkerEvent) => void>();
  private readonly unsubscribe: () => void;
  private nextRequestId = 1;
  private terminated = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: WorkerTransport,
    private readonly options: SimWorkerClientOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.unsubscribe = transport.subscribe(
      (message) => this.handleMessage(message),
      (error) => this.handleTransportError(error),
    );
  }

  request<Type extends SimWorkerRequest["type"]>(
    input: SimWorkerRequestInputOf<Type>,
  ): Promise<SimWorkerPayloadByType[Type]> {
    if (this.terminated) return Promise.reject(new WorkerTerminatedError());
    const requestId = `request-${this.nextRequestId++}`;
    const request = { ...input, requestId } as SimWorkerRequest;
    return new Promise<SimWorkerPayloadByType[Type]>((resolve, reject) => {
      const timeoutHandle = this.options.scheduler.schedule(() => {
        this.pending.delete(requestId);
        reject(new WorkerRequestTimeoutError(requestId));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: (payload) => resolve(payload as SimWorkerPayloadByType[Type]),
        reject,
        timeoutHandle,
      });
      this.transport.postMessage(request);
    });
  }

  onEvent(listener: (event: SimWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.unsubscribe();
    this.transport.terminate();
    const error = new WorkerTerminatedError();
    for (const pending of this.pending.values()) {
      this.options.scheduler.cancel(pending.timeoutHandle);
      pending.reject(error);
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private handleMessage(message: unknown): void {
    if (!isOutbound(message)) return;
    if (message.type === "REQUEST_SUCCEEDED" || message.type === "REQUEST_FAILED") {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      this.options.scheduler.cancel(pending.timeoutHandle);
      if (message.type === "REQUEST_SUCCEEDED") pending.resolve(message.payload);
      else pending.reject(errorFromSerialized(message.error));
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private handleTransportError(error: unknown): void {
    const failure = error instanceof Error ? error : new Error("Simulation worker crashed");
    for (const pending of this.pending.values()) {
      this.options.scheduler.cancel(pending.timeoutHandle);
      pending.reject(failure);
    }
    this.pending.clear();
    for (const listener of this.listeners) {
      listener({
        type: "RUNTIME_ERROR",
        error: { name: failure.name, code: "worker-crash", message: failure.message },
      });
    }
  }
}

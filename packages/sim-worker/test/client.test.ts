import {
  SimWorkerClient,
  WorkerRequestTimeoutError,
  WorkerTerminatedError,
  type SimWorkerRequest,
  type TimeoutScheduler,
  type WorkerTransport,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";

class FakeScheduler implements TimeoutScheduler {
  private callbacks = new Map<number, () => void>();
  private next = 1;
  schedule(callback: () => void): unknown {
    const id = this.next++;
    this.callbacks.set(id, callback);
    return id;
  }
  cancel(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
  }
  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

class FakeTransport implements WorkerTransport {
  readonly sent: SimWorkerRequest[] = [];
  terminated = false;
  private onMessage: ((message: unknown) => void) | undefined;
  private onError: ((error: unknown) => void) | undefined;
  postMessage(message: SimWorkerRequest): void {
    this.sent.push(message);
  }
  subscribe(onMessage: (message: unknown) => void, onError: (error: unknown) => void): () => void {
    this.onMessage = onMessage;
    this.onError = onError;
    return () => {
      this.onMessage = undefined;
      this.onError = undefined;
    };
  }
  terminate(): void {
    this.terminated = true;
  }
  receive(message: unknown): void {
    this.onMessage?.(message);
  }
  crash(error: unknown): void {
    this.onError?.(error);
  }
}

describe("SimWorkerClient", () => {
  it("correlates out-of-order responses by requestId", async () => {
    const transport = new FakeTransport();
    const scheduler = new FakeScheduler();
    const client = new SimWorkerClient(transport, { scheduler });
    const first = client.request({ type: "GET_SNAPSHOT" });
    const second = client.request({ type: "GET_SNAPSHOT" });
    const firstRequestId = transport.sent[0]!.requestId;
    const secondRequestId = transport.sent[1]!.requestId;
    expect(firstRequestId).not.toBe(secondRequestId);
    const snapshot = { labId: "x", title: "x", engineState: "idle" as const, virtualTime: 0, nodes: [], links: [] };
    transport.receive({ type: "REQUEST_SUCCEEDED", requestId: secondRequestId, payload: { ...snapshot, title: "second" } });
    transport.receive({ type: "REQUEST_SUCCEEDED", requestId: firstRequestId, payload: { ...snapshot, title: "first" } });
    await expect(first).resolves.toMatchObject({ title: "first" });
    await expect(second).resolves.toMatchObject({ title: "second" });
  });

  it("rejects a request when its timeout expires", async () => {
    const transport = new FakeTransport();
    const scheduler = new FakeScheduler();
    const client = new SimWorkerClient(transport, { scheduler, timeoutMs: 5 });
    const pending = client.request({ type: "GET_SNAPSHOT" });
    scheduler.fireAll();
    await expect(pending).rejects.toBeInstanceOf(WorkerRequestTimeoutError);
  });

  it("cleans pending requests on termination", async () => {
    const transport = new FakeTransport();
    const scheduler = new FakeScheduler();
    const client = new SimWorkerClient(transport, { scheduler });
    const pending = client.request({ type: "GET_SNAPSHOT" });
    client.terminate();
    await expect(pending).rejects.toBeInstanceOf(WorkerTerminatedError);
    expect(transport.terminated).toBe(true);
    await expect(client.request({ type: "GET_SNAPSHOT" })).rejects.toBeInstanceOf(WorkerTerminatedError);
  });

  it("emits a safe runtime event when the worker crashes", () => {
    const transport = new FakeTransport();
    const scheduler = new FakeScheduler();
    const client = new SimWorkerClient(transport, { scheduler });
    const events: string[] = [];
    client.onEvent((event) => {
      if (event.type === "RUNTIME_ERROR") events.push(event.error.code);
    });
    transport.crash(new Error("boom"));
    expect(events).toEqual(["worker-crash"]);
  });
});

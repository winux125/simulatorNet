/**
 * The decode client's two halves.
 *
 * The worker-backed path is exercised against a stub `Worker`, because what
 * matters here is the protocol — stages forwarded, a refusal rebuilt as a typed
 * error, a cancel that actually reaches the thread, a dispose that leaves
 * nothing pending. The decoding itself is covered where it lives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPacketTracerImportClient, PacketTracerInspectError } from "./packet-tracer-client";
import type { PacketTracerWorkerRequest, PacketTracerWorkerResponse } from "./packet-tracer-protocol";

const original = Reflect.get(globalThis, "Worker") as unknown;

/** Records what the client posts and lets a test answer it by hand. */
class StubWorker {
  static last: StubWorker | undefined;
  readonly posted: PacketTracerWorkerRequest[] = [];
  readonly transfers: unknown[][] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: URL, readonly options?: WorkerOptions) {
    StubWorker.last = this;
  }

  postMessage(request: PacketTracerWorkerRequest, transfer: unknown[] = []): void {
    this.posted.push(request);
    this.transfers.push(transfer);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: PacketTracerWorkerResponse): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: message });
  }

  crash(message: string): void {
    for (const listener of this.listeners.get("error") ?? []) listener({ message });
  }

  /** The id of the inspect request the client posted, in order. */
  requestId(index = 0): string {
    return this.posted.filter((request) => request.kind === "inspect")[index]!.requestId;
  }
}

function useStubWorker(): void {
  StubWorker.last = undefined;
  Reflect.set(globalThis, "Worker", StubWorker);
}

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, "Worker");
  else Reflect.set(globalThis, "Worker", original);
});

const BYTES = new Uint8Array([1, 2, 3, 4]);
const INSPECTION = { format: "packet-tracer-pkt", networks: [], selectedNetworkId: "n0" } as never;

/** Wait for the client to have posted its request without polling on a timer. */
async function postedRequest(): Promise<StubWorker> {
  for (let attempt = 0; attempt < 50 && (StubWorker.last?.posted.length ?? 0) === 0; attempt++) {
    await Promise.resolve();
  }
  return StubWorker.last!;
}

describe("worker-backed decode client", () => {
  it("posts the bytes as a transfer and resolves with the inspection", async () => {
    useStubWorker();
    const client = createPacketTracerImportClient();
    const pending = client.inspect({ filename: "lab.pkt", bytes: BYTES });
    const worker = await postedRequest();

    const request = worker.posted[0]!;
    expect(request.kind).toBe("inspect");
    expect(worker.options?.type).toBe("module");
    // Transferred, so the decode does not begin by copying the upload.
    expect(worker.transfers[0]).toHaveLength(1);

    worker.reply({ kind: "inspected", requestId: worker.requestId(), inspection: INSPECTION });
    await expect(pending).resolves.toBe(INSPECTION);
    client.dispose();
  });

  it("forwards each named stage as it arrives", async () => {
    useStubWorker();
    const client = createPacketTracerImportClient();
    const onStage = vi.fn();
    const pending = client.inspect({ bytes: BYTES, onStage });
    const worker = await postedRequest();
    const requestId = worker.requestId();

    worker.reply({ kind: "stage", requestId, stage: "decoding" });
    worker.reply({ kind: "stage", requestId, stage: "parsing" });
    expect(onStage.mock.calls.map((call) => call[0])).toEqual(["decoding", "parsing"]);

    worker.reply({ kind: "inspected", requestId, inspection: INSPECTION });
    await pending;
    client.dispose();
  });

  it("rebuilds a refusal as a typed error carrying its reason", async () => {
    useStubWorker();
    const client = createPacketTracerImportClient();
    const pending = client.inspect({ bytes: BYTES });
    const worker = await postedRequest();

    worker.reply({
      kind: "failed",
      requestId: worker.requestId(),
      message: "Unsupported Packet Tracer container version",
      reason: "PACKET_TRACER_UNSUPPORTED_VERSION",
      suggestsCompanionFallback: true,
      cancelled: false,
    });

    await expect(pending).rejects.toBeInstanceOf(PacketTracerInspectError);
    await pending.catch((error: PacketTracerInspectError) => {
      expect(error.reason).toBe("PACKET_TRACER_UNSUPPORTED_VERSION");
      expect(error.suggestsCompanionFallback).toBe(true);
    });
    client.dispose();
  });

  it("cancels the named request when its signal aborts", async () => {
    useStubWorker();
    const client = createPacketTracerImportClient();
    const abort = new AbortController();
    const pending = client.inspect({ bytes: BYTES, signal: abort.signal });
    const worker = await postedRequest();
    const requestId = worker.requestId();

    abort.abort();
    expect(worker.posted.at(-1)).toEqual({ kind: "cancel", requestId });

    // The rejection still comes from the worker, so there is one settle path.
    worker.reply({ kind: "failed", requestId, message: "cancelled", suggestsCompanionFallback: false, cancelled: true });
    await expect(pending).rejects.toMatchObject({ cancelled: true });
    client.dispose();
  });

  it("fails every pending request when the worker crashes", async () => {
    useStubWorker();
    const client = createPacketTracerImportClient();
    const first = client.inspect({ bytes: BYTES });
    const worker = await postedRequest();
    const second = client.inspect({ bytes: BYTES });
    await postedRequest();

    worker.crash("boom");
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    client.dispose();
  });

  it("terminates the thread and settles what was left on dispose", async () => {
    useStubWorker();
    const client = createPacketTracerImportClient();
    const pending = client.inspect({ bytes: BYTES });
    const worker = await postedRequest();

    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow("closed");
    await expect(client.inspect({ bytes: BYTES })).rejects.toBeInstanceOf(PacketTracerInspectError);
  });

  it("reuses one thread across requests", async () => {
    useStubWorker();
    const client = createPacketTracerImportClient();
    const first = client.inspect({ bytes: BYTES });
    const worker = await postedRequest();
    worker.reply({ kind: "inspected", requestId: worker.requestId(), inspection: INSPECTION });
    await first;

    const second = client.inspect({ bytes: BYTES });
    await postedRequest();
    expect(StubWorker.last).toBe(worker);
    worker.reply({ kind: "inspected", requestId: worker.requestId(1), inspection: INSPECTION });
    await second;
    client.dispose();
  });
});

describe("in-process decode client", () => {
  it("is chosen where no Worker exists and refuses in the same typed way", async () => {
    // jsdom has no Worker, so this is the fallback the wizard's own tests use.
    expect(Reflect.get(globalThis, "Worker")).toBeUndefined();
    const client = createPacketTracerImportClient();
    await expect(client.inspect({ filename: "lab.pkt", bytes: new Uint8Array([0, 1, 2]) }))
      .rejects.toMatchObject({
        name: "PacketTracerInspectError",
        reason: "PACKET_TRACER_NOT_A_CONTAINER",
        suggestsCompanionFallback: true,
      });
    client.dispose();
  });
});

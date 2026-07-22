import { SimWorkerClient, type WorkerTransport } from "@sim/sim-worker";

export function createBrowserSimWorkerClient(): SimWorkerClient {
  const worker = new Worker(new URL("./simulator.worker.ts", import.meta.url), { type: "module" });
  const transport: WorkerTransport = {
    postMessage: (message) => worker.postMessage(message),
    subscribe: (onMessage, onError) => {
      const messageListener = (event: MessageEvent<unknown>) => onMessage(event.data);
      const errorListener = (event: ErrorEvent) => onError(new Error(event.message || "Simulation worker crashed"));
      worker.addEventListener("message", messageListener);
      worker.addEventListener("error", errorListener);
      return () => {
        worker.removeEventListener("message", messageListener);
        worker.removeEventListener("error", errorListener);
      };
    },
    terminate: () => worker.terminate(),
  };
  return new SimWorkerClient(transport, {
    timeoutMs: 15_000,
    scheduler: {
      schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      cancel: (handle) => {
        if (typeof handle === "number") window.clearTimeout(handle);
      },
    },
  });
}

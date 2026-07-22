/// <reference lib="webworker" />

import { createSimulationWorkerRuntime } from "@sim/sim-worker";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const runtime = createSimulationWorkerRuntime((message) => scope.postMessage(message));

scope.onmessage = (event: MessageEvent<unknown>) => {
  scope.postMessage(runtime.handleRequest(event.data));
};

export {};

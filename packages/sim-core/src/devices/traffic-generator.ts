import {
  DEFAULT_PING_TIMEOUT_NS,
  NS_PER_S,
} from "../engine/constants";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import { EndHost } from "./pc";

export const TRAFFIC_GENERATOR_LIMITS = Object.freeze({
  maximumFlows: 32,
  maximumPacketsPerFlow: 1_024,
  maximumIntervalNs: 60 * NS_PER_S,
  maximumPayloadBytes: 65_536,
  completionTimeoutNs: 6 * NS_PER_S,
});

interface TrafficFlowBase {
  readonly id: string;
  readonly destination: Ipv4;
  readonly count: number;
  readonly intervalNs: number;
  readonly payloadBytes?: number;
}

export type TrafficFlow =
  | (TrafficFlowBase & { readonly protocol: "icmp" })
  | (TrafficFlowBase & {
      readonly protocol: "udp";
      readonly destinationPort: number;
      readonly sourcePort?: number;
    })
  | (TrafficFlowBase & {
      readonly protocol: "tcp";
      readonly destinationPort: number;
    })
  | (TrafficFlowBase & {
      readonly protocol: "http";
      readonly url: string;
    });

export interface TrafficFlowResult {
  readonly flowId: string;
  readonly status: "queued" | "running" | "completed";
  readonly sent: number;
  readonly received: number;
  readonly dropped: number;
  readonly permitted: number;
  readonly denied: number;
  readonly translated: number;
  readonly timedOut: number;
  readonly startedAtNs: number;
  readonly completedAtNs: number | undefined;
}

interface MutableTrafficFlowResult extends Omit<TrafficFlowResult, "status" | "sent" | "received" | "dropped" | "permitted" | "denied" | "translated" | "timedOut" | "completedAtNs"> {
  status: TrafficFlowResult["status"];
  sent: number;
  received: number;
  dropped: number;
  permitted: number;
  denied: number;
  translated: number;
  timedOut: number;
  completedAtNs: number | undefined;
}

/** Bounded deterministic traffic source. Auto/Step execution is owned by the worker. */
export class TrafficGenerator extends EndHost {
  readonly deviceType = "traffic-generator" as const;
  private readonly flows = new Map<string, TrafficFlow>();
  private readonly results = new Map<string, MutableTrafficFlowResult>();
  private sequence = 0;

  configureFlow(flow: TrafficFlow): void {
    validateFlow(flow);
    if (!this.flows.has(flow.id) && this.flows.size >= TRAFFIC_GENERATOR_LIMITS.maximumFlows) {
      throw new TrafficGeneratorError(
        "TRAFFIC_FLOW_LIMIT",
        `Traffic flow limit exceeded (${TRAFFIC_GENERATOR_LIMITS.maximumFlows}).`,
      );
    }
    this.flows.set(flow.id, { ...flow });
    this.results.delete(flow.id);
  }

  removeFlow(flowId: string): void {
    this.flows.delete(flowId);
    this.results.delete(flowId);
  }

  flowConfigurations(): TrafficFlow[] {
    return [...this.flows.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((flow) => ({ ...flow }));
  }

  startFlow(flowId: string): TrafficFlowResult {
    const flow = this.flows.get(flowId);
    if (!flow) throw new TrafficGeneratorError("TRAFFIC_FLOW_NOT_FOUND", `Traffic flow '${flowId}' was not found.`);
    if (!this.ip) throw new TrafficGeneratorError("TRAFFIC_INVALID_CONFIGURATION", "Traffic Generator requires an IPv4 address.");
    const current = this.results.get(flowId);
    if (current && current.status !== "completed") {
      throw new TrafficGeneratorError("TRAFFIC_FLOW_RUNNING", `Traffic flow '${flowId}' is already running.`);
    }
    const result: MutableTrafficFlowResult = {
      flowId,
      status: "queued",
      sent: 0,
      received: 0,
      dropped: 0,
      permitted: 0,
      denied: 0,
      translated: 0,
      timedOut: 0,
      startedAtNs: this.engine.now(),
      completedAtNs: undefined,
    };
    this.results.set(flowId, result);
    const pingStart = this.pingResults.length;
    const httpStart = this.applications.httpResults.length;

    for (let index = 0; index < flow.count; index++) {
      this.engine.scheduleIn(index * flow.intervalNs, () => {
        result.status = "running";
        result.sent++;
        this.sendFlowUnit(flow, result);
      });
    }
    const networkWait = flow.protocol === "icmp"
      ? DEFAULT_PING_TIMEOUT_NS
      : TRAFFIC_GENERATOR_LIMITS.completionTimeoutNs;
    this.engine.scheduleIn((flow.count - 1) * flow.intervalNs + networkWait, () => {
      this.finishFlow(flow, result, pingStart, httpStart);
    });
    this.engine.trace({
      time: this.engine.now(),
      type: "traffic-flow-queued",
      device: this.id,
      detail: { flowId, protocol: flow.protocol, count: flow.count, intervalNs: flow.intervalNs },
    });
    return { ...result };
  }

  flowResults(): TrafficFlowResult[] {
    return [...this.results.values()]
      .map((result) => ({ ...result }))
      .sort((a, b) => a.flowId.localeCompare(b.flowId));
  }

  resetFlowRuntime(): void {
    this.results.clear();
    this.sequence = 0;
  }

  private sendFlowUnit(flow: TrafficFlow, result: MutableTrafficFlowResult): void {
    if (flow.protocol === "icmp") {
      this.ping(flow.destination, ++this.sequence);
      return;
    }
    if (flow.protocol === "udp") {
      this.sendUdp({
        destinationAddress: flow.destination,
        destinationPort: flow.destinationPort,
        sourcePort: flow.sourcePort,
        payload: {
          kind: "udp-application",
          protocol: "traffic-generator",
          data: "x".repeat(flow.payloadBytes ?? 0),
        },
      });
      return;
    }
    if (flow.protocol === "tcp") {
      let established = false;
      this.connectTcp(flow.destination, flow.destinationPort, {
        onEstablished: (connection) => {
          established = true;
          result.received++;
          result.permitted++;
          connection.close();
        },
        onReset: () => {
          result.dropped++;
          result.denied++;
        },
        onClosed: () => {
          if (!established) {
            result.dropped++;
            result.timedOut++;
          }
        },
      }, "traffic-generator");
      return;
    }
    this.applications.httpGet(flow.url);
  }

  private finishFlow(
    flow: TrafficFlow,
    result: MutableTrafficFlowResult,
    pingStart: number,
    httpStart: number,
  ): void {
    if (flow.protocol === "icmp") {
      const attempts = this.pingResults.slice(pingStart, pingStart + flow.count);
      result.received = attempts.filter((attempt) => attempt.success).length;
      result.timedOut = attempts.filter((attempt) => !attempt.success).length;
      result.permitted = result.received;
      result.dropped = result.timedOut;
    } else if (flow.protocol === "http") {
      const attempts = this.applications.httpResults.slice(httpStart, httpStart + flow.count);
      result.received = attempts.filter((attempt) => attempt.status === "completed").length;
      result.timedOut = attempts.filter((attempt) => attempt.status === "timeout").length;
      result.denied = attempts.filter((attempt) => attempt.status === "connection-refused").length;
      result.permitted = result.received;
      result.dropped = result.timedOut + result.denied;
    }
    result.status = "completed";
    result.completedAtNs = this.engine.now();
    this.engine.trace({
      time: this.engine.now(),
      type: "traffic-flow-completed",
      device: this.id,
      detail: {
        flowId: flow.id,
        sent: result.sent,
        received: result.received,
        dropped: result.dropped,
        permitted: result.permitted,
        denied: result.denied,
        translated: result.translated,
        timedOut: result.timedOut,
      },
    });
  }
}

export type TrafficGeneratorErrorCode =
  | "TRAFFIC_INVALID_CONFIGURATION"
  | "TRAFFIC_FLOW_LIMIT"
  | "TRAFFIC_FLOW_NOT_FOUND"
  | "TRAFFIC_FLOW_RUNNING";

export class TrafficGeneratorError extends Error {
  override readonly name = "TrafficGeneratorError";

  constructor(
    readonly code: TrafficGeneratorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function validateFlow(flow: TrafficFlow): void {
  if (!flow.id.trim()) throw new TrafficGeneratorError("TRAFFIC_INVALID_CONFIGURATION", "Flow ID is required.");
  ipToInt(flow.destination);
  if (!Number.isInteger(flow.count) || flow.count < 1 || flow.count > TRAFFIC_GENERATOR_LIMITS.maximumPacketsPerFlow) {
    throw new TrafficGeneratorError(
      "TRAFFIC_INVALID_CONFIGURATION",
      `Flow count must be between 1 and ${TRAFFIC_GENERATOR_LIMITS.maximumPacketsPerFlow}.`,
    );
  }
  if (!Number.isSafeInteger(flow.intervalNs)
    || flow.intervalNs < 0
    || flow.intervalNs > TRAFFIC_GENERATOR_LIMITS.maximumIntervalNs) {
    throw new TrafficGeneratorError("TRAFFIC_INVALID_CONFIGURATION", "Flow interval is outside the supported range.");
  }
  if (flow.payloadBytes !== undefined
    && (!Number.isInteger(flow.payloadBytes)
      || flow.payloadBytes < 0
      || flow.payloadBytes > TRAFFIC_GENERATOR_LIMITS.maximumPayloadBytes)) {
    throw new TrafficGeneratorError("TRAFFIC_INVALID_CONFIGURATION", "Flow payload size is outside the supported range.");
  }
  if (flow.protocol === "tcp" || flow.protocol === "udp") validatePort(flow.destinationPort);
  if (flow.protocol === "udp" && flow.sourcePort !== undefined) validatePort(flow.sourcePort);
  if (flow.protocol === "http") {
    if (flow.url.length > 2_048 || !flow.url.startsWith(`http://${flow.destination}`)) {
      throw new TrafficGeneratorError(
        "TRAFFIC_INVALID_CONFIGURATION",
        "HTTP flow URL must be a bounded http:// URL for the configured destination.",
      );
    }
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TrafficGeneratorError("TRAFFIC_INVALID_CONFIGURATION", `Invalid traffic flow port '${port}'.`);
  }
}

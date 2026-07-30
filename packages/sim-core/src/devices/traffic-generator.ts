import {
  DEFAULT_PING_TIMEOUT_NS,
  NS_PER_S,
} from "../engine/constants";
import { MAXIMUM_COS, requireCos, requireDscp } from "../qos/markings";
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
  /** DSCP stamped on the packets this flow originates. */
  readonly dscp?: number;
  /** 802.1p CoS requested for a tagged egress path; ignored when untagged. */
  readonly cos?: number;
}

export type TrafficFlow =
  | (TrafficFlowBase & { readonly protocol: "icmp" })
  | (TrafficFlowBase & {
      readonly protocol: "udp";
      readonly destinationPort: number;
      readonly sourcePort?: number;
    })
  /** A TCP flow uses the host stack's deterministic ephemeral source port. */
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
  /** Packets a QoS policy re-marked while they crossed the network. */
  readonly marked: number;
  /** Packets a policer dropped or marked down. */
  readonly policed: number;
  /** Packets a shaper deliberately held back before transmitting. */
  readonly shaped: number;
  /** Packets an egress queue dropped, by tail drop or a resource limit. */
  readonly queueDropped: number;
  /**
   * Mean and maximum virtual delay observed for this flow, in nanoseconds. It
   * is a deterministic simulated measurement, never a real-hardware benchmark.
   */
  readonly averageDelayNs: number;
  readonly maximumDelayNs: number;
  readonly startedAtNs: number;
  readonly completedAtNs: number | undefined;
}

type MutableFields =
  | "status" | "sent" | "received" | "dropped" | "permitted" | "denied" | "translated"
  | "timedOut" | "marked" | "policed" | "shaped" | "queueDropped"
  | "averageDelayNs" | "maximumDelayNs" | "completedAtNs";

type MutableTrafficFlowResult = Omit<TrafficFlowResult, MutableFields> & {
  -readonly [K in MutableFields]: TrafficFlowResult[K];
};

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
      marked: 0,
      policed: 0,
      shaped: 0,
      queueDropped: 0,
      averageDelayNs: 0,
      maximumDelayNs: 0,
      startedAtNs: this.engine.now(),
      completedAtNs: undefined,
    };
    this.results.set(flowId, result);
    const pingStart = this.pingResults.length;
    const httpStart = this.applications.httpResults.length;
    const traceStart = this.engine.traceLog.length;

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
      this.finishFlow(flow, result, pingStart, httpStart, traceStart);
    });
    this.engine.trace({
      time: this.engine.now(),
      type: "traffic-flow-queued",
      device: this.id,
      detail: {
        flowId,
        protocol: flow.protocol,
        count: flow.count,
        intervalNs: flow.intervalNs,
        dscp: flow.dscp ?? null,
        cos: flow.cos ?? null,
        payloadBytes: flow.payloadBytes ?? null,
      },
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
    // The flow's DSCP is stamped by the host origination path, so a policy that
    // matches `dscp ef` sees exactly what the learner configured.
    this.originationDscp = flow.dscp;
    try {
      this.sendFlowPacket(flow, result);
    } finally {
      this.originationDscp = undefined;
    }
  }

  private sendFlowPacket(flow: TrafficFlow, result: MutableTrafficFlowResult): void {
    if (flow.protocol === "icmp") {
      this.ping(flow.destination, ++this.sequence, { payloadBytes: flow.payloadBytes });
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
          data: flow.id,
          payloadBytes: flow.payloadBytes,
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
    traceStart: number,
  ): void {
    if (flow.protocol === "icmp") {
      const attempts = this.pingResults.slice(pingStart, pingStart + flow.count);
      result.received = attempts.filter((attempt) => attempt.success).length;
      result.timedOut = attempts.filter((attempt) => !attempt.success).length;
      result.permitted = result.received;
      result.dropped = result.timedOut;
      const delays = attempts.flatMap((attempt) => (attempt.rttNs === undefined ? [] : [attempt.rttNs]));
      result.averageDelayNs = delays.length === 0
        ? 0
        : Math.round(delays.reduce((total, value) => total + value, 0) / delays.length);
      result.maximumDelayNs = delays.reduce((maximum, value) => Math.max(maximum, value), 0);
    } else if (flow.protocol === "http") {
      const attempts = this.applications.httpResults.slice(httpStart, httpStart + flow.count);
      result.received = attempts.filter((attempt) => attempt.status === "completed").length;
      result.timedOut = attempts.filter((attempt) => attempt.status === "timeout").length;
      result.denied = attempts.filter((attempt) => attempt.status === "connection-refused").length;
      result.permitted = result.received;
      result.dropped = result.timedOut + result.denied;
    }
    this.collectQosOutcomes(result, traceStart);
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
        marked: result.marked,
        policed: result.policed,
        shaped: result.shaped,
        queueDropped: result.queueDropped,
        averageDelayNs: result.averageDelayNs,
        maximumDelayNs: result.maximumDelayNs,
      },
    });
  }

  /**
   * Summarize what QoS did to this flow's window of the deterministic trace.
   * The trace is the one shared record of the run, so browser and verifier
   * report identical marked/policed/shaped counts.
   */
  private collectQosOutcomes(result: MutableTrafficFlowResult, traceStart: number): void {
    let queueWaitTotalNs = 0;
    let queueWaitSamples = 0;
    for (let index = traceStart; index < this.engine.traceLog.length; index++) {
      const entry = this.engine.traceLog[index]!;
      switch (entry.type) {
        case "qos-marked":
          result.marked++;
          break;
        case "qos-police-exceed":
          result.policed++;
          break;
        case "qos-shape-delayed":
          result.shaped++;
          break;
        case "packet-tail-dropped":
          result.queueDropped++;
          break;
        case "packet-dequeued": {
          const waited = entry.detail?.waitedNs;
          if (typeof waited === "number") {
            queueWaitTotalNs += waited;
            queueWaitSamples++;
            result.maximumDelayNs = Math.max(result.maximumDelayNs, waited);
          }
          break;
        }
        default:
          break;
      }
    }
    if (result.averageDelayNs === 0 && queueWaitSamples > 0) {
      result.averageDelayNs = Math.round(queueWaitTotalNs / queueWaitSamples);
    }
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
  if (flow.dscp !== undefined) {
    try {
      requireDscp(flow.dscp);
    } catch {
      throw new TrafficGeneratorError("TRAFFIC_INVALID_CONFIGURATION", "Flow DSCP must be between 0 and 63.");
    }
  }
  if (flow.cos !== undefined) {
    try {
      requireCos(flow.cos);
    } catch {
      throw new TrafficGeneratorError(
        "TRAFFIC_INVALID_CONFIGURATION",
        `Flow CoS must be between 0 and ${MAXIMUM_COS}.`,
      );
    }
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

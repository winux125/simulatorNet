import type { GradingCheck } from "@sim/contracts/grading";
import type { BuiltLab } from "@sim/lab-format";
import {
  EndHost,
  Layer3Switch,
  QOS_CLASS_DEFAULT,
  Router,
  TrafficGenerator,
  type TraceEntry,
} from "@sim/sim-core";

/** The QoS check types this module owns. */
const QOS_CHECK_TYPES = new Set([
  "qos-class-map",
  "qos-policy-map",
  "qos-policy-attached",
  "packet-dscp",
  "packet-cos",
  "traffic-classified",
  "policer-result",
  "shaper-result",
  "queue-drop-count",
  "traffic-priority-order",
]);

export type QosGradingCheck = Extract<GradingCheck, { type: string }> & {
  type:
    | "qos-class-map" | "qos-policy-map" | "qos-policy-attached" | "packet-dscp" | "packet-cos"
    | "traffic-classified" | "policer-result" | "shaper-result" | "queue-drop-count"
    | "traffic-priority-order";
};

export function isQosCheck(check: GradingCheck): check is QosGradingCheck {
  return QOS_CHECK_TYPES.has(check.type);
}

export interface QosCheckOutcome {
  readonly passed: boolean;
  readonly message: string;
  readonly diagnostics: Record<string, unknown>;
  readonly error?: string;
}

/** Drain the shared event queue for one bounded operation. */
export type DrainOperation = () => void;

function qosDevice(built: BuiltLab, deviceId: string): Router | Layer3Switch | undefined {
  const device = built.getDevice(deviceId);
  if (device instanceof Layer3Switch) return device;
  return device instanceof Router ? device : undefined;
}

function failure(message: string, diagnostics: Record<string, unknown> = {}): QosCheckOutcome {
  return { passed: false, message, diagnostics, error: message };
}

/**
 * Send one bounded operation so QoS has something to act on, then hand back the
 * trace window it produced. Explicit traffic keeps a check honest: it grades
 * what the network did, not only what was typed into the configuration.
 */
function runTraffic(
  built: BuiltLab,
  drain: DrainOperation,
  options: {
    sourceDeviceId?: string;
    destinationIp?: string;
    trafficDeviceId?: string;
    flowId?: string;
  },
): { trace: TraceEntry[]; failure?: string } {
  const start = built.engine.traceLog.length;
  try {
    if (options.trafficDeviceId && options.flowId) {
      const generator = built.getTrafficGenerator(options.trafficDeviceId);
      if (!(generator instanceof TrafficGenerator)) {
        return { trace: [], failure: `Traffic Generator '${options.trafficDeviceId}' was not found` };
      }
      generator.startFlow(options.flowId);
    } else if (options.sourceDeviceId && options.destinationIp) {
      const source = built.getDevice(options.sourceDeviceId);
      if (!(source instanceof EndHost) && !(source instanceof Router) && !(source instanceof Layer3Switch)) {
        return { trace: [], failure: `Ping-capable device '${options.sourceDeviceId}' was not found` };
      }
      source.ping(options.destinationIp, 1);
    } else {
      return { trace: [] };
    }
    drain();
  } catch (error) {
    return {
      trace: built.engine.traceLog.slice(start),
      failure: error instanceof Error ? error.message : "Traffic execution failed",
    };
  }
  return { trace: built.engine.traceLog.slice(start) };
}

export function runQosCheck(
  check: QosGradingCheck,
  built: BuiltLab,
  drain: DrainOperation,
): QosCheckOutcome {
  switch (check.type) {
    case "qos-class-map": {
      const device = qosDevice(built, check.configuration.deviceId);
      if (!device) return failure(`QoS-capable device '${check.configuration.deviceId}' was not found`);
      const classMap = device.qosClassMapConfigurations()
        .find((map) => map.id === check.configuration.classMapId);
      if (!classMap) {
        return {
          passed: false,
          message: `Class-map ${check.configuration.classMapId} is not defined`,
          diagnostics: { defined: device.qosClassMapConfigurations().map((map) => map.id) },
        };
      }
      const typeMatches = check.configuration.expectedMatchType === undefined
        || classMap.matchType === check.configuration.expectedMatchType;
      const passed = typeMatches && classMap.matches.length >= check.configuration.minimumMatches;
      return {
        passed,
        message: `Class-map ${classMap.id} is ${classMap.matchType} with ${classMap.matches.length} match rule(s)`,
        diagnostics: {
          matchType: classMap.matchType,
          matches: classMap.matches.length,
          expectedMatchType: check.configuration.expectedMatchType,
          minimumMatches: check.configuration.minimumMatches,
        },
      };
    }

    case "qos-policy-map": {
      const device = qosDevice(built, check.configuration.deviceId);
      if (!device) return failure(`QoS-capable device '${check.configuration.deviceId}' was not found`);
      const policy = device.qosPolicyMapConfigurations()
        .find((map) => map.id === check.configuration.policyMapId);
      const entry = policy?.classes.find((candidate) => candidate.className === check.configuration.className);
      if (!entry) {
        return {
          passed: false,
          message: `Policy-map ${check.configuration.policyMapId} has no class ${check.configuration.className}`,
          diagnostics: { classes: policy?.classes.map((candidate) => candidate.className) ?? [] },
        };
      }
      const actual = policyActionValue(entry, check.configuration.expectedAction);
      const passed = actual !== undefined
        && (check.configuration.expectedValue === undefined || actual === check.configuration.expectedValue);
      return {
        passed,
        message: `Class ${entry.className} ${check.configuration.expectedAction} is ${actual ?? "not configured"}`,
        diagnostics: {
          action: check.configuration.expectedAction,
          actual,
          expectedValue: check.configuration.expectedValue,
        },
      };
    }

    case "qos-policy-attached": {
      const device = qosDevice(built, check.configuration.deviceId);
      if (!device) return failure(`QoS-capable device '${check.configuration.deviceId}' was not found`);
      const bindings = device.qosServicePolicies();
      const passed = bindings.some((binding) =>
        binding.interfaceName === check.configuration.interfaceId
        && binding.direction === check.configuration.direction
        && binding.policyMapId === check.configuration.policyMapId);
      return {
        passed,
        message: passed
          ? `${check.configuration.policyMapId} is attached ${check.configuration.direction} on ${check.configuration.interfaceId}`
          : `${check.configuration.policyMapId} is not attached ${check.configuration.direction} on ${check.configuration.interfaceId}`,
        diagnostics: { bindings },
      };
    }

    case "packet-dscp":
    case "packet-cos": {
      const outcome = runTraffic(built, drain, {
        sourceDeviceId: check.configuration.sourceDeviceId,
        destinationIp: check.configuration.destinationIp,
      });
      if (outcome.failure) return failure(outcome.failure);
      const field = check.type === "packet-dscp" ? "dscpAfter" : "cosAfter";
      const expected = check.type === "packet-dscp"
        ? check.configuration.expectedDscp
        : check.configuration.expectedCos;
      const observed = outcome.trace
        .filter((entry) => entry.type === "qos-marked" && entry.device === check.configuration.deviceId)
        .map((entry) => entry.detail?.[field]);
      const passed = observed.includes(expected);
      return {
        passed,
        message: passed
          ? `${check.configuration.deviceId} marked the packet with ${field.replace("After", "")} ${expected}`
          : `${check.configuration.deviceId} did not mark the packet with ${field.replace("After", "")} ${expected}`,
        diagnostics: { observed, expected },
      };
    }

    case "traffic-classified": {
      const device = qosDevice(built, check.configuration.deviceId);
      if (!device) return failure(`QoS-capable device '${check.configuration.deviceId}' was not found`);
      const outcome = runTraffic(built, drain, {
        sourceDeviceId: check.configuration.sourceDeviceId,
        destinationIp: check.configuration.destinationIp,
      });
      if (outcome.failure) return failure(outcome.failure);
      const matched = device.qosCounters()
        .filter((row) => row.className === check.configuration.className)
        .reduce((total, row) => total + row.matchedPackets, 0);
      const passed = matched >= check.configuration.minimumPackets;
      return {
        passed,
        message: `Class ${check.configuration.className} matched ${matched} packet(s)`,
        diagnostics: { matched, minimumPackets: check.configuration.minimumPackets },
      };
    }

    case "policer-result": {
      const device = qosDevice(built, check.configuration.deviceId);
      if (!device) return failure(`QoS-capable device '${check.configuration.deviceId}' was not found`);
      const outcome = runTraffic(built, drain, {
        trafficDeviceId: check.configuration.trafficDeviceId,
        flowId: check.configuration.flowId,
      });
      if (outcome.failure) return failure(outcome.failure);
      const dropped = device.qosCounters()
        .filter((row) => row.className === check.configuration.className)
        .reduce((total, row) => total + row.droppedPackets, 0);
      const passed = dropped >= check.configuration.minimumDropped
        && (check.configuration.maximumDropped === undefined || dropped <= check.configuration.maximumDropped);
      return {
        passed,
        message: `Policer on ${check.configuration.className} dropped ${dropped} packet(s)`,
        diagnostics: {
          dropped,
          minimumDropped: check.configuration.minimumDropped,
          maximumDropped: check.configuration.maximumDropped,
        },
      };
    }

    case "shaper-result": {
      const device = qosDevice(built, check.configuration.deviceId);
      if (!device) return failure(`QoS-capable device '${check.configuration.deviceId}' was not found`);
      const outcome = runTraffic(built, drain, {
        trafficDeviceId: check.configuration.trafficDeviceId,
        flowId: check.configuration.flowId,
      });
      if (outcome.failure) return failure(outcome.failure);
      const delayed = outcome.trace.filter((entry) =>
        entry.type === "qos-shape-delayed"
        && entry.device === check.configuration.deviceId
        && entry.detail?.interface === check.configuration.interfaceId).length;
      const iface = device.getInterface(check.configuration.interfaceId);
      const dropped = iface?.egress.snapshot().droppedPackets ?? 0;
      const passed = delayed >= check.configuration.minimumDelayedPackets
        && (check.configuration.maximumDroppedPackets === undefined
          || dropped <= check.configuration.maximumDroppedPackets);
      return {
        passed,
        message: `Shaper on ${check.configuration.interfaceId} delayed ${delayed} packet(s) and dropped ${dropped}`,
        diagnostics: {
          delayed,
          dropped,
          minimumDelayedPackets: check.configuration.minimumDelayedPackets,
          maximumDroppedPackets: check.configuration.maximumDroppedPackets,
        },
      };
    }

    case "queue-drop-count": {
      const device = qosDevice(built, check.configuration.deviceId);
      if (!device) return failure(`QoS-capable device '${check.configuration.deviceId}' was not found`);
      const outcome = runTraffic(built, drain, {
        trafficDeviceId: check.configuration.trafficDeviceId,
        flowId: check.configuration.flowId,
      });
      if (outcome.failure) return failure(outcome.failure);
      const iface = device.getInterface(check.configuration.interfaceId);
      if (!iface) return failure(`Interface '${check.configuration.interfaceId}' was not found`);
      const snapshot = iface.egress.snapshot();
      const passed = snapshot.droppedPackets >= check.configuration.minimumDrops
        && (check.configuration.maximumDrops === undefined
          || snapshot.droppedPackets <= check.configuration.maximumDrops);
      return {
        passed,
        message: `${check.configuration.interfaceId} dropped ${snapshot.droppedPackets} queued packet(s)`,
        diagnostics: {
          dropped: snapshot.droppedPackets,
          dropsByReason: snapshot.dropsByReason,
          minimumDrops: check.configuration.minimumDrops,
          maximumDrops: check.configuration.maximumDrops,
        },
      };
    }

    case "traffic-priority-order": {
      const generator = built.getTrafficGenerator(check.configuration.deviceId);
      if (!(generator instanceof TrafficGenerator)) {
        return failure(`Traffic Generator '${check.configuration.deviceId}' was not found`);
      }
      try {
        generator.startFlow(check.configuration.bulkFlowId);
        generator.startFlow(check.configuration.priorityFlowId);
        drain();
      } catch (error) {
        return failure(error instanceof Error ? error.message : "Traffic flows could not be started");
      }
      const results = generator.flowResults();
      const priority = results.find((row) => row.flowId === check.configuration.priorityFlowId);
      const bulk = results.find((row) => row.flowId === check.configuration.bulkFlowId);
      if (!priority || !bulk) return failure("Both flows must produce a result");
      const passed = priority.averageDelayNs <= bulk.averageDelayNs;
      return {
        passed,
        message: `Priority flow averaged ${priority.averageDelayNs} ns against ${bulk.averageDelayNs} ns for bulk`,
        diagnostics: {
          priorityAverageDelayNs: priority.averageDelayNs,
          bulkAverageDelayNs: bulk.averageDelayNs,
          priorityMaximumDelayNs: priority.maximumDelayNs,
          bulkMaximumDelayNs: bulk.maximumDelayNs,
        },
      };
    }
  }
}

function policyActionValue(
  entry: {
    priority?: { percent?: number; rateBps?: number };
    bandwidthPercent?: number;
    police?: { rateBps: number };
    shape?: { averageRateBps: number };
    marking?: { dscp?: number; cos?: number };
  },
  action: "priority" | "bandwidth" | "police" | "shape" | "set-dscp" | "set-cos",
): number | undefined {
  switch (action) {
    case "priority":
      return entry.priority?.percent ?? entry.priority?.rateBps;
    case "bandwidth":
      return entry.bandwidthPercent;
    case "police":
      return entry.police?.rateBps;
    case "shape":
      return entry.shape?.averageRateBps;
    case "set-dscp":
      return entry.marking?.dscp;
    case "set-cos":
      return entry.marking?.cos;
  }
}

export { QOS_CLASS_DEFAULT };

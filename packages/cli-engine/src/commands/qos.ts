import {
  Layer3Switch,
  QOS_CLASS_DEFAULT,
  Router,
  dscpName,
  parseDscp,
  requireCos,
  requireIpPrecedence,
  type QosClassMap,
  type QosDirection,
  type QosMatchRule,
  type QosPolicyClass,
  type QosPolicyMap,
} from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi } from "../types";
import { isRoutingDevice } from "./helpers";

const SHOW_MODES = ["exec", "privileged"] as const;

type QosDevice = Router | Layer3Switch;

function qosDevice(session: SessionApi): QosDevice {
  if (!isRoutingDevice(session.device)) throw new InvalidModeError("A routing device is required.");
  return session.device;
}

function interfaceName(session: SessionApi): string {
  const context = session.ifaceCtx;
  if (!context) throw new InvalidModeError("No interface selected.");
  if (context.sviVlan !== undefined) return `Vlan${context.sviVlan}`;
  if (context.isSubinterface) {
    if (!context.subCreated || context.subVlan === undefined) {
      throw new ValidationError("Configure encapsulation before applying a service policy.");
    }
    return `${context.physical}.${context.subVlan}`;
  }
  return context.physical;
}

function classMapContext(session: SessionApi) {
  if (!session.classMapCtx) throw new InvalidModeError("A class-map context is required.");
  return session.classMapCtx;
}

function policyClassContext(session: SessionApi) {
  const context = session.policyMapCtx;
  if (!context?.className) throw new InvalidModeError("A policy-map class context is required.");
  return { policyMapId: context.id, className: context.className };
}

function currentClassMap(device: QosDevice, id: string): QosClassMap {
  return device.qosClassMapConfigurations().find((map) => map.id === id)
    ?? { id, matchType: "match-any", matches: [] };
}

function currentPolicyMap(device: QosDevice, id: string): QosPolicyMap {
  return device.qosPolicyMapConfigurations().find((map) => map.id === id) ?? { id, classes: [] };
}

/** Append one `match` line to the class map currently being configured. */
function addMatch(session: SessionApi, rule: QosMatchRule): void {
  const device = qosDevice(session);
  const context = classMapContext(session);
  const existing = currentClassMap(device, context.id);
  device.defineQosClassMap({
    id: existing.id,
    matchType: existing.matchType,
    matches: [...existing.matches, rule],
  });
}

/** Merge one action into the policy class currently being configured. */
function updatePolicyClass(session: SessionApi, patch: Partial<QosPolicyClass>): void {
  const device = qosDevice(session);
  const { policyMapId, className } = policyClassContext(session);
  const policy = currentPolicyMap(device, policyMapId);
  const classes = policy.classes.some((entry) => entry.className === className)
    ? policy.classes.map((entry) => (entry.className === className ? { ...entry, ...patch } : entry))
    : [...policy.classes, { className, ...patch }];
  device.defineQosPolicyMap({ id: policyMapId, classes });
}

function positiveInteger(token: string, label: string): number {
  const value = Number(token);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive integer.`);
  }
  return value;
}

function percent(token: string, label: string): number {
  const value = Number(token);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ValidationError(`${label} must be between 1 and 100.`);
  }
  return value;
}

function direction(token: string): QosDirection {
  if (token === "input" || token === "output") return token;
  throw new ValidationError("Service-policy direction must be input or output.");
}

// --- show output ----------------------------------------------------------

function showClassMap(session: SessionApi): string {
  const maps = qosDevice(session).qosClassMapConfigurations();
  if (maps.length === 0) return "No class maps configured.";
  return maps.flatMap((map) => [
    `Class Map ${map.matchType} ${map.id}`,
    ...map.matches.map((rule) => `    ${describeMatch(rule)}`),
  ]).join("\n");
}

function describeMatch(rule: QosMatchRule): string {
  switch (rule.kind) {
    case "any":
      return "Match any";
    case "access-group":
      return `Match access-group name ${rule.aclId}`;
    case "ipv6-access-group":
      return `Match ipv6 access-group name ${rule.aclId}`;
    case "protocol":
      return `Match protocol ${rule.protocol}`;
    case "source-port":
      return `Match source-port ${describePort(rule.port)}`;
    case "destination-port":
      return `Match destination-port ${describePort(rule.port)}`;
    case "dscp":
      return `Match dscp ${rule.values.map(dscpName).join(" ")}`;
    case "precedence":
      return `Match precedence ${rule.values.join(" ")}`;
    case "cos":
      return `Match cos ${rule.values.join(" ")}`;
    case "source-prefix":
      return `Match source ${rule.ipv4 ? describeIpv4(rule.ipv4) : describeIpv6(rule.ipv6!)}`;
    case "destination-prefix":
      return `Match destination ${rule.ipv4 ? describeIpv4(rule.ipv4) : describeIpv6(rule.ipv6!)}`;
    case "traffic-flow":
      return `Match traffic-generator flow ${rule.flowId}`;
  }
}

function describePort(port: { kind: string; port?: number; start?: number; end?: number }): string {
  if (port.kind === "eq") return `eq ${port.port}`;
  if (port.kind === "range") return `range ${port.start} ${port.end}`;
  return "any";
}

function describeIpv4(matcher: { kind: string; address?: string; wildcard?: string }): string {
  if (matcher.kind === "any") return "any";
  if (matcher.kind === "host") return `host ${matcher.address}`;
  return `${matcher.address} ${matcher.wildcard}`;
}

function describeIpv6(matcher: { kind: string; address?: string; prefixLength?: number }): string {
  if (matcher.kind === "any") return "any";
  if (matcher.kind === "host") return `host ${matcher.address}`;
  return `${matcher.address}/${matcher.prefixLength}`;
}

function describePolicyClass(entry: QosPolicyClass): string[] {
  const lines = [`  Class ${entry.className}`];
  if (entry.priority) {
    lines.push(entry.priority.percent !== undefined
      ? `    priority percent ${entry.priority.percent}`
      : `    priority ${entry.priority.rateBps} bps`);
  }
  if (entry.bandwidthPercent !== undefined) lines.push(`    bandwidth percent ${entry.bandwidthPercent}`);
  if (entry.marking?.dscp !== undefined) lines.push(`    set dscp ${dscpName(entry.marking.dscp)}`);
  if (entry.marking?.precedence !== undefined) lines.push(`    set precedence ${entry.marking.precedence}`);
  if (entry.marking?.cos !== undefined) lines.push(`    set cos ${entry.marking.cos}`);
  if (entry.police) {
    lines.push(
      `    police ${entry.police.rateBps} ${entry.police.burstBytes}`
      + ` conform-action transmit exceed-action ${entry.police.exceedAction === "drop" ? "drop" : `set-dscp-transmit ${dscpName(entry.police.exceedDscp ?? 0)}`}`,
    );
  }
  if (entry.shape) lines.push(`    shape average ${entry.shape.averageRateBps}`);
  if (entry.queueLimitPackets !== undefined) lines.push(`    queue-limit ${entry.queueLimitPackets} packets`);
  return lines;
}

function showPolicyMap(session: SessionApi): string {
  const maps = qosDevice(session).qosPolicyMapConfigurations();
  if (maps.length === 0) return "No policy maps configured.";
  return maps.flatMap((map) => [`Policy Map ${map.id}`, ...map.classes.flatMap(describePolicyClass)]).join("\n");
}

function showPolicyMapInterface(session: SessionApi): string {
  const device = qosDevice(session);
  const bindings = device.qosServicePolicies();
  if (bindings.length === 0) return "No service policies are attached.";
  const counters = device.qosCounters();
  return bindings.flatMap((binding) => {
    const policy = device.qosPolicyMapConfigurations().find((map) => map.id === binding.policyMapId);
    const rows = counters.filter((row) =>
      row.interfaceName === binding.interfaceName && row.direction === binding.direction);
    return [
      `${binding.interfaceName}`,
      `  Service-policy ${binding.direction}: ${binding.policyMapId}`,
      ...(policy?.classes ?? []).flatMap((entry) => {
        const row = rows.find((candidate) => candidate.className === entry.className);
        return [
          `    Class-map: ${entry.className}`,
          `      ${row?.matchedPackets ?? 0} packets, ${row?.matchedBytes ?? 0} bytes`,
          `      marked ${row?.markedPackets ?? 0}, dropped ${row?.droppedPackets ?? 0}`,
        ];
      }),
    ];
  }).join("\n");
}

function showQueueingInterface(session: SessionApi, name: string): string {
  const device = qosDevice(session);
  const iface = device.getInterface(name);
  if (!iface) throw new ValidationError(`Interface '${name}' was not found.`);
  const snapshot = iface.egress.snapshot();
  const binding = device.qosServicePolicies().find((entry) =>
    entry.direction === "output" && entry.interfaceName.startsWith(name));
  return [
    `Interface ${name} queueing strategy: ${binding ? "class-based (priority + deficit round robin)" : "fifo"}`,
    `  Output policy: ${binding?.policyMapId ?? "none"}`,
    `  Queue depth: ${snapshot.depthPackets} packets, ${snapshot.depthBytes} bytes`,
    `  Total drops: ${snapshot.droppedPackets}`,
    `  Maximum virtual wait: ${snapshot.maximumWaitingTimeNs} ns`,
    ...snapshot.classes.map((entry) =>
      `    ${entry.className}: depth ${entry.depthPackets}/${entry.limitPackets},`
      + ` out ${entry.dequeuedPackets} packets, drops ${entry.droppedPackets}`),
  ].join("\n");
}

function showInterfaceCounters(session: SessionApi): string {
  const device = qosDevice(session);
  const rows = [...device.interfaces.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((iface) => {
      const snapshot = iface.egress.snapshot();
      return `${iface.name.padEnd(12)}${String(snapshot.enqueuedPackets).padStart(10)}`
        + `${String(snapshot.dequeuedPackets).padStart(12)}`
        + `${String(snapshot.dequeuedBytes).padStart(14)}`
        + `${String(snapshot.droppedPackets).padStart(10)}`;
    });
  return ["Port          OutQueued   OutPackets      OutBytes   OutDrops", ...rows].join("\n");
}

export const qosCommands: CommandSpec[] = [
  // --- class maps ---------------------------------------------------------
  {
    pattern: "class-map match-any {name}",
    usage: "class-map match-any <name>",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const device = qosDevice(session);
      const existing = device.qosClassMapConfigurations().find((map) => map.id === params.name);
      device.defineQosClassMap({ id: params.name!, matchType: "match-any", matches: existing?.matches ?? [] });
      session.classMapCtx = { id: params.name! };
      session.enter("config-cmap");
    },
  },
  {
    pattern: "class-map match-all {name}",
    usage: "class-map match-all <name>",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const device = qosDevice(session);
      const existing = device.qosClassMapConfigurations().find((map) => map.id === params.name);
      device.defineQosClassMap({ id: params.name!, matchType: "match-all", matches: existing?.matches ?? [] });
      session.classMapCtx = { id: params.name! };
      session.enter("config-cmap");
    },
  },
  {
    pattern: "no class-map {name}",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => qosDevice(session).removeQosClassMap(params.name!),
  },
  {
    pattern: "match any",
    modes: ["config-cmap"],
    device: "router",
    run: (session) => addMatch(session, { kind: "any" }),
  },
  {
    pattern: "match dscp {value}",
    usage: "match dscp <0-63|default|cs0-cs7|af11-af43|ef>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => addMatch(session, { kind: "dscp", values: [parseDscp(params.value!)] }),
  },
  {
    pattern: "match precedence {value}",
    usage: "match precedence <0-7>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => addMatch(session, {
      kind: "precedence",
      values: [requireIpPrecedence(Number(params.value))],
    }),
  },
  {
    pattern: "match cos {value}",
    usage: "match cos <0-7>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => addMatch(session, { kind: "cos", values: [requireCos(Number(params.value))] }),
  },
  {
    pattern: "match protocol {protocol}",
    usage: "match protocol <icmp|tcp|udp>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => {
      const protocol = params.protocol!.toLowerCase();
      if (protocol !== "icmp" && protocol !== "tcp" && protocol !== "udp") {
        throw new ValidationError("Supported class-map protocols are icmp, tcp and udp.");
      }
      addMatch(session, { kind: "protocol", protocol });
    },
  },
  {
    pattern: "match access-group name {name}",
    usage: "match access-group name <acl-name>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => addMatch(session, { kind: "access-group", aclId: params.name! }),
  },
  {
    pattern: "match access-group {acl}",
    usage: "match access-group <acl-number>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => addMatch(session, { kind: "access-group", aclId: params.acl! }),
  },
  {
    pattern: "match destination-port {port}",
    usage: "match destination-port <1-65535>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => addMatch(session, {
      kind: "destination-port",
      port: { kind: "eq", port: positiveInteger(params.port!, "Port") },
    }),
  },
  {
    pattern: "match source-port {port}",
    usage: "match source-port <1-65535>",
    modes: ["config-cmap"],
    device: "router",
    run: (session, params) => addMatch(session, {
      kind: "source-port",
      port: { kind: "eq", port: positiveInteger(params.port!, "Port") },
    }),
  },

  // --- policy maps --------------------------------------------------------
  {
    pattern: "policy-map {name}",
    usage: "policy-map <name>",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const device = qosDevice(session);
      const existing = device.qosPolicyMapConfigurations().find((map) => map.id === params.name);
      if (!existing) device.defineQosPolicyMap({ id: params.name!, classes: [] });
      session.policyMapCtx = { id: params.name!, className: undefined };
      session.enter("config-pmap");
    },
  },
  {
    pattern: "no policy-map {name}",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => qosDevice(session).removeQosPolicyMap(params.name!),
  },
  {
    pattern: "class {name}",
    usage: "class <class-map-name|class-default>",
    modes: ["config-pmap"],
    device: "router",
    run: (session, params) => {
      const context = session.policyMapCtx;
      if (!context) throw new InvalidModeError("A policy-map context is required.");
      const device = qosDevice(session);
      const name = params.name!;
      if (name !== QOS_CLASS_DEFAULT && !device.qosClassMapConfigurations().some((map) => map.id === name)) {
        throw new ValidationError(`Class-map '${name}' is not defined.`);
      }
      const policy = currentPolicyMap(device, context.id);
      if (!policy.classes.some((entry) => entry.className === name)) {
        device.defineQosPolicyMap({ id: context.id, classes: [...policy.classes, { className: name }] });
      }
      context.className = name;
      session.enter("config-pmap-c");
    },
  },
  {
    pattern: "set dscp {value}",
    usage: "set dscp <0-63|default|cs0-cs7|af11-af43|ef>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, { marking: { dscp: parseDscp(params.value!) } }),
  },
  {
    pattern: "set precedence {value}",
    usage: "set precedence <0-7>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      marking: { precedence: requireIpPrecedence(Number(params.value)) },
    }),
  },
  {
    pattern: "set cos {value}",
    usage: "set cos <0-7>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, { marking: { cos: requireCos(Number(params.value)) } }),
  },
  {
    pattern: "priority percent {value}",
    usage: "priority percent <1-100>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      priority: { percent: percent(params.value!, "Priority percent") },
      bandwidthPercent: undefined,
    }),
  },
  {
    pattern: "bandwidth percent {value}",
    usage: "bandwidth percent <1-100>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      bandwidthPercent: percent(params.value!, "Bandwidth percent"),
      priority: undefined,
    }),
  },
  {
    pattern: "police {rate} {burst} conform-action transmit exceed-action drop",
    usage: "police <bps> <burst-bytes> conform-action transmit exceed-action drop",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      police: {
        rateBps: positiveInteger(params.rate!, "Police rate"),
        burstBytes: positiveInteger(params.burst!, "Police burst"),
        exceedAction: "drop",
      },
    }),
  },
  {
    pattern: "police {rate} {burst} conform-action transmit exceed-action set-dscp-transmit {dscp}",
    usage: "police <bps> <burst-bytes> conform-action transmit exceed-action set-dscp-transmit <dscp>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      police: {
        rateBps: positiveInteger(params.rate!, "Police rate"),
        burstBytes: positiveInteger(params.burst!, "Police burst"),
        exceedAction: "set-dscp-transmit",
        exceedDscp: parseDscp(params.dscp!),
      },
    }),
  },
  {
    pattern: "police {rate} {burst}",
    usage: "police <bps> <burst-bytes>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      police: {
        rateBps: positiveInteger(params.rate!, "Police rate"),
        burstBytes: positiveInteger(params.burst!, "Police burst"),
        exceedAction: "drop",
      },
    }),
  },
  {
    pattern: "shape average {rate}",
    usage: "shape average <bps>",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      shape: { averageRateBps: positiveInteger(params.rate!, "Shape average rate") },
    }),
  },
  {
    pattern: "queue-limit {packets} packets",
    usage: "queue-limit <1-4096> packets",
    modes: ["config-pmap-c"],
    device: "router",
    run: (session, params) => updatePolicyClass(session, {
      queueLimitPackets: positiveInteger(params.packets!, "Queue limit"),
    }),
  },

  // --- interface attachment ----------------------------------------------
  {
    pattern: "service-policy {direction} {name}",
    usage: "service-policy <input|output> <policy-map-name>",
    modes: ["config-if"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      qosDevice(session).applyServicePolicy(
        interfaceName(session),
        direction(params.direction!.toLowerCase()),
        params.name!,
      );
    },
  },
  {
    pattern: "no service-policy {direction}",
    usage: "no service-policy <input|output>",
    modes: ["config-if"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      qosDevice(session).removeServicePolicy(interfaceName(session), direction(params.direction!.toLowerCase()));
    },
  },

  // --- inspection ---------------------------------------------------------
  {
    pattern: "show class-map",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["packet-policy"],
    run: showClassMap,
  },
  {
    pattern: "show policy-map interface",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["packet-policy"],
    run: showPolicyMapInterface,
  },
  {
    pattern: "show policy-map",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["packet-policy"],
    run: showPolicyMap,
  },
  {
    pattern: "show queueing interface {name}",
    usage: "show queueing interface <interface-name>",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => showQueueingInterface(session, params.name!),
  },
  {
    pattern: "show interfaces counters",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["packet-policy"],
    run: showInterfaceCounters,
  },
  {
    pattern: "clear qos counters",
    modes: ["privileged"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session) => {
      qosDevice(session).resetQosRuntime();
      return "QoS class counters cleared.";
    },
  },
];

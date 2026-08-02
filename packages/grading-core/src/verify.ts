import {
  LabSubmissionDocumentSchema,
  type LabDocument,
} from "@sim/contracts";
import {
  GradingSpecSchema,
  type GradingCheck,
  type VerificationCheckResult,
  type VerificationRequest,
  type VerificationResult,
  VerificationRequestSchema,
  VerificationResultSchema,
} from "@sim/contracts/grading";
import {
  buildLabFromDocument,
  deviceConfigurationDrift,
  parseLabDocument,
  type BuiltLab,
} from "@sim/lab-format";
import {
  AccessPoint,
  EndHost,
  Firewall,
  ipToInt,
  L2Switch,
  Layer3Switch,
  maskToInt,
  normalizeDnsName,
  normalizeIpv6,
  ipv6InPrefix,
  ipv6Network,
  Ipv6NextHeader,
  Router,
  TcpState,
  TrafficGenerator,
  WirelessEndHost,
  WirelessRouter,
} from "@sim/sim-core";
import type { SimulationEngine } from "@sim/sim-core";
import type { ZodIssue } from "zod";
import { VerificationError, VerificationResourceLimitError } from "./errors";
import { DEFAULT_VERIFICATION_LIMITS, type VerificationLimits } from "./limits";
import { isManagementCheck, runManagementCheck } from "./management-checks";
import { isQosCheck, runQosCheck } from "./qos-checks";
import { isVpnCheck, runVpnCheck } from "./vpn-checks";
import { stableHash, stableStringify, utf8ByteLength } from "./stable";

interface InternalCheckResult extends VerificationCheckResult {
  title: string;
  visibility: "hidden" | "visible";
  diagnostics: Record<string, unknown>;
}

class VerificationRuntime {
  processedEvents = 0;
  private pingSequence = 0;

  constructor(
    readonly built: BuiltLab,
    readonly limits: VerificationLimits,
    /** The rebuilt submission, so a check can read stored configuration. */
    readonly document: LabDocument,
  ) {}

  nextPingSequence(): number {
    return ++this.pingSequence;
  }

  runUntil(done: () => boolean): void {
    while (!done()) {
      const nextTime = this.built.engine.nextEventTime();
      if (nextTime === undefined) return;
      if (nextTime > this.limits.maximumVirtualTimeNs) {
        throw new VerificationResourceLimitError("maximumVirtualTimeNs", nextTime, this.limits.maximumVirtualTimeNs);
      }
      if (this.processedEvents >= this.limits.maximumVirtualEvents) {
        throw new VerificationResourceLimitError(
          "maximumVirtualEvents",
          this.processedEvents + 1,
          this.limits.maximumVirtualEvents,
        );
      }
      this.built.engine.runNextEvent();
      this.processedEvents++;
    }
  }
}

function issues(issuesToMap: ZodIssue[]): Array<{ path: string; message: string }> {
  return issuesToMap.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function parseRequest(input: unknown): VerificationRequest {
  const candidate = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const submission = LabSubmissionDocumentSchema.safeParse(candidate.submission);
  if (!submission.success) {
    throw new VerificationError("invalid-submission", "Submission validation failed", { issues: issues(submission.error.issues) });
  }
  const grading = GradingSpecSchema.safeParse(candidate.gradingSpec);
  if (!grading.success) {
    throw new VerificationError("invalid-grading-spec", "Grading specification validation failed", { issues: issues(grading.error.issues) });
  }
  const request = VerificationRequestSchema.safeParse(input);
  if (!request.success) {
    throw new VerificationError("invalid-request", "Verification request validation failed", { issues: issues(request.error.issues) });
  }
  return request.data;
}

function submissionDocument(request: VerificationRequest): LabDocument {
  const submission = request.submission;
  try {
    return parseLabDocument({
      schemaVersion: submission.schemaVersion,
      id: submission.labId,
      title: `Submission ${submission.labId}`,
      simulation: submission.simulation,
      topology: submission.snapshot.topology,
      configurations: submission.snapshot.configurations,
      // Startup snapshots are configuration, so a submission carries them and
      // the verifier rebuilds them like everything else.
      startupConfigurations: submission.snapshot.startupConfigurations,
    });
  } catch (error) {
    throw new VerificationError(
      "invalid-submission",
      error instanceof Error ? error.message : "Submission could not be built",
    );
  }
}

function enforceStaticLimits(document: LabDocument, request: VerificationRequest, limits: VerificationLimits): void {
  const nodes = document.topology.nodes.length;
  const links = document.topology.links.length;
  const interfaces = document.topology.nodes.reduce((total, node) => total + node.interfaces.length, 0);
  const checks = request.gradingSpec.checks.length;
  const candidates: Array<[keyof VerificationLimits, number, number]> = [
    ["maximumNodes", nodes, limits.maximumNodes],
    ["maximumLinks", links, limits.maximumLinks],
    ["maximumInterfaces", interfaces, limits.maximumInterfaces],
    ["maximumGradingChecks", checks, limits.maximumGradingChecks],
  ];
  for (const [name, actual, maximum] of candidates) {
    if (actual > maximum) throw new VerificationResourceLimitError(name, actual, maximum);
  }
}

function prepareDhcp(runtime: VerificationRuntime, document: LabDocument): void {
  const clients: EndHost[] = [];
  for (const node of document.topology.nodes) {
    const config = document.configurations[node.id];
    const pc = runtime.built.getPc(node.id);
    if (pc && config?.kind === "pc" && config.dhcpEnabled) {
      pc.requestDhcp();
      clients.push(pc);
    }
    const server = runtime.built.getServer(node.id);
    if (server && config?.kind === "server" && config.dhcpClientEnabled) {
      server.requestDhcp();
      clients.push(server);
    }
  }
  runtime.runUntil(() => clients.every((client) => client.dhcpState === "bound" || client.dhcpState === "failed"));
}

function result(
  check: GradingCheck,
  passed: boolean,
  message: string,
  diagnostics: Record<string, unknown>,
  status: "passed" | "failed" | "error" = passed ? "passed" : "failed",
): InternalCheckResult {
  return {
    id: check.id,
    title: check.title,
    visibility: check.visibility,
    status,
    awardedPoints: passed ? check.points : 0,
    maximumPoints: check.points,
    message,
    diagnostics,
  };
}

function errorResult(check: GradingCheck, message: string): InternalCheckResult {
  return result(check, false, message, { reason: message }, "error");
}

function executePing(
  runtime: VerificationRuntime,
  sourceDeviceId: string,
  destinationIp: string,
): {
  source: EndHost | Router | Layer3Switch;
  success: boolean;
  trace: SimulationEngine["traceLog"];
  failure?: string;
} | undefined {
  const candidate = runtime.built.getDevice(sourceDeviceId);
  const source = candidate instanceof EndHost || candidate instanceof Router || candidate instanceof Layer3Switch
    ? candidate
    : undefined;
  if (!source) return undefined;
  const sequence = runtime.nextPingSequence();
  const traceStart = runtime.built.engine.traceLog.length;
  let failure: string | undefined;
  try {
    source.ping(destinationIp, sequence);
    runtime.runUntil(() => source.pingResults.some((entry) => entry.sequence === sequence));
  } catch (error) {
    if (error instanceof VerificationResourceLimitError) throw error;
    failure = error instanceof Error ? error.message : "Ping execution failed";
  }
  return {
    source,
    success: source.pingResults.find((entry) => entry.sequence === sequence)?.success ?? false,
    trace: runtime.built.engine.traceLog.slice(traceStart),
    failure,
  };
}

function executeIpv6Traffic(
  runtime: VerificationRuntime,
  sourceDeviceId: string,
  destination: string,
  nextHeader: 6 | 17 | 58 = Ipv6NextHeader.ICMPv6,
  destinationPort = 80,
): {
  source: EndHost | Router | Layer3Switch;
  success: boolean;
  trace: SimulationEngine["traceLog"];
  failure?: string;
} | undefined {
  const candidate = runtime.built.getDevice(sourceDeviceId);
  const source = candidate instanceof EndHost || candidate instanceof Router || candidate instanceof Layer3Switch
    ? candidate
    : undefined;
  if (!source) return undefined;
  const traceStart = runtime.built.engine.traceLog.length;
  let failure: string | undefined;
  let success = false;
  try {
    if (nextHeader === Ipv6NextHeader.ICMPv6) {
      const sequence = runtime.nextPingSequence();
      source.ping6(destination, sequence);
      runtime.runUntil(() => source.ipv6PingResults.some((entry) => entry.sequence === sequence));
      success = source.ipv6PingResults.find((entry) => entry.sequence === sequence)?.success ?? false;
    } else if (source instanceof EndHost && nextHeader === Ipv6NextHeader.TCP) {
      source.connectTcp(destination, destinationPort);
      runtime.runUntil(() => runtime.built.engine.nextEventTime() === undefined);
      success = source.transport.tcp.inspect().some((entry) =>
        entry.remoteAddress === destination && entry.remotePort === destinationPort && entry.state === TcpState.Established);
    } else if (source instanceof EndHost && nextHeader === Ipv6NextHeader.UDP) {
      source.sendUdp({
        destinationAddress: destination,
        destinationPort,
        payload: { kind: "udp-application", protocol: "grading", data: "ipv6-policy-check" },
      });
      runtime.runUntil(() => runtime.built.engine.nextEventTime() === undefined);
      success = true;
    } else {
      failure = "TCP and UDP IPv6 policy checks require an end host source";
    }
  } catch (error) {
    if (error instanceof VerificationResourceLimitError) throw error;
    failure = error instanceof Error ? error.message : "IPv6 operation failed";
  }
  return {
    source,
    success,
    trace: runtime.built.engine.traceLog.slice(traceStart),
    failure,
  };
}

/** Router or L3 Switch: the two devices that can run an OSPF process. */
function ospfDeviceOf(built: BuiltLab, deviceId: string): Router | Layer3Switch | undefined {
  const device = built.getDevice(deviceId);
  if (device instanceof Layer3Switch) return device;
  return device instanceof Router && device.deviceType === "router" ? device : undefined;
}

function runCheck(check: GradingCheck, runtime: VerificationRuntime): InternalCheckResult {
  const built = runtime.built;
  // The management plane drives real simulated sessions, so it gets the
  // rebuilt document too: the verifier replays the credential the learner
  // stored instead of a grading spec ever carrying one.
  if (isQosCheck(check)) {
    const outcome = runQosCheck(check, built, () => runtime.runUntil(() => built.engine.pendingEventCount() === 0));
    return result(
      check,
      outcome.passed,
      outcome.message,
      outcome.error ? { ...outcome.diagnostics, failure: outcome.error } : outcome.diagnostics,
      outcome.error && !outcome.passed ? "error" : outcome.passed ? "passed" : "failed",
    );
  }
  if (isVpnCheck(check)) {
    const outcome = runVpnCheck(check, built, () => runtime.runUntil(() => built.engine.pendingEventCount() === 0));
    return result(
      check,
      outcome.passed,
      outcome.message,
      outcome.error ? { ...outcome.diagnostics, failure: outcome.error } : outcome.diagnostics,
      outcome.error && !outcome.passed ? "error" : outcome.passed ? "passed" : "failed",
    );
  }
  if (isManagementCheck(check)) {
    const outcome = runManagementCheck(check, built, runtime.document, () => runtime.runUntil(() => built.engine.pendingEventCount() === 0));
    return result(
      check,
      outcome.passed,
      outcome.message,
      outcome.error ? { ...outcome.diagnostics, failure: outcome.error } : outcome.diagnostics,
      outcome.error && !outcome.passed ? "error" : outcome.passed ? "passed" : "failed",
    );
  }
  switch (check.type) {
    case "configuration-saved": {
      const { deviceId } = check.configuration;
      if (!built.getDevice(deviceId)) return errorResult(check, `Device '${deviceId}' was not found`);
      const status = deviceConfigurationDrift(built, deviceId);
      return result(
        check,
        status.drift === "saved",
        status.drift === "saved"
          ? `${deviceId} running configuration matches its startup configuration`
          : status.drift === "modified"
            ? `${deviceId} has unsaved running configuration changes`
            : `${deviceId} has no startup configuration`,
        { deviceId, drift: status.drift },
      );
    }
    case "ping": {
      const candidate = built.getDevice(check.configuration.sourceDeviceId);
      const source = candidate instanceof EndHost || candidate instanceof Router || candidate instanceof Layer3Switch
        ? candidate
        : undefined;
      if (!source) return errorResult(check, `Ping-capable device '${check.configuration.sourceDeviceId}' was not found`);
      const sequence = runtime.nextPingSequence();
      let failure: string | undefined;
      try {
        source.ping(check.configuration.destinationIp, sequence);
        runtime.runUntil(() => source.pingResults.some((entry) => entry.sequence === sequence));
      } catch (error) {
        if (error instanceof VerificationResourceLimitError) throw error;
        failure = error instanceof Error ? error.message : "Ping execution failed";
      }
      const ping = source.pingResults.find((entry) => entry.sequence === sequence);
      const actual = ping?.success ?? false;
      const passed = check.configuration.expected === "success" ? actual : !actual;
      return result(
        check,
        passed,
        actual
          ? `${source.name} reached ${check.configuration.destinationIp}`
          : `${source.name} did not reach ${check.configuration.destinationIp}`,
        { actual: actual ? "success" : "failure", expected: check.configuration.expected, failure },
      );
    }
    case "interface-state": {
      const device = built.getDevice(check.configuration.deviceId);
      const iface = device?.getInterface(check.configuration.interfaceId);
      if (!device || !iface) return errorResult(check, "Device or interface was not found");
      const passed = iface.adminUp === check.configuration.expectedAdminUp;
      return result(check, passed, `${device.name} ${iface.name} is administratively ${iface.adminUp ? "up" : "down"}`, {
        actualAdminUp: iface.adminUp,
        expectedAdminUp: check.configuration.expectedAdminUp,
      });
    }
    case "switchport": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device?.getInterface(check.configuration.interfaceId)) return errorResult(check, "Switch or interface was not found");
      const actual = device.portConfigOf(check.configuration.interfaceId);
      const routed = device instanceof Layer3Switch && device.isRoutedPort(check.configuration.interfaceId);
      const passed = !routed && actual.mode === check.configuration.expectedMode
        && (check.configuration.expectedAccessVlan === undefined || actual.accessVlan === check.configuration.expectedAccessVlan);
      return result(check, passed, `${device.name} ${check.configuration.interfaceId} is ${routed ? "routed" : actual.mode}${routed ? "" : ` VLAN ${actual.accessVlan}`}`, {
        actualMode: routed ? "routed" : actual.mode,
        actualAccessVlan: actual.accessVlan,
        expectedMode: check.configuration.expectedMode,
        expectedAccessVlan: check.configuration.expectedAccessVlan,
      });
    }
    case "vlan-exists": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const exists = device.vlanDefinitions().some((vlan) => vlan.id === check.configuration.vlanId);
      return result(check, exists, `VLAN ${check.configuration.vlanId} ${exists ? "exists" : "does not exist"} on ${device.name}`, {
        exists,
        expectedVlan: check.configuration.vlanId,
      });
    }
    case "route-exists": {
      const candidate = built.getDevice(check.configuration.deviceId);
      const device = candidate instanceof Router || candidate instanceof Layer3Switch ? candidate : undefined;
      if (!device) return errorResult(check, "Routing device was not found");
      const expectedMask = maskToInt(check.configuration.prefixLength);
      const exists = device.routingTable().some((route) => route.network === check.configuration.network && route.maskInt === expectedMask);
      return result(check, exists, `Route ${check.configuration.network}/${check.configuration.prefixLength} ${exists ? "exists" : "is missing"}`, {
        exists,
        expectedNetwork: check.configuration.network,
        expectedPrefixLength: check.configuration.prefixLength,
      });
    }
    case "dhcp-address": {
      const candidate = built.getDevice(check.configuration.deviceId);
      const device = candidate instanceof EndHost ? candidate : undefined;
      if (!device) return errorResult(check, "DHCP-capable end host was not found");
      const [network, prefixText] = check.configuration.expectedSubnet.split("/");
      const prefixLength = Number(prefixText);
      const mask = maskToInt(prefixLength);
      const matches = device.ip !== undefined && ((ipToInt(device.ip) & mask) >>> 0) === ((ipToInt(network!) & mask) >>> 0);
      return result(check, matches, `${device.name} ${matches ? "received" : "did not receive"} an address in ${check.configuration.expectedSubnet}`, {
        actualAddress: device.ip,
        expectedSubnet: check.configuration.expectedSubnet,
        dhcpState: device.dhcpState,
      });
    }
    case "device-type": {
      const device = built.getDevice(check.configuration.deviceId);
      if (!device) return errorResult(check, "Device was not found");
      const passed = device.deviceType === check.configuration.expectedType;
      return result(check, passed, `${device.name} is a ${device.profile.displayName}`, {
        actualType: device.deviceType,
        expectedType: check.configuration.expectedType,
      });
    }
    case "capability-present": {
      const device = built.getDevice(check.configuration.deviceId);
      if (!device) return errorResult(check, "Device was not found");
      const present = device.hasCapability(check.configuration.capability);
      return result(check, present, `${device.name} ${present ? "supports" : "does not support"} ${check.configuration.capability}`, {
        capability: check.configuration.capability,
        present,
      });
    }
    case "svi-state": {
      const device = built.getLayer3Switch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Layer-3 switch was not found");
      const svi = device.sviSummaries().find((entry) => entry.vlanId === check.configuration.vlanId);
      if (!svi) return errorResult(check, `SVI VLAN ${check.configuration.vlanId} was not found`);
      const passed = svi.adminUp === check.configuration.expectedAdminUp
        && svi.operUp === check.configuration.expectedOperationalUp;
      return result(check, passed, `${device.name} Vlan${svi.vlanId} is ${svi.operUp ? "up" : "down"}`, {
        actualAdminUp: svi.adminUp,
        actualOperationalUp: svi.operUp,
        expectedAdminUp: check.configuration.expectedAdminUp,
        expectedOperationalUp: check.configuration.expectedOperationalUp,
      });
    }
    case "ip-routing-enabled": {
      const device = built.getLayer3Switch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Layer-3 switch was not found");
      const passed = device.ipRoutingEnabled === check.configuration.expected;
      return result(check, passed, `IP routing is ${device.ipRoutingEnabled ? "enabled" : "disabled"} on ${device.name}`, {
        actual: device.ipRoutingEnabled,
        expected: check.configuration.expected,
      });
    }
    case "dns-record": {
      const server = built.getServer(check.configuration.deviceId);
      if (!server) return errorResult(check, "Server was not found");
      let hostname: string;
      try {
        hostname = normalizeDnsName(check.configuration.hostname);
      } catch {
        return errorResult(check, "DNS hostname is invalid");
      }
      const record = server.services.configurations()
        .filter((service) => service.type === "dns")
        .flatMap((service) => service.records)
        .find((candidate) => candidate.name === hostname);
      const passed = record?.address === check.configuration.expectedAddress;
      return result(check, passed, `${hostname} ${passed ? "maps" : "does not map"} to ${check.configuration.expectedAddress}`, {
        hostname,
        actualAddress: record?.address,
        expectedAddress: check.configuration.expectedAddress,
      });
    }
    case "dns-resolution": {
      const source = built.getDevice(check.configuration.sourceDeviceId);
      if (!(source instanceof EndHost)) return errorResult(check, "DNS client end host was not found");
      const requestId = source.applications.resolveDns(check.configuration.hostname, check.configuration.dnsServer);
      runtime.runUntil(() => source.applications.dnsResults.some((entry) => entry.requestId === requestId));
      const resolution = source.applications.dnsResults.find((entry) => entry.requestId === requestId);
      const passed = resolution?.status === "success" && resolution.address === check.configuration.expectedAddress;
      return result(check, passed, `${source.name} ${passed ? "resolved" : "did not resolve"} ${check.configuration.hostname}`, {
        status: resolution?.status,
        actualAddress: resolution?.address,
        expectedAddress: check.configuration.expectedAddress,
      });
    }
    case "http-response": {
      const source = built.getDevice(check.configuration.sourceDeviceId);
      if (!(source instanceof EndHost)) return errorResult(check, "HTTP client end host was not found");
      const requestId = source.applications.httpGet(check.configuration.url);
      runtime.runUntil(() => source.applications.httpResults.some((entry) => entry.requestId === requestId));
      const response = source.applications.httpResults.find((entry) => entry.requestId === requestId);
      const passed = response?.status === "completed"
        && response.statusCode === check.configuration.expectedStatus
        && (check.configuration.expectedBody === undefined || response.body === check.configuration.expectedBody);
      return result(check, passed, `HTTP ${check.configuration.url} returned ${response?.statusCode ?? response?.status ?? "no response"}`, {
        actualStatus: response?.statusCode,
        expectedStatus: check.configuration.expectedStatus,
        bodyMatched: check.configuration.expectedBody === undefined || response?.body === check.configuration.expectedBody,
      });
    }
    case "tftp-file": {
      const source = built.getDevice(check.configuration.sourceDeviceId);
      if (!(source instanceof EndHost)) return errorResult(check, "TFTP client end host was not found");
      const requestId = source.applications.tftpGet(check.configuration.serverIp, check.configuration.filename);
      runtime.runUntil(() => source.applications.tftpResults.some((entry) => entry.requestId === requestId));
      const transfer = source.applications.tftpResults.find((entry) => entry.requestId === requestId);
      const passed = transfer?.status === "completed"
        && (check.configuration.expectedContent === undefined || transfer.content === check.configuration.expectedContent);
      return result(check, passed, `${check.configuration.filename} ${passed ? "was downloaded" : "was not downloaded"}`, {
        status: transfer?.status,
        contentMatched: check.configuration.expectedContent === undefined || transfer?.content === check.configuration.expectedContent,
      });
    }
    case "ntp-response": {
      const source = built.getDevice(check.configuration.sourceDeviceId);
      if (!(source instanceof EndHost)) return errorResult(check, "NTP client end host was not found");
      const requestId = source.applications.queryNtp(check.configuration.serverIp);
      runtime.runUntil(() => source.applications.ntpResults.some((entry) => entry.requestId === requestId));
      const response = source.applications.ntpResults.find((entry) => entry.requestId === requestId);
      const succeeded = response?.status === "completed";
      const passed = check.configuration.expected === "success" ? succeeded : !succeeded;
      return result(check, passed, `NTP query ${succeeded ? "received a response" : "timed out"}`, {
        actual: succeeded ? "success" : "failure",
        expected: check.configuration.expected,
        serverTimeNs: response?.serverTimeNs,
      });
    }
    case "syslog-received": {
      const source = built.getDevice(check.configuration.sourceDeviceId);
      const server = built.getServer(check.configuration.serverDeviceId);
      if (!(source instanceof EndHost) || !server?.ip) return errorResult(check, "Syslog source or server was not found");
      const before = server.serviceRuntimeSnapshot().syslog.entries.length;
      source.applications.sendSyslog(server.ip, check.configuration.severity, check.configuration.message);
      runtime.runUntil(() => server.serviceRuntimeSnapshot().syslog.entries.length > before);
      const entry = server.serviceRuntimeSnapshot().syslog.entries.at(-1);
      const passed = entry?.severity === check.configuration.severity && entry.message === check.configuration.message;
      return result(check, passed, `Syslog message ${passed ? "was received" : "was not received"} by ${server.name}`, {
        received: !!entry,
        actualSeverity: entry?.severity,
        source: entry?.source,
      });
    }
    case "tcp-listener": {
      const server = built.getServer(check.configuration.deviceId);
      if (!server) return errorResult(check, "Server was not found");
      const listener = server.transport.tcp.inspect().find((entry) =>
        entry.localPort === check.configuration.port && entry.state === TcpState.Listen);
      return result(check, !!listener, `TCP port ${check.configuration.port} is ${listener ? "listening" : "closed"} on ${server.name}`, {
        listening: !!listener,
        service: listener?.service,
        port: check.configuration.port,
      });
    }
    case "acl-rule": {
      const candidate = built.getDevice(check.configuration.deviceId);
      const device = candidate instanceof Router || candidate instanceof Layer3Switch ? candidate : undefined;
      if (!device) return errorResult(check, "ACL-capable routing device was not found");
      const acl = device.aclConfigurations().find((entry) => entry.id === check.configuration.aclId);
      const rule = acl?.rules.find((entry) => entry.sequence === check.configuration.sequence);
      const passed = rule?.action === check.configuration.expectedAction;
      return result(check, passed, `ACL ${check.configuration.aclId} sequence ${check.configuration.sequence} ${passed ? "matches" : "does not match"} the expected action`, {
        actualAction: rule?.action,
        expectedAction: check.configuration.expectedAction,
        aclType: acl?.type,
      });
    }
    case "acl-binding": {
      const candidate = built.getDevice(check.configuration.deviceId);
      const device = candidate instanceof Router || candidate instanceof Layer3Switch ? candidate : undefined;
      if (!device) return errorResult(check, "ACL-capable routing device was not found");
      const binding = device.aclBindings().find((entry) =>
        entry.interfaceName === check.configuration.interfaceId
        && entry.direction === check.configuration.direction);
      const passed = binding?.aclId === check.configuration.aclId;
      return result(check, passed, `ACL ${check.configuration.aclId} is ${passed ? "bound" : "not bound"} to ${check.configuration.interfaceId} ${check.configuration.direction}`, {
        actualAclId: binding?.aclId,
        expectedAclId: check.configuration.aclId,
      });
    }
    case "packet-permitted":
    case "packet-denied": {
      const execution = executePing(
        runtime,
        check.configuration.sourceDeviceId,
        check.configuration.destinationIp,
      );
      if (!execution) return errorResult(check, "Packet source device was not found");
      const permits = execution.trace.filter((entry) =>
        entry.type === "acl-permitted" || entry.type === "firewall-permitted");
      const denies = execution.trace.filter((entry) =>
        entry.type === "acl-denied"
        || entry.type === "acl-implicit-deny"
        || entry.type === "firewall-denied"
        || entry.type === "nat-no-translation");
      const permitted = permits.length > 0 && denies.length === 0;
      const passed = check.type === "packet-permitted" ? permitted : denies.length > 0;
      return result(check, passed, `Packet was ${denies.length > 0 ? "denied" : permitted ? "permitted" : "not decided by policy"}`, {
        pingSuccess: execution.success,
        permitEvents: permits.map((entry) => entry.type),
        denyEvents: denies.map((entry) => entry.type),
        failure: execution.failure,
      });
    }
    case "nat-rule": {
      const device = built.getRouter(check.configuration.deviceId);
      if (!device) return errorResult(check, "NAT device was not found");
      const rule = device.natRuleConfigurations().find((entry) => entry.id === check.configuration.ruleId);
      const passed = rule?.kind === check.configuration.expectedKind;
      return result(check, passed, `NAT rule ${check.configuration.ruleId} is ${rule?.kind ?? "missing"}`, {
        actualKind: rule?.kind,
        expectedKind: check.configuration.expectedKind,
      });
    }
    case "nat-translation": {
      const device = built.getRouter(check.configuration.deviceId);
      if (!device) return errorResult(check, "NAT device was not found");
      const execution = executePing(
        runtime,
        check.configuration.sourceDeviceId,
        check.configuration.destinationIp,
      );
      if (!execution) return errorResult(check, "NAT test source was not found");
      const translations = device.natTranslations();
      const translation = translations.find((entry) =>
        check.configuration.expectedInsideGlobalAddress === undefined
        || entry.insideGlobalAddress === check.configuration.expectedInsideGlobalAddress);
      return result(check, !!translation, `NAT translation ${translation ? "was created" : "was not created"}`, {
        translationCount: translations.length,
        actualInsideGlobalAddress: translation?.insideGlobalAddress,
        expectedInsideGlobalAddress: check.configuration.expectedInsideGlobalAddress,
        pingSuccess: execution.success,
      });
    }
    case "firewall-rule": {
      const device = built.getFirewall(check.configuration.deviceId);
      if (!device) return errorResult(check, "Firewall was not found");
      const rule = device.policyConfigurations().find((entry) => entry.id === check.configuration.ruleId);
      const passed = rule?.action === check.configuration.expectedAction;
      return result(check, passed, `Firewall rule ${check.configuration.ruleId} ${passed ? "matches" : "does not match"} the expected action`, {
        actualAction: rule?.action,
        expectedAction: check.configuration.expectedAction,
      });
    }
    case "firewall-session": {
      const device = built.getFirewall(check.configuration.deviceId);
      if (!(device instanceof Firewall)) return errorResult(check, "Firewall was not found");
      const execution = executePing(
        runtime,
        check.configuration.sourceDeviceId,
        check.configuration.destinationIp,
      );
      if (!execution) return errorResult(check, "Firewall test source was not found");
      const session = device.connectionTable().find((entry) =>
        entry.destinationAddress === check.configuration.destinationIp);
      return result(check, !!session, `Firewall session ${session ? "was created" : "was not created"}`, {
        connectionId: session?.id,
        state: session?.state,
        pingSuccess: execution.success,
      });
    }
    case "external-connectivity": {
      const execution = executePing(
        runtime,
        check.configuration.sourceDeviceId,
        check.configuration.destinationIp,
      );
      if (!execution) return errorResult(check, "External connectivity source was not found");
      const passed = check.configuration.expected === "success"
        ? execution.success
        : !execution.success;
      return result(check, passed, `External connectivity ${execution.success ? "succeeded" : "failed"}`, {
        actual: execution.success ? "success" : "failure",
        expected: check.configuration.expected,
        failure: execution.failure,
      });
    }
    // --- M10.4 control protocols ---------------------------------------
    case "stp-root": {
      const expected = built.getSwitch(check.configuration.expectedDeviceId);
      if (!expected) return errorResult(check, "Expected root switch was not found");
      const instance = expected.spanningTreeSummary().instances
        .find((entry) => entry.vlanId === check.configuration.vlanId);
      if (!instance) return errorResult(check, `VLAN ${check.configuration.vlanId} has no spanning-tree instance`);
      // Every switch in the VLAN must agree on that root bridge id.
      const agreeing = [...built.devices.values()]
        .filter((device): device is typeof expected => device instanceof L2Switch)
        .map((device) => device.spanningTreeSummary().instances
          .find((entry) => entry.vlanId === check.configuration.vlanId))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      const passed = instance.isRoot && agreeing.every((entry) => entry.rootId === instance.bridgeId);
      return result(check, passed, `${expected.name} ${passed ? "is" : "is not"} the root bridge for VLAN ${check.configuration.vlanId}`, {
        expectedRoot: check.configuration.expectedDeviceId,
        actualRootId: instance.rootId,
        bridgeId: instance.bridgeId,
        agreement: agreeing.length,
      });
    }
    case "stp-mode": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const passed = device.spanningTreeMode === check.configuration.expectedMode;
      return result(check, passed, `${device.name} spanning tree is ${device.spanningTreeMode}`, {
        actualMode: device.spanningTreeMode,
        expectedMode: check.configuration.expectedMode,
      });
    }
    case "stp-port-role":
    case "stp-port-state": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const port = device.spanningTreeSummary().instances
        .find((entry) => entry.vlanId === check.configuration.vlanId)?.ports
        .find((entry) => entry.port === check.configuration.interfaceId);
      if (!port) {
        return errorResult(check, `${check.configuration.interfaceId} has no spanning-tree state in VLAN ${check.configuration.vlanId}`);
      }
      const isRole = check.type === "stp-port-role";
      const actual = isRole ? port.role : port.state;
      const expected = isRole ? check.configuration.expectedRole : check.configuration.expectedState;
      return result(check, actual === expected, `${device.name} ${port.port} is ${port.role}/${port.state}`, {
        actualRole: port.role,
        actualState: port.state,
        expected,
      });
    }
    case "stp-portfast": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const configuration = device.spanningTree.portConfigurationOf(check.configuration.interfaceId);
      const passed = configuration.portFast === check.configuration.expected;
      return result(check, passed, `PortFast is ${configuration.portFast ? "enabled" : "disabled"} on ${check.configuration.interfaceId}`, {
        actual: configuration.portFast,
        expected: check.configuration.expected,
      });
    }
    case "bpdu-guard-state": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const errorDisabled = device.spanningTree.isErrorDisabled(check.configuration.interfaceId);
      const passed = errorDisabled === check.configuration.expectedErrorDisabled;
      return result(check, passed, `${check.configuration.interfaceId} is ${errorDisabled ? "" : "not "}error-disabled`, {
        actualErrorDisabled: errorDisabled,
        expectedErrorDisabled: check.configuration.expectedErrorDisabled,
        bpduGuard: device.spanningTree.portConfigurationOf(check.configuration.interfaceId).bpduGuard,
      });
    }
    case "etherchannel-formed": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const channel = device.etherChannelSummaries()
        .find((entry) => entry.channelId === check.configuration.channelId);
      if (!channel) return errorResult(check, `Port-channel${check.configuration.channelId} is not configured`);
      const expectedMembers = check.configuration.expectedMembers;
      const membersMatch = expectedMembers === undefined
        || (expectedMembers.length === channel.activeMembers.length
          && [...expectedMembers].sort().every((member, index) => member === [...channel.activeMembers].sort()[index]));
      const passed = channel.status === "up" && membersMatch;
      return result(check, passed, `${channel.name} is ${channel.status} with ${channel.activeMembers.length} active member(s)`, {
        status: channel.status,
        actualMembers: channel.activeMembers,
        expectedMembers,
        suspendedMembers: channel.suspendedMembers,
      });
    }
    case "etherchannel-protocol": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const channel = device.etherChannelSummaries()
        .find((entry) => entry.channelId === check.configuration.channelId);
      if (!channel) return errorResult(check, `Port-channel${check.configuration.channelId} is not configured`);
      const passed = channel.protocol === check.configuration.expectedProtocol
        && (check.configuration.expectedMode === undefined || channel.mode === check.configuration.expectedMode);
      return result(check, passed, `${channel.name} negotiates with ${channel.protocol} (${channel.mode})`, {
        actualProtocol: channel.protocol,
        actualMode: channel.mode,
        expectedProtocol: check.configuration.expectedProtocol,
        expectedMode: check.configuration.expectedMode,
      });
    }
    case "etherchannel-member-state": {
      const device = built.getSwitch(check.configuration.deviceId);
      if (!device) return errorResult(check, "Switch was not found");
      const member = device.etherChannelSummaries()
        .find((entry) => entry.channelId === check.configuration.channelId)?.members
        .find((entry) => entry.port === check.configuration.interfaceId);
      if (!member) return errorResult(check, `${check.configuration.interfaceId} is not a member of that channel`);
      const passed = member.state === check.configuration.expectedState;
      return result(check, passed, `${member.port} is ${member.state}`, {
        actualState: member.state,
        expectedState: check.configuration.expectedState,
        reason: member.reason,
      });
    }
    case "cdp-neighbor":
    case "lldp-neighbor": {
      const candidate = built.getDevice(check.configuration.deviceId) as { discovery?: Router["discovery"] } | undefined;
      if (!candidate?.discovery) return errorResult(check, "Device does not support neighbour discovery");
      const protocol = check.type === "cdp-neighbor" ? "cdp" : "lldp";
      const neighbor = candidate.discovery.neighborTable().find((entry) =>
        entry.protocol === protocol
        && entry.localInterface === check.configuration.localInterfaceId
        && entry.deviceId === check.configuration.expectedNeighborId
        && (check.configuration.expectedRemoteInterfaceId === undefined
          || entry.remoteInterface === check.configuration.expectedRemoteInterfaceId));
      return result(check, !!neighbor, `${protocol.toUpperCase()} neighbour ${check.configuration.expectedNeighborId} ${neighbor ? "was" : "was not"} discovered on ${check.configuration.localInterfaceId}`, {
        found: !!neighbor,
        actualRemoteInterface: neighbor?.remoteInterface,
        expectedNeighbor: check.configuration.expectedNeighborId,
      });
    }
    case "ospf-router-id": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPF-capable device was not found");
      const routerId = device.ospf.overview().routerId;
      const passed = routerId === check.configuration.expectedRouterId;
      return result(check, passed, `${device.name} router id is ${routerId ?? "unassigned"}`, {
        actualRouterId: routerId,
        expectedRouterId: check.configuration.expectedRouterId,
        source: device.ospf.overview().routerIdSource,
      });
    }
    case "ospf-neighbor-state": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPF-capable device was not found");
      const neighbor = device.ospf.neighborSummaries()
        .find((entry) => entry.neighborRouterId === check.configuration.neighborRouterId);
      const actual = neighbor?.state ?? "down";
      const passed = actual === check.configuration.expectedState;
      return result(check, passed, `Neighbour ${check.configuration.neighborRouterId} is ${actual}`, {
        actualState: actual,
        expectedState: check.configuration.expectedState,
        interfaceId: neighbor?.interfaceId,
      });
    }
    case "ospf-interface": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPF-capable device was not found");
      const iface = device.ospf.interfaceSummaries()
        .find((entry) => entry.interfaceId === check.configuration.interfaceId);
      if (!iface) return errorResult(check, `${check.configuration.interfaceId} is not running OSPF`);
      const passed = (check.configuration.expectedCost === undefined || iface.cost === check.configuration.expectedCost)
        && (check.configuration.expectedPassive === undefined || iface.passive === check.configuration.expectedPassive)
        && (check.configuration.expectedNetworkType === undefined || iface.networkType === check.configuration.expectedNetworkType);
      return result(check, passed, `${iface.interfaceId} cost ${iface.cost}, ${iface.networkType}${iface.passive ? ", passive" : ""}`, {
        actualCost: iface.cost,
        actualPassive: iface.passive,
        actualNetworkType: iface.networkType,
        expectedCost: check.configuration.expectedCost,
        expectedPassive: check.configuration.expectedPassive,
        expectedNetworkType: check.configuration.expectedNetworkType,
      });
    }
    case "ospf-dr":
    case "ospf-bdr": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPF-capable device was not found");
      const iface = device.ospf.interfaceSummaries()
        .find((entry) => entry.interfaceId === check.configuration.interfaceId);
      if (!iface) return errorResult(check, `${check.configuration.interfaceId} is not running OSPF`);
      const isDr = check.type === "ospf-dr";
      const actual = isDr ? iface.designatedRouter : iface.backupDesignatedRouter;
      const expected = isDr
        ? check.configuration.expectedDesignatedRouter
        : check.configuration.expectedBackupDesignatedRouter;
      return result(check, actual === expected, `${iface.interfaceId} ${isDr ? "DR" : "BDR"} is ${actual ?? "none"}`, {
        actual,
        expected,
        designatedRouter: iface.designatedRouter,
        backupDesignatedRouter: iface.backupDesignatedRouter,
      });
    }
    case "ospf-route":
    case "ospf-path-cost": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPF-capable device was not found");
      const expectedMask = maskToInt(check.configuration.prefixLength);
      const route = device.routingTable().find((entry) =>
        entry.kind === "ospf"
        && entry.network === check.configuration.network
        && entry.maskInt === expectedMask);
      if (check.type === "ospf-path-cost") {
        const passed = route?.metric === check.configuration.expectedCost;
        return result(check, passed, `OSPF cost to ${check.configuration.network} is ${route?.metric ?? "unknown"}`, {
          actualCost: route?.metric,
          expectedCost: check.configuration.expectedCost,
        });
      }
      const passed = route !== undefined
        && (check.configuration.expectedNextHop === undefined || route.viaIp === check.configuration.expectedNextHop);
      return result(check, passed, `OSPF route ${check.configuration.network}/${check.configuration.prefixLength} ${route ? "exists" : "is missing"}`, {
        found: route !== undefined,
        actualNextHop: route?.viaIp,
        expectedNextHop: check.configuration.expectedNextHop,
        administrativeDistance: route?.administrativeDistance,
      });
    }
    case "ospf-lsdb-entry": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPF-capable device was not found");
      const entry = device.ospf.database().find((candidate) =>
        candidate.type === check.configuration.lsaType
        && candidate.advertisingRouter === check.configuration.advertisingRouter);
      return result(check, !!entry, `${check.configuration.lsaType} LSA from ${check.configuration.advertisingRouter} ${entry ? "is" : "is not"} in the database`, {
        found: !!entry,
        sequence: entry?.sequence,
        linkCount: entry?.linkCount,
        databaseSize: device.ospf.database().length,
      });
    }
    case "ipv6-address": {
      const device = built.getDevice(check.configuration.deviceId);
      if (!device) return errorResult(check, "IPv6 device was not found");
      const addresses = device instanceof EndHost
        ? device.ipv6AddressSummaries().map((entry) => ({ interfaceId: device.primary.name, ...entry }))
        : device instanceof Router || device instanceof Layer3Switch
          ? device.ipv6InterfaceSummaries().flatMap((entry) =>
              entry.addresses.map((address) => ({ interfaceId: entry.name, ...address })))
          : [];
      const expectedAddress = normalizeIpv6(check.configuration.expectedAddress);
      const address = addresses.find((entry) =>
        entry.address === expectedAddress
        && (check.configuration.interfaceId === undefined || entry.interfaceId === check.configuration.interfaceId)
        && (check.configuration.expectedPrefixLength === undefined
          || entry.prefixLength === check.configuration.expectedPrefixLength));
      return result(check, !!address, `IPv6 address ${check.configuration.expectedAddress} ${address ? "is configured" : "is missing"}`, {
        found: !!address,
        actualAddresses: addresses,
        expectedAddress: check.configuration.expectedAddress,
        expectedPrefixLength: check.configuration.expectedPrefixLength,
      });
    }
    case "ipv6-neighbor": {
      const device = built.getDevice(check.configuration.deviceId);
      const neighbors = device instanceof EndHost
        ? device.ipv6NeighborEntries()
        : device instanceof Router || device instanceof Layer3Switch
          ? device.ipv6NeighborEntries()
          : [];
      if (!device) return errorResult(check, "IPv6 device was not found");
      const expectedNeighbor = normalizeIpv6(check.configuration.neighborAddress);
      const neighbor = neighbors.find((entry) => entry.address === expectedNeighbor);
      return result(check, !!neighbor, `IPv6 neighbor ${check.configuration.neighborAddress} ${neighbor ? "was resolved" : "is missing"}`, {
        found: !!neighbor,
        macAddress: neighbor?.mac,
        state: neighbor?.state,
      });
    }
    case "slaac-address":
    case "dhcpv6-address": {
      const device = built.getDevice(check.configuration.deviceId);
      if (!(device instanceof EndHost)) return errorResult(check, "IPv6 end host was not found");
      const [prefix, lengthText] = check.configuration.expectedPrefix.split("/");
      const prefixLength = Number(lengthText);
      const expectedSource = check.type === "slaac-address" ? "slaac" : "dhcpv6";
      const address = device.ipv6AddressSummaries().find((entry) =>
        entry.source === expectedSource
        && entry.state !== "duplicate"
        && ipv6InPrefix(entry.address, prefix!, prefixLength));
      return result(check, !!address, `${device.name} ${address ? "has" : "does not have"} a ${expectedSource.toUpperCase()} address in ${check.configuration.expectedPrefix}`, {
        actualAddress: address?.address,
        actualState: address?.state,
        expectedPrefix: check.configuration.expectedPrefix,
        source: expectedSource,
      });
    }
    case "ipv6-route": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "IPv6 routing device was not found");
      const expectedNetwork = ipv6Network(check.configuration.network, check.configuration.prefixLength);
      const expectedNextHop = check.configuration.expectedNextHop === undefined
        ? undefined
        : normalizeIpv6(check.configuration.expectedNextHop);
      const route = device.ipv6RoutingTable().find((entry) =>
        entry.network === expectedNetwork
        && entry.prefixLength === check.configuration.prefixLength
        && (expectedNextHop === undefined || entry.viaIp === expectedNextHop));
      return result(check, !!route, `IPv6 route ${check.configuration.network}/${check.configuration.prefixLength} ${route ? "exists" : "is missing"}`, {
        found: !!route,
        actualNextHop: route?.viaIp,
        expectedNextHop: check.configuration.expectedNextHop,
        routeKind: route?.kind,
      });
    }
    case "ipv6-connectivity": {
      const execution = executeIpv6Traffic(
        runtime,
        check.configuration.sourceDeviceId,
        check.configuration.destination,
      );
      if (!execution) return errorResult(check, "IPv6 source device was not found");
      const passed = check.configuration.expected === "success" ? execution.success : !execution.success;
      return result(check, passed, `IPv6 connectivity ${execution.success ? "succeeded" : "failed"} to ${check.configuration.destination}`, {
        actual: execution.success ? "success" : "failure",
        expected: check.configuration.expected,
        failure: execution.failure,
      });
    }
    case "ospfv3-neighbor": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPFv3-capable device was not found");
      const neighbor = device.ospfv3.neighborSummaries()
        .find((entry) => entry.neighborRouterId === check.configuration.neighborRouterId);
      const actual = neighbor?.state ?? "down";
      return result(check, actual === check.configuration.expectedState, `OSPFv3 neighbour ${check.configuration.neighborRouterId} is ${actual}`, {
        actualState: actual,
        expectedState: check.configuration.expectedState,
        interfaceId: neighbor?.interfaceId,
        address: neighbor?.address,
      });
    }
    case "ospfv3-route": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "OSPFv3-capable device was not found");
      const expectedNetwork = ipv6Network(check.configuration.network, check.configuration.prefixLength);
      const route = device.ipv6RoutingTable().find((entry) =>
        entry.kind === "ospfv3"
        && entry.network === expectedNetwork
        && entry.prefixLength === check.configuration.prefixLength);
      return result(check, !!route, `OSPFv3 route ${check.configuration.network}/${check.configuration.prefixLength} ${route ? "exists" : "is missing"}`, {
        found: !!route,
        nextHop: route?.viaIp,
        interfaceId: route?.egressName,
        metric: route?.metric,
      });
    }
    case "ipv6-acl-rule": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "IPv6 policy device was not found");
      const rule = device.ipv6AclConfigurations()
        .find((acl) => acl.id === check.configuration.aclId)?.rules
        .find((candidate) => candidate.sequence === check.configuration.sequence);
      const passed = rule?.action === check.configuration.expectedAction;
      return result(check, passed, `IPv6 ACL ${check.configuration.aclId} sequence ${check.configuration.sequence} is ${rule?.action ?? "missing"}`, {
        actualAction: rule?.action,
        expectedAction: check.configuration.expectedAction,
      });
    }
    case "ipv6-packet-permitted":
    case "ipv6-packet-denied": {
      const execution = executeIpv6Traffic(
        runtime,
        check.configuration.sourceDeviceId,
        check.configuration.destination,
        check.configuration.nextHeader,
        check.configuration.destinationPort,
      );
      if (!execution) return errorResult(check, "IPv6 packet source was not found");
      const permits = execution.trace.filter((entry) => entry.type === "ipv6-acl-permitted");
      const denies = execution.trace.filter((entry) => entry.type === "ipv6-acl-denied");
      const passed = check.type === "ipv6-packet-permitted"
        ? permits.length > 0 && denies.length === 0
        : denies.length > 0;
      return result(check, passed, `IPv6 packet was ${denies.length > 0 ? "denied" : permits.length > 0 ? "permitted" : "not decided by policy"}`, {
        operationSuccess: execution.success,
        permitEvents: permits.length,
        denyEvents: denies.length,
        nextHeader: check.configuration.nextHeader,
        destinationPort: check.configuration.destinationPort,
        failure: execution.failure,
      });
    }
    case "wireless-associated": {
      const station = built.getDevice(check.configuration.stationDeviceId);
      if (!(station instanceof WirelessEndHost)) {
        return errorResult(check, "Wireless station was not found");
      }
      const status = station.wirelessStatus();
      const passed = status.state === "associated"
        && (check.configuration.accessPointDeviceId === undefined
          || status.accessPointDeviceId === check.configuration.accessPointDeviceId);
      return result(check, passed, `${station.name} is ${passed ? "associated" : "not associated"}`, {
        state: status.state,
        accessPointDeviceId: status.accessPointDeviceId,
        bssid: status.bssid,
      });
    }
    case "wireless-ssid":
    case "wireless-security": {
      const candidate = built.getDevice(check.configuration.deviceId);
      const device = candidate instanceof AccessPoint || candidate instanceof WirelessRouter
        ? candidate
        : undefined;
      if (!device) return errorResult(check, "Wireless access point was not found");
      const accessPoint = device.configurationSnapshot().accessPoint;
      if (check.type === "wireless-ssid") {
        const passed = accessPoint.ssid === check.configuration.expectedSsid;
        return result(check, passed, `${device.name} advertises SSID ${accessPoint.ssid}`, {
          actualSsid: accessPoint.ssid,
          expectedSsid: check.configuration.expectedSsid,
        });
      }
      const passed = accessPoint.security.mode === check.configuration.expectedMode;
      return result(check, passed, `${device.name} uses ${accessPoint.security.mode}`, {
        actualMode: accessPoint.security.mode,
        expectedMode: check.configuration.expectedMode,
      });
    }
    case "wireless-client-count": {
      const candidate = built.getDevice(check.configuration.deviceId);
      const device = candidate instanceof AccessPoint || candidate instanceof WirelessRouter
        ? candidate
        : undefined;
      if (!device) return errorResult(check, "Wireless access point was not found");
      const count = device.associatedClients().length;
      const passed = count >= check.configuration.minimumClients
        && (check.configuration.maximumClients === undefined
          || count <= check.configuration.maximumClients);
      return result(check, passed, `${device.name} has ${count} associated wireless client${count === 1 ? "" : "s"}`, {
        actualClients: count,
        minimumClients: check.configuration.minimumClients,
        maximumClients: check.configuration.maximumClients,
      });
    }
    case "wireless-ipv4": {
      const station = built.getDevice(check.configuration.deviceId);
      if (!(station instanceof WirelessEndHost)) return errorResult(check, "Wireless station was not found");
      const [network, prefixText] = check.configuration.expectedSubnet.split("/");
      const mask = maskToInt(Number(prefixText));
      const matches = station.wirelessStatus().state === "associated"
        && station.ip !== undefined
        && ((ipToInt(station.ip) & mask) >>> 0) === ((ipToInt(network!) & mask) >>> 0);
      return result(check, matches, `${station.name} ${matches ? "has" : "does not have"} a wireless IPv4 address in ${check.configuration.expectedSubnet}`, {
        actualAddress: station.ip,
        expectedSubnet: check.configuration.expectedSubnet,
        associationState: station.wirelessStatus().state,
      });
    }
    case "wireless-ipv6": {
      const station = built.getDevice(check.configuration.deviceId);
      if (!(station instanceof WirelessEndHost)) return errorResult(check, "Wireless station was not found");
      const [prefix, lengthText] = check.configuration.expectedPrefix.split("/");
      const address = station.ipv6AddressSummaries().find((entry) =>
        entry.state !== "duplicate"
        && !entry.address.startsWith("fe80:")
        && ipv6InPrefix(entry.address, prefix!, Number(lengthText)));
      const passed = station.wirelessStatus().state === "associated" && address !== undefined;
      return result(check, passed, `${station.name} ${passed ? "has" : "does not have"} a wireless IPv6 address in ${check.configuration.expectedPrefix}`, {
        actualAddress: address?.address,
        expectedPrefix: check.configuration.expectedPrefix,
        source: address?.source,
      });
    }
    case "wireless-connectivity": {
      const station = built.getDevice(check.configuration.sourceDeviceId);
      if (!(station instanceof WirelessEndHost)) return errorResult(check, "Wireless station was not found");
      if (station.wirelessStatus().state !== "associated") {
        return result(check, check.configuration.expected === "failure", `${station.name} is not associated`, {
          associationState: station.wirelessStatus().state,
          expected: check.configuration.expected,
        });
      }
      const ipv6 = check.configuration.destination.includes(":");
      const execution = ipv6
        ? executeIpv6Traffic(runtime, station.id, check.configuration.destination)
        : executePing(runtime, station.id, check.configuration.destination);
      if (!execution) return errorResult(check, "Wireless connectivity operation could not start");
      const passed = check.configuration.expected === "success" ? execution.success : !execution.success;
      return result(check, passed, `Wireless connectivity ${execution.success ? "succeeded" : "failed"} to ${check.configuration.destination}`, {
        actual: execution.success ? "success" : "failure",
        expected: check.configuration.expected,
        associationState: station.wirelessStatus().state,
        failure: execution.failure,
      });
    }
    case "wireless-roamed": {
      const station = built.getDevice(check.configuration.stationDeviceId);
      if (!(station instanceof WirelessEndHost)) return errorResult(check, "Wireless station was not found");
      if (check.configuration.triggerAccessPointShutdownDeviceId) {
        const trigger = built.getDevice(check.configuration.triggerAccessPointShutdownDeviceId);
        if (!(trigger instanceof AccessPoint) && !(trigger instanceof WirelessRouter)) {
          return errorResult(check, "Wireless failover trigger access point was not found");
        }
        trigger.updateWireless({
          ...trigger.configurationSnapshot().accessPoint,
          enabled: false,
        });
        runtime.runUntil(() => {
          const current = station.wirelessStatus();
          return current.state === "associated"
            && current.accessPointDeviceId !== check.configuration.triggerAccessPointShutdownDeviceId;
        });
      }
      const status = station.wirelessStatus();
      const passed = status.lastRoamedAtNs !== undefined
        && (check.configuration.expectedFromBssid === undefined
          || status.lastRoamedFromBssid === check.configuration.expectedFromBssid)
        && (check.configuration.expectedToAccessPointDeviceId === undefined
          || status.accessPointDeviceId === check.configuration.expectedToAccessPointDeviceId);
      return result(check, passed, `${station.name} ${passed ? "roamed successfully" : "has no matching roam event"}`, {
        fromBssid: status.lastRoamedFromBssid,
        toBssid: status.bssid,
        accessPointDeviceId: status.accessPointDeviceId,
        lastRoamedAtNs: status.lastRoamedAtNs,
      });
    }
    case "wireless-router-nat": {
      const device = built.getDevice(check.configuration.deviceId);
      if (!(device instanceof WirelessRouter)) return errorResult(check, "Wireless router was not found");
      const enabled = device.configurationSnapshot().natEnabled;
      const passed = enabled === check.configuration.expectedEnabled;
      return result(check, passed, `${device.name} NAT is ${enabled ? "enabled" : "disabled"}`, {
        actualEnabled: enabled,
        expectedEnabled: check.configuration.expectedEnabled,
        translations: device.firewallRouter.natTranslations().length,
      });
    }
    case "traffic-flow-result": {
      const device = built.getTrafficGenerator(check.configuration.deviceId);
      if (!(device instanceof TrafficGenerator)) return errorResult(check, "Traffic Generator was not found");
      device.startFlow(check.configuration.flowId);
      runtime.runUntil(() =>
        device.flowResults().some((entry) =>
          entry.flowId === check.configuration.flowId && entry.status === "completed"));
      const flow = device.flowResults().find((entry) => entry.flowId === check.configuration.flowId);
      if (!flow) return errorResult(check, "Traffic flow did not produce a result");
      const passed = flow.received >= check.configuration.minimumReceived
        && (check.configuration.maximumDropped === undefined
          || flow.dropped <= check.configuration.maximumDropped);
      return result(check, passed, `Traffic flow ${check.configuration.flowId} received ${flow.received} and dropped ${flow.dropped}`, {
        sent: flow.sent,
        received: flow.received,
        dropped: flow.dropped,
        permitted: flow.permitted,
        denied: flow.denied,
        translated: flow.translated,
        timedOut: flow.timedOut,
        minimumReceived: check.configuration.minimumReceived,
        maximumDropped: check.configuration.maximumDropped,
      });
    }
  }
}

function studentResult(check: InternalCheckResult): VerificationCheckResult {
  if (check.visibility === "visible") {
    const { diagnostics: _diagnostics, visibility: _visibility, ...visible } = check;
    return visible;
  }
  return {
    id: check.id,
    title: "Hidden check",
    status: check.status,
    awardedPoints: check.awardedPoints,
    maximumPoints: check.maximumPoints,
    message: check.status === "passed" ? "Hidden check passed" : check.status === "failed" ? "Hidden check failed" : "Hidden check could not run",
  };
}

export function verifySubmission(input: unknown, limits: VerificationLimits = DEFAULT_VERIFICATION_LIMITS): VerificationResult {
  const payloadBytes = utf8ByteLength(stableStringify(input));
  if (payloadBytes > limits.maximumJsonPayloadBytes) {
    throw new VerificationResourceLimitError("maximumJsonPayloadBytes", payloadBytes, limits.maximumJsonPayloadBytes);
  }
  const request = parseRequest(input);
  const document = submissionDocument(request);
  enforceStaticLimits(document, request, limits);

  let built: BuiltLab;
  try {
    built = buildLabFromDocument(document);
  } catch (error) {
    throw new VerificationError("invalid-submission", error instanceof Error ? error.message : "Lab build failed");
  }
  built.engine.enableTrace(limits.maximumTraceRecords);
  const runtime = new VerificationRuntime(built, limits, document);
  prepareDhcp(runtime, document);
  runtime.runUntil(() => built.engine.nextEventTime() === undefined);
  const internalChecks = request.gradingSpec.checks.map((check) => {
    try {
      // Each check is one bounded operation for the control protocols too.
      built.engine.controlProtocolBudget.reset();
      return runCheck(check, runtime);
    } catch (error) {
      if (error instanceof VerificationResourceLimitError) throw error;
      return errorResult(check, error instanceof Error ? error.message : "Check execution failed");
    }
  });
  const maximumPoints = internalChecks.reduce((total, check) => total + check.maximumPoints, 0);
  const awardedPoints = internalChecks.reduce((total, check) => total + check.awardedPoints, 0);
  const score = maximumPoints === 0 ? 0 : Math.round((awardedPoints / maximumPoints) * 10_000) / 100;
  const checks = request.resultView === "student" ? internalChecks.map(studentResult) : internalChecks;
  const verification: VerificationResult = {
    verificationId: `ver-${stableHash({ submission: request.submission, gradingSpec: request.gradingSpec })}`,
    status: "completed",
    resultView: request.resultView,
    score,
    awardedPoints,
    maximumPoints,
    checks,
    engine: {
      schemaVersion: 1,
      simulationSeed: document.simulation.seed,
      processedEvents: runtime.processedEvents,
      virtualTimeNs: built.engine.now(),
    },
  };
  return VerificationResultSchema.parse(verification);
}

export function traceDiagnostics(engine: SimulationEngine, maximum = DEFAULT_VERIFICATION_LIMITS.maximumTraceRecords) {
  return engine.traceLog.slice(0, maximum);
}

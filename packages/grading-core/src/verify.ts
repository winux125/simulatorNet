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
  normalizeMac,
  ipFamilyOf,
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

function mplsRouterOf(built: BuiltLab, deviceId: string): Router | undefined {
  const device = built.getDevice(deviceId);
  return device instanceof Router && device.deviceType === "router" ? device : undefined;
}

/** The VTEP capability belongs to the L3 Switch, and to nothing else. */
function vtepOf(built: BuiltLab, deviceId: string): Layer3Switch | undefined {
  const device = built.getDevice(deviceId);
  return device instanceof Layer3Switch ? device : undefined;
}

/**
 * A BGP peer address may be IPv4 or IPv6 transport. The engine stores the
 * canonical form, so a grading spec written as `2001:DB8:12::2` must compare
 * equal to it; an IPv4 address is already canonical and is left alone.
 */
function normalizeBgpPeerAddress(address: string): string {
  return ipFamilyOf(address) === "ipv6" ? normalizeIpv6(address) : address;
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
    case "bgp-neighbor-state": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const neighbor = device.bgp.summaries().find((entry) => entry.address === check.configuration.neighborAddress);
      const actual = neighbor?.state ?? "idle";
      return result(check, actual === check.configuration.expectedState, `BGP neighbor ${check.configuration.neighborAddress} is ${actual}`, {
        actualState: actual,
        expectedState: check.configuration.expectedState,
        lastError: neighbor?.lastError,
      });
    }
    case "bgp-local-as": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const actual = device.bgp.localAs;
      return result(check, actual === check.configuration.expectedLocalAs, `${device.name} local AS is ${actual ?? "not configured"}`, {
        actualLocalAs: actual,
        expectedLocalAs: check.configuration.expectedLocalAs,
      });
    }
    case "bgp-network": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const found = device.bgp.configurationSnapshot()?.networks?.some((entry) =>
        entry.network === check.configuration.network && entry.prefixLength === check.configuration.prefixLength) ?? false;
      return result(check, found, `BGP network ${check.configuration.network}/${check.configuration.prefixLength} ${found ? "is configured" : "is missing"}`, { found });
    }
    case "bgp-route": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const route = device.routingTable().find((entry) => entry.kind === "bgp"
        && entry.network === check.configuration.network
        && entry.maskInt === maskToInt(check.configuration.prefixLength));
      const passed = route !== undefined
        && (check.configuration.expectedNextHop === undefined || route.viaIp === check.configuration.expectedNextHop)
        && (check.configuration.expectedAdministrativeDistance === undefined
          || route.administrativeDistance === check.configuration.expectedAdministrativeDistance);
      return result(check, passed, `BGP route ${check.configuration.network}/${check.configuration.prefixLength} ${route ? "is installed" : "is missing"}`, {
        found: route !== undefined,
        actualNextHop: route?.viaIp,
        actualAdministrativeDistance: route?.administrativeDistance,
      });
    }
    case "bgp-best-path":
    case "bgp-next-hop": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const route = device.bgp.routes().find((entry) => entry.best
        && entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength);
      const passed = check.type === "bgp-next-hop"
        ? route?.nextHop === check.configuration.expectedNextHop
        : route !== undefined
          && (check.configuration.expectedNeighborAddress === undefined || route.neighborAddress === check.configuration.expectedNeighborAddress)
          && (check.configuration.expectedAsPath === undefined
            || JSON.stringify(route.asPath) === JSON.stringify(check.configuration.expectedAsPath));
      return result(check, passed, `Best BGP path for ${check.configuration.network}/${check.configuration.prefixLength} ${route ? `uses ${route.nextHop}` : "is missing"}`, {
        found: route !== undefined,
        nextHop: route?.nextHop,
        neighborAddress: route?.neighborAddress,
        asPath: route?.asPath,
      });
    }
    case "prefix-list-entry": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const entry = device.bgp.routingPolicy.prefixListConfigurations()
        .find((list) => list.id === check.configuration.prefixListId)?.entries
        .find((candidate) => candidate.sequence === check.configuration.sequence);
      const passed = entry?.action === check.configuration.expectedAction;
      return result(check, passed, `Prefix-list ${check.configuration.prefixListId} sequence ${check.configuration.sequence} is ${entry?.action ?? "missing"}`, {
        actualAction: entry?.action,
        expectedAction: check.configuration.expectedAction,
      });
    }
    case "route-map-sequence": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const sequence = device.bgp.routingPolicy.routeMapConfigurations()
        .find((map) => map.id === check.configuration.routeMapId)?.sequences
        .find((candidate) => candidate.sequence === check.configuration.sequence);
      const passed = sequence?.action === check.configuration.expectedAction;
      return result(check, passed, `Route-map ${check.configuration.routeMapId} sequence ${check.configuration.sequence} is ${sequence?.action ?? "missing"}`, {
        actualAction: sequence?.action,
        expectedAction: check.configuration.expectedAction,
      });
    }
    case "route-policy-result":
    case "bgp-advertised-route":
    case "bgp-received-route": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const direction = check.type === "bgp-advertised-route" ? "out"
        : check.type === "bgp-received-route" ? "in"
          : check.configuration.direction;
      const entries = direction === "out"
        ? device.bgp.adjRibOutEntries(check.configuration.neighborAddress)
        : device.bgp.adjRibInEntries(check.configuration.neighborAddress);
      const found = entries.some((entry) => entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength);
      const expected = check.type === "route-policy-result" ? check.configuration.expected === "permitted" : true;
      return result(check, found === expected, `${direction === "out" ? "Advertised" : "Received"} BGP route ${check.configuration.network}/${check.configuration.prefixLength} ${found ? "is present" : "is absent"}`, {
        found,
        direction,
        neighborAddress: check.configuration.neighborAddress,
      });
    }
    case "bgp-route-reflector-client": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const isClient = device.bgp.routeReflectorClients().includes(check.configuration.neighborAddress);
      return result(check, isClient, `BGP neighbor ${check.configuration.neighborAddress} ${isClient ? "is" : "is not"} a route-reflector client`, {
        isClient,
        clusterId: device.bgp.clusterIdentity,
      });
    }
    case "bgp-cluster-id": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const actual = device.bgp.clusterIdentity;
      return result(check, actual === check.configuration.expectedClusterId, `Cluster ID is ${actual}`, { actualClusterId: actual });
    }
    case "bgp-route-reflected": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const route = device.bgp.routes().find((entry) => entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength
        && entry.clusterList.length > 0);
      const passed = route !== undefined
        && (check.configuration.expectedOriginatorId === undefined || route.originatorId === check.configuration.expectedOriginatorId)
        && (check.configuration.expectedClusterId === undefined || route.clusterList.includes(check.configuration.expectedClusterId));
      return result(check, passed, `${check.configuration.network}/${check.configuration.prefixLength} ${route ? "was reflected" : "was not reflected"}`, {
        found: route !== undefined,
        originatorId: route?.originatorId,
        clusterList: route?.clusterList,
      });
    }
    case "bgp-originator-loop-prevented": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      // The verifier reruns the lab, so the rejection is a fact of this run's
      // trace; a client-supplied trace is never consulted.
      const rejected = built.engine.traceLog.some((entry) =>
        entry.device === check.configuration.deviceId
        && (entry.type === "bgp-originator-loop-rejected" || entry.type === "bgp-cluster-loop-rejected"));
      const absent = !device.bgp.routes().some((entry) => entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength
        && entry.source === "ibgp");
      return result(check, rejected && absent, `Reflection loop prevention ${rejected ? "rejected" : "did not reject"} ${check.configuration.network}/${check.configuration.prefixLength}`, {
        rejected,
        absentFromRib: absent,
      });
    }
    case "bgp-community": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const routes = device.bgp.routes().filter((entry) => entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength);
      const present = routes.some((entry) => entry.communities.includes(check.configuration.expectedCommunity));
      const passed = present === (check.configuration.expected === "present");
      return result(check, passed, `${check.configuration.network}/${check.configuration.prefixLength} ${present ? "carries" : "does not carry"} the expected community`, {
        present,
        // Only the observed set is reported; the expected value stays hidden
        // in a student result exactly like every other expectation.
        actualCommunities: routes.flatMap((entry) => entry.communities),
      });
    }
    case "bgp-community-list":
    case "bgp-as-path-list": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const entry = check.type === "bgp-community-list"
        ? device.bgp.routingPolicy.communityListConfigurations()
          .find((list) => list.id === check.configuration.communityListId)?.entries
          .find((candidate) => candidate.sequence === check.configuration.sequence)
        : device.bgp.routingPolicy.asPathListConfigurations()
          .find((list) => list.id === check.configuration.asPathListId)?.entries
          .find((candidate) => candidate.sequence === check.configuration.sequence);
      const passed = entry?.action === check.configuration.expectedAction;
      const label = check.type === "bgp-community-list" ? check.configuration.communityListId : check.configuration.asPathListId;
      return result(check, passed, `${label} sequence ${check.configuration.sequence} is ${entry?.action ?? "missing"}`, {
        actualAction: entry?.action,
      });
    }
    case "bgp-route-policy-result": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const counter = device.bgp.routingPolicy.counterSummaries().find((entry) => entry.policyType === "route-map"
        && entry.policyId === check.configuration.routeMapId
        && entry.sequence === check.configuration.sequence);
      const matches = counter?.matches ?? 0;
      const passed = check.configuration.expectedMatches === undefined ? matches > 0 : matches === check.configuration.expectedMatches;
      return result(check, passed, `route-map ${check.configuration.routeMapId} sequence ${check.configuration.sequence} matched ${matches} route(s)`, {
        actualMatches: matches,
      });
    }
    case "bgp-aggregate": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const aggregate = device.bgp.aggregateSummaries().find((entry) => entry.prefix === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength);
      const passed = aggregate !== undefined
        && aggregate.active === check.configuration.expectedActive
        && (check.configuration.expectedSummaryOnly === undefined
          || (aggregate.summaryOnly ?? false) === check.configuration.expectedSummaryOnly);
      return result(check, passed, `Aggregate ${check.configuration.network}/${check.configuration.prefixLength} ${aggregate?.active ? "is active" : "is not active"}`, {
        found: aggregate !== undefined,
        active: aggregate?.active,
        contributingRoutes: aggregate?.contributingRoutes,
      });
    }
    case "bgp-specific-suppressed": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const suppressed = device.bgp.suppressedRoutes().some((entry) => entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength);
      // summary-only hides an advertisement, never the local forwarding entry.
      const stillLocal = device.bgp.selectedRoutes().some((entry) => entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength);
      return result(check, suppressed && stillLocal, `${check.configuration.network}/${check.configuration.prefixLength} ${suppressed ? "is suppressed" : "is not suppressed"}`, {
        suppressed,
        presentInLocRib: stillLocal,
      });
    }
    case "bgp-default-advertised": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const advertised = device.bgp.adjRibOutEntries(check.configuration.neighborAddress)
        .some((entry) => entry.network === "0.0.0.0" && entry.prefixLength === 0);
      const passed = advertised === (check.configuration.expected === "advertised");
      return result(check, passed, `0.0.0.0/0 ${advertised ? "is" : "is not"} advertised to ${check.configuration.neighborAddress}`, {
        advertised,
        neighborAddress: check.configuration.neighborAddress,
      });
    }
    case "mpls-interface-enabled": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "MPLS Router was not found");
      const enabled = router.mpls.interfaceEnabled(check.interfaceId);
      return result(check, enabled, `MPLS ${enabled ? "is" : "is not"} enabled on ${check.interfaceId}`, { enabled, interfaceId: check.interfaceId });
    }
    case "ldp-neighbor-state": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "LDP Router was not found");
      const neighbor = router.ldp.neighborSummaries().find((entry) => entry.routerId === check.neighborRouterId);
      const actual = neighbor?.state ?? "nonexistent";
      return result(check, actual === check.expectedState, `LDP neighbor ${check.neighborRouterId} is ${actual}`, { actualState: actual, expectedState: check.expectedState });
    }
    case "ldp-binding": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "LDP Router was not found");
      const binding = router.ldp.labelBindings().find((entry) => entry.fec === check.fec);
      const remoteLabels = binding ? Object.values(binding.remoteLabels) : [];
      const passed = binding !== undefined && (check.expectedRemoteLabel === undefined
        || remoteLabels.includes(check.expectedRemoteLabel)
        || (check.expectedRemoteLabel === 3 && binding.implicitNullNeighborIds.length > 0));
      return result(check, passed, `LDP binding for ${check.fec} ${binding ? "is installed" : "is missing"}`, {
        localLabel: binding?.localLabel,
        remoteLabels,
        implicitNullNeighbors: binding?.implicitNullNeighborIds,
      });
    }
    case "mpls-lfib-entry": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "MPLS Router was not found");
      const entry = router.mpls.forwardingTable().find((candidate) => candidate.fec === check.fec);
      const passed = entry !== undefined && (check.expectedOperation === undefined || entry.operation.type === check.expectedOperation);
      return result(check, passed, `LFIB entry for ${check.fec} ${entry ? `uses ${entry.operation.type}` : "is missing"}`, {
        operation: entry?.operation.type,
        incomingLabel: entry?.incomingLabel,
        nextHop: entry?.nextHop,
      });
    }
    case "mpls-label-operation": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "MPLS Router was not found");
      const traceType = check.operation === "push" ? "mpls-label-imposed"
        : check.operation === "swap" ? "mpls-label-swapped"
          : check.operation === "pop" ? "mpls-label-popped" : "mpls-packet-delivered";
      const traced = built.engine.traceLog.some((entry) => entry.device === check.deviceId && entry.type === traceType);
      const installed = router.mpls.forwardingTable().some((entry) => entry.operation.type === check.operation);
      return result(check, traced || installed, `MPLS ${check.operation} ${traced ? "was observed" : installed ? "is installed" : "was not observed"}`, { traceType, traced, installed });
    }
    case "vrf-exists": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      const found = router.vrfConfigurations().some((vrf) => vrf.id === check.vrfId);
      return result(check, found, `VRF ${check.vrfId} ${found ? "exists" : "is missing"}`, { found });
    }
    case "vrf-interface": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      const actual = router.interfaceVrf(check.interfaceId);
      return result(check, actual === check.vrfId, `${check.interfaceId} belongs to ${actual ?? "global routing"}`, { actualVrfId: actual, expectedVrfId: check.vrfId });
    }
    case "vrf-route": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      let routes;
      try { routes = router.vrfRoutingTable(check.vrfId); } catch { return errorResult(check, `VRF '${check.vrfId}' was not found`); }
      const route = routes.find((entry) => entry.network === check.network && entry.prefixLength === check.prefixLength);
      const passed = route !== undefined && (check.expectedSource === undefined || route.source === check.expectedSource);
      return result(check, passed, `VRF route ${check.network}/${check.prefixLength} ${route ? `is ${route.source}` : "is missing"}`, { source: route?.source, nextHop: route?.nextHop, vpnLabel: route?.vpnLabel });
    }
    case "vpnv4-route": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "VPNv4 Router was not found");
      const route = router.bgp.vpnv4Routes().find((entry) => entry.routeDistinguisher === check.routeDistinguisher
        && entry.network === check.network && entry.prefixLength === check.prefixLength);
      return result(check, !!route, `VPNv4 route ${check.routeDistinguisher}:${check.network}/${check.prefixLength} ${route ? "exists" : "is missing"}`, {
        found: !!route,
        routeTargets: route?.routeTargets,
        vpnLabel: route?.vpnLabel,
        nextHop: route?.nextHop,
      });
    }
    case "route-target-import":
    case "route-target-export": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      const vrf = router.vrfConfigurations().find((entry) => entry.id === check.vrfId);
      const values = check.type === "route-target-import" ? vrf?.importRouteTargets : vrf?.exportRouteTargets;
      const found = values?.includes(check.routeTarget) ?? false;
      return result(check, found, `${check.type === "route-target-import" ? "Import" : "Export"} route target ${check.routeTarget} ${found ? "is configured" : "is missing"}`, { found });
    }
    case "l3vpn-connectivity": {
      const outcome = executePing(runtime, check.sourceDeviceId, check.destinationIp);
      if (!outcome) return errorResult(check, `Ping-capable device '${check.sourceDeviceId}' was not found`);
      const passed = check.expected === "success" ? outcome.success : !outcome.success;
      const labelEvents = outcome.trace.filter((entry) => entry.type.startsWith("mpls-") || entry.type.startsWith("l3vpn-"));
      return result(check, passed, `${outcome.source.name} ${outcome.success ? "reached" : "did not reach"} ${check.destinationIp} through L3VPN`, {
        actual: outcome.success ? "success" : "failure",
        expected: check.expected,
        labelEvents: labelEvents.map((entry) => entry.type),
        failure: outcome.failure,
      });
    }
    case "customer-isolation": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      const destination = router.vrfConfigurations().find((vrf) => vrf.id === check.destinationVrfId);
      if (!destination) return errorResult(check, `VRF '${check.destinationVrfId}' was not found`);
      let sourceRoutes;
      try { sourceRoutes = router.vrfRoutingTable(check.sourceVrfId); } catch { return errorResult(check, `VRF '${check.sourceVrfId}' was not found`); }
      const leaked = sourceRoutes.find((route) => route.network === check.network && route.prefixLength === check.prefixLength
        && route.routeDistinguisher === destination.routeDistinguisher);
      return result(check, !leaked, `Customer VRFs ${leaked ? "share an unintended route" : "remain isolated"}`, { leakedRouteDistinguisher: leaked?.routeDistinguisher });
    }
    case "overlapping-prefix-isolation": {
      const router = mplsRouterOf(built, check.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      const first = router.vrfConfigurations().find((vrf) => vrf.id === check.firstVrfId);
      const second = router.vrfConfigurations().find((vrf) => vrf.id === check.secondVrfId);
      if (!first || !second) return errorResult(check, "One or both VRFs were not found");
      const firstRoutes = router.vrfRoutingTable(first.id).filter((route) => route.network === check.network && route.prefixLength === check.prefixLength);
      const secondRoutes = router.vrfRoutingTable(second.id).filter((route) => route.network === check.network && route.prefixLength === check.prefixLength);
      const crossed = firstRoutes.some((route) => route.routeDistinguisher === second.routeDistinguisher)
        || secondRoutes.some((route) => route.routeDistinguisher === first.routeDistinguisher);
      const distinctPolicy = first.routeDistinguisher !== second.routeDistinguisher
        && !first.importRouteTargets.some((target) => second.exportRouteTargets.includes(target))
        && !second.importRouteTargets.some((target) => first.exportRouteTargets.includes(target));
      const passed = firstRoutes.length > 0 && secondRoutes.length > 0 && distinctPolicy && !crossed;
      return result(check, passed, `Overlapping ${check.network}/${check.prefixLength} ${passed ? "is isolated by VRF" : "is not safely isolated"}`, {
        firstRouteCount: firstRoutes.length,
        secondRouteCount: secondRoutes.length,
        distinctPolicy,
        crossed,
      });
    }
    // --- M10.14 VXLAN and BGP EVPN Layer 2 overlays -----------------------
    // Every diagnostic below names only what the submission actually holds:
    // the expected RD, route target and MAC stay in the hidden spec and are
    // never echoed back into a result.
    case "nve-configured": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const nve = device.nveSummaries()[0];
      const sourceMatches = check.configuration.expectedSourceInterfaceId === undefined
        || nve?.sourceInterfaceId === check.configuration.expectedSourceInterfaceId;
      const passed = check.configuration.expected === "down"
        ? nve !== undefined && !nve.up
        : nve !== undefined && sourceMatches && (check.configuration.expected === "configured" || nve.up);
      return result(check, passed, `nve1 ${nve ? (nve.up ? "is operational" : `is down: ${nve.reason}`) : "is not configured"}`, {
        configured: nve !== undefined,
        up: nve?.up ?? false,
        actualSourceInterfaceId: nve?.sourceInterfaceId,
        sourceAddress: nve?.sourceAddress,
        reason: nve?.reason,
        expected: check.configuration.expected,
      });
    }
    case "vxlan-vni-mapping": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const mapping = device.vniSummaries().find((entry) => entry.vni === check.configuration.vni);
      const passed = mapping !== undefined
        && mapping.vlanId === check.configuration.vlanId
        && (check.configuration.expectedReplication === undefined
          || mapping.replication === check.configuration.expectedReplication);
      return result(check, passed, `VNI ${check.configuration.vni} ${mapping ? `maps VLAN ${mapping.vlanId}` : "is not mapped"}`, {
        actualVlanId: mapping?.vlanId,
        actualReplication: mapping?.replication,
        up: mapping?.up ?? false,
        reason: mapping?.reason,
      });
    }
    case "vxlan-peer-state": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const peer = device.vxlanPeerSummaries()
        .find((entry) => entry.vni === check.configuration.vni && entry.address === check.configuration.peerAddress);
      const passed = check.configuration.expected === "absent"
        ? peer === undefined
        : peer !== undefined && (check.configuration.expected === "unreachable" ? !peer.reachable : peer.reachable);
      return result(check, passed, `VTEP ${check.configuration.peerAddress} ${peer ? (peer.reachable ? "is reachable" : "has no underlay route") : "is not a peer"}`, {
        found: peer !== undefined,
        reachable: peer?.reachable ?? false,
        learnedFrom: peer?.source,
        expected: check.configuration.expected,
      });
    }
    case "vxlan-remote-mac": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const entry = device.remoteMacEntries().find((row) =>
        row.vni === check.configuration.vni && row.mac === normalizeMac(check.configuration.macAddress));
      const matches = entry !== undefined
        && (check.configuration.expectedRemoteVtep === undefined || entry.remoteVtep === check.configuration.expectedRemoteVtep)
        && (check.configuration.expectedSource === undefined || entry.source === check.configuration.expectedSource);
      const passed = check.configuration.expected === "present" ? matches : !matches;
      return result(check, passed, `Remote MAC in VNI ${check.configuration.vni} ${entry ? `points to ${entry.remoteVtep}` : "is not installed"}`, {
        found: entry !== undefined,
        actualRemoteVtep: entry?.remoteVtep,
        actualSource: entry?.source,
        expected: check.configuration.expected,
      });
    }
    case "evpn-type2-route":
    case "evpn-type3-route": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const wantType = check.type === "evpn-type2-route" ? 2 : 3;
      const candidates = device.evpnRoutes().filter((route) => route.type === wantType
        && route.vni === check.configuration.vni
        && (check.configuration.routeDistinguisher === undefined
          || route.routeDistinguisher === check.configuration.routeDistinguisher));
      const route = check.type === "evpn-type2-route"
        ? candidates.find((entry) => entry.type === 2
          && entry.macAddress === normalizeMac(check.configuration.macAddress)
          && (check.configuration.expectedNextHop === undefined || entry.nextHop === check.configuration.expectedNextHop))
        : candidates.find((entry) => entry.type === 3
          && (check.configuration.originatingVtep === undefined
            || entry.originatingVtep === check.configuration.originatingVtep));
      const passed = check.configuration.expected === "present" ? route !== undefined : route === undefined;
      return result(check, passed, `EVPN Type ${wantType} route for VNI ${check.configuration.vni} ${route ? "is present" : "is missing"}`, {
        found: route !== undefined,
        best: route?.best,
        actualNextHop: route?.nextHop,
        candidateCount: candidates.length,
        expected: check.configuration.expected,
      });
    }
    case "evpn-route-target": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const evpn = device.evpnVniConfigurations().find((entry) => entry.vni === check.configuration.vni);
      const values = check.configuration.direction === "import" ? evpn?.importRouteTargets : evpn?.exportRouteTargets;
      const found = values?.includes(check.configuration.routeTarget) ?? false;
      return result(check, found, `VNI ${check.configuration.vni} ${check.configuration.direction} route target ${found ? "is configured" : "is missing"}`, {
        found,
        configuredCount: values?.length ?? 0,
      });
    }
    case "vxlan-l2-connectivity": {
      const outcome = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      if (!outcome) return errorResult(check, `Ping-capable device '${check.configuration.sourceDeviceId}' was not found`);
      const overlayEvents = outcome.trace.filter((entry) => entry.type.startsWith("vxlan-"));
      const encapsulated = overlayEvents.some((entry) => entry.type === "vxlan-packet-sent");
      const reachable = outcome.success && (!check.configuration.requireEncapsulation || encapsulated);
      const passed = check.configuration.expected === "success" ? reachable : !reachable;
      return result(check, passed, `${outcome.source.name} ${outcome.success ? "reached" : "did not reach"} ${check.configuration.destinationIp}${encapsulated ? " through VXLAN" : ""}`, {
        actual: outcome.success ? "success" : "failure",
        expected: check.configuration.expected,
        encapsulated,
        overlayEvents: [...new Set(overlayEvents.map((entry) => entry.type))],
        failure: outcome.failure,
      });
    }
    case "evpn-route-reflected": {
      // The reflector stamps ORIGINATOR_ID and CLUSTER_LIST on what it passes
      // on, so the evidence lives on the client that received the route — the
      // same convention `bgp-route-reflected` uses for IPv4 unicast.
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const route = device.bgp.evpnRoutes().find((entry) =>
        (check.configuration.routeType === undefined || entry.type === check.configuration.routeType)
        && entry.clusterList.length > 0
        && (check.configuration.expectedOriginatorId === undefined
          || entry.originatorId === check.configuration.expectedOriginatorId)
        && (check.configuration.expectedClusterId === undefined
          || entry.clusterList.includes(check.configuration.expectedClusterId)));
      return result(check, route !== undefined, `EVPN route ${route ? "was reflected" : "was not reflected"}`, {
        found: route !== undefined,
        routeType: route?.type,
        originatorId: route?.originatorId,
        clusterList: route?.clusterList,
      });
    }
    // --- M10.16 EVPN Single-Active multihoming ---------------------------
    case "evpn-ethernet-segment": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const segment = device.ethernetSegmentStates()
        .find((entry) => entry.id === check.configuration.segmentId);
      const attachmentsMatch = check.configuration.expectedInterfaces === undefined
        || (segment !== undefined
          && [...check.configuration.expectedInterfaces].sort().join(",") === [...segment.interfaces].sort().join(","));
      const passed = check.configuration.expected === "absent"
        ? segment === undefined
        : segment !== undefined && attachmentsMatch
          && (check.configuration.expected === "configured"
            || (check.configuration.expected === "operational" ? segment.up : !segment.up));
      return result(check, passed, `Ethernet Segment '${check.configuration.segmentId}' ${segment ? (segment.up ? "is operational" : `is down (${segment.reason ?? "unknown"})`) : "is not configured"}`, {
        found: segment !== undefined,
        up: segment?.up,
        reason: segment?.reason,
        attachmentCount: segment?.interfaces.length ?? 0,
        operationalAttachmentCount: segment?.operationalInterfaces.length ?? 0,
        expected: check.configuration.expected,
      });
    }
    case "evpn-esi": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const segment = device.ethernetSegmentConfigurations()
        .find((entry) => entry.id === check.configuration.segmentId);
      const matches = segment?.esi === check.configuration.esi;
      // The expected ESI stays in the hidden spec; only the verdict travels.
      return result(check, matches, `Ethernet Segment '${check.configuration.segmentId}' ${matches ? "carries the expected ESI" : "does not carry the expected ESI"}`, {
        found: segment !== undefined,
        matches,
      });
    }
    case "evpn-df-role": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const state = device.designatedForwarderStates()
        .find((entry) => entry.esi === check.configuration.esi && entry.vlanId === check.configuration.vlanId);
      const winnerMatches = check.configuration.expectedDesignatedForwarder === undefined
        || state?.designatedForwarder === check.configuration.expectedDesignatedForwarder;
      const passed = state !== undefined && state.localRole === check.configuration.expectedRole && winnerMatches;
      return result(check, passed, `${device.name} is ${state ? state.localRole.toUpperCase() : "not a participant"} for VLAN ${check.configuration.vlanId}`, {
        found: state !== undefined,
        actualRole: state?.localRole,
        expectedRole: check.configuration.expectedRole,
        candidateCount: state?.candidates.length ?? 0,
      });
    }
    case "evpn-type1-route":
    case "evpn-type4-route": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const wantType = check.type === "evpn-type1-route" ? 1 : 4;
      const route = device.evpnRoutes().find((entry) => {
        if (entry.type !== wantType) return false;
        if (entry.esi !== check.configuration.esi) return false;
        if (check.configuration.originatingVtep !== undefined
          && entry.originatingVtep !== check.configuration.originatingVtep) return false;
        if (entry.type !== 1) return true;
        if (check.type !== "evpn-type1-route" || entry.scope !== check.configuration.scope) return false;
        return check.configuration.vni === undefined
          || (entry.scope === "per-evi" && entry.vni === check.configuration.vni);
      });
      const passed = check.configuration.expected === "present" ? route !== undefined : route === undefined;
      return result(check, passed, `EVPN Type ${wantType} route ${route ? "is present" : "is missing"}`, {
        found: route !== undefined,
        best: route?.best,
        source: route?.source,
        expected: check.configuration.expected,
      });
    }
    case "evpn-multihoming-primary": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const mac = normalizeMac(check.configuration.macAddress);
      const entry = device.remoteMacEntries()
        .find((row) => row.vni === check.configuration.vni && row.mac === mac);
      const matches = entry !== undefined
        && entry.ethernetSegmentId !== undefined
        && (check.configuration.expectedPrimary === undefined || entry.remoteVtep === check.configuration.expectedPrimary)
        && (check.configuration.expectedEsi === undefined || entry.ethernetSegmentId === check.configuration.expectedEsi);
      const passed = check.configuration.expected === "present" ? matches : !matches;
      return result(check, passed, `Multihomed MAC ${mac} ${entry ? "is programmed" : "is not programmed"} in VNI ${check.configuration.vni}`, {
        found: entry !== undefined,
        multihomed: entry?.ethernetSegmentId !== undefined,
        backupCount: entry?.backupVteps.length ?? 0,
        expected: check.configuration.expected,
      });
    }
    case "evpn-multihoming-backup": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const mac = normalizeMac(check.configuration.macAddress);
      const entry = device.remoteMacEntries()
        .find((row) => row.vni === check.configuration.vni && row.mac === mac);
      const backups = entry?.backupVteps ?? [];
      const passed = backups.length >= check.configuration.minimumBackups
        && (check.configuration.expectedBackup === undefined || backups.includes(check.configuration.expectedBackup));
      return result(check, passed, `Multihomed MAC ${mac} keeps ${backups.length} deterministic backup path(s)`, {
        found: entry !== undefined,
        backupCount: backups.length,
        minimumBackups: check.configuration.minimumBackups,
      });
    }
    case "evpn-single-active-failover": {
      const before = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      if (!before) return errorResult(check, `Ping-capable device '${check.configuration.sourceDeviceId}' was not found`);
      const failing = vtepOf(built, check.configuration.failDeviceId);
      const attachment = failing?.interfaces.get(check.configuration.failInterfaceId);
      if (!failing || !attachment) {
        return errorResult(check, `Attachment '${check.configuration.failInterfaceId}' was not found`);
      }
      const survivor = check.configuration.expectedNewDesignatedForwarderDeviceId === undefined
        ? undefined
        : vtepOf(built, check.configuration.expectedNewDesignatedForwarderDeviceId);
      // One bounded deterministic action: take the attachment down and let the
      // fabric reconverge. The engine never becomes idle — BGP keeps its
      // session alive — so convergence is what is waited for, not silence.
      const convergenceStart = built.engine.traceLog.length;
      attachment.shutdown();
      runtime.runUntil(() => survivor !== undefined
        ? survivor.designatedForwarderStates().some((entry) => entry.localRole === "df")
        : failing.ethernetSegmentStates().every((entry) => !entry.up));
      const converged = built.engine.traceLog.slice(convergenceStart);
      // The withdrawal is graded on state, not on an event: a trace is optional
      // and the verifier does not keep one, but a leaf that withdrew its
      // Ethernet A-D route is no longer a reachable peer on that segment —
      // which is exactly what a mass withdrawal means.
      const failedEsis = new Set((survivor ?? failing).ethernetSegmentStates().map((entry) => entry.esi));
      const massWithdrawn = converged.some((entry) => entry.type === "evpn-es-mass-withdraw"
        || entry.type === "evpn-ad-route-withdrawn")
        || (survivor ?? failing).ethernetSegmentPeers()
          .every((peer) => peer.local || !failedEsis.has(peer.esi) || !peer.reachable);
      const after = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      const tookOver = survivor === undefined
        || survivor.designatedForwarderStates().some((entry) => entry.localRole === "df");
      const passed = before.success
        && after?.success === true
        && tookOver
        && (!check.configuration.requireMassWithdraw || massWithdrawn);
      return result(check, passed, `Traffic ${after?.success ? "recovered" : "did not recover"} after the Designated Forwarder attachment failed`, {
        beforeFailure: before.success,
        afterFailure: after?.success ?? false,
        massWithdrawn,
        newDesignatedForwarderTookOver: tookOver,
      });
    }
    case "evpn-split-horizon": {
      const outcome = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      if (!outcome) return errorResult(check, `Ping-capable device '${check.configuration.sourceDeviceId}' was not found`);
      const guard = built.getDevice(check.configuration.nonDesignatedDeviceId);
      if (!guard) return errorResult(check, "Ethernet Segment peer device was not found");
      // The leaf attached to the same segment refused to hand the frame back,
      // and the conversation still completed — which is what "no loop" means.
      //
      // A refusal is only observable while there is still something to flood,
      // so a lab that pings first would see none. Standing by is the same fact
      // in a form that survives: a non-DF that learned nothing on its segment
      // attachment never returned anything to the CE either.
      const refused = outcome.trace.filter((entry) => entry.device === guard.id
        && (entry.type === "evpn-es-split-horizon-drop" || entry.type === "evpn-non-df-egress-drop"
          || entry.type === "evpn-non-df-ingress-drop"));
      const standby = guard instanceof Layer3Switch
        && guard.designatedForwarderStates().some((entry) => entry.localRole === "non-df")
        && guard.macAddressTable().every((row) => guard.ethernetSegmentIdOf(row.port) === undefined);
      const passed = outcome.success && (refused.length > 0 || standby);
      return result(check, passed, `${guard.name} ${refused.length > 0 || standby ? "did not" : "did"} return the frame to its own Ethernet Segment`, {
        reachable: outcome.success,
        refusedCount: refused.length,
        standby,
        reasons: [...new Set(refused.map((entry) => entry.type))],
      });
    }
    case "evpn-all-active-mode": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const segment = device.ethernetSegmentStates()
        .find((entry) => entry.id === check.configuration.segmentId);
      // Peer agreement is a separate demand: a leaf may be correctly configured
      // while the far end still disagrees, and a lab may grade either fact.
      const peers = segment === undefined
        ? []
        : device.ethernetSegmentPeers().filter((peer) => peer.esi === segment.esi && !peer.local);
      const agreed = peers.every((peer) => peer.modeAgrees);
      const passed = segment !== undefined
        && segment.redundancyMode === check.configuration.expectedMode
        && (!check.configuration.requirePeerAgreement || (peers.length > 0 && agreed));
      return result(check, passed, `Ethernet Segment '${check.configuration.segmentId}' runs ${segment ? segment.redundancyMode : "no"} redundancy`, {
        found: segment !== undefined,
        actualMode: segment?.redundancyMode,
        peerCount: peers.length,
        peersAgree: agreed,
      });
    }
    case "evpn-aliasing-path": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const mac = normalizeMac(check.configuration.macAddress);
      const path = device.aliasingPathSets()
        .find((row) => row.vni === check.configuration.vni && row.macAddress === mac);
      const eligible = path?.eligibleVteps ?? [];
      const expectedEligible = check.configuration.expectedEligibleVteps;
      const matches = path !== undefined
        && eligible.length >= check.configuration.minimumEligibleVteps
        && (check.configuration.expectedEsi === undefined || path.esi === check.configuration.expectedEsi)
        && (check.configuration.expectedAdvertisingVtep === undefined
          || path.advertisingVtep === check.configuration.expectedAdvertisingVtep)
        && (expectedEligible === undefined || expectedEligible.every((vtep) => eligible.includes(vtep)));
      const passed = check.configuration.expected === "present" ? matches : !matches;
      return result(check, passed, `MAC ${mac} ${path ? `has ${eligible.length} eligible aliasing path(s)` : "has no aliasing path set"} in VNI ${check.configuration.vni}`, {
        found: path !== undefined,
        eligibleCount: eligible.length,
        minimumEligibleVteps: check.configuration.minimumEligibleVteps,
        reason: path?.reason,
        expected: check.configuration.expected,
      });
    }
    case "evpn-all-active-connectivity": {
      const outcome = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      if (!outcome) return errorResult(check, `Ping-capable device '${check.configuration.sourceDeviceId}' was not found`);
      // Reaching a MAC over a leaf that never advertised it is the one thing
      // Single-Active cannot do, so that is what "aliased" means here.
      const aliased = [...built.devices.values()].some((device) => device instanceof Layer3Switch
        && device.aliasingPathSets().some((row) => row.eligibleVteps.length > 1
          && row.selectedVtep !== row.advertisingVtep));
      const passed = outcome.success && (!check.configuration.requireAliasedPath || aliased);
      return result(check, passed, `All-Active destination ${outcome.success ? "is reachable" : "is unreachable"}`, {
        reachable: outcome.success,
        aliasedPathUsed: aliased,
        requireAliasedPath: check.configuration.requireAliasedPath,
      });
    }
    case "evpn-mac-mobility-sequence": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const mac = normalizeMac(check.configuration.macAddress);
      const state = device.macMobilityStates()
        .find((row) => row.vni === check.configuration.vni && row.macAddress === mac);
      const passed = state !== undefined
        && (check.configuration.expectedSequence === undefined
          || state.sequence === check.configuration.expectedSequence)
        && (check.configuration.minimumSequence === undefined
          || state.sequence >= check.configuration.minimumSequence);
      // The expected sequence stays in the hidden spec; only the verdict and
      // the observed state travel back.
      return result(check, passed, `MAC ${mac} ${state ? `carries mobility sequence ${state.sequence}` : "has no mobility state"} in VNI ${check.configuration.vni}`, {
        found: state !== undefined,
        actualSequence: state?.sequence,
        state: state?.state,
      });
    }
    case "evpn-mac-owner": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const mac = normalizeMac(check.configuration.macAddress);
      const state = device.macMobilityStates()
        .find((row) => row.vni === check.configuration.vni && row.macAddress === mac);
      // `local` means this leaf owns the address, so it is compared as this
      // leaf's own VTEP address rather than as a literal.
      const localAddress = device.vxlan.state().sourceAddress;
      const owner = state?.owner === "local" ? localAddress : state?.owner;
      const passed = state !== undefined
        && (check.configuration.expectedOwner === undefined || owner === check.configuration.expectedOwner)
        && (check.configuration.expectedPreviousOwner === undefined
          || state.previousOwner === check.configuration.expectedPreviousOwner)
        && (!check.configuration.requirePreviousOwnerStale || state.previousOwner !== undefined);
      return result(check, passed, `MAC ${mac} ${state ? `is owned by ${owner ?? "an unknown VTEP"}` : "has no recorded owner"}`, {
        found: state !== undefined,
        ownerIsLocal: state?.owner === "local",
        hasPreviousOwner: state?.previousOwner !== undefined,
        state: state?.state,
      });
    }
    case "evpn-hrw-df": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const state = device.designatedForwarderStates()
        .find((entry) => entry.esi === check.configuration.esi && entry.vlanId === check.configuration.vlanId);
      const passed = state !== undefined
        && (!check.configuration.requireHrwEffective || state.effectiveAlgorithm === "hrw")
        && (check.configuration.expectedDesignatedForwarder === undefined
          || state.designatedForwarder === check.configuration.expectedDesignatedForwarder)
        && (check.configuration.expectedBackupDesignatedForwarder === undefined
          || state.backupDesignatedForwarder === check.configuration.expectedBackupDesignatedForwarder)
        && (check.configuration.expectedLocalRole === undefined
          || state.localRole === check.configuration.expectedLocalRole);
      // The expected winner, the backup and every weight stay hidden: only
      // whether the election ran as asked, and this leaf's own role, travel.
      return result(check, passed, `${device.name} ran the ${state?.effectiveAlgorithm ?? "no"} election for VLAN ${check.configuration.vlanId}`, {
        found: state !== undefined,
        effectiveAlgorithm: state?.effectiveAlgorithm,
        actualRole: state?.localRole,
        hasBackup: state?.backupDesignatedForwarder !== undefined,
        candidateCount: state?.candidates.length ?? 0,
      });
    }
    case "evpn-hrw-fallback": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const state = device.designatedForwarderStates()
        .find((entry) => entry.esi === check.configuration.esi && entry.vlanId === check.configuration.vlanId);
      const passed = state !== undefined
        && state.requestedAlgorithm === check.configuration.expectedRequestedAlgorithm
        && state.effectiveAlgorithm === check.configuration.expectedEffectiveAlgorithm
        && (!check.configuration.requireFallbackReason || state.fallbackReason !== undefined);
      return result(check, passed, `${device.name} requested ${state?.requestedAlgorithm ?? "no"} election and ran ${state?.effectiveAlgorithm ?? "none"}`, {
        found: state !== undefined,
        requestedAlgorithm: state?.requestedAlgorithm,
        effectiveAlgorithm: state?.effectiveAlgorithm,
        fellBack: state?.fallbackReason !== undefined,
      });
    }
    case "evpn-all-active-failover": {
      const before = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      if (!before) return errorResult(check, `Ping-capable device '${check.configuration.sourceDeviceId}' was not found`);
      const failing = vtepOf(built, check.configuration.failDeviceId);
      const attachment = failing?.interfaces.get(check.configuration.failInterfaceId);
      if (!failing || !attachment) {
        return errorResult(check, `Attachment '${check.configuration.failInterfaceId}' was not found`);
      }
      // What must survive the failure: every address that already had an alias
      // path, recorded before the attachment goes down so a relearn is visible.
      const remote = [...built.devices.values()].filter((device): device is Layer3Switch =>
        device instanceof Layer3Switch && device !== failing);
      const beforePaths = new Map(remote.flatMap((device) => device.aliasingPathSets()
        .map((row) => [`${device.id}|${row.vni}|${row.macAddress}`, row.eligibleVteps.length] as const)));
      attachment.shutdown();
      // One bounded deterministic action, as the Single-Active check is: the
      // engine never goes idle while BGP holds its sessions, so convergence is
      // what is waited for rather than silence.
      runtime.runUntil(() => remote.every((device) => device.aliasingPathSets()
        .every((row) => !row.eligibleVteps.includes(failing.vxlan.state().sourceAddress ?? ""))));
      const after = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      // A relearn would drop the address and re-add it, so an address that had
      // a path before and has none now is exactly what must not happen.
      const survived = [...beforePaths.keys()].every((key) => {
        const [deviceId, vniText, mac] = key.split("|") as [string, string, string];
        const device = remote.find((entry) => entry.id === deviceId);
        return device?.aliasingPathSets()
          .some((row) => row.vni === Number(vniText) && row.macAddress === mac
            && row.eligibleVteps.length > 0) === true;
      });
      const carriedBySurvivor = check.configuration.expectedSurvivingVtep === undefined
        || remote.some((device) => device.aliasingPathSets()
          .some((row) => row.selectedVtep === check.configuration.expectedSurvivingVtep));
      const passed = before.success
        && after?.success === true
        && carriedBySurvivor
        && (!check.configuration.requireNoRelearn || survived);
      return result(check, passed, `Traffic ${after?.success ? "continued" : "stopped"} after the All-Active attachment failed`, {
        beforeFailure: before.success,
        afterFailure: after?.success ?? false,
        pathsTracked: beforePaths.size,
        survivedWithoutRelearn: survived,
        carriedBySurvivor,
      });
    }
    case "evpn-customer-isolation": {
      // The underlay carries the outer IPv4/UDP only: a Spine or P device must
      // never learn a tenant MAC, and a VTEP must never import a VNI whose
      // route target it does not hold.
      const underlay = built.getDevice(check.configuration.underlayDeviceId);
      if (!underlay) return errorResult(check, "Underlay device was not found");
      const tenantVnis = new Set<number>();
      for (const device of built.devices.values()) {
        if (!(device instanceof Layer3Switch)) continue;
        for (const member of device.vxlan.members()) tenantVnis.add(member.vni);
      }
      const tenantMacs = new Set<string>();
      for (const device of built.devices.values()) {
        if (!(device instanceof Layer3Switch)) continue;
        for (const row of device.macAddressTable()) {
          if (device.vxlan.memberForVlan(row.vlan)) tenantMacs.add(normalizeMac(row.mac));
        }
      }
      const underlayMacs = underlay instanceof L2Switch
        ? underlay.macAddressTable().map((row) => normalizeMac(row.mac))
        : [];
      const leaked = underlayMacs.filter((mac) => tenantMacs.has(mac));
      const foreignImport = check.configuration.vtepDeviceId === undefined
        ? []
        : (vtepOf(built, check.configuration.vtepDeviceId)?.remoteMacEntries() ?? [])
          .filter((entry) => check.configuration.foreignVni !== undefined && entry.vni === check.configuration.foreignVni);
      const passed = leaked.length === 0 && foreignImport.length === 0;
      return result(check, passed, `Tenant Layer 2 ${passed ? "stayed inside its VNI" : "leaked into the underlay"}`, {
        underlayTenantMacs: leaked.length,
        foreignVniEntries: foreignImport.length,
        tenantVnis: tenantVnis.size,
      });
    }
    // --- M10.15 routed EVPN: anycast gateway, L3VNI and symmetric IRB -----
    // Every diagnostic below names only what the submission actually holds:
    // the expected gateway MAC, RD, route target and VNI stay in the hidden
    // spec and are never echoed back into a result.
    case "evpn-anycast-gateway": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const configured = device.isAnycastGateway(check.configuration.vlanId);
      const fabricMac = device.fabricConfiguration().anycastGatewayMac;
      const svi = device.sviSummaries().find((row) => row.vlanId === check.configuration.vlanId);
      const vrfId = device.interfaceVrf(`Vlan${check.configuration.vlanId}`);
      const matches = configured
        && (check.configuration.expectedGatewayAddress === undefined
          || svi?.ip === check.configuration.expectedGatewayAddress)
        && (check.configuration.expectedGatewayMac === undefined
          || (fabricMac !== undefined && fabricMac === normalizeMac(check.configuration.expectedGatewayMac)))
        && (check.configuration.expectedVrfId === undefined || vrfId === check.configuration.expectedVrfId);
      // A gateway is only *operational* once the fabric MAC exists and the SVI
      // is up; two leaves sharing that address is never a conflict.
      const operational = matches && fabricMac !== undefined && (svi?.operUp ?? false);
      const passed = check.configuration.expected === "absent"
        ? !configured
        : check.configuration.expected === "configured" ? matches : operational;
      return result(check, passed, `Vlan${check.configuration.vlanId} ${configured ? (operational ? "is a distributed anycast gateway" : "is an anycast gateway but is not operational") : "is not an anycast gateway"}`, {
        configured,
        fabricMacConfigured: fabricMac !== undefined,
        addressConfigured: svi?.ip !== undefined,
        operUp: svi?.operUp ?? false,
        expected: check.configuration.expected,
      });
    }
    case "evpn-l3vni": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const state = device.l3VniSummaries().find((entry) => entry.vni === check.configuration.vni);
      const vrf = state === undefined
        ? undefined
        : device.vrfConfigurations().find((entry) => entry.id === state.vrfId);
      const matches = state !== undefined
        && (check.configuration.expectedVrfId === undefined || state.vrfId === check.configuration.expectedVrfId)
        && (check.configuration.expectedRouteDistinguisher === undefined
          || vrf?.routeDistinguisher === check.configuration.expectedRouteDistinguisher)
        && (check.configuration.expectedAdvertiseEvpn === undefined
          || (vrf?.advertiseEvpn === true) === check.configuration.expectedAdvertiseEvpn);
      const passed = check.configuration.expected === "absent"
        ? state === undefined
        : check.configuration.expected === "down"
          ? state !== undefined && !state.up
          : matches && (check.configuration.expected === "configured" || state.up);
      return result(check, passed, `L3VNI ${check.configuration.vni} ${state ? (state.up ? `transports VRF ${state.vrfId}` : `is down: ${state.reason}`) : "is not associated with a VRF"}`, {
        configured: state !== undefined,
        up: state?.up ?? false,
        reason: state?.reason,
        advertiseEvpn: vrf?.advertiseEvpn === true,
        expected: check.configuration.expected,
      });
    }
    case "evpn-type5-route": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const candidates = device.evpnRoutes().filter((route) => route.type === 5
        && route.network === check.configuration.network
        && route.prefixLength === check.configuration.prefixLength);
      const route = candidates.find((entry) => entry.type === 5
        && (check.configuration.routeDistinguisher === undefined
          || entry.routeDistinguisher === check.configuration.routeDistinguisher)
        && (check.configuration.expectedL3Vni === undefined || entry.l3Vni === check.configuration.expectedL3Vni)
        && (check.configuration.expectedNextHopVtep === undefined
          || entry.nextHopVtep === check.configuration.expectedNextHopVtep)
        && (check.configuration.expectedOrigin === undefined
          || (check.configuration.expectedOrigin === "local") === (entry.source === "local")));
      const passed = check.configuration.expected === "present" ? route !== undefined : route === undefined;
      return result(check, passed, `EVPN Type 5 prefix ${check.configuration.network}/${check.configuration.prefixLength} ${route ? "is present" : "is missing"}`, {
        found: route !== undefined,
        best: route?.best,
        origin: route?.source,
        candidateCount: candidates.length,
        expected: check.configuration.expected,
      });
    }
    case "evpn-type5-imported": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      if (!device.vrfConfigurations().some((vrf) => vrf.id === check.configuration.vrfId)) {
        return errorResult(check, `VRF '${check.configuration.vrfId}' was not found`);
      }
      const entry = device.importedEvpnRoutes(check.configuration.vrfId).find((route) =>
        route.network === check.configuration.network
        && route.prefixLength === check.configuration.prefixLength
        && (check.configuration.expectedRemoteVtep === undefined
          || route.remoteVtep === check.configuration.expectedRemoteVtep)
        && (check.configuration.expectedL3Vni === undefined || route.l3Vni === check.configuration.expectedL3Vni));
      const passed = check.configuration.expected === "present" ? entry !== undefined : entry === undefined;
      return result(check, passed, `VRF ${check.configuration.vrfId} ${entry ? "installed" : "did not install"} ${check.configuration.network}/${check.configuration.prefixLength} from EVPN`, {
        found: entry !== undefined,
        importedCount: device.importedEvpnRoutes(check.configuration.vrfId).length,
        expected: check.configuration.expected,
      });
    }
    case "evpn-irb-connectivity": {
      const outcome = executePing(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      if (!outcome) return errorResult(check, `Ping-capable device '${check.configuration.sourceDeviceId}' was not found`);
      // Symmetric IRB routes at both ends, so the evidence is the L3VNI
      // encapsulation — a bridged L2VNI delivery is a different thing entirely.
      const routedEvents = outcome.trace.filter((entry) => entry.type.startsWith("evpn-"));
      const transited = routedEvents.some((entry) => entry.type === "evpn-l3vni-encapsulated");
      const reachable = outcome.success && (!check.configuration.requireL3VniTransit || transited);
      const passed = check.configuration.expected === "success" ? reachable : !reachable;
      return result(check, passed, `${outcome.source.name} ${outcome.success ? "reached" : "did not reach"} ${check.configuration.destinationIp}${transited ? " through an L3VNI" : ""}`, {
        actual: outcome.success ? "success" : "failure",
        expected: check.configuration.expected,
        l3VniTransit: transited,
        routedEvents: [...new Set(routedEvents.map((entry) => entry.type))],
        failure: outcome.failure,
      });
    }
    case "evpn-vrf-isolation": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      if (!device.vrfConfigurations().some((vrf) => vrf.id === check.configuration.vrfId)) {
        return errorResult(check, `VRF '${check.configuration.vrfId}' was not found`);
      }
      // Import is decided by route target alone: a foreign prefix may sit in
      // the EVPN RIB, but it must never become this tenant's forwarding state.
      const leaked = device.vrfRoutingTable(check.configuration.vrfId).some((route) =>
        route.network === check.configuration.foreignNetwork
        && route.prefixLength === check.configuration.foreignPrefixLength);
      const underlay = check.configuration.underlayDeviceId === undefined
        ? undefined
        : built.getDevice(check.configuration.underlayDeviceId);
      if (check.configuration.underlayDeviceId !== undefined && !underlay) {
        return errorResult(check, "Underlay device was not found");
      }
      // An underlay router carries the outer IPv4/UDP only: it holds no tenant
      // routing context and therefore no VRF at all.
      const underlayTenantRoutes = underlay instanceof Router || underlay instanceof Layer3Switch
        ? underlay.vrfConfigurations().length
        : 0;
      const passed = !leaked && underlayTenantRoutes === 0;
      return result(check, passed, `Tenant ${check.configuration.vrfId} ${passed ? "stayed isolated" : "holds a foreign prefix"}`, {
        foreignPrefixInstalled: leaked,
        underlayTenantVrfs: underlayTenantRoutes,
      });
    }
    case "evpn-remote-prefix": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      if (!device.vrfConfigurations().some((vrf) => vrf.id === check.configuration.vrfId)) {
        return errorResult(check, `VRF '${check.configuration.vrfId}' was not found`);
      }
      const route = device.vrfRoutingTable(check.configuration.vrfId).find((entry) =>
        entry.source === "evpn-type5"
        && entry.network === check.configuration.network
        && entry.prefixLength === check.configuration.prefixLength
        && (check.configuration.expectedRemoteVtep === undefined
          || entry.remoteVtep === check.configuration.expectedRemoteVtep));
      const reachable = route?.remoteVtep !== undefined
        && device.bgpRouteReachable(route.remoteVtep);
      const passed = route !== undefined && (!check.configuration.requireUnderlayReachable || reachable);
      return result(check, passed, `Remote tenant prefix ${check.configuration.network}/${check.configuration.prefixLength} ${route ? (reachable ? "is usable" : "has no underlay route to its VTEP") : "is not installed"}`, {
        found: route !== undefined,
        underlayReachable: reachable,
        l3Vni: route?.l3Vni,
      });
    }
    case "evpn-routed-overlay-operational": {
      const device = vtepOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "VXLAN tunnel endpoint was not found");
      const states = device.l3VniSummaries();
      const operational = states.filter((entry) => entry.up);
      const imported = states.reduce(
        (total, entry) => total + device.importedEvpnRoutes(entry.vrfId).length,
        0,
      );
      const originated = device.evpnRoutes()
        .filter((route) => route.type === 5 && route.source === "local").length;
      const up = operational.length > 0
        && imported >= check.configuration.minimumImportedPrefixes
        && originated >= check.configuration.minimumOriginatedPrefixes;
      const passed = check.configuration.expected === "operational" ? up : !up;
      return result(check, passed, `The routed overlay ${up ? "is operational" : "is not carrying tenant prefixes"}`, {
        l3VniCount: states.length,
        operationalL3VniCount: operational.length,
        importedPrefixCount: imported,
        originatedPrefixCount: originated,
        expected: check.configuration.expected,
      });
    }
    // --- M10.13 MP-BGP IPv6 unicast and MPLS VPNv6 ------------------------
    case "bgp-ipv6-neighbor-state": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const expected = normalizeBgpPeerAddress(check.configuration.neighborAddress);
      const neighbor = device.bgp.summaries()
        .find((entry) => normalizeBgpPeerAddress(entry.address) === expected);
      const actual = neighbor?.state ?? "idle";
      // The family must actually be negotiated: an Established session that
      // never activated IPv6 unicast is not what this check is asking about.
      const familyNegotiated = neighbor?.addressFamilies.includes("ipv6-unicast") ?? false;
      const passed = actual === check.configuration.expectedState
        && (check.configuration.expectedState !== "established" || familyNegotiated);
      return result(check, passed, `IPv6 BGP neighbor ${check.configuration.neighborAddress} is ${actual}`, {
        actualState: actual,
        expectedState: check.configuration.expectedState,
        addressFamilies: neighbor?.addressFamilies,
        lastError: neighbor?.lastError,
      });
    }
    case "bgp-ipv6-route": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const network = normalizeIpv6(check.configuration.network);
      const route = device.bgp.routes("ipv6-unicast").find((entry) => entry.best
        && normalizeIpv6(entry.network) === network
        && entry.prefixLength === check.configuration.prefixLength);
      const nextHopMatches = check.configuration.expectedNextHop === undefined
        || (route !== undefined && normalizeIpv6(route.nextHop) === normalizeIpv6(check.configuration.expectedNextHop));
      const found = route !== undefined && nextHopMatches;
      const passed = check.configuration.expected === "present" ? found : !found;
      return result(check, passed, `IPv6 BGP route ${check.configuration.network}/${check.configuration.prefixLength} ${route ? "is installed" : "is missing"}`, {
        found: route !== undefined,
        actualNextHop: route?.nextHop,
        expected: check.configuration.expected,
      });
    }
    case "bgp-ipv6-best-path": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const network = normalizeIpv6(check.configuration.network);
      const route = device.bgp.routes("ipv6-unicast").find((entry) => entry.best
        && normalizeIpv6(entry.network) === network
        && entry.prefixLength === check.configuration.prefixLength);
      const expectedNeighbor = check.configuration.expectedNeighborAddress;
      const passed = route !== undefined
        && (expectedNeighbor === undefined
          || (route.neighborAddress !== undefined
            && normalizeBgpPeerAddress(route.neighborAddress) === normalizeBgpPeerAddress(expectedNeighbor)))
        && (check.configuration.expectedAsPath === undefined
          || stableStringify(route.asPath) === stableStringify(check.configuration.expectedAsPath));
      return result(check, passed, `Best IPv6 BGP path for ${check.configuration.network}/${check.configuration.prefixLength} ${route ? `uses ${route.nextHop}` : "is missing"}`, {
        found: route !== undefined,
        nextHop: route?.nextHop,
        neighborAddress: route?.neighborAddress,
        asPath: route?.asPath,
      });
    }
    case "ipv6-prefix-list-entry": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const entry = device.bgp.routingPolicy.ipv6PrefixListConfigurations()
        .find((list) => list.id === check.configuration.prefixListId)?.entries
        .find((candidate) => candidate.sequence === check.configuration.sequence);
      const passed = entry?.action === check.configuration.expectedAction;
      return result(check, passed, `IPv6 prefix-list ${check.configuration.prefixListId} sequence ${check.configuration.sequence} is ${entry?.action ?? "missing"}`, {
        actualAction: entry?.action,
        expectedAction: check.configuration.expectedAction,
      });
    }
    case "bgp-ipv6-policy-result": {
      const device = ospfDeviceOf(built, check.configuration.deviceId);
      if (!device) return errorResult(check, "BGP-capable device was not found");
      const network = normalizeIpv6(check.configuration.network);
      const entries = check.configuration.direction === "out"
        ? device.bgp.adjRibOutEntries(check.configuration.neighborAddress, "ipv6-unicast")
        : device.bgp.adjRibInEntries(check.configuration.neighborAddress, "ipv6-unicast");
      const found = entries.some((entry) => normalizeIpv6(entry.network) === network
        && entry.prefixLength === check.configuration.prefixLength);
      const passed = found === (check.configuration.expected === "permitted");
      return result(check, passed, `IPv6 route ${check.configuration.network}/${check.configuration.prefixLength} ${found ? "passed" : "was denied by"} the ${check.configuration.direction === "out" ? "outbound" : "inbound"} policy`, {
        found,
        direction: check.configuration.direction,
        expected: check.configuration.expected,
      });
    }
    case "vpnv6-route": {
      const router = mplsRouterOf(built, check.configuration.deviceId);
      if (!router) return errorResult(check, "VPNv6 Router was not found");
      const network = normalizeIpv6(check.configuration.network);
      const route = router.bgp.vpnv6Routes().find((entry) =>
        entry.routeDistinguisher === check.configuration.routeDistinguisher
        && normalizeIpv6(entry.network) === network
        && entry.prefixLength === check.configuration.prefixLength);
      const targetMatches = check.configuration.expectedRouteTarget === undefined
        || (route?.routeTargets.includes(check.configuration.expectedRouteTarget) ?? false);
      // The observed RD, route targets and VPN label stay in diagnostics, which
      // a student result never carries.
      return result(check, route !== undefined && targetMatches, `VPNv6 route ${check.configuration.network}/${check.configuration.prefixLength} ${route ? "exists" : "is missing"}`, {
        found: route !== undefined,
        routeTargets: route?.routeTargets,
        vpnLabel: route?.vpnLabel,
        nextHop: route?.nextHop,
      });
    }
    case "vpnv6-label": {
      const router = mplsRouterOf(built, check.configuration.deviceId);
      if (!router) return errorResult(check, "VPNv6 Router was not found");
      // A label is allocated per VRF *and* address family, so an IPv4 binding
      // on the same VRF can never satisfy this check.
      const binding = router.vpnLabelBindings()
        .find((entry) => entry.vrfId === check.configuration.vrfId && entry.addressFamily === "ipv6");
      const passed = binding !== undefined
        && (check.configuration.expectedLabel === undefined || binding.label === check.configuration.expectedLabel);
      return result(check, passed, `VRF ${check.configuration.vrfId} ${binding ? "has" : "has no"} an IPv6 VPN label`, {
        found: binding !== undefined,
        actualLabel: binding?.label,
      });
    }
    case "vrf-ipv6-route": {
      const router = mplsRouterOf(built, check.configuration.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      let routes;
      try { routes = router.vrfIpv6RoutingTable(check.configuration.vrfId); } catch {
        return errorResult(check, `VRF '${check.configuration.vrfId}' was not found`);
      }
      const network = normalizeIpv6(check.configuration.network);
      const route = routes.find((entry) => normalizeIpv6(entry.network) === network
        && entry.prefixLength === check.configuration.prefixLength
        && (check.configuration.expectedSource === undefined || entry.source === check.configuration.expectedSource));
      const passed = check.configuration.expected === "present" ? route !== undefined : route === undefined;
      return result(check, passed, `VRF IPv6 route ${check.configuration.network}/${check.configuration.prefixLength} ${route ? `is ${route.source}` : "is missing"}`, {
        found: route !== undefined,
        source: route?.source,
        nextHop: route?.nextHop,
        vpnLabel: route?.vpnLabel,
      });
    }
    case "vpnv6-connectivity": {
      const execution = executeIpv6Traffic(runtime, check.configuration.sourceDeviceId, check.configuration.destinationIp);
      if (!execution) return errorResult(check, "IPv6 source device was not found");
      const passed = check.configuration.expected === "success" ? execution.success : !execution.success;
      return result(check, passed, `${check.configuration.sourceDeviceId} ${execution.success ? "reached" : "did not reach"} ${check.configuration.destinationIp} through the IPv6 VPN`, {
        actual: execution.success ? "success" : "failure",
        expected: check.configuration.expected,
        failure: execution.failure,
      });
    }
    case "overlapping-ipv6-prefix-isolation": {
      const router = mplsRouterOf(built, check.configuration.deviceId);
      if (!router) return errorResult(check, "VRF Router was not found");
      const first = router.vrfConfigurations().find((vrf) => vrf.id === check.configuration.firstVrfId);
      const second = router.vrfConfigurations().find((vrf) => vrf.id === check.configuration.secondVrfId);
      if (!first || !second) return errorResult(check, "One or both VRFs were not found");
      const network = normalizeIpv6(check.configuration.network);
      const matching = (vrfId: string) => router.vrfIpv6RoutingTable(vrfId)
        .filter((route) => normalizeIpv6(route.network) === network
          && route.prefixLength === check.configuration.prefixLength);
      const firstRoutes = matching(first.id);
      const secondRoutes = matching(second.id);
      const crossed = firstRoutes.some((route) => route.routeDistinguisher === second.routeDistinguisher)
        || secondRoutes.some((route) => route.routeDistinguisher === first.routeDistinguisher);
      const distinctPolicy = first.routeDistinguisher !== second.routeDistinguisher
        && !first.importRouteTargets.some((target) => second.exportRouteTargets.includes(target))
        && !second.importRouteTargets.some((target) => first.exportRouteTargets.includes(target));
      const passed = firstRoutes.length > 0 && secondRoutes.length > 0 && distinctPolicy && !crossed;
      return result(check, passed, `Overlapping IPv6 ${check.configuration.network}/${check.configuration.prefixLength} ${passed ? "is isolated by VRF" : "is not safely isolated"}`, {
        firstRouteCount: firstRoutes.length,
        secondRouteCount: secondRoutes.length,
        distinctPolicy,
        crossed,
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

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
import { buildLabFromDocument, parseLabDocument, type BuiltLab } from "@sim/lab-format";
import { EndHost, ipToInt, Layer3Switch, maskToInt, normalizeDnsName, Router, TcpState } from "@sim/sim-core";
import type { SimulationEngine } from "@sim/sim-core";
import type { ZodIssue } from "zod";
import { VerificationError, VerificationResourceLimitError } from "./errors";
import { DEFAULT_VERIFICATION_LIMITS, type VerificationLimits } from "./limits";
import { stableHash, stableStringify, utf8ByteLength } from "./stable";

interface InternalCheckResult extends VerificationCheckResult {
  title: string;
  visibility: "hidden" | "visible";
  diagnostics: Record<string, unknown>;
}

class VerificationRuntime {
  processedEvents = 0;
  private pingSequence = 0;

  constructor(readonly built: BuiltLab, readonly limits: VerificationLimits) {}

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

function runCheck(check: GradingCheck, runtime: VerificationRuntime): InternalCheckResult {
  const built = runtime.built;
  switch (check.type) {
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
  const runtime = new VerificationRuntime(built, limits);
  prepareDhcp(runtime, document);
  runtime.runUntil(() => built.engine.nextEventTime() === undefined);
  const internalChecks = request.gradingSpec.checks.map((check) => {
    try {
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

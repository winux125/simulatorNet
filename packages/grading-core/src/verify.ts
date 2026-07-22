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
import { ipToInt, maskToInt, Pc } from "@sim/sim-core";
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
  const clients: Pc[] = [];
  for (const node of document.topology.nodes) {
    const config = document.configurations[node.id];
    const pc = runtime.built.getPc(node.id);
    if (pc && config?.kind === "pc" && config.dhcpEnabled) {
      pc.requestDhcp();
      clients.push(pc);
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
      const source = built.getPc(check.configuration.sourceDeviceId);
      if (!source) return errorResult(check, `PC '${check.configuration.sourceDeviceId}' was not found`);
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
      const passed = actual.mode === check.configuration.expectedMode
        && (check.configuration.expectedAccessVlan === undefined || actual.accessVlan === check.configuration.expectedAccessVlan);
      return result(check, passed, `${device.name} ${check.configuration.interfaceId} is ${actual.mode} VLAN ${actual.accessVlan}`, {
        actualMode: actual.mode,
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
      const device = built.getRouter(check.configuration.deviceId);
      if (!device) return errorResult(check, "Router was not found");
      const expectedMask = maskToInt(check.configuration.prefixLength);
      const exists = device.routingTable().some((route) => route.network === check.configuration.network && route.maskInt === expectedMask);
      return result(check, exists, `Route ${check.configuration.network}/${check.configuration.prefixLength} ${exists ? "exists" : "is missing"}`, {
        exists,
        expectedNetwork: check.configuration.network,
        expectedPrefixLength: check.configuration.prefixLength,
      });
    }
    case "dhcp-address": {
      const device = built.getPc(check.configuration.deviceId);
      if (!device) return errorResult(check, "PC was not found");
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
  const internalChecks = request.gradingSpec.checks.map((check) => runCheck(check, runtime));
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

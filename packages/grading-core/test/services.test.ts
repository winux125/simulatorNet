import type { GradingSpec, LabDocument } from "@sim/contracts";
import { verifySubmission } from "@sim/grading-core";
import { createSimulationWorkerRuntime } from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import { clone, submissionFrom } from "./fixtures";

function serviceLab(): LabDocument {
  return {
    schemaVersion: 1,
    id: "service-grading",
    title: "Service grading",
    simulation: { seed: 90210 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
        { id: "server", kind: "server", name: "SRV1", interfaces: [{ id: "eth0" }] },
      ],
      links: [{ id: "direct", a: { node: "pc", iface: "eth0" }, b: { node: "server", iface: "eth0" } }],
    },
    configurations: {
      pc: {
        kind: "pc",
        hostname: "PC1",
        interfaces: [],
        ipv4: { address: "10.10.0.20", prefixLength: 24 },
        dhcpEnabled: false,
        dnsServer: "10.10.0.10",
      },
      server: {
        kind: "server",
        hostname: "SRV1",
        interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.10.0.10", prefixLength: 24 } }],
        dhcpClientEnabled: false,
        enabledServices: [
          { id: "dns", type: "dns", enabled: true, port: 53, records: [{ name: "web.lab", address: "10.10.0.10" }] },
          { id: "http", type: "http", enabled: true, port: 80, resources: [{ path: "/", contentType: "text/plain", body: "graded" }] },
          { id: "tftp", type: "tftp", enabled: true, port: 69, files: [{ filename: "answer.txt", content: "42" }] },
          { id: "ntp", type: "ntp", enabled: true, port: 123, offsetNs: 5_000 },
          { id: "syslog", type: "syslog", enabled: true, port: 514, retention: 10 },
        ],
      },
    },
  };
}

function spec(): GradingSpec {
  return {
    schemaVersion: 1,
    id: "service-checks",
    checks: [
      { id: "dns-record", title: "DNS record", type: "dns-record", points: 1, visibility: "visible", configuration: { deviceId: "server", hostname: "web.lab", expectedAddress: "10.10.0.10" } },
      { id: "dns-resolution", title: "DNS resolves", type: "dns-resolution", points: 1, visibility: "hidden", configuration: { sourceDeviceId: "pc", hostname: "web.lab", expectedAddress: "10.10.0.10" } },
      { id: "http", title: "HTTP response", type: "http-response", points: 2, visibility: "hidden", configuration: { sourceDeviceId: "pc", url: "http://10.10.0.10/", expectedStatus: 200, expectedBody: "graded" } },
      { id: "tftp", title: "TFTP file", type: "tftp-file", points: 2, visibility: "visible", configuration: { sourceDeviceId: "pc", serverIp: "10.10.0.10", filename: "answer.txt", expectedContent: "42" } },
      { id: "ntp", title: "NTP response", type: "ntp-response", points: 1, visibility: "visible", configuration: { sourceDeviceId: "pc", serverIp: "10.10.0.10", expected: "success" } },
      { id: "syslog", title: "Syslog received", type: "syslog-received", points: 1, visibility: "visible", configuration: { sourceDeviceId: "pc", serverDeviceId: "server", severity: "notice", message: "grading probe" } },
      { id: "tcp", title: "HTTP listener", type: "tcp-listener", points: 2, visibility: "visible", configuration: { deviceId: "server", port: 80 } },
    ],
  };
}

describe("deterministic service grading", () => {
  it("runs every service check through a rebuilt server runtime", () => {
    const result = verifySubmission({ submission: submissionFrom(serviceLab()), gradingSpec: spec(), resultView: "instructor" });
    expect(result.checks).toHaveLength(7);
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
    expect(result).toMatchObject({ awardedPoints: 10, maximumPoints: 10, score: 100 });
  });

  it("fails changed expected values without trusting client runtime", () => {
    const grading = spec();
    grading.checks[0]!.configuration = { deviceId: "server", hostname: "web.lab", expectedAddress: "10.10.0.99" };
    const result = verifySubmission({ submission: submissionFrom(serviceLab()), gradingSpec: grading, resultView: "instructor", score: 100 });
    expect(result.checks[0]).toMatchObject({ status: "failed", awardedPoints: 0 });
    expect(result.score).toBe(90);
  });

  it("redacts hidden service expectations from student results", () => {
    const result = verifySubmission({ submission: submissionFrom(serviceLab()), gradingSpec: spec(), resultView: "student" });
    const hidden = result.checks.find((check) => check.id === "http")!;
    expect(hidden).toMatchObject({ title: "Hidden check", message: "Hidden check passed" });
    expect(JSON.stringify(hidden)).not.toContain("graded");
    expect(hidden).not.toHaveProperty("diagnostics");
  });

  it("returns byte-identical service results for identical inputs", () => {
    const input = { submission: submissionFrom(serviceLab()), gradingSpec: spec(), resultView: "instructor" as const };
    expect(JSON.stringify(verifySubmission(input))).toBe(JSON.stringify(verifySubmission(clone(input))));
  });

  it("keeps the browser worker and rebuilt server verifier equivalent", () => {
    const document = serviceLab();
    const runtime = createSimulationWorkerRuntime();
    expect(runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "equivalence-init", document })).toMatchObject({
      type: "REQUEST_SUCCEEDED",
    });
    const browserResult = runtime.handleRequest({
      type: "EXECUTE_CLI",
      requestId: "equivalence-dns",
      sessionId: "pc",
      deviceId: "pc",
      input: "nslookup web.lab",
    });
    expect(browserResult).toMatchObject({
      type: "REQUEST_SUCCEEDED",
      payload: { output: expect.stringContaining("Address: 10.10.0.10") },
    });

    const serverResult = verifySubmission({
      submission: submissionFrom(document),
      gradingSpec: {
        schemaVersion: 1,
        id: "equivalence",
        checks: [{
          id: "dns",
          title: "DNS equivalence",
          type: "dns-resolution",
          points: 1,
          visibility: "visible",
          configuration: { sourceDeviceId: "pc", hostname: "web.lab", expectedAddress: "10.10.0.10" },
        }],
      },
      resultView: "instructor",
    });
    expect(serverResult).toMatchObject({ score: 100, checks: [{ status: "passed", awardedPoints: 1 }] });
  });

  it("returns a typed check error when a required client setting is absent", () => {
    const document = serviceLab();
    const pc = document.configurations.pc;
    if (pc?.kind === "pc") delete pc.dnsServer;
    const grading = spec();
    grading.checks = [grading.checks[1]!];
    const result = verifySubmission({ submission: submissionFrom(document), gradingSpec: grading, resultView: "instructor" });
    expect(result).toMatchObject({
      score: 0,
      checks: [{ status: "error", awardedPoints: 0, diagnostics: { reason: expect.stringContaining("DNS server") } }],
    });
  });
});

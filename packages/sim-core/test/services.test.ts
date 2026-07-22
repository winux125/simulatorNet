import type { ServerServiceConfig } from "@sim/contracts";
import {
  L2Switch,
  Pc,
  Server,
  TcpState,
  createSimulationEngine,
  macFromIndex,
  type DnsMessage,
  type HttpMessage,
  type SimulationEngine,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

interface ServiceLan {
  engine: SimulationEngine;
  pc: Pc;
  server: Server;
}

function buildServiceLan(services: ServerServiceConfig[] = [], serverIp = "192.168.40.10"): ServiceLan {
  const engine = createSimulationEngine({ seed: 1001 });
  const sw = engine.add(new L2Switch("sw", "SW1"));
  const pc = engine.add(new Pc("pc", "PC1"));
  const server = engine.add(new Server("server", "SRV1"));
  pc.addInterface("eth0", macFromIndex(1));
  pc.configure({ ip: "192.168.40.20", mask: 24, gateway: "192.168.40.1", dnsServer: serverIp });
  server.addInterface("eth0", macFromIndex(2));
  server.configure({ ip: serverIp, mask: 24, gateway: "192.168.40.1" });
  sw.addInterface("Gi0/1", macFromIndex(101));
  sw.addInterface("Gi0/2", macFromIndex(102));
  engine.connect(pc.id, "eth0", sw.id, "Gi0/1");
  engine.connect(server.id, "eth0", sw.id, "Gi0/2");
  server.configureServices(services);
  return { engine, pc, server };
}

const dns = (records = [{ name: "www.example.test", address: "192.168.40.10" }]): ServerServiceConfig => ({
  id: "dns-main",
  type: "dns",
  enabled: true,
  port: 53,
  records,
});

const http = (resources = [{ path: "/", contentType: "text/plain", body: "hello" }]): ServerServiceConfig => ({
  id: "http-main",
  type: "http",
  enabled: true,
  port: 80,
  resources,
});

const tftp = (files = [{ filename: "startup.cfg", content: "hostname R1" }]): ServerServiceConfig => ({
  id: "tftp-main",
  type: "tftp",
  enabled: true,
  port: 69,
  files,
});

const ntp = (offsetNs = 5_000_000_000): ServerServiceConfig => ({
  id: "ntp-main",
  type: "ntp",
  enabled: true,
  port: 123,
  offsetNs,
});

const syslog = (retention = 200): ServerServiceConfig => ({
  id: "syslog-main",
  type: "syslog",
  enabled: true,
  port: 514,
  retention,
});

describe("server service lifecycle", () => {
  it("starts with an empty service registry", () => {
    const { server } = buildServiceLan();
    expect(server.listServices()).toEqual([]);
  });

  it("keeps a disabled service unbound", () => {
    const config = { ...dns(), enabled: false };
    const { engine, server } = buildServiceLan([config]);
    engine.runUntilIdle();
    expect(server.listServices()).toEqual([expect.objectContaining({ state: "disabled", enabled: false })]);
    expect(server.transport.udp.inspect()).toEqual([]);
  });

  it("moves an enabled service from starting to listening on virtual time", () => {
    const { engine, server } = buildServiceLan([dns()]);
    expect(server.listServices()[0]).toMatchObject({ state: "starting" });
    engine.runUntilIdle();
    expect(server.listServices()[0]).toMatchObject({ state: "listening", listeningPort: 53 });
  });

  it("enables and disables a configured service without wall-clock work", () => {
    const { engine, server } = buildServiceLan([{ ...http(), enabled: false }]);
    server.enableService("http-main");
    engine.runUntilIdle();
    expect(server.listServices()[0]?.state).toBe("listening");
    server.disableService("http-main");
    expect(server.listServices()[0]?.state).toBe("disabled");
    expect(server.transport.tcp.inspect()).toEqual([]);
  });

  it("surfaces a deterministic error for conflicting service ports", () => {
    const second = { ...dns(), id: "dns-secondary" };
    const { engine, server } = buildServiceLan([dns(), second]);
    engine.runUntilIdle();
    expect(server.listServices().map((entry) => entry.state).sort()).toEqual(["error", "listening"]);
    expect(server.transport.udp.inspect()).toHaveLength(1);
  });

  it("reports an error when an enabled service has no IPv4 address", () => {
    const { engine, server } = buildServiceLan([], "192.168.40.10");
    server.setDhcpEnabled(true);
    server.configureServices([dns()]);
    engine.runUntilIdle();
    expect(server.listServices()[0]).toMatchObject({ state: "error", error: "Service requires a configured IPv4 address" });
  });
});

describe("DNS over UDP", () => {
  it("resolves an A record case-insensitively", () => {
    const { engine, pc } = buildServiceLan([dns([{ name: "WWW.Example.Test.", address: "192.168.40.10" }])]);
    engine.runUntilIdle();
    pc.applications.resolveDns("www.EXAMPLE.test");
    engine.runUntilIdle();
    expect(pc.applications.dnsResults.at(-1)).toMatchObject({ status: "success", address: "192.168.40.10" });
  });

  it("returns NXDOMAIN for an absent record", () => {
    const { engine, pc } = buildServiceLan([dns()]);
    engine.runUntilIdle();
    pc.applications.resolveDns("missing.example.test");
    engine.runUntilIdle();
    expect(pc.applications.dnsResults.at(-1)).toMatchObject({ status: "nxdomain" });
  });

  it("returns FORMERR for a malformed query name", () => {
    const { engine, pc, server } = buildServiceLan([dns()]);
    engine.runUntilIdle();
    let response: DnsMessage | undefined;
    const port = pc.bindUdp(0, (received) => {
      if (received.payload.kind === "dns") response = received.payload;
    });
    pc.sendUdp({
      destinationAddress: server.ip!,
      destinationPort: 53,
      sourcePort: port,
      payload: { kind: "dns", messageType: "query", transactionId: 99, name: "bad name" },
    });
    engine.runUntilIdle();
    expect(response).toMatchObject({ responseCode: "FORMERR", transactionId: 99 });
  });

  it("serves multiple stable canonical records", () => {
    const { engine, pc, server } = buildServiceLan([dns([
      { name: "z.example", address: "192.168.40.12" },
      { name: "a.example", address: "192.168.40.11" },
    ])]);
    engine.runUntilIdle();
    expect(server.services.configurations()[0]).toMatchObject({ records: [{ name: "a.example" }, { name: "z.example" }] });
    pc.applications.resolveDns("z.example");
    engine.runUntilIdle();
    expect(pc.applications.dnsResults.at(-1)?.address).toBe("192.168.40.12");
  });

  it("times out with one bounded retry when no DNS server answers", () => {
    const { engine, pc } = buildServiceLan();
    pc.applications.setDnsServer("192.168.40.250");
    engine.enableTrace();
    pc.applications.resolveDns("www.example.test");
    engine.runUntilIdle();
    expect(pc.applications.dnsResults.at(-1)?.status).toBe("timeout");
    expect(engine.traceLog.filter((entry) => entry.type === "dns-query")).toHaveLength(2);
  });
});

describe("HTTP over TCP", () => {
  it("returns a deterministic 200 response to GET", () => {
    const { engine, pc, server } = buildServiceLan([http()]);
    engine.runUntilIdle();
    pc.applications.httpGet(`http://${server.ip}/`);
    engine.runUntilIdle();
    expect(pc.applications.httpResults.at(-1)).toMatchObject({ status: "completed", statusCode: 200, body: "hello" });
  });

  it("returns headers without a body to HEAD", () => {
    const { engine, pc, server } = buildServiceLan([http()]);
    engine.runUntilIdle();
    pc.applications.httpGet(`http://${server.ip}/`, "HEAD");
    engine.runUntilIdle();
    expect(pc.applications.httpResults.at(-1)).toMatchObject({ statusCode: 200, body: undefined });
    expect(pc.applications.httpResults.at(-1)?.headers?.["content-length"]).toBe("5");
  });

  it("returns 404 for a missing path", () => {
    const { engine, pc, server } = buildServiceLan([http()]);
    engine.runUntilIdle();
    pc.applications.httpGet(`http://${server.ip}/missing`);
    engine.runUntilIdle();
    expect(pc.applications.httpResults.at(-1)).toMatchObject({ statusCode: 404, body: "Not Found" });
  });

  it("returns 400 for a malformed structured request", () => {
    const { engine, pc, server } = buildServiceLan([http()]);
    engine.runUntilIdle();
    let response: HttpMessage | undefined;
    pc.connectTcp(server.ip!, 80, {
      onEstablished: (connection) => connection.send({ kind: "http", messageType: "request" }),
      onMessage: (payload) => { if (payload.kind === "http") response = payload; },
    });
    engine.runUntilIdle();
    expect(response).toMatchObject({ status: 400 });
  });

  it("supports a configured non-default listening port", () => {
    const custom = { ...http(), port: 8080 };
    const { engine, pc, server } = buildServiceLan([custom]);
    engine.runUntilIdle();
    pc.applications.httpGet(`http://${server.ip}:8080/`);
    engine.runUntilIdle();
    expect(pc.applications.httpResults.at(-1)?.statusCode).toBe(200);
  });

  it("serves canonical path-specific content types", () => {
    const { engine, pc, server } = buildServiceLan([http([
      { path: "/z", contentType: "text/plain", body: "z" },
      { path: "/api", contentType: "application/json", body: "{}" },
    ])]);
    engine.runUntilIdle();
    pc.applications.httpGet(`http://${server.ip}/api`);
    engine.runUntilIdle();
    expect(pc.applications.httpResults.at(-1)).toMatchObject({ statusCode: 200, body: "{}" });
    expect(pc.applications.httpResults.at(-1)?.headers?.["content-type"]).toBe("application/json");
  });

  it("closes request connections gracefully after one response", () => {
    const { engine, pc, server } = buildServiceLan([http()]);
    engine.runUntilIdle();
    pc.applications.httpGet(`http://${server.ip}/`);
    engine.runUntilIdle();
    expect(pc.transport.tcp.inspect()).toEqual([]);
    expect(server.transport.tcp.inspect().filter((row) => row.state !== TcpState.Listen)).toEqual([]);
  });
});

describe("TFTP over UDP", () => {
  it("downloads a small runtime-only file", () => {
    const { engine, pc, server } = buildServiceLan([tftp()]);
    engine.runUntilIdle();
    pc.applications.tftpGet(server.ip!, "startup.cfg");
    engine.runUntilIdle();
    expect(pc.applications.tftpResults.at(-1)).toMatchObject({ status: "completed", content: "hostname R1" });
    expect(pc.applications.downloadedFiles.get("startup.cfg")).toBe("hostname R1");
  });

  it("transfers multiple acknowledged blocks in order", () => {
    const content = "a".repeat(1_200);
    const { engine, pc, server } = buildServiceLan([tftp([{ filename: "large.txt", content }])]);
    engine.runUntilIdle();
    pc.applications.tftpGet(server.ip!, "large.txt");
    engine.runUntilIdle();
    expect(pc.applications.downloadedFiles.get("large.txt")).toBe(content);
  });

  it("terminates exact-block-size files with a final empty block", () => {
    const content = "x".repeat(512);
    const { engine, pc, server } = buildServiceLan([tftp([{ filename: "exact.bin", content }])]);
    engine.enableTrace();
    engine.runUntilIdle();
    pc.applications.tftpGet(server.ip!, "exact.bin");
    engine.runUntilIdle();
    expect(pc.applications.downloadedFiles.get("exact.bin")).toBe(content);
    expect(engine.traceLog.some((entry) => entry.type === "tftp-service-block" && entry.detail?.final === true)).toBe(true);
  });

  it("returns a typed not-found result", () => {
    const { engine, pc, server } = buildServiceLan([tftp()]);
    engine.runUntilIdle();
    pc.applications.tftpGet(server.ip!, "missing.cfg");
    engine.runUntilIdle();
    expect(pc.applications.tftpResults.at(-1)).toMatchObject({ status: "not-found", message: "File not found" });
  });

  it("normalizes configured and requested filenames", () => {
    const { engine, pc, server } = buildServiceLan([tftp([{ filename: "BACKUP.CFG", content: "ok" }])]);
    engine.runUntilIdle();
    pc.applications.tftpGet(server.ip!, "Backup.Cfg");
    engine.runUntilIdle();
    expect(pc.applications.downloadedFiles.get("backup.cfg")).toBe("ok");
  });

  it("reports completed transfers separately from configuration", () => {
    const { engine, pc, server } = buildServiceLan([tftp()]);
    engine.runUntilIdle();
    pc.applications.tftpGet(server.ip!, "startup.cfg");
    engine.runUntilIdle();
    expect(server.serviceRuntimeSnapshot().tftp).toEqual({ activeTransfers: 0, completedTransfers: 1 });
    expect(server.services.configurations()[0]).not.toHaveProperty("completedTransfers");
  });
});

describe("NTP over UDP", () => {
  it("derives server time exclusively from virtual time and configured offset", () => {
    const { engine, pc, server } = buildServiceLan([ntp(9_000)]);
    engine.enableTrace();
    engine.runUntilIdle();
    pc.applications.queryNtp(server.ip!);
    engine.runUntilIdle();
    const trace = engine.traceLog.find((entry) => entry.type === "ntp-service-query")!;
    expect(trace.detail?.serverTimeNs).toBe(trace.time + 9_000);
  });

  it("updates the querying host's deterministic clock offset", () => {
    const { engine, pc, server } = buildServiceLan([ntp(1_000_000)]);
    engine.runUntilIdle();
    pc.applications.queryNtp(server.ip!);
    engine.runUntilIdle();
    expect(pc.applications.ntpResults.at(-1)?.status).toBe("completed");
    expect(pc.applications.clockNow()).toBe(engine.now() + pc.applications.clockOffsetNs);
  });

  it("times out without consulting the host wall clock", () => {
    const { engine, pc } = buildServiceLan();
    pc.applications.queryNtp("192.168.40.250");
    engine.runUntilIdle();
    expect(pc.applications.ntpResults.at(-1)).toMatchObject({ status: "timeout" });
  });
});

describe("Syslog over UDP", () => {
  it("retains structured source, severity, facility and virtual timestamps", () => {
    const { engine, pc, server } = buildServiceLan([syslog()]);
    engine.runUntilIdle();
    pc.applications.sendSyslog(server.ip!, "warning", "link changed", "local0");
    engine.runUntilIdle();
    expect(server.serviceRuntimeSnapshot().syslog.entries[0]).toMatchObject({
      source: "PC1",
      sourceAddress: "192.168.40.20",
      severity: "warning",
      facility: "local0",
      message: "link changed",
    });
  });

  it("evicts oldest entries at the configured retention bound", () => {
    const { engine, pc, server } = buildServiceLan([syslog(2)]);
    engine.runUntilIdle();
    for (const message of ["one", "two", "three"]) pc.applications.sendSyslog(server.ip!, "informational", message);
    engine.runUntilIdle();
    expect(server.serviceRuntimeSnapshot().syslog.entries.map((entry) => entry.message)).toEqual(["two", "three"]);
  });

  it("clears runtime entries without changing persistent service configuration", () => {
    const { engine, pc, server } = buildServiceLan([syslog()]);
    engine.runUntilIdle();
    pc.applications.sendSyslog(server.ip!, "error", "failure");
    engine.runUntilIdle();
    server.services.clearSyslog();
    expect(server.serviceRuntimeSnapshot().syslog.entries).toEqual([]);
    expect(server.services.configurations()).toHaveLength(1);
  });

  it("produces a deterministic bounded runtime snapshot", () => {
    const run = () => {
      const { engine, pc, server } = buildServiceLan([syslog(3)]);
      engine.runUntilIdle();
      pc.applications.sendSyslog(server.ip!, "notice", "ready");
      engine.runUntilIdle();
      return server.serviceRuntimeSnapshot();
    };
    expect(run()).toEqual(run());
  });
});

describe("service safety limits", () => {
  it("rejects more than sixteen services", () => {
    const { server } = buildServiceLan();
    const services = Array.from({ length: 17 }, (_, index): ServerServiceConfig => ({
      id: `ntp-${index}`,
      type: "ntp",
      enabled: false,
      port: 1_000 + index,
      offsetNs: 0,
    }));
    expect(() => server.configureServices(services)).toThrow(/service limit exceeded/);
  });

  it("rejects HTTP bodies beyond the configured byte bound", () => {
    const { server } = buildServiceLan();
    expect(() => server.configureService(http([{ path: "/", contentType: "text/plain", body: "x".repeat(65_537) }]))).toThrow();
  });
});

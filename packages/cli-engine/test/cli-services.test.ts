import { createCliSession } from "@sim/cli-engine";
import { L2Switch, Pc, Server, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { beforeEach, describe, expect, it } from "vitest";

describe("transport and service CLI", () => {
  const setup = () => {
    const engine = createSimulationEngine({ seed: 77 });
    const sw = engine.add(new L2Switch("sw", "SW1"));
    const pc = engine.add(new Pc("pc", "PC1"));
    const server = engine.add(new Server("server", "SRV1"));
    pc.addInterface("eth0", macFromIndex(1));
    pc.configure({ ip: "10.0.0.20", mask: 24, dnsServer: "10.0.0.10" });
    server.addInterface("eth0", macFromIndex(2));
    server.configure({ ip: "10.0.0.10", mask: 24 });
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    engine.connect(pc.id, "eth0", sw.id, "Gi0/1");
    engine.connect(server.id, "eth0", sw.id, "Gi0/2");
    server.configureServices([
      { id: "dns", type: "dns", enabled: true, port: 53, records: [{ name: "web.lab", address: "10.0.0.10" }] },
      { id: "http", type: "http", enabled: true, port: 80, resources: [{ path: "/", contentType: "text/plain", body: "SimulatorNet" }] },
      { id: "tftp", type: "tftp", enabled: true, port: 69, files: [{ filename: "backup.cfg", content: "hostname R1" }] },
      { id: "ntp", type: "ntp", enabled: true, port: 123, offsetNs: 1_000 },
      { id: "syslog", type: "syslog", enabled: true, port: 514, retention: 10 },
    ]);
    engine.runUntilIdle();
    return { engine, pc, server, pcCli: createCliSession(pc, engine), serverCli: createCliSession(server, engine) };
  };

  let lab: ReturnType<typeof setup>;
  beforeEach(() => { lab = setup(); });

  it("resolves DNS with nslookup and configured resolver", () => {
    expect(lab.pcCli.execute("nslookup web.lab")).toContain("Address: 10.0.0.10");
  });

  it("reports DNS NXDOMAIN", () => {
    expect(lab.pcCli.execute("nslookup missing.lab")).toContain("NXDOMAIN");
  });

  it("gets an HTTP resource", () => {
    expect(lab.pcCli.execute("http get http://10.0.0.10/")).toContain("HTTP/1.1 200");
    expect(lab.pcCli.execute("http get http://10.0.0.10/")).toContain("SimulatorNet");
  });

  it("downloads a TFTP file into transient host storage", () => {
    expect(lab.pcCli.execute("tftp get 10.0.0.10 backup.cfg")).toBe("Received 11 bytes as backup.cfg");
    expect(lab.pc.applications.downloadedFiles.get("backup.cfg")).toBe("hostname R1");
  });

  it("queries NTP and shows a virtual clock", () => {
    expect(lab.pcCli.execute("ntp query 10.0.0.10")).toContain("NTP server time:");
    expect(lab.pcCli.execute("show clock")).toContain("ns (virtual)");
  });

  it("sends and inspects structured Syslog", () => {
    expect(lab.pcCli.execute("syslog send 10.0.0.10 warning link down")).toContain("message sent");
    expect(lab.serverCli.execute("show syslog")).toContain("link down");
  });

  it("shows server service state and persistent content", () => {
    expect(lab.serverCli.execute("show services")).toContain("dns");
    expect(lab.serverCli.execute("show dns")).toContain("web.lab");
    expect(lab.serverCli.execute("show http")).toContain("text/plain");
    expect(lab.serverCli.execute("show tftp")).toContain("backup.cfg");
  });

  it("shows UDP sockets and TCP listeners", () => {
    expect(lab.serverCli.execute("show udp sockets")).toContain("dns");
    expect(lab.serverCli.execute("show tcp connections")).toContain("LISTEN");
  });

  it("renders contextual application help", () => {
    expect(lab.pcCli.execute("?")).toContain("nslookup");
    expect(lab.pcCli.execute("nslookup ?")).toContain("<hostname>");
    expect(lab.pcCli.execute("http get ?")).toContain("<url>");
    expect(lab.serverCli.execute("show ?")).toContain("services");
  });

  it("distinguishes incomplete and validation errors", () => {
    expect(lab.pcCli.execute("tftp get")).toContain("% Incomplete command.");
    expect(lab.pcCli.execute("syslog send 10.0.0.10 banana message")).toContain("Syslog severity must be");
  });
});

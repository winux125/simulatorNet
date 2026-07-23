import { allCommands, createCliSession } from "@sim/cli-engine";
import { getDeviceProfile } from "@sim/contracts";
import {
  EthernetBridge,
  Hub,
  L2Switch,
  Layer3Switch,
  Pc,
  Router,
  Server,
  createSimulationEngine,
  macFromIndex,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function routerCli() {
  const engine = createSimulationEngine({ seed: 101 });
  const router = engine.add(new Router("r1", "R1"));
  router.addInterface("Gi0/0", macFromIndex(1));
  router.addInterface("Gi0/1", macFromIndex(2));
  return { engine, router, cli: createCliSession(router, engine) };
}

function switchCli(layer3 = false) {
  const engine = createSimulationEngine({ seed: 102 });
  const sw = layer3
    ? engine.add(new Layer3Switch("sw1", "SW1"))
    : engine.add(new L2Switch("sw1", "SW1"));
  sw.addInterface("Gi0/1", macFromIndex(11));
  sw.addInterface("Gi0/2", macFromIndex(12));
  return { engine, sw, cli: createCliSession(sw, engine) };
}

function hostCli(server = false) {
  const engine = createSimulationEngine({ seed: 103 });
  const host = server
    ? engine.add(new Server("server", "SRV1"))
    : engine.add(new Pc("pc", "PC1"));
  host.addInterface("eth0", macFromIndex(21));
  host.configure({ ip: "192.0.2.10", mask: 24, gateway: "192.0.2.1", dnsServer: "192.0.2.53" });
  return { engine, host, cli: createCliSession(host, engine) };
}

describe("M10.2.1 device command profiles", () => {
  it("assigns distinct PC and Server CLI profiles", () => {
    expect(getDeviceProfile("pc").cliProfile).toBe("pc-host");
    expect(getDeviceProfile("server").cliProfile).toBe("server-host");
  });

  it("uses a host-style PC command prompt", () => {
    expect(hostCli().cli.prompt()).toBe("C:\\>");
  });

  it("uses a named host prompt for Server", () => {
    expect(hostCli(true).cli.prompt()).toBe("SRV1>");
  });

  it("keeps IOS-like prompts on Router", () => {
    const { cli } = routerCli();
    expect(cli.prompt()).toBe("R1>");
    cli.execute("enable");
    expect(cli.prompt()).toBe("R1#");
  });

  it("rejects interactive CLI creation for Hub", () => {
    const engine = createSimulationEngine({ seed: 104 });
    const hub = engine.add(new Hub("hub", "Hub1"));
    expect(() => createCliSession(hub, engine)).toThrow("has no CLI profile");
  });

  it("shows only host-facing roots on PC", () => {
    const help = hostCli().cli.execute("?");
    expect(help).toContain("ipconfig");
    expect(help).toContain("tracert");
    expect(help).toContain("netstat");
    expect(help).toContain("nslookup");
    expect(help).not.toContain("configure");
    expect(help).not.toContain("enable");
  });

  it("keeps switch configuration commands out of Server help", () => {
    const help = hostCli(true).cli.execute("help");
    expect(help).toContain("ipconfig");
    expect(help).toContain("sim");
    expect(help).not.toContain("switchport");
    expect(help).not.toContain("configure");
    expect(help).not.toContain("vlan");
  });

  it("marks SimulatorNet service commands as extensions", () => {
    const help = hostCli().cli.execute("?");
    expect(help).toContain("sim");
    expect(help).toContain("SimulatorNet extensions (non-IOS)");
    expect(help).not.toContain("\n  http");
  });

  it("keeps the Bridge profile to managed bridge commands", () => {
    const engine = createSimulationEngine({ seed: 105 });
    const bridge = engine.add(new EthernetBridge("bridge", "BR1"));
    bridge.addInterface("Eth0/1", macFromIndex(31));
    bridge.addInterface("Eth0/2", macFromIndex(32));
    const cli = createCliSession(bridge, engine);
    expect(cli.execute("?")).toContain("show");
    cli.execute("enable");
    cli.execute("configure terminal");
    expect(cli.execute("?")).not.toContain("vlan");
    expect(cli.execute("?")).not.toContain("ipconfig");
  });

  it("omits routing commands from the L2 Switch profile", () => {
    const { cli } = switchCli();
    expect(cli.execute("?")).not.toContain("ping");
    cli.execute("enable");
    expect(cli.execute("show ?")).not.toContain("ip route");
  });

  it("exposes routing and VLAN commands on the L3 Switch profile", () => {
    const { cli } = switchCli(true);
    expect(cli.execute("?")).toContain("ping");
    cli.execute("enable");
    expect(cli.execute("show ?")).toContain("ip route");
    cli.execute("configure terminal");
    expect(cli.execute("?")).toContain("vlan");
  });

  it("accepts the unique abbreviation conf t case-insensitively", () => {
    const { cli } = routerCli();
    cli.execute("EN");
    expect(cli.execute("CoNf T")).toBe("");
    expect(cli.prompt()).toBe("R1(config)#");
  });

  it("accepts show run", () => {
    const { cli } = routerCli();
    expect(cli.execute("show run")).toContain("hostname R1");
  });

  it("accepts show ip int br", () => {
    const { cli } = routerCli();
    expect(cli.execute("show ip int br")).toContain("Interface");
  });

  it("accepts int gi0/1", () => {
    const { cli } = routerCli();
    cli.execute("en");
    cli.execute("conf t");
    expect(cli.execute("int gi0/1")).toBe("");
    expect(cli.prompt()).toBe("R1(config-if)#");
  });

  it("accepts shut and no shut", () => {
    const { router, cli } = routerCli();
    cli.execute("en");
    cli.execute("conf t");
    cli.execute("int gi0/1");
    expect(cli.execute("shut")).toBe("");
    expect(router.getInterface("Gi0/1")?.adminUp).toBe(false);
    expect(cli.execute("no shut")).toBe("");
    expect(router.getInterface("Gi0/1")?.adminUp).toBe(true);
  });

  it("rejects an ambiguous abbreviation without guessing", () => {
    const { cli } = switchCli(true);
    cli.execute("en");
    cli.execute("conf t");
    cli.execute("int gi0/1");
    expect(cli.execute("no s")).toBe('% Ambiguous command: "no s"');
    expect(hostCli().cli.execute("n")).toBe('% Ambiguous command: "n"');
  });

  it("does not fuzzy-match misspelled commands", () => {
    expect(routerCli().cli.execute("shwo run")).toBe("^\n% Invalid input detected at '^' marker.");
  });

  it("keeps contextual help mode and prefix aware", () => {
    const { cli } = routerCli();
    expect(cli.execute("show ?")).toContain("ip interface brief");
    expect(cli.execute("ping ?")).toContain("<destination-ip>");
    expect(cli.execute("show i ?")).toBe('% Ambiguous command: "show i"');
  });

  it("prompts Router and L3 Switch for a bare ping target", () => {
    for (const cli of [routerCli().cli, switchCli(true).cli]) {
      expect(cli.execute("ping")).toBe("");
      expect(cli.prompt()).toBe("Target IP address:");
      expect(cli.execute("203.0.113.10")).toMatch(/Success rate is|% .*no route/);
      expect(cli.prompt()).not.toBe("Target IP address:");
    }
  });

  it("reports a bare PC ping as incomplete", () => {
    expect(hostCli().cli.execute("ping")).toBe("% Incomplete command.\nUsage: ping <ip-or-hostname>");
  });

  it("produces Cisco-like output for a direct Router ping", () => {
    const { engine, router, cli } = routerCli();
    router.getOrCreateInterface("Gi0/0");
    router.setInterfaceIp("Gi0/0", "192.0.2.1", "255.255.255.0");
    const pc = engine.add(new Pc("target", "Target"));
    pc.addInterface("eth0", macFromIndex(41));
    pc.configure({ ip: "192.0.2.2", mask: 24 });
    engine.connect(router.id, "Gi0/0", pc.id, "eth0");
    expect(cli.execute("ping 192.0.2.2")).toContain("!!!!!");
    expect(cli.execute("ping 192.0.2.2")).toContain("Success rate is 100 percent (5/5)");
  });

  it("supports Windows-like ipconfig variants", () => {
    const { host, cli } = hostCli();
    expect(cli.execute("ipconfig /all")).toContain("Host Name");
    expect(cli.execute("ipconfig /all")).toContain("DHCP Enabled");
    expect(cli.execute("ipconfig /release")).toContain("successfully released");
    expect(host.ip).toBeUndefined();
    expect(cli.execute("ipconfig /renew")).toContain("Windows IP Configuration");
  });

  it("supports host diagnostic commands", () => {
    const { cli } = hostCli();
    expect(cli.execute("arp -a")).toContain("Address");
    expect(cli.execute("netstat")).toContain("Active Connections");
    expect(cli.execute("tracert 192.0.2.99")).toContain("Trace complete.");
    expect(cli.execute("nslookup ?")).toContain("<hostname>");
  });

  it("omits unsupported IOS lifecycle commands", () => {
    const { cli } = routerCli();
    expect(cli.execute("show ?")).not.toContain("startup-config");
    expect(cli.execute("copy running-config startup-config")).toContain("% Invalid input");
    expect(cli.execute("reload")).toContain("% Invalid input");
  });

  it("returns a typed interface-not-found error", () => {
    const { cli } = routerCli();
    cli.execute("enable");
    cli.execute("configure terminal");
    expect(cli.execute("interface Gi9/9")).toBe("% Interface not found.");
  });

  it("keeps the documented compatibility commands aligned with the registry", () => {
    const patterns = new Set(allCommands.map((command) => command.pattern));
    for (const documented of [
      "configure terminal",
      "interface {spec...}",
      "shutdown",
      "no shutdown",
      "ip address {ip} {mask}",
      "ip route {network} {mask} {nexthop}",
      "switchport access vlan {id}",
      "show running-config",
      "show ip interface brief",
      "show mac address-table",
      "ping {target}",
      "ipconfig /all",
      "ipconfig /renew",
      "ipconfig /release",
      "tracert {target}",
      "arp -a",
      "nslookup {hostname}",
      "netstat",
      "sim http get {url}",
      "sim show services",
    ]) expect(patterns, documented).toContain(documented);
    for (const unsupported of [
      "show startup-config",
      "copy running-config startup-config",
      "write memory",
      "reload",
      "no ip address",
      "no ip route",
    ]) expect(patterns, unsupported).not.toContain(unsupported);
  });
});

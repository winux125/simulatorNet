import { createCliSession } from "@sim/cli-engine";
import { Router, L2Switch, Layer3Switch, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { describe, expect, it } from "vitest";
import { createTestConfigurationService } from "./helpers/configuration";

function setup(kind: "router" | "switch" | "l3" = "router") {
  const engine = createSimulationEngine({ seed: 175 });
  const device = engine.add(kind === "router" ? new Router("d", "Router")
    : kind === "switch" ? new L2Switch("d", "Switch") : new Layer3Switch("d", "Switch"));
  const names = kind === "router" ? ["Gi0/0", "Gi0/1"] : ["Fa0/1", "Fa0/2", "Fa0/3", "Fa0/4", "Gi0/1"];
  names.forEach((name, i) => device.addInterface(name, macFromIndex(i + 1)));
  const cli = createCliSession(device, engine);
  cli.useConfigurationService(createTestConfigurationService(device));
  return { engine, device, cli };
}

describe("IOS compatibility corpus", () => {
  it.each([
    ["exec", "en", "enable", "privileged", ""],
    ["privileged", "conf t", "configure terminal", "config", ""],
    ["privileged", "sh ip int br", "show ip interface brief", "privileged", "Interface"],
    ["privileged", "sh run", "show running-config", "privileged", "hostname Router"],
    ["privileged", "sh start", "show startup-config", "privileged", "hostname Router"],
    ["privileged", "co t", undefined, "privileged", '% Ambiguous command: "co t"'],
    ["config", "interface", "interface", "config", "% Incomplete command."],
    ["privileged", "show ip something-invalid", undefined, "privileged", "        ^\n% Invalid input"],
  ] as const)("%s: %s", (mode, input, canonical, after, output) => {
    const { cli } = setup();
    cli.enter(mode);
    const result = cli.execute(input);
    expect(cli.resolvedCommand).toBe(canonical);
    expect(cli.mode).toBe(after);
    expect(result).toContain(output);
  });

  it("uses the same capability and mode filtered tree for help and completion", () => {
    const { cli } = setup();
    expect(cli.execute("sh?")).toBe("  show");
    expect(cli.execute("show ?")).toContain("  ip");
    expect(cli.execute("show ip ?")).toContain("  interface");
    expect(cli.complete("conf").input).toBe("conf"); // unavailable in user EXEC
    cli.enter("privileged");
    expect(cli.complete("conf").input).toBe("configure");
    expect(cli.complete("show ip int").input).toBe("show ip interface");
    expect(cli.complete("co").candidates.sort()).toEqual(["configure", "copy"]);
    expect(cli.complete("co").input).toBe("co");
    expect(cli.execute("c")).toContain("Ambiguous");
    expect(cli.execute("co")).toContain("Ambiguous");
    cli.enter("config");
    expect(cli.execute("interface ?")).toContain("Gi0/0");
    expect(cli.execute("?")).not.toContain("switchport");
    cli.execute("interface Gi0/0");
    expect(cli.execute("sh")).toBe(""); // only shutdown in this mode
    expect(cli.resolvedCommand).toBe("shutdown");
    const l3 = setup("l3").cli;
    l3.enter("config"); l3.execute("int Gi0/1");
    expect(l3.execute("?")).not.toContain("encapsulation");
    expect(l3.complete("enc").candidates).toEqual([]);
  });
});

describe("IOS configuration compatibility", () => {
  it.each([
    ["router", "Gi0/0", ["GigabitEthernet0/0", "Gig0/0", "Gi0/0", "G0/0"]],
    ["switch", "Fa0/1", ["FastEthernet0/1", "Fast0/1", "Fa0/1", "F0/1"]],
    ["router", "Loopback0", ["Loopback0", "Lo0"]],
    ["switch", "Vlan10", ["Vlan10", "Vl10", "vlan 10"]],
  ] as const)("normalizes %s interface %s", (kind, canonical, aliases) => {
    const { cli } = setup(kind);
    for (const alias of aliases) {
      cli.enter("config");
      expect(cli.execute("int " + alias.toUpperCase())).toBe("");
      expect(cli.ifaceCtx?.physical).toBe(canonical);
    }
    cli.enter("config");
    for (const absent of ["g99/99", "g0/2", "s0/0/0"]) {
      expect(cli.execute("int " + absent)).toContain("Interface not found");
      expect(cli.mode).toBe("config");
    }
  });

  it("resolves existing Serial, Port-channel and NVE without manufacturing Serial", () => {
    const { device, cli } = setup();
    device.addInterface("Serial0/0/0", macFromIndex(20));
    for (const alias of ["Serial0/0/0", "Ser0/0/0", "S0/0/0"]) {
      cli.enter("config"); expect(cli.execute("int " + alias)).toBe("");
      expect(cli.ifaceCtx?.physical).toBe("Serial0/0/0");
    }
    const sw = setup("l3").cli;
    sw.transcript(["en", "conf t", "int gi0/1", "channel-group 10 mode on", "exit", "int Po10"]);
    expect(sw.ifaceCtx?.physical).toBe("Port-channel10");
    sw.enter("config"); expect(sw.execute("int Nve1")).toBe("");
    expect(sw.mode).toBe("config-nve");
  });

  it.each([
    ["router", ["int g0/0", "desc LAN", "no desc"], "description LAN"],
    ["router", ["int g0/0", "ip add 192.168.1.1 255.255.255.0", "no ip add"], "ip address 192.168.1.1"],
    ["router", ["int g0/0", "ipv6 add 2001:db8::1/64", "no ipv6 add"], "ipv6 address 2001:db8::1"],
    ["router", ["ip ro 0.0.0.0 0.0.0.0 10.0.0.1", "no ip ro 0.0.0.0 0.0.0.0 10.0.0.1",
      "ipv6 route ::/0 2001:db8::1", "no ipv6 route ::/0 2001:db8::1"], "route"],
    ["switch", ["ip default-gateway 10.0.0.1", "no ip default-gateway", "vlan 10", "exit", "no vl 10"], "ip default-gateway"],
    ["l3", ["ip routing", "no ip routing", "int gi0/1", "no sw", "sw", "sw access vlan 10", "no sw access vlan",
      "sw trunk native vlan 20", "no sw trunk native vlan"], "no switchport"],
  ] as const)("reverses existing %s configuration: %s", (kind, lines, absent) => {
    const { cli, device } = setup(kind);
    cli.enter("config");
    for (const line of lines) expect(cli.execute(line), line).toBe("");
    cli.execute("end");
    expect(cli.execute("sh run")).not.toContain(absent);
    if (device instanceof Layer3Switch) {
      expect(device.ipRoutingEnabled).toBe(false);
      expect(device.isRoutedPort("Gi0/1")).toBe(false);
      expect(device.portConfigOf("Gi0/1")).toMatchObject({ accessVlan: 1, nativeVlan: 1 });
    }
    if (device instanceof Router) {
      expect(device.staticRouteConfigurations()).toEqual([]);
      expect(device.ipv6StaticRouteConfigurations()).toEqual([]);
    }
    if (kind === "switch") expect((device as L2Switch).hasVlan(10)).toBe(false);
    cli.enter("config");
    expect(cli.execute("no hostname")).toContain("Invalid input");
    expect(cli.negated).toBe(false);
  });

  it("runs the engineer's router transcript including config-mode EXEC", () => {
    const { cli, device } = setup();
    const commands = [
      "en", "conf t", "hostname R1", "int g0/0", "desc LAN",
      "ip add 192.168.1.1 255.255.255.0", "no shut", "exit",
      "ip route 0.0.0.0 0.0.0.0 10.0.0.1", "end", "sh ip int br", "sh ip ro", "sh run", "wr",
    ];
    for (const line of commands) expect(cli.execute(line), line).not.toContain("% ");
    expect(cli.resolvedCommand).toBe("write");
    expect(cli.mode).toBe("privileged");
    expect(device.name).toBe("R1");
    expect(cli.execute("sh run")).toContain("ip address 192.168.1.1 255.255.255.0");
    cli.transcript(["conf t", "int g0/0"]);
    const ctx = cli.ifaceCtx;
    for (const line of ["do sh ip int br", "do sh run"]) {
      expect(cli.execute(line)).toContain("192.168.1.1");
      expect(cli.mode).toBe("config-if"); expect(cli.ifaceCtx).toBe(ctx);
    }
    expect(cli.execute("do conf t")).toContain("Invalid input");
    expect(cli.execute("do exit")).toContain("Invalid input");
    expect(cli.complete("do sh ip int").input).toBe("do sh ip interface");
    expect(cli.mode).toBe("config-if");
  });

  it("runs the engineer's switch transcript and trunk modifiers on all range members", () => {
    const { cli, device } = setup("switch");
    for (const line of ["en", "conf t", "vlan 10", "name USERS", "exit", "int range fa0/1-4",
      "sw mode access", "sw access vlan 10", "shut", "no shut", "desc USERS", "exit", "int gi0/1",
      "sw mode trunk", "sw trunk allowed vlan 10,20", "sw trunk allowed vlan add 40",
      "sw trunk allowed vlan remove 20", "end", "sh vlan br", "sh int trunk", "sh mac add",
      "sh spanning-tree", "sh etherchannel summary"]) expect(cli.execute(line), line).not.toMatch(/Invalid input|Ambiguous|Incomplete/);
    const sw = device as L2Switch;
    expect([...sw.portConfigOf("Gi0/1").allowedVlans!]).toEqual([10, 40]);
    for (let i = 1; i <= 4; i++) {
      expect(sw.portConfigOf("Fa0/" + i).accessVlan).toBe(10);
      expect(sw.getInterface("Fa0/" + i)?.adminUp).toBe(true);
      expect(sw.getInterface("Fa0/" + i)?.description).toBe("USERS");
    }
    expect(cli.mode).toBe("privileged");
  });

  it("preflights range membership, parameters and mixed routed ports before changes", () => {
    const { cli, device } = setup("l3");
    cli.transcript(["en", "conf t"]);
    expect(cli.execute("int range fa0/1-8")).toContain("not found");
    expect(cli.mode).toBe("config");
    expect(cli.execute("int range fa0/1-2, fa0/4")).toBe("");
    expect(cli.ifaceCtx?.range).toEqual(["Fa0/1", "Fa0/2", "Fa0/4"]);
    expect(cli.execute("sw access vlan 5000")).toContain("% ");
    expect((device as L2Switch).hasVlan(5000)).toBe(false);
    (device as Layer3Switch).setPortRouted("Fa0/4", true);
    expect(cli.execute("sw mode trunk")).toContain("routed port");
    expect((device as L2Switch).portConfigOf("Fa0/1").mode).toBe("access");
    expect(cli.execute("ip add 10.0.0.1 255.255.255.0")).toContain("not supported in interface range");
  });

  it("keeps a channel-group range atomic when its last member conflicts", () => {
    const { cli, device } = setup("switch");
    const sw = device as L2Switch;
    sw.addChannelGroupMember(2, "Fa0/4", "on");
    cli.transcript(["en", "conf t", "int range fa0/1-4"]);
    expect(cli.execute("channel-group 1 mode active")).toContain("already belongs");
    expect(sw.etherChannelConfigurations().map((c) => c.channelId)).toEqual([2]);
    sw.removeChannelGroupMember("Fa0/4");
    expect(cli.execute("channel-group 1 mode active")).toBe("");
    expect(sw.etherChannelConfigurations()[0]?.members).toHaveLength(4);
    expect(cli.mode).toBe("config-if");
  });
});

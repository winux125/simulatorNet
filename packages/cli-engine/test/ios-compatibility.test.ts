import { createCliSession } from "@sim/cli-engine";
import { Router, L2Switch, Layer3Switch, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { parseIosConfig } from "@sim/device-config";
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
    expect(cli.execute("interface ?")).toContain("range");
    expect(cli.execute("interface ?")).toContain("loopback");
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
      expect(cli.execute("do sh int " + alias.replace(/ /g, ""))).toContain(canonical);
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
    ["router", ["ip route 0.0.0.0 0.0.0.0 10.0.0.1", "no ip route 0.0.0.0 0.0.0.0 10.0.0.1",
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
    for (const line of ["spanning-tree cost 20", "spanning-tree portfast", "no spanning-tree portfast",
      "no cdp enable", "cdp enable", "no lldp transmit", "lldp transmit"]) expect(cli.execute(line), line).toBe("");
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

describe("IOS operational presentation compatibility", () => {
  it.each(["router", "switch"] as const)("presents existing %s state through abbreviated operational commands", (kind) => {
    const { cli } = setup(kind);
    cli.enter("privileged");
    const commands = kind === "router" ? [
      "sh ver", "sh hist", "sh int g0/0", "sh ip protocols", "sh ip route 192.0.2.0/24",
      "sh ipv6 route 2001:db8::/64", "sh ip access-lists", "sh aaa", "sh logging",
      "sh ip dhcp pool", "sh ip dhcp binding", "sh ip ospf", "sh ip ospf nei detail",
      "sh ip ospf database", "sh ip ospf int br", "sh ipv6 ospf nei detail", "sh ipv6 ospf int br",
      "sh ip bgp", "sh ip bgp summary", "sh ip bgp neighbors", "sh bgp ipv6 unicast sum",
      "sh ip nat translations", "sh ip nat statistics", "sh cdp nei detail", "sh lldp nei detail",
      "sh users", "sh ssh", "sh snmp",
    ] : ["sh int status", "sh int switchport", "sh int trunk", "sh vlan br", "sh mac add",
      "sh spanning-tree", "sh spanning-tree vlan 10", "sh etherchannel sum", "sh int port-channel",
      "sh lacp nei", "sh pagp nei", "sh cdp nei detail", "sh lldp nei detail", "sh ver", "sh hist"];
    for (const line of commands) {
      expect(cli.execute(line), line).not.toMatch(/Invalid input|Ambiguous command|Incomplete command/);
      expect(cli.resolvedCommand, line).toBeDefined();
      expect(cli.mode).toBe("privileged");
    }
    expect(cli.execute("sh hist")).toContain("sh ver");
    cli.requestCredential("Password:", "test", () => "");
    cli.execute("secret-answer", "opaque");
    expect(cli.execute("sh hist")).not.toContain("secret-answer");
    cli.enter("config");
    cli.execute("crypto k generate rsa modulus 512");
    cli.execute("snmp-server comm inline-sensitive-value ro");
    cli.enter("privileged");
    expect(cli.execute("sh hist")).not.toMatch(/crypto k|inline-sensitive-value/);
    if (kind === "router") {
      cli.transcript(["conf t", "int g0/0", "ip add 192.0.2.1 255.255.255.0", "end"]);
      expect(cli.execute("sh ip route 192.0.2.0/24")).toContain("192.0.2.0/24");
      cli.transcript(["conf t", "int g0/0"]);
      expect(cli.execute("do ping 198.51.100.1")).not.toMatch(/Invalid input|Incomplete/);
      expect(cli.mode).toBe("config-if");
      expect(cli.execute("do traceroute 198.51.100.1")).not.toMatch(/Invalid input|Incomplete/);
      expect(cli.mode).toBe("config-if");
    }
  });

  it("imports address removals only inside a resolved interface block", () => {
    const parsed = parseIosConfig([
      "interface G0/0", " ip address 192.0.2.1 255.255.255.0", " no ip address",
      " ipv6 address 2001:db8::1/64", " no ipv6 address", " description LAN", " no description",
      "interface Serial0/0/0", " no ip address", " shutdown",
    ].join("\n"), ["Gi0/0"]);
    expect(parsed.interfaces).toEqual([{ id: "Gi0/0", shutdown: false }]);
    expect(parsed.unparsedLines).toEqual(["interface Serial0/0/0", "no ip address", "shutdown"]);
    expect(parsed.appliedLines).toHaveLength(7);
  });
});

it("removes only the matching OSPF/BGP process through the no operator", () => {
  const { cli, device } = setup();
  const router = device as Router;
  cli.transcript(["en", "conf t", "router b 65000", "exit"]);
  expect(cli.execute("no router b nope")).toContain("Invalid BGP");
  expect(cli.execute("no router b 65001")).toContain("not configured");
  expect(router.bgp.enabled).toBe(true);
  expect(cli.execute("no router b 65000")).toBe("");
  expect(router.bgp.enabled).toBe(false);
  cli.transcript(["router os 1", "exit"]);
  expect(cli.execute("no router os 2")).toContain("not configured");
  expect(router.ospf.enabled).toBe(true);
  expect(cli.execute("no router os 1")).toBe("");
  expect(router.ospf.enabled).toBe(false);
  expect(cli.mode).toBe("config");
});

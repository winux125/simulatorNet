import { createCliSession } from "@sim/cli-engine";
import {
  EthernetBridge,
  Hub,
  Layer3Switch,
  Pc,
  Server,
  createSimulationEngine,
  macFromIndex,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";
import { createTestConfigurationService } from "./helpers/configuration";

describe("M10 capability-aware CLI", () => {
  it("gives a bridge interface/MAC CLI without VLAN commands", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const bridge = engine.add(new EthernetBridge("br", "Bridge"));
    bridge.addInterface("Eth0/1", macFromIndex(1));
    bridge.addInterface("Eth0/2", macFromIndex(2));
    const cli = createCliSession(bridge, engine);
    cli.useConfigurationService(createTestConfigurationService(bridge));
    expect(cli.execute("?")).toContain("show");
    cli.execute("enable");
    cli.execute("configure terminal");
    expect(cli.execute("?")).not.toContain("vlan");
    cli.execute("interface Eth0/1");
    cli.execute("description left segment");
    cli.execute("shutdown");
    cli.execute("end");
    expect(cli.execute("show running-config")).toContain("description left segment");
    expect(cli.execute("show mac address-table")).toContain("Mac Address");
  });

  it("uses the host CLI profile for a server", () => {
    const engine = createSimulationEngine({ seed: 2 });
    const server = engine.add(new Server("server", "Server"));
    const pc = engine.add(new Pc("pc", "PC"));
    server.addInterface("eth0", macFromIndex(1));
    server.addInterface("eth1", macFromIndex(2));
    server.configure({ ip: "10.0.0.10", mask: 24 });
    pc.addInterface("eth0", macFromIndex(3));
    pc.configure({ ip: "10.0.0.20", mask: 24 });
    engine.connect("server", "eth0", "pc", "eth0");
    const cli = createCliSession(server, engine);
    expect(cli.prompt()).toBe("Server>");
    expect(cli.execute("?")).toContain("ipconfig");
    expect(cli.execute("ipconfig")).toContain("10.0.0.10");
    expect(cli.execute("ping ?")).toContain("<ip-or-hostname>");
    expect(cli.execute("ping 10.0.0.20")).toContain("Success rate is 100 percent");
  });

  it("configures L2 ports, SVIs, routing, and routed ports through public methods", () => {
    const engine = createSimulationEngine({ seed: 3 });
    const sw = engine.add(new Layer3Switch("l3", "L3SW"));
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    sw.addInterface("Gi0/8", macFromIndex(108));
    const cli = createCliSession(sw, engine);
    cli.useConfigurationService(createTestConfigurationService(sw));
    for (const line of [
      "enable",
      "configure terminal",
      "vlan 10",
      "name USERS",
      "exit",
      "interface Gi0/1",
      "switchport mode access",
      "switchport access vlan 10",
      "exit",
      "interface vlan 10",
      "ip address 192.168.10.1 255.255.255.0",
      "no shutdown",
      "exit",
      "interface Gi0/8",
      "no switchport",
      "ip address 10.0.0.1 255.255.255.252",
      "exit",
      "ip routing",
      "end",
    ]) expect(cli.execute(line)).not.toContain("% ");
    expect(sw.ipRoutingEnabled).toBe(true);
    expect(sw.sviSummaries()).toContainEqual(expect.objectContaining({ vlanId: 10, ip: "192.168.10.1" }));
    expect(sw.isRoutedPort("Gi0/8")).toBe(true);
    // The renderer writes IOS's own SVI form, `interface Vlan10`.
    expect(cli.execute("show running-config")).toContain("interface Vlan10");
    expect(cli.execute("show ip route")).toContain("192.168.10.0/24");
    cli.execute("configure terminal");
    expect(cli.execute("interface ?")).toContain("vlan <1-4094>");
    expect(cli.execute("interface ?")).toContain("Gi0/1");
    cli.execute("interface Gi0/8");
    expect(cli.execute("encapsulation dot1Q 10")).toBe("% This device does not support router-subinterfaces.");
    expect(cli.execute("?")).not.toContain("encapsulation");
  });

  it("rejects a hub CLI session because its profile is intentionally read-only", () => {
    const engine = createSimulationEngine({ seed: 4 });
    const hub = engine.add(new Hub("hub", "Hub"));
    expect(() => createCliSession(hub, engine)).toThrow("has no CLI profile");
  });
});

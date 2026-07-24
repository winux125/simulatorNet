import {
  Layer3Switch,
  Router,
  createSimulationEngine,
  macFromIndex,
} from "@sim/sim-core";
import { createCliSession } from "@sim/cli-engine";
import { describe, expect, it } from "vitest";

function routerSession() {
  const engine = createSimulationEngine({ seed: 901 });
  const router = engine.add(new Router("r1", "R1"));
  router.addInterface("Gi0/0", macFromIndex(1));
  router.addInterface("Gi0/1", macFromIndex(2));
  const cli = createCliSession(router, engine);
  cli.execute("enable");
  cli.execute("configure terminal");
  return { engine, router, cli };
}

describe("M10.3 security CLI", () => {
  it("defines numbered and named ACLs and binds them to an interface", () => {
    const { router, cli } = routerSession();
    expect(cli.execute("access-list 10 permit 192.168.10.0 0.0.0.255")).toBe("");
    expect(cli.execute("access-list 10 deny any")).toBe("");
    expect(cli.execute("ip access-list extended WEB")).toBe("");
    expect(cli.prompt()).toBe("R1(config-acl)#");
    expect(cli.execute("permit tcp any host 203.0.113.10 eq 80")).toBe("");
    expect(cli.execute("deny ip any any")).toBe("");
    cli.execute("exit");
    cli.execute("interface Gi0/0");
    cli.execute("ip address 192.168.10.1 255.255.255.0");
    expect(cli.execute("ip access-group 10 in")).toBe("");
    cli.execute("end");
    expect(cli.execute("show access-lists")).toContain("Extended IP access list WEB");
    expect(cli.execute("show ip interface")).toContain("Inbound access list is 10");
    expect(router.aclConfigurations()).toHaveLength(2);
    expect(router.aclBindings()).toEqual([{ interfaceName: "Gi0/0", direction: "in", aclId: "10" }]);
    cli.execute("configure terminal");
    expect(cli.execute("access-list 2700 deny any")).toContain(
      "Numbered ACL ID must be in 1-199 or 1300-2699.",
    );
  });

  it("configures static, dynamic and PAT rules and exposes runtime commands", () => {
    const { router, cli } = routerSession();
    cli.execute("access-list 10 permit 10.0.0.0 0.0.0.255");
    cli.execute("interface Gi0/0");
    cli.execute("ip address 10.0.0.1 255.255.255.0");
    cli.execute("ip nat inside");
    cli.execute("exit");
    cli.execute("interface Gi0/1");
    cli.execute("ip address 203.0.113.1 255.255.255.0");
    cli.execute("ip nat outside");
    cli.execute("exit");
    cli.execute("ip nat inside source static 10.0.0.10 203.0.113.10");
    cli.execute("ip nat pool PUBLIC 203.0.113.100 203.0.113.110 netmask 255.255.255.0");
    cli.execute("ip nat inside source list 10 pool PUBLIC");
    cli.execute("ip nat inside source list 10 interface Gi0/1 overload");
    cli.execute("end");
    expect(cli.execute("show ip nat statistics")).toContain("Configured rules: 3");
    expect(cli.execute("show ip nat translations")).toBe("No active NAT translations.");
    expect(router.natRole("Gi0/0")).toBe("inside");
    expect(router.natRole("Gi0/1")).toBe("outside");
    expect(router.natRuleConfigurations()).toHaveLength(3);
    expect(cli.execute("clear ip nat translation *")).toBe("Dynamic NAT translations cleared.");
  });

  it("returns a domain capability error for NAT on an L3 Switch", () => {
    const engine = createSimulationEngine({ seed: 902 });
    const device = engine.add(new Layer3Switch("dsw", "DSW1"));
    device.addInterface("Gi0/1", macFromIndex(1));
    const cli = createCliSession(device, engine);
    cli.execute("enable");
    cli.execute("configure terminal");
    cli.execute("interface Gi0/1");
    expect(cli.execute("ip nat inside")).toContain("does not support nat");
  });
});

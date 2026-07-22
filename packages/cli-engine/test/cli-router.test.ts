import { describe, expect, it } from "vitest";
import { createSimulationEngine, L2Switch, macFromIndex, Pc, Router } from "@sim/sim-core";
import { createCliSession } from "@sim/cli-engine";

describe("CLI router configuration", () => {
  it("configures interfaces, a subinterface and a static route via public methods", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const r = engine.add(new Router("r1", "Router"));
    r.addInterface("Gi0/0", macFromIndex(10));
    r.addInterface("Gi0/1", macFromIndex(11));
    const session = createCliSession(r, engine);

    for (const line of ROUTER_SCRIPT) session.execute(line);

    const gi01 = r.interfaceSummaries().find((i) => i.name === "Gi0/1");
    expect(gi01?.ip).toBe("10.0.0.1");
    const sub = r.interfaceSummaries().find((i) => i.name === "Gi0/0.10");
    expect(sub).toMatchObject({ ip: "192.168.10.1", vlan: 10 });
    expect(r.routingTable().some((rt) => rt.kind === "static" && rt.network === "172.16.0.0")).toBe(true);
  });

  it("produces a stable transcript for show ip route and running-config (golden)", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const r = engine.add(new Router("r1", "Router"));
    r.addInterface("Gi0/0", macFromIndex(10));
    r.addInterface("Gi0/1", macFromIndex(11));
    const session = createCliSession(r, engine);
    expect(session.transcript(ROUTER_SCRIPT)).toBe(GOLDEN_ROUTER_TRANSCRIPT);
  });
});

describe("CLI-driven data plane (router-on-a-stick)", () => {
  it("routes between two VLANs after the switch and router are configured from the CLI", () => {
    const engine = createSimulationEngine({ seed: 3 });

    const sw = engine.add(new L2Switch("sw1", "SW1"));
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    sw.addInterface("Gi0/24", macFromIndex(124));

    const r = engine.add(new Router("r1", "R1"));
    r.addInterface("Gi0/0", macFromIndex(200));

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc1.configure({ ip: "192.168.10.10", mask: 24, gateway: "192.168.10.1" });

    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc2.addInterface("eth0", macFromIndex(2));
    pc2.configure({ ip: "192.168.20.10", mask: 24, gateway: "192.168.20.1" });

    engine.connect("sw1", "Gi0/1", "pc1", "eth0");
    engine.connect("sw1", "Gi0/2", "pc2", "eth0");
    engine.connect("sw1", "Gi0/24", "r1", "Gi0/0");

    // Configure the switch entirely through the CLI.
    const swCli = createCliSession(sw, engine);
    for (const line of [
      "enable",
      "configure terminal",
      "vlan 10",
      "name USERS",
      "exit",
      "vlan 20",
      "name SERVERS",
      "exit",
      "interface Gi0/1",
      "switchport mode access",
      "switchport access vlan 10",
      "exit",
      "interface Gi0/2",
      "switchport mode access",
      "switchport access vlan 20",
      "exit",
      "interface Gi0/24",
      "switchport mode trunk",
      "switchport trunk allowed vlan 10,20",
      "end",
    ]) {
      swCli.execute(line);
    }

    // Configure the router-on-a-stick through the CLI.
    const rCli = createCliSession(r, engine);
    for (const line of [
      "enable",
      "configure terminal",
      "interface Gi0/0.10",
      "encapsulation dot1Q 10",
      "ip address 192.168.10.1 255.255.255.0",
      "exit",
      "interface Gi0/0.20",
      "encapsulation dot1Q 20",
      "ip address 192.168.20.1 255.255.255.0",
      "end",
    ]) {
      rCli.execute(line);
    }

    pc1.ping("192.168.20.10", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults[0]).toMatchObject({ sequence: 1, success: true });
  });
});

const ROUTER_SCRIPT = [
  "enable",
  "configure terminal",
  "hostname R1",
  "interface Gi0/1",
  "ip address 10.0.0.1 255.255.255.0",
  "no shutdown",
  "exit",
  "interface Gi0/0.10",
  "encapsulation dot1Q 10",
  "ip address 192.168.10.1 255.255.255.0",
  "exit",
  "ip route 172.16.0.0 255.255.0.0 10.0.0.2",
  "end",
  "show ip route",
  "show ip interface brief",
  "show running-config",
];

const GOLDEN_ROUTER_TRANSCRIPT = `Router>enable
Router#configure terminal
Router(config)#hostname R1
R1(config)#interface Gi0/1
R1(config-if)#ip address 10.0.0.1 255.255.255.0
R1(config-if)#no shutdown
R1(config-if)#exit
R1(config)#interface Gi0/0.10
R1(config-if)#encapsulation dot1Q 10
R1(config-if)#ip address 192.168.10.1 255.255.255.0
R1(config-if)#exit
R1(config)#ip route 172.16.0.0 255.255.0.0 10.0.0.2
R1(config)#end
R1#show ip route
Codes: C - connected, S - static

C    10.0.0.0/24 is directly connected, Gi0/1
C    192.168.10.0/24 is directly connected, Gi0/0.10
S    172.16.0.0/16 [1/0] via 10.0.0.2
R1#show ip interface brief
Interface               IP-Address      Status                  Protocol
Gi0/1                   10.0.0.1        down                    down
Gi0/0.10                192.168.10.1    down                    down
R1#show running-config
!
hostname R1
!
interface Gi0/1
 ip address 10.0.0.1 255.255.255.0
!
interface Gi0/0.10
 encapsulation dot1Q 10
 ip address 192.168.10.1 255.255.255.0
!
ip route 172.16.0.0 255.255.0.0 10.0.0.2
!
end`;

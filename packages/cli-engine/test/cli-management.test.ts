import { describe, expect, it } from "vitest";
import {
  createSimulationEngine,
  EthernetBridge,
  L2Switch,
  Layer3Switch,
  macFromIndex,
  Router,
} from "@sim/sim-core";
import { createCliSession, type CliSession } from "../src";

function configure(device: L2Switch | Layer3Switch | Router): CliSession {
  const engine = createSimulationEngine({ seed: 1 });
  engine.add(device);
  device.addInterface("Gi0/1", macFromIndex(1));
  const session = createCliSession(device, engine);
  session.execute("enable");
  session.execute("configure terminal");
  return session;
}

describe("management CLI", () => {
  it("configures a management SVI and default gateway on an L2 switch", () => {
    const sw = new L2Switch("sw1", "SW1");
    const cli = configure(sw);
    for (const line of [
      "vlan 10",
      "name MGMT",
      "exit",
      "interface Gi0/1",
      "switchport mode access",
      "switchport access vlan 10",
      "exit",
      "interface vlan 10",
      "ip address 192.168.10.2 255.255.255.0",
      "no shutdown",
      "exit",
      "ip default-gateway 192.168.10.1",
    ]) expect(cli.execute(line)).not.toContain("% ");

    expect(sw.managementSviSummary()).toMatchObject({ vlanId: 10, ip: "192.168.10.2", adminUp: true });
    expect(sw.managementDefaultGateway).toBe("192.168.10.1");
  });

  it("keeps the L2 switch a layer-2 device: no routing commands are offered", () => {
    const sw = new L2Switch("sw1", "SW1");
    const cli = configure(sw);
    expect(cli.execute("ip routing")).toContain("%");
    expect(cli.execute("ip route 10.0.0.0 255.0.0.0 192.168.10.1")).toContain("%");
  });

  it("still gives an L3 switch a routed SVI rather than a management interface", () => {
    const sw = new Layer3Switch("sw1", "SW1");
    const cli = configure(sw);
    for (const line of ["vlan 20", "exit", "interface vlan 20", "ip address 10.0.0.1 255.255.255.0"]) {
      expect(cli.execute(line)).not.toContain("% ");
    }
    expect(sw.sviSummaries()).toContainEqual(expect.objectContaining({ vlanId: 20, ip: "10.0.0.1" }));
  });

  describe.each([
    ["router", () => new Router("r1", "R1")],
    ["l2-switch", () => new L2Switch("sw1", "SW1")],
    ["l3-switch", () => new Layer3Switch("sw1", "SW1")],
  ])("VTY and SSH configuration on a %s", (_kind, create) => {
    it("configures VTY lines, transports and exec-timeout", () => {
      const device = create();
      const cli = configure(device);
      for (const line of [
        "line vty 0 4",
        "login local",
        "transport input ssh",
        "exec-timeout 10 0",
      ]) expect(cli.execute(line)).not.toContain("% ");

      const lines = device.remoteAccess.vtyLines;
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        first: 0,
        last: 4,
        loginMode: "local",
        transports: ["ssh"],
        execTimeoutSeconds: 600,
      });
    });

    it("requires a domain name before generating a simulated host key", () => {
      const device = create();
      const cli = configure(device);
      expect(cli.execute("crypto key generate rsa modulus 2048")).toContain("Please define a domain-name first");
      expect(device.remoteAccess.sshConfig.enabled).toBe(false);

      expect(cli.execute("ip domain-name lab.local")).toBe("");
      const output = cli.execute("crypto key generate rsa modulus 2048");
      expect(output).toContain("Fingerprint: SHA256:");
      expect(output).toContain("not a cryptographic key");
      expect(device.remoteAccess.sshConfig.enabled).toBe(true);
      expect(device.remoteAccess.sshConfig.hostKeyFingerprint).toMatch(/^SHA256:/u);
    });
  });

  it("derives the same host-key fingerprint for the same device identity", () => {
    const first = new Router("r1", "R1");
    const second = new Router("r1", "R1");
    for (const device of [first, second]) {
      const cli = configure(device);
      cli.execute("ip domain-name lab.local");
      cli.execute("crypto key generate rsa modulus 2048");
    }
    expect(first.remoteAccess.sshConfig.hostKeyFingerprint)
      .toBe(second.remoteAccess.sshConfig.hostKeyFingerprint);
  });

  it("rejects unsupported transports and SSH versions", () => {
    const device = new Router("r1", "R1");
    const cli = configure(device);
    cli.execute("line vty 0 4");
    expect(cli.execute("transport input banana")).toContain("transport input accepts");
    cli.execute("exit");
    expect(cli.execute("ip ssh version 1")).toContain("Only simulated SSH version 2");
  });

  it("does not offer management commands on a device without a management plane", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const bridge = engine.add(new EthernetBridge("b1", "B1"));
    bridge.addInterface("Eth0/1", macFromIndex(9));
    const cli = createCliSession(bridge, engine);
    cli.execute("enable");
    cli.execute("configure terminal");
    // A bridge has a CLI but no VTY lines, SSH server or management SVI.
    expect(cli.execute("line vty 0 4")).toContain("%");
    expect(cli.execute("ip domain-name lab.local")).toContain("%");
  });
});

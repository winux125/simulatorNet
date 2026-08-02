import { createCliSession } from "@sim/cli-engine";
import { createVpnPreSharedKeyVerifier, VPN_PRE_SHARED_KEY_SCOPE } from "@sim/console-auth";
import { Firewall, Layer3Switch, Router, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { describe, expect, it } from "vitest";
import { createTestConfigurationService } from "./helpers/configuration";

function routerSession(kind: "router" | "firewall" = "router") {
  const engine = createSimulationEngine({ seed: 10_909 });
  const device = kind === "router"
    ? engine.add(new Router("r1", "R1"))
    : engine.add(new Firewall("r1", "R1"));
  device.addInterface("Gi0/0", macFromIndex(10));
  device.addInterface("Gi0/1", macFromIndex(11));
  device.configureInterface("Gi0/0", { ip: "10.1.0.1", mask: 24 });
  device.configureInterface("Gi0/1", { ip: "203.0.113.1", mask: 30 });
  const session = createCliSession(device, engine);
  session.useConfigurationService(createTestConfigurationService(device));
  session.execute("enable");
  session.execute("configure terminal");
  return { engine, device, session };
}

describe("site-to-site VPN CLI", () => {
  it("configures a GRE tunnel through the IOS-like subset", () => {
    const { device, session } = routerSession();
    session.execute("interface Tunnel0");
    expect(session.prompt()).toBe("R1(config-if)#");
    session.execute("ip address 10.255.0.1 255.255.255.252");
    session.execute("ipv6 address 2001:db8:ffff::1/64");
    session.execute("tunnel source Gi0/1");
    session.execute("tunnel destination 203.0.113.6");
    session.execute("tunnel mode gre ip");
    session.execute("tunnel mtu 1400");
    session.execute("tunnel ttl 64");
    session.execute("no shutdown");

    const [tunnel] = device.tunnelConfigurations();
    expect(tunnel).toMatchObject({
      id: "Tunnel0",
      source: { type: "interface", interfaceId: "Gi0/1" },
      destinationAddress: "203.0.113.6",
      mode: "gre-ipv4",
      mtu: 1_400,
      ttl: 64,
      adminUp: true,
    });
    expect(tunnel!.ipv4Addresses).toEqual([{ address: "10.255.0.1", prefixLength: 30 }]);
    expect(tunnel!.ipv6Addresses).toEqual([{ address: "2001:db8:ffff::1", prefixLength: 64 }]);
  });

  it("builds an IKEv2 proposal, peer and IPsec profile and binds it to the tunnel", () => {
    const { device, session } = routerSession();
    session.execute("crypto ikev2 proposal IKE-PROP");
    expect(session.prompt()).toBe("R1(config-ikev2-proposal)#");
    session.execute("encryption sim-aes256");
    session.execute("integrity sim-sha256");
    session.execute("exit");
    session.execute("crypto ikev2 peer BRANCH");
    expect(session.prompt()).toBe("R1(config-ikev2-peer)#");
    session.execute("address 203.0.113.6");
    session.execute("proposal IKE-PROP");
    session.execute("lifetime 3600");
    session.execute("exit");
    session.execute("crypto ipsec profile SITE-VPN");
    expect(session.prompt()).toBe("R1(ipsec-profile)#");
    session.execute("set ikev2-peer BRANCH");
    session.execute("set proposal IKE-PROP");
    session.execute("exit");
    session.execute("interface Tunnel0");
    session.execute("tunnel source Gi0/1");
    session.execute("tunnel destination 203.0.113.6");
    session.execute("tunnel protection ipsec profile SITE-VPN");

    expect(device.ipsecProposalConfigurations()).toEqual([
      { id: "IKE-PROP", encryption: "sim-aes256", integrity: "sim-sha256" },
    ]);
    expect(device.ipsecProfileConfigurations()[0]).toMatchObject({
      id: "SITE-VPN",
      ikePeerId: "BRANCH",
      proposalId: "IKE-PROP",
    });
    expect(device.tunnelConfigurations()[0]!.ipsecProfileId).toBe("SITE-VPN");
  });

  it.each([
    ["rejects a real encryption transform", "encryption aes-cbc-256", /sim-aes/u],
    ["rejects a real integrity transform", "integrity sha1", /sim-sha256/u],
  ] as const)("%s", (_label, command, expected) => {
    const { session } = routerSession();
    session.execute("crypto ikev2 proposal P");
    expect(session.execute(command)).toMatch(expected);
  });

  it("rejects a profile binding that names an undefined profile", () => {
    const { session } = routerSession();
    session.execute("interface Tunnel0");
    expect(session.execute("tunnel protection ipsec profile MISSING")).toMatch(/not defined/u);
  });

  it("collects the pre-shared key at a no-echo prompt and never echoes it back", async () => {
    const { device, session } = routerSession();
    session.execute("crypto ikev2 proposal IKE-PROP");
    session.execute("exit");
    session.execute("crypto ikev2 peer BRANCH");
    session.execute("address 203.0.113.6");
    session.execute("proposal IKE-PROP");

    // The command itself produces no output: it arms a credential prompt.
    expect(session.execute("pre-shared-key")).toBe("");
    expect(session.expectsSecret()).toBe(true);
    expect(session.credentialScope()).toBe(VPN_PRE_SHARED_KEY_SCOPE);
    expect(session.prompt()).toBe("Pre-shared key:");

    // The terminal derives the verifier and submits only the fingerprint.
    const verifier = await createVpnPreSharedKeyVerifier("simulatornet-site-vpn");
    const output = session.execute("", verifier.hashBase64);
    expect(output).toMatch(/never displayed/u);
    expect(output).not.toContain("simulatornet-site-vpn");
    expect(output).not.toContain(verifier.hashBase64);
    expect(session.expectsSecret()).toBe(false);
    expect(device.ikePeerConfigurations()[0]!.preSharedKeyVerifier?.hashBase64).toBe(verifier.hashBase64);
  });

  it("cancels the key command when no credential is supplied", () => {
    const { device, session } = routerSession();
    session.execute("crypto ikev2 proposal IKE-PROP");
    session.execute("exit");
    session.execute("crypto ikev2 peer BRANCH");
    session.execute("pre-shared-key");
    expect(session.execute("typed-in-the-clear")).toMatch(/nothing was changed/u);
    expect(device.ikePeerConfigurations()[0]!.preSharedKeyVerifier).toBeUndefined();
  });

  it("redacts the pre-shared key from show running-config", async () => {
    const { session } = routerSession();
    session.execute("crypto ikev2 proposal IKE-PROP");
    session.execute("exit");
    session.execute("crypto ikev2 peer BRANCH");
    session.execute("address 203.0.113.6");
    session.execute("proposal IKE-PROP");
    session.execute("pre-shared-key");
    const verifier = await createVpnPreSharedKeyVerifier("simulatornet-site-vpn");
    session.execute("", verifier.hashBase64);
    session.execute("exit");
    session.execute("crypto ipsec profile SITE-VPN");
    session.execute("set ikev2-peer BRANCH");
    session.execute("set proposal IKE-PROP");
    session.execute("exit");
    session.execute("interface Tunnel0");
    session.execute("ip address 10.255.0.1 255.255.255.252");
    session.execute("tunnel source Gi0/1");
    session.execute("tunnel destination 203.0.113.6");
    session.execute("tunnel protection ipsec profile SITE-VPN");
    session.execute("end");

    const config = session.execute("show running-config");
    expect(config).toContain("crypto ikev2 proposal IKE-PROP");
    expect(config).toContain("crypto ipsec profile SITE-VPN");
    expect(config).toContain("interface Tunnel0");
    expect(config).toContain(" tunnel protection ipsec profile SITE-VPN");
    expect(config).toContain(" pre-shared-key <configured>");
    // Neither the key nor its verifier may ever be rendered.
    expect(config).not.toContain("simulatornet-site-vpn");
    expect(config).not.toContain(verifier.hashBase64);
    expect(config).not.toContain(verifier.saltBase64);
  });

  it("shows tunnel, IKE and IPsec state without exposing key material", () => {
    const { session } = routerSession();
    session.execute("interface Tunnel0");
    session.execute("ip address 10.255.0.1 255.255.255.252");
    session.execute("tunnel source Gi0/1");
    session.execute("tunnel destination 203.0.113.6");
    session.execute("end");

    const tunnels = session.execute("show interfaces tunnel");
    // Gi0/1 is addressed but uncabled here, so the tunnel honestly reports why
    // it is down rather than claiming a source it cannot use.
    expect(tunnels).toContain("Tunnel0 is down (source-unavailable)");
    expect(tunnels).toContain("Tunnel source unresolved (Gi0/1), destination 203.0.113.6");
    expect(tunnels).toContain("Internet address is 10.255.0.1/30");
    expect(tunnels).toContain("Tunnel protection: none (plain GRE)");
    expect(session.execute("show crypto ikev2 sa")).toMatch(/No IKEv2 peers/u);
    expect(session.execute("show crypto ipsec sa")).toMatch(/No IPsec security associations/u);
    expect(session.execute("show crypto session")).toMatch(/No protected tunnels/u);
  });

  it("clears IKE and IPsec runtime from privileged EXEC", () => {
    const { session } = routerSession();
    session.execute("end");
    expect(session.execute("clear crypto ikev2 sa")).toMatch(/cleared/u);
    expect(session.execute("clear crypto ipsec sa")).toMatch(/cleared/u);
  });

  it("offers the tunnel and crypto subset on a firewall too", () => {
    const { device, session } = routerSession("firewall");
    session.execute("interface Tunnel0");
    session.execute("tunnel source Gi0/1");
    session.execute("tunnel destination 203.0.113.6");
    expect(device.tunnelConfigurations()[0]!.destinationAddress).toBe("203.0.113.6");
  });

  it("does not offer tunnel or crypto commands on an L3 switch", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const device = engine.add(new Layer3Switch("sw", "SW"));
    device.addInterface("Gi0/1", macFromIndex(1));
    const session = createCliSession(device, engine);
    session.execute("enable");
    session.execute("configure terminal");
    // Unrecognised on this device kind rather than silently accepted.
    expect(session.execute("interface Tunnel0")).toMatch(/%/u);
    expect(session.execute("crypto ikev2 proposal P")).toMatch(/%/u);
  });

  it("matches gre and esp in an extended ACL so a lab can block a VPN", () => {
    const { device, session } = routerSession();
    session.execute("ip access-list extended BLOCK-VPN");
    session.execute("deny esp any any");
    session.execute("deny gre any any");
    const [acl] = device.aclConfigurations();
    expect(acl!.rules.map((rule) => (rule as { protocol: unknown }).protocol)).toEqual([50, 47]);
  });
});

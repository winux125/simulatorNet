import { buildDeviceConfigFromIos, parseIosConfig } from "@sim/importers";
import { describe, expect, it } from "vitest";

const SITE_VPN_CONFIG = `
hostname HQ
!
interface GigabitEthernet0/1
 ip address 203.0.113.1 255.255.255.252
 no shutdown
!
crypto ikev2 proposal IKE-PROP
 encryption aes-cbc-256
 integrity sha256
!
crypto ikev2 peer BRANCH
 address 203.0.113.6
 identity local hq.example
 pre-shared-key 0 NeverImportThisKey
 proposal IKE-PROP
 lifetime 3600
!
crypto ipsec profile SITE-VPN
 set ikev2-peer BRANCH
 set proposal IKE-PROP
 lifetime 3600
!
interface Tunnel0
 ip address 10.255.0.1 255.255.255.252
 tunnel source GigabitEthernet0/1
 tunnel destination 203.0.113.6
 tunnel mode gre ip
 tunnel mtu 1400
 tunnel protection ipsec profile SITE-VPN
 no shutdown
!
end
`;

const UNSUPPORTED_CRYPTO = `
hostname LEGACY
!
crypto isakmp policy 10
 encryption aes 256
!
crypto isakmp key SuperSecret address 203.0.113.6
!
crypto map OUTSIDE-MAP 10 ipsec-isakmp
 set peer 203.0.113.6
 set transform-set TS
!
crypto pki trustpoint CA
 enrollment url http://ca.example
!
interface Tunnel9
 tunnel mode ipsec ipv4
!
end
`;

describe("IOS-like site-to-site VPN import", () => {
  it("maps the supported tunnel and crypto subset", () => {
    const applied = parseIosConfig(SITE_VPN_CONFIG, ["Gi0/1"]);

    expect(applied.vpn.proposals).toEqual([
      { id: "IKE-PROP", encryption: "sim-aes256", integrity: "sim-sha256" },
    ]);
    expect(applied.vpn.ikePeers[0]).toMatchObject({
      id: "BRANCH",
      address: "203.0.113.6",
      localIdentity: "hq.example",
      proposalId: "IKE-PROP",
      lifetimeSeconds: 3_600,
      credentialResetRequired: true,
    });
    expect(applied.vpn.ipsecProfiles[0]).toMatchObject({
      id: "SITE-VPN",
      ikePeerId: "BRANCH",
      proposalId: "IKE-PROP",
    });
    expect(applied.vpn.tunnels[0]).toMatchObject({
      id: 0,
      sourceInterface: "Gi0/1",
      destinationAddress: "203.0.113.6",
      mode: "gre-ipv4",
      mtu: 1_400,
      ipsecProfileId: "SITE-VPN",
      ipv4: { address: "10.255.0.1", prefixLength: 30 },
    });
  });

  it("never preserves the vendor pre-shared key in any form", () => {
    const applied = parseIosConfig(SITE_VPN_CONFIG, ["Gi0/1"]);
    const { config } = buildDeviceConfigFromIos("router", applied, ["Gi0/1"], "HQ");

    expect(JSON.stringify(applied.vpn)).not.toContain("NeverImportThisKey");
    expect(JSON.stringify(config)).not.toContain("NeverImportThisKey");
    // The `pre-shared-key` line is recognised, so it is not reported as
    // unparsed — but the key itself is dropped and a reset is required.
    expect(applied.appliedLines.some((line) => line.startsWith("pre-shared-key"))).toBe(true);
    const vpn = "vpn" in config ? config.vpn : undefined;
    expect(vpn?.ikePeers[0]?.preSharedKeyVerifier).toBeUndefined();
    expect(vpn?.ikePeers[0]?.credentialResetRequired).toBe(true);
  });

  it("maps the imported VPN onto a router configuration", () => {
    const applied = parseIosConfig(SITE_VPN_CONFIG, ["Gi0/1"]);
    const { config } = buildDeviceConfigFromIos("router", applied, ["Gi0/1"], "HQ");
    const vpn = "vpn" in config ? config.vpn : undefined;

    expect(vpn?.tunnels[0]).toMatchObject({
      id: 0,
      source: { type: "interface", interfaceId: "Gi0/1" },
      destinationAddress: "203.0.113.6",
      mode: "gre-ipv4",
      mtu: 1_400,
      ipsecProfileId: "SITE-VPN",
    });
    expect(vpn?.proposals).toHaveLength(1);
    expect(vpn?.ipsecProfiles).toHaveLength(1);
  });

  it("preserves unsupported crypto as unparsed warnings rather than approximating it", () => {
    const applied = parseIosConfig(UNSUPPORTED_CRYPTO, ["Gi0/1"]);

    expect(applied.vpn.proposals).toEqual([]);
    expect(applied.vpn.ikePeers).toEqual([]);
    expect(applied.vpn.ipsecProfiles).toEqual([]);
    // A tunnel in an unsupported mode keeps no invented GRE mode.
    expect(applied.vpn.tunnels[0]?.mode).toBeUndefined();
    for (const fragment of [
      "crypto isakmp policy 10",
      "crypto isakmp key SuperSecret address 203.0.113.6",
      "crypto map OUTSIDE-MAP 10 ipsec-isakmp",
      "crypto pki trustpoint CA",
      "tunnel mode ipsec ipv4",
    ]) {
      expect(applied.unparsedLines).toContain(fragment);
    }
  });

  it("drops a tunnel whose source interface does not exist on the mapped device", () => {
    const applied = parseIosConfig(SITE_VPN_CONFIG, ["Gi0/1"]);
    // Map onto a device that has no Gi0/1 at all.
    const { config } = buildDeviceConfigFromIos("router", applied, ["Eth0/0"], "HQ");
    const vpn = "vpn" in config ? config.vpn : undefined;
    expect(vpn?.tunnels ?? []).toEqual([]);
  });
});

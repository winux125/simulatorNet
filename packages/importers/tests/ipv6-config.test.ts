import { buildDeviceConfigFromIos, parseIosConfig } from "@sim/importers";
import { describe, expect, it } from "vitest";

const IOS_IPV6 = `ipv6 unicast-routing
interface Gi0/0
 ipv6 address 2001:db8:10::1/64
 ipv6 ospf 1 area 0
 ipv6 ospf cost 10
 ipv6 traffic-filter WEB6 in
!
ipv6 route 2001:db8:20::/64 2001:db8:10::2
ipv6 router ospf 1
 router-id 1.1.1.1
 passive-interface Gi0/1
!
ipv6 access-list WEB6
 permit tcp 2001:db8:10::/64 host 2001:db8:20::10 eq 80
 deny ipv6 any any
!
router bgp 65000
`;

describe("IOS IPv6 config import", () => {
  it("parses the supported IPv6, OSPFv3 and ACL subset and preserves unsupported lines", () => {
    const parsed = parseIosConfig(IOS_IPV6, ["Gi0/0", "Gi0/1"]);
    expect(parsed.ipv6StaticRoutes, JSON.stringify(parsed.unparsedLines)).toEqual([
      { network: "2001:db8:20::", prefixLength: 64, nextHop: "2001:db8:10::2" },
    ]);
    expect(parsed).toMatchObject({
      ipv6UnicastRoutingEnabled: true,
      ipv6StaticRoutes: [{ network: "2001:db8:20::", prefixLength: 64, nextHop: "2001:db8:10::2" }],
      ospfv3: { processId: 1, routerId: "1.1.1.1", passiveInterfaces: ["Gi0/1"] },
    });
    expect(parsed.interfaces[0]).toMatchObject({
      id: "Gi0/0",
      ipv6: [{ address: "2001:db8:10::1", prefixLength: 64 }],
      ospfv3: { enabled: true, cost: 10 },
      ipv6TrafficFilters: [{ aclId: "WEB6", direction: "in" }],
    });
    expect(parsed.ipv6Acls[0]?.rules).toHaveLength(2);
    expect(parsed.unparsedLines).toContain("router bgp 65000");
  });

  it("builds canonical Router and L3 Switch configuration without executing source text", () => {
    const parsed = parseIosConfig(IOS_IPV6, ["Gi0/0", "Gi0/1"]);
    for (const deviceType of ["router", "l3-switch"] as const) {
      const config = buildDeviceConfigFromIos(deviceType, parsed, ["Gi0/0", "Gi0/1"], "R1").config;
      expect(config).toMatchObject({
        kind: deviceType,
        ipv6UnicastRoutingEnabled: true,
        ipv6StaticRoutes: [{ network: "2001:db8:20::", prefixLength: 64, nextHop: "2001:db8:10::2" }],
        ospfv3: { processId: 1, routerId: "1.1.1.1" },
        ipv6AclBindings: [{ interfaceName: "Gi0/0", direction: "in", aclId: "WEB6" }],
      });
      expect(config && "ipv6Acls" in config ? config.ipv6Acls : []).toHaveLength(1);
    }
  });
});

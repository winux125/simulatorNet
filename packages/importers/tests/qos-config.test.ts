import { buildDeviceConfigFromIos, parseIosConfig } from "@sim/importers";
import { describe, expect, it } from "vitest";

const CONFIG = `
hostname EDGE
!
class-map match-any REALTIME
 match dscp ef
 match protocol udp
!
class-map match-all WEB
 match access-group name WEB-ACL
!
policy-map WAN-EDGE
 class REALTIME
  priority percent 20
  set dscp ef
 class WEB
  bandwidth percent 30
 class class-default
  bandwidth percent 50
!
policy-map GUEST-POLICE
 class REALTIME
  police 1000000 32000 conform-action transmit exceed-action drop
!
policy-map WAN-SHAPE
 class class-default
  shape average 2000000
!
interface GigabitEthernet0/0
 ip address 10.0.0.1 255.255.255.0
 service-policy input GUEST-POLICE
 service-policy output WAN-EDGE
!
`;

describe("IOS QoS import subset", () => {
  it("parses class maps, policy maps and service policies", () => {
    const parsed = parseIosConfig(CONFIG, ["Gi0/0"]);
    expect(parsed.qos.classMaps.map((map) => map.id)).toEqual(["REALTIME", "WEB"]);
    expect(parsed.qos.classMaps[0]).toMatchObject({ matchType: "match-any" });
    expect(parsed.qos.classMaps[0]!.matches).toEqual([
      { kind: "dscp", values: [46] },
      { kind: "protocol", protocol: "udp" },
    ]);
    expect(parsed.qos.classMaps[1]).toMatchObject({ matchType: "match-all" });

    const edge = parsed.qos.policyMaps.find((map) => map.id === "WAN-EDGE")!;
    expect(edge.classes.map((entry) => entry.className)).toEqual(["REALTIME", "WEB", "class-default"]);
    expect(edge.classes[0]).toMatchObject({ priority: { percent: 20 }, marking: { dscp: 46 } });
    expect(edge.classes[1]).toMatchObject({ bandwidthPercent: 30 });

    expect(parsed.qos.policyMaps.find((map) => map.id === "GUEST-POLICE")!.classes[0]!.police)
      .toEqual({ rateBps: 1_000_000, burstBytes: 32_000, exceedAction: "drop" });
    expect(parsed.qos.policyMaps.find((map) => map.id === "WAN-SHAPE")!.classes[0]!.shape)
      .toEqual({ averageRateBps: 2_000_000 });

    expect(parsed.qos.servicePolicies).toEqual([
      { interfaceName: "Gi0/0", direction: "input", policyMapId: "GUEST-POLICE" },
      { interfaceName: "Gi0/0", direction: "output", policyMapId: "WAN-EDGE" },
    ]);
  });

  it("preserves unsupported advanced QoS lines in the import report", () => {
    const parsed = parseIosConfig([
      "policy-map ADVANCED",
      " class class-default",
      "  random-detect dscp-based",
      "  fair-queue 256",
      "!",
      "mls qos",
    ].join("\n"), ["Gi0/0"]);
    expect(parsed.unparsedLines).toContain("random-detect dscp-based");
    expect(parsed.unparsedLines).toContain("fair-queue 256");
    expect(parsed.unparsedLines).toContain("mls qos");
  });

  it("drops a service policy that names a policy map the file never defined", () => {
    const parsed = parseIosConfig([
      "interface GigabitEthernet0/0",
      " service-policy output MISSING",
    ].join("\n"), ["Gi0/0"]);
    expect(parsed.qos.servicePolicies).toEqual([]);
    const built = buildDeviceConfigFromIos("router", parsed, ["Gi0/0"], "EDGE");
    expect((built.config as { qos?: unknown }).qos).toBeUndefined();
  });

  it("carries the imported QoS subset into the router device configuration", () => {
    const parsed = parseIosConfig(CONFIG, ["Gi0/0"]);
    const built = buildDeviceConfigFromIos("router", parsed, ["Gi0/0"], "EDGE");
    const qos = (built.config as { qos?: { policyMaps: Array<{ id: string }>; servicePolicies: unknown[] } }).qos!;
    expect(qos.policyMaps.map((map) => map.id)).toEqual(["WAN-EDGE", "GUEST-POLICE", "WAN-SHAPE"]);
    expect(qos.servicePolicies).toHaveLength(2);
  });
});

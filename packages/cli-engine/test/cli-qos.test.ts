import { createCliSession } from "@sim/cli-engine";
import { Router, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function router() {
  const engine = createSimulationEngine({ seed: 3 });
  const device = engine.add(new Router("r1", "R1"));
  device.addInterface("Gi0/0", macFromIndex(1));
  device.addInterface("Gi0/1", macFromIndex(2));
  device.getOrCreateInterface("Gi0/0");
  device.getOrCreateInterface("Gi0/1");
  device.setInterfaceIp("Gi0/0", "10.0.0.1", 24);
  device.setInterfaceIp("Gi0/1", "10.0.1.1", 24);
  return { device, session: createCliSession(device, engine) };
}

function run(session: ReturnType<typeof createCliSession>, lines: string[]): string[] {
  return lines.map((line) => session.execute(line));
}

const CONFIGURE = ["enable", "configure terminal"];

describe("QoS CLI subset", () => {
  it("builds a class map, policy map and interface binding", () => {
    const { device, session } = router();
    const output = run(session, [
      ...CONFIGURE,
      "class-map match-any REALTIME",
      "match dscp ef",
      "match protocol udp",
      "exit",
      "policy-map WAN-EDGE",
      "class REALTIME",
      "priority percent 20",
      "set dscp ef",
      "exit",
      "class class-default",
      "bandwidth percent 50",
      "exit",
      "exit",
      "interface Gi0/1",
      "service-policy output WAN-EDGE",
    ]);
    expect(output.every((line) => !line.startsWith("%"))).toBe(true);

    const classMap = device.qosClassMapConfigurations()[0]!;
    expect(classMap).toMatchObject({ id: "REALTIME", matchType: "match-any" });
    expect(classMap.matches).toHaveLength(2);
    const policy = device.qosPolicyMapConfigurations()[0]!;
    expect(policy.classes.map((entry) => entry.className)).toEqual(["REALTIME", "class-default"]);
    expect(policy.classes[0]).toMatchObject({ priority: { percent: 20 }, marking: { dscp: 46 } });
    expect(policy.classes[1]).toMatchObject({ bandwidthPercent: 50 });
    expect(device.qosServicePolicies()).toEqual([
      { interfaceName: "Gi0/1", direction: "output", policyMapId: "WAN-EDGE" },
    ]);
  });

  it("configures a policer and a shaper", () => {
    const { device, session } = router();
    run(session, [
      ...CONFIGURE,
      "class-map match-any GUEST",
      "match any",
      "exit",
      "policy-map GUEST-POLICE",
      "class GUEST",
      "police 1000000 32000 conform-action transmit exceed-action drop",
      "exit",
      "exit",
      "policy-map WAN-SHAPE",
      "class class-default",
      "shape average 2000000",
    ]);
    const police = device.qosPolicyMapConfigurations().find((map) => map.id === "GUEST-POLICE")!;
    expect(police.classes[0]!.police).toEqual({ rateBps: 1_000_000, burstBytes: 32_000, exceedAction: "drop" });
    const shape = device.qosPolicyMapConfigurations().find((map) => map.id === "WAN-SHAPE")!;
    expect(shape.classes[0]!.shape).toEqual({ averageRateBps: 2_000_000 });
  });

  it("renders show class-map, show policy-map and show queueing interface", () => {
    const { session } = router();
    run(session, [
      ...CONFIGURE,
      "class-map match-any REALTIME",
      "match dscp ef",
      "exit",
      "policy-map WAN-EDGE",
      "class REALTIME",
      "priority percent 20",
      "end",
    ]);
    expect(session.execute("show class-map")).toContain("Class Map match-any REALTIME");
    expect(session.execute("show class-map")).toContain("Match dscp ef");
    expect(session.execute("show policy-map")).toContain("priority percent 20");
    expect(session.execute("show queueing interface Gi0/1")).toContain("queueing strategy");
    expect(session.execute("show interfaces counters")).toContain("OutDrops");
  });

  it("rejects an unknown class and an invalid DSCP", () => {
    const { session } = router();
    run(session, [...CONFIGURE, "policy-map P"]);
    expect(session.execute("class MISSING")).toContain("is not defined");
    run(session, ["exit", "class-map match-any C", "match any", "exit", "policy-map P", "class C"]);
    expect(session.execute("set dscp af99")).toContain("Invalid DSCP");
  });

  it("hides unimplemented IOS QoS commands from contextual help", () => {
    const { session } = router();
    run(session, CONFIGURE);
    const help = session.execute("?");
    expect(help).toContain("class-map");
    expect(help).toContain("policy-map");
    expect(help).not.toContain("mls");
    expect(help).not.toContain("random-detect");
    session.execute("class-map match-any C");
    const matchHelp = session.execute("match ?");
    expect(matchHelp).toContain("dscp");
    expect(matchHelp).not.toContain("nbar");
    expect(matchHelp).not.toContain("mpls");
  });
});

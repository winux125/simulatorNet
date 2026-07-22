import { describe, expect, it } from "vitest";
import { normalizeMac } from "@sim/sim-core";
import { buildStarLan } from "./helpers";

describe("L2 switch forwarding", () => {
  it("learns source MACs against their ingress ports during a ping", () => {
    const { engine, sw, pcs } = buildStarLan(2);
    const [pc1, pc2] = pcs;
    pc1!.ping("192.168.1.11");
    engine.runUntilIdle();

    expect(sw.macTable.get(normalizeMac(pc1!.primary.mac))?.port).toBe("Gi0/1");
    expect(sw.macTable.get(normalizeMac(pc2!.primary.mac))?.port).toBe("Gi0/2");
  });

  it("floods broadcast ARP to every port but forwards unicast selectively", () => {
    const { engine, pcs } = buildStarLan(3);
    const [pc1, , pc3] = pcs;
    pc1!.ping("192.168.1.11"); // target is pc2; pc3 is a bystander
    engine.runUntilIdle();

    // The broadcast ARP request reached the bystander pc3 (flooding).
    expect(pc3!.arpTable.has("192.168.1.10")).toBe(true);
    // The unicast ARP reply / ICMP never reached pc3 (selective forwarding).
    expect(pc3!.arpTable.has("192.168.1.11")).toBe(false);
  });
});

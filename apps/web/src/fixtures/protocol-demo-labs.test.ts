import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { PROTOCOL_DEMO_LABS } from "./protocol-demo-labs";

describe("M10.4 demo labs", () => {
  it.each(PROTOCOL_DEMO_LABS.map((lab) => [lab.id, lab] as const))(
    "%s canonicalizes, builds and round-trips",
    (_id, lab) => {
      const canonical = canonicalizeLabDocument(lab);
      const built = buildLabFromDocument(canonical);
      const serialized = serializeLabDocument(built, {
        id: canonical.id,
        title: canonical.title,
        description: canonical.description,
        instructions: canonical.instructions,
        expectedOutcome: canonical.expectedOutcome,
      });
      expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
      expect(() => buildLabFromDocument(parseLabDocument(stringifyLabDocument(serialized)))).not.toThrow();
    },
  );

  it.each(PROTOCOL_DEMO_LABS.map((lab) => [lab.id, lab] as const))(
    "%s documents its objective, addressing, configuration, result and hints",
    (_id, lab) => {
      expect(lab.instructions).toContain("Objective:");
      expect(lab.instructions).toContain("Addressing table:");
      expect(lab.instructions).toContain("Required configuration:");
      expect(lab.instructions).toContain("Expected result:");
      expect(lab.instructions).toContain("Troubleshooting hints:");
      expect(lab.expectedOutcome).toBeTruthy();
    },
  );

  it("elects SW1 as the root and blocks one link in the STP triangle", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[0]!));
    built.engine.runUntilIdle();

    const sw1 = built.getSwitch("sw1")!;
    const sw3 = built.getSwitch("sw3")!;
    expect(sw1.spanningTreeSummary().instances[0]!.isRoot).toBe(true);
    const blocked = sw3.spanningTreeSummary().instances[0]!.ports
      .filter((port) => port.role === "alternate");
    expect(blocked).toHaveLength(1);

    const pc1 = built.getPc("pc1")!;
    pc1.ping("10.0.0.13", 1);
    built.engine.runUntilIdle();
    expect(pc1.pingResults.at(-1)).toMatchObject({ success: true });
  });

  it("error-disables the guarded edge port in the BPDU Guard demo", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[2]!));
    built.engine.runUntilIdle();
    expect(built.getSwitch("sw1")!.spanningTree.isErrorDisabled("Gi0/1")).toBe(true);
  });

  it("forms Port-channel1 in the LACP demo and keeps it up after a member fails", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[3]!));
    built.engine.runUntilIdle();
    const sw1 = built.getSwitch("sw1")!;
    expect(sw1.etherChannelSummaries()[0]).toMatchObject({ status: "up", protocol: "lacp" });
    // Spanning tree sees exactly one logical port for the bundle.
    const ports = sw1.spanningTreeSummary().instances[0]!.ports.map((port) => port.port);
    expect(ports).toContain("Port-channel1");
    expect(ports).not.toContain("Gi0/1");

    sw1.getInterface("Gi0/1")!.shutdown();
    built.engine.runUntilIdle();
    expect(sw1.etherChannelSummaries()[0]!.status).toBe("up");
  });

  it("never bundles auto with auto in the PAgP demo", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[4]!));
    built.engine.runUntilIdle();
    expect(built.getSwitch("sw1")!.etherChannelSummaries()[0]!.status).toBe("up");

    const sw2 = built.getSwitch("sw2")!;
    expect(sw2.etherChannelSummaries()[0]!.protocol).toBe("pagp");
  });

  it("discovers network devices with CDP and the server only with LLDP", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[5]!));
    built.engine.runUntilIdle();

    const sw1 = built.getSwitch("sw1")!;
    const cdp = sw1.discovery.neighborTable().filter((entry) => entry.protocol === "cdp");
    const lldp = sw1.discovery.neighborTable().filter((entry) => entry.protocol === "lldp");
    expect(cdp.map((entry) => entry.deviceId).sort()).toEqual(["L3SW", "R1"]);
    expect(lldp.map((entry) => entry.deviceId).sort()).toEqual(["L3SW", "R1", "SRV1"]);
  });

  it("brings the OSPF Basic demo to Full and installs every remote loopback", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[6]!));
    built.engine.runUntilIdle();

    const r1 = built.getRouter("r1")!;
    expect(r1.ospf.neighborSummaries().map((neighbor) => neighbor.state)).toEqual(["full"]);
    const learned = r1.routingTable().filter((route) => route.kind === "ospf").map((route) => route.network);
    expect(learned).toContain("2.2.2.2");
    expect(learned).toContain("3.3.3.3");
  });

  it("prefers the cheaper path in the OSPF Redundant Path demo", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[7]!));
    built.engine.runUntilIdle();

    const r1 = built.getRouter("r1")!;
    const route = r1.routingTable().find((entry) => entry.kind === "ospf" && entry.network === "4.4.4.4");
    // Gi0/0 carries cost 500, so SPF chooses the R3 path on Gi0/1.
    expect(route?.egressName).toBe("Gi0/1");
  });

  it("elects the configured DR and BDR in the DR/BDR demo", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(PROTOCOL_DEMO_LABS[8]!));
    built.engine.runUntilIdle();

    const view = built.getRouter("r1")!.ospf.interfaceSummaries()[0]!;
    expect(view.designatedRouter).toBe("10.0.0.2");
    expect(view.backupDesignatedRouter).toBe("10.0.0.3");
  });
});

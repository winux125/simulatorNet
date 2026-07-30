import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  serializeLabDocument,
  type BuiltLab,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  DSCP_CLASSIFICATION_DEMO,
  POLICING_AND_SHAPING_DEMO,
  QOS_DEMO_LABS,
  VOICE_VS_BULK_DEMO,
} from "./qos-demo-labs";

describe("QoS demo labs", () => {
  it.each(QOS_DEMO_LABS.map((document) => [document.title, document] as const))(
    "%s canonicalizes, builds and round-trips",
    (_title, document) => {
      const canonical = canonicalizeLabDocument(document);
      const built = buildLabFromDocument(canonical);
      const serialized = serializeLabDocument(built, {
        id: canonical.id,
        title: canonical.title,
        description: canonical.description,
        instructions: canonical.instructions,
        expectedOutcome: canonical.expectedOutcome,
      });
      expect(serialized.configurations).toEqual(canonical.configurations);
      expect(serialized.topology.links).toEqual(canonical.topology.links);
    },
  );

  it.each(QOS_DEMO_LABS.map((document) => [document.title, document] as const))(
    "%s documents its objective, CLI and troubleshooting hints",
    (_title, document) => {
      expect(document.description).toMatch(/Objective:/);
      expect(document.instructions).toMatch(/Addressing:/);
      expect(document.instructions).toMatch(/Traffic classes:/);
      expect(document.instructions).toMatch(/Required CLI:/);
      expect(document.instructions).toMatch(/Expected result:/);
      expect(document.instructions).toMatch(/Troubleshooting hints:/);
      expect(document.expectedOutcome).toBeTruthy();
    },
  );

  it("marks voice EF and web AF31 in the classification demo", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(DSCP_CLASSIFICATION_DEMO));
    built.engine.enableTrace();
    const voice = built.getPc("voice")!;
    voice.sendUdp({
      destinationAddress: "10.0.30.10",
      destinationPort: 5060,
      payload: { kind: "udp-application", protocol: "voice", data: "x", payloadBytes: 160 },
    });
    built.engine.runUntilIdle();
    const marks = built.engine.traceLog
      .filter((entry) => entry.type === "qos-marked")
      .map((entry) => entry.detail?.dscpAfter);
    expect(marks).toContain(46);
  });

  it("gives the priority flow a lower average virtual delay than bulk", () => {
    const built: BuiltLab = buildLabFromDocument(canonicalizeLabDocument(VOICE_VS_BULK_DEMO));
    const bulk = built.getTrafficGenerator("tg-bulk")!;
    const voice = built.getTrafficGenerator("tg-voice")!;
    bulk.startFlow("BULK");
    voice.startFlow("VOICE");
    built.engine.runUntilIdle();
    const voiceResult = voice.flowResults().find((row) => row.flowId === "VOICE")!;
    const bulkResult = bulk.flowResults().find((row) => row.flowId === "BULK")!;
    expect(voiceResult.averageDelayNs).toBeLessThanOrEqual(bulkResult.averageDelayNs);
  });

  it("polices on ingress and shapes on egress in the policing demo", () => {
    const built: BuiltLab = buildLabFromDocument(canonicalizeLabDocument(POLICING_AND_SHAPING_DEMO));
    built.engine.enableTrace();
    built.getTrafficGenerator("guest")!.startFlow("GUEST-BURST");
    built.engine.runUntilIdle();
    const types = new Set(built.engine.traceLog.map((entry) => entry.type));
    expect(types.has("qos-police-conform")).toBe(true);
    expect(types.has("qos-police-dropped")).toBe(true);
    expect(types.has("qos-shape-delayed")).toBe(true);
    const router = built.getRouter("router")!;
    expect(router.qosCounters().some((row) => row.className === "GUEST" && row.droppedPackets > 0)).toBe(true);
  });
});

import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  DMZ_FIREWALL_DEMO,
  EXTENDED_ACL_DEMO,
  PACKET_LOSS_DEMO,
  PAT_INTERNET_DEMO,
  SECURITY_DEMO_LABS,
  STANDARD_ACL_DEMO,
} from "./security-demo-labs";

describe("M10.3d security demo labs", () => {
  it("canonicalizes, builds, serializes, and rebuilds all five labs", () => {
    expect(SECURITY_DEMO_LABS).toHaveLength(5);
    for (const entry of SECURITY_DEMO_LABS) {
      const canonical = canonicalizeLabDocument(entry.document);
      const built = buildLabFromDocument(canonical);
      const serialized = serializeLabDocument(built, {
        id: canonical.id,
        title: canonical.title,
        description: canonical.description,
        instructions: canonical.instructions,
        expectedOutcome: canonical.expectedOutcome,
        diagram: canonical.diagram,
      });
      expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
      expect(() => buildLabFromDocument(parseLabDocument(stringifyLabDocument(serialized)))).not.toThrow();
    }
  });

  it("demonstrates standard ACL permit and deny paths", () => {
    const built = buildLabFromDocument(STANDARD_ACL_DEMO);
    const admin = built.getPc("admin")!;
    const guest = built.getPc("guest")!;
    admin.ping("172.16.0.10", 1);
    guest.ping("172.16.0.10", 2);
    built.engine.runUntilIdle();
    expect(admin.pingResults.at(-1)).toMatchObject({ success: true });
    expect(guest.pingResults.at(-1)).toMatchObject({ success: false });
    expect(built.getRouter("router")?.aclCounters()).toEqual(expect.arrayContaining([
      expect.objectContaining({ aclId: "10", action: "permit" }),
      expect.objectContaining({ aclId: "10", action: "deny" }),
    ]));
  });

  it("permits HTTP but denies ICMP in the extended ACL lab", () => {
    const built = buildLabFromDocument(EXTENDED_ACL_DEMO);
    const client = built.getPc("client")!;
    client.applications.httpGet("http://203.0.113.10/");
    client.ping("203.0.113.10", 1);
    built.engine.runUntilIdle();
    expect(client.applications.httpResults.at(-1)).toMatchObject({ status: "completed", statusCode: 200 });
    expect(client.pingResults.at(-1)).toMatchObject({ success: false });
  });

  it("creates distinct deterministic PAT translations for two inside hosts", () => {
    const built = buildLabFromDocument(PAT_INTERNET_DEMO);
    const pc1 = built.getPc("pc1")!;
    const pc2 = built.getPc("pc2")!;
    pc1.ping("203.0.113.10", 1);
    pc2.ping("203.0.113.10", 2);
    built.engine.runUntilIdle();
    expect(pc1.pingResults.at(-1)).toMatchObject({ success: true });
    expect(pc2.pingResults.at(-1)).toMatchObject({ success: true });
    expect(built.getRouter("router")?.natTranslations()).toEqual([
      expect.objectContaining({ insideLocalAddress: "10.0.0.10" }),
      expect.objectContaining({ insideLocalAddress: "10.0.0.20" }),
    ]);
  });

  it("creates a stateful Firewall session and denies unsolicited reverse traffic", () => {
    const built = buildLabFromDocument(DMZ_FIREWALL_DEMO);
    const inside = built.getPc("inside")!;
    inside.ping("203.0.113.10", 1);
    built.engine.runUntilIdle();
    expect(inside.pingResults.at(-1)).toMatchObject({ success: true });
    expect(built.getFirewall("firewall")?.connectionTable()).not.toHaveLength(0);

    const unsolicited = buildLabFromDocument(DMZ_FIREWALL_DEMO);
    const outside = unsolicited.getPc("outside")!;
    outside.ping("10.0.0.10", 2);
    unsolicited.engine.runUntilIdle();
    expect(outside.pingResults.at(-1)).toMatchObject({ success: false });
  });

  it("replays seeded ISP impairment and Traffic Generator results identically", () => {
    const run = () => {
      const built = buildLabFromDocument(PACKET_LOSS_DEMO);
      const generator = built.getTrafficGenerator("tg")!;
      generator.startFlow("WAN-ICMP");
      built.engine.runUntilIdle();
      return {
        result: generator.flowResults(),
        impairment: built.getCloud("cloud")?.impairmentConfigurations(),
      };
    };
    const first = run();
    expect(first.result).toEqual([
      expect.objectContaining({ flowId: "WAN-ICMP", status: "completed", sent: 8 }),
    ]);
    expect(first.result[0]!.received + first.result[0]!.dropped).toBe(8);
    expect(first.impairment).toHaveLength(2);
    expect(run()).toEqual(first);
  });
});

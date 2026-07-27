import { canonicalizeLabDocument } from "@sim/lab-format";
import { buildLabFromDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { IPV6_DEMO_LABS } from "./ipv6-demo-labs";

describe("M10.5 IPv6 demo labs", () => {
  it.each(IPV6_DEMO_LABS.map((lab) => [lab.title, lab] as const))(
    "%s is an explicit, buildable schema-v1 lab",
    (_title, lab) => {
      const canonical = canonicalizeLabDocument(lab);
      const built = buildLabFromDocument(canonical);
      built.engine.runUntilIdle();
      expect(canonical.schemaVersion).toBe(1);
      expect(canonical.topology.nodes.length).toBeGreaterThan(1);
      expect(built.devices.size).toBe(canonical.topology.nodes.length);
    },
  );
});

import { createCliSession, type CliMode } from "@sim/cli-engine";
import { Router, L2Switch, Layer3Switch, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { describe, expect, it } from "vitest";
import { createTestConfigurationService } from "./helpers/configuration";

function setup(kind: "router" | "switch" | "l3" = "router") {
  const engine = createSimulationEngine({ seed: 175 });
  const device = engine.add(kind === "router" ? new Router("d", "Router")
    : kind === "switch" ? new L2Switch("d", "Switch") : new Layer3Switch("d", "Switch"));
  const names = kind === "router" ? ["Gi0/0", "Gi0/1"] : ["Fa0/1", "Fa0/2", "Fa0/3", "Fa0/4", "Gi0/1"];
  names.forEach((name, i) => device.addInterface(name, macFromIndex(i + 1)));
  const cli = createCliSession(device, engine);
  cli.useConfigurationService(createTestConfigurationService(device));
  return { engine, device, cli };
}

describe("IOS compatibility corpus", () => {
  it.each([
    ["exec", "en", "enable", "privileged", ""],
    ["privileged", "conf t", "configure terminal", "config", ""],
    ["privileged", "sh ip int br", "show ip interface brief", "privileged", "Interface"],
    ["privileged", "sh run", "show running-config", "privileged", "hostname Router"],
    ["privileged", "sh start", "show startup-config", "privileged", "hostname Router"],
    ["privileged", "co t", undefined, "privileged", '% Ambiguous command: "co t"'],
    ["config", "interface", "interface", "config", "% Incomplete command."],
    ["privileged", "show ip something-invalid", undefined, "privileged", "        ^\n% Invalid input"],
  ] as const)("%s: %s", (mode, input, canonical, after, output) => {
    const { cli } = setup();
    cli.enter(mode);
    const result = cli.execute(input);
    expect(cli.resolvedCommand).toBe(canonical);
    expect(cli.mode).toBe(after);
    expect(result).toContain(output);
  });

  it("uses the same capability and mode filtered tree for help and completion", () => {
    const { cli } = setup();
    expect(cli.execute("sh?")).toBe("  show");
    expect(cli.execute("show ?")).toContain("  ip");
    expect(cli.execute("show ip ?")).toContain("  interface");
    expect(cli.complete("conf").input).toBe("conf"); // unavailable in user EXEC
    cli.enter("privileged");
    expect(cli.complete("conf").input).toBe("configure");
    expect(cli.complete("show ip int").input).toBe("show ip interface");
    expect(cli.complete("co").candidates.sort()).toEqual(["configure", "copy"]);
    expect(cli.complete("co").input).toBe("co");
    expect(cli.execute("c")).toContain("Ambiguous");
    expect(cli.execute("co")).toContain("Ambiguous");
    cli.enter("config");
    expect(cli.execute("interface ?")).toContain("Gi0/0");
    expect(cli.execute("?")).not.toContain("switchport");
    cli.execute("interface Gi0/0");
    expect(cli.execute("sh")).toBe(""); // only shutdown in this mode
    expect(cli.resolvedCommand).toBe("shutdown");
    const l3 = setup("l3").cli;
    l3.enter("config"); l3.execute("int Gi0/1");
    expect(l3.execute("?")).not.toContain("encapsulation");
    expect(l3.complete("enc").candidates).toEqual([]);
  });
});

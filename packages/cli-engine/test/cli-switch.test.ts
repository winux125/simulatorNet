import { describe, expect, it } from "vitest";
import { createSimulationEngine, L2Switch, macFromIndex, type SimulationEngine } from "@sim/sim-core";
import { createCliSession } from "@sim/cli-engine";
import { createTestConfigurationService } from "./helpers/configuration";

function buildSwitch(): { engine: SimulationEngine; sw: L2Switch } {
  const engine = createSimulationEngine({ seed: 1 });
  const sw = engine.add(new L2Switch("sw1", "Switch"));
  sw.addInterface("Gi0/1", macFromIndex(1));
  sw.addInterface("Gi0/2", macFromIndex(2));
  sw.addInterface("Gi0/3", macFromIndex(3));
  return { engine, sw };
}

const VERTICAL_SLICE = [
  "enable",
  "configure terminal",
  "hostname S1",
  "vlan 10",
  "name STUDENTS",
  "exit",
  "interface Gi0/1",
  "switchport mode access",
  "switchport access vlan 10",
  "no shutdown",
  "exit",
  "end",
  "show vlan brief",
  "show running-config",
];

describe("CLI vertical slice: configure a VLAN and an access port", () => {
  it("drives sim-core state through public methods only", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    for (const line of VERTICAL_SLICE) session.execute(line);

    // The CLI changed real sim-core state:
    const cfg = sw.portConfigOf("Gi0/1");
    expect(cfg.mode).toBe("access");
    expect(cfg.accessVlan).toBe(10);
    const vlan10 = sw.vlanBrief().find((v) => v.id === 10);
    expect(vlan10).toMatchObject({ name: "STUDENTS", ports: ["Gi0/1"] });
  });

  it("prompts track mode and hostname changes", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    expect(session.prompt()).toBe("Switch>");
    session.execute("enable");
    expect(session.prompt()).toBe("Switch#");
    session.execute("configure terminal");
    session.execute("hostname S1");
    expect(session.prompt()).toBe("S1(config)#");
    session.execute("interface Gi0/1");
    expect(session.prompt()).toBe("S1(config-if)#");
  });

  it("produces a stable Cisco-like transcript (golden)", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    session.useConfigurationService(createTestConfigurationService(sw));
    const transcript = session.transcript(VERTICAL_SLICE);
    expect(transcript).toBe(GOLDEN_SWITCH_TRANSCRIPT);
  });
});

describe("CLI error handling", () => {
  it("rejects unknown commands with a Cisco-like marker", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    session.execute("enable");
    expect(session.execute("frobnicate")).toBe("^\n% Invalid input detected at '^' marker.");
  });

  it("rejects a config command issued from the wrong mode", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    // `hostname` is a config command; from user EXEC it is not valid.
    expect(session.execute("hostname X")).toBe("^\n% Invalid input detected at '^' marker.");
    expect(sw.name).toBe("Switch");
  });

  it("validates VLAN ids", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    session.execute("enable");
    session.execute("configure terminal");
    expect(session.execute("vlan 9999")).toBe("% VLAN ID must be between 1 and 4094.");
  });

  it("distinguishes incomplete, syntax and domain validation errors", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    session.execute("enable");
    session.execute("configure terminal");
    expect(session.execute("interface")).toBe("% Incomplete command.\nUsage: interface <interface-name>");
    session.execute("interface Gi0/1");
    expect(session.execute("switchport banana")).toBe("           ^\n% Invalid input detected at '^' marker.");
    expect(session.execute("switchport access vlan 5000")).toBe("% VLAN ID must be between 1 and 4094.");
  });

  it("provides mode and device-aware contextual help", () => {
    const { engine, sw } = buildSwitch();
    const session = createCliSession(sw, engine);
    expect(session.execute("?")).toContain("show");
    expect(session.execute("?")).toContain("enable");
    session.execute("enable");
    expect(session.execute("show vlan ?")).toContain("brief");
    expect(session.execute("show mac ?")).toContain("address-table");
  });
});

const GOLDEN_SWITCH_TRANSCRIPT = `Switch>enable
Switch#configure terminal
Switch(config)#hostname S1
S1(config)#vlan 10
S1(config-vlan)#name STUDENTS
S1(config-vlan)#exit
S1(config)#interface Gi0/1
S1(config-if)#switchport mode access
S1(config-if)#switchport access vlan 10
S1(config-if)#no shutdown
S1(config-if)#exit
S1(config)#end
S1#show vlan brief
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Gi0/2, Gi0/3
10   STUDENTS                         active    Gi0/1
S1#show running-config
!
hostname S1
!
vlan 10
 name STUDENTS
!
interface Gi0/1
 switchport mode access
 switchport access vlan 10
!
interface Gi0/2
 switchport mode access
!
interface Gi0/3
 switchport mode access
!
end`;

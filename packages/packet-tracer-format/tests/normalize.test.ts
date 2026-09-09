import { describe, expect, it } from "vitest";
import { classifyPacketTracerModel } from "../src/normalize/device-models";
import { normalizeCoordinates } from "../src/normalize/coordinates";
import {
  parsePacketTracerInterfaceName,
  resolveInterfaceOnDevice,
  resolvePacketTracerInterface,
} from "../src/normalize/interfaces";

describe("classifyPacketTracerModel", () => {
  it("classifies access switches with their real port density", () => {
    expect(classifyPacketTracerModel("Switch", "2960-24TT")).toMatchObject({
      sourceKind: "l2-switch", accessPorts: 24, uplinkPorts: 2, matched: true,
    });
    expect(classifyPacketTracerModel("Switch", "2960-48TT")).toMatchObject({
      sourceKind: "l2-switch", accessPorts: 48, uplinkPorts: 4,
    });
  });

  it("classifies routers, hosts and infrastructure", () => {
    expect(classifyPacketTracerModel("Router", "1941").sourceKind).toBe("router");
    expect(classifyPacketTracerModel("Pc", "PC-PT").sourceKind).toBe("pc");
    expect(classifyPacketTracerModel("Server", "Server-PT").sourceKind).toBe("server");
    expect(classifyPacketTracerModel("Laptop", "Laptop-PT").sourceKind).toBe("laptop");
    expect(classifyPacketTracerModel("Hub", "Hub-PT").sourceKind).toBe("hub");
    expect(classifyPacketTracerModel("Cloud", "Cloud-PT").sourceKind).toBe("cloud");
  });

  it("falls back to the engine class when the model is unknown", () => {
    expect(classifyPacketTracerModel("Router", "SomeUnlistedChassis").sourceKind).toBe("router");
  });

  it("keeps an unknown device rather than losing it", () => {
    const result = classifyPacketTracerModel("Power Distribution Device", "Power Distribution Device");
    expect(result.sourceKind).toBe("external-appliance");
    expect(result.matched).toBe(false);
    expect(result.note).toContain("Unsupported Packet Tracer model");
  });

  it("widens a switch profile rather than under-sizing it", () => {
    // A chassis reporting 52 ports must not be given a 24-port profile: the
    // lab's own cabling would not fit.
    const result = classifyPacketTracerModel("Switch", "2960-24TT", 52);
    expect(result.accessPorts).toBe(48);
    expect(result.note).toContain("widened");
  });
});

describe("parsePacketTracerInterfaceName", () => {
  it("abbreviates full Packet Tracer names", () => {
    expect(parsePacketTracerInterfaceName("FastEthernet0/1")?.abbreviated).toBe("Fa0/1");
    expect(parsePacketTracerInterfaceName("GigabitEthernet0/0")?.abbreviated).toBe("Gi0/0");
    expect(parsePacketTracerInterfaceName("TenGigabitEthernet1/0/1")?.abbreviated).toBe("Te1/0/1");
    expect(parsePacketTracerInterfaceName("Serial0/0/0")?.abbreviated).toBe("Se0/0/0");
  });

  it("passes an already-abbreviated name through", () => {
    expect(parsePacketTracerInterfaceName("Gi0/1")?.abbreviated).toBe("Gi0/1");
  });

  it("declines a name whose media it does not know", () => {
    expect(parsePacketTracerInterfaceName("UnknownModule0/1")).toBeUndefined();
    expect(parsePacketTracerInterfaceName("")).toBeUndefined();
  });
});

describe("resolveInterfaceOnDevice", () => {
  const switchPorts = ["Fa0/1", "Fa0/2", "Fa0/24", "Gi0/1", "Gi0/2"];

  it("resolves by exact and abbreviated name", () => {
    expect(resolveInterfaceOnDevice("Fa0/2", switchPorts)).toBe("Fa0/2");
    expect(resolveInterfaceOnDevice("FastEthernet0/24", switchPorts)).toBe("Fa0/24");
    expect(resolveInterfaceOnDevice("GigabitEthernet0/1", switchPorts)).toBe("Gi0/1");
  });

  it("maps a host port positionally, because a host has no slots to confuse", () => {
    expect(resolveInterfaceOnDevice("FastEthernet0", ["eth0"])).toBe("eth0");
    expect(resolveInterfaceOnDevice("FastEthernet0", ["eth0", "eth1"], 1)).toBe("eth1");
    expect(resolveInterfaceOnDevice("Wireless0", ["wlan0", "eth0"])).toBe("wlan0");
  });

  it("refuses to place an interface the device does not have", () => {
    // The alternative — quietly picking a free port — would rewire the lab.
    expect(resolveInterfaceOnDevice("FastEthernet0/48", switchPorts)).toBeUndefined();
    expect(resolveInterfaceOnDevice("UnknownModule0/1", switchPorts)).toBeUndefined();
  });
});

/**
 * Speed substitution. A real Packet Tracer router lab is cabled on
 * `FastEthernet0/0`, where SimulatorNet's router has `Gi0/0`; without this the
 * most common lab of all imports with no cables at all.
 */
describe("resolvePacketTracerInterface", () => {
  const routerPorts = ["Gi0/0", "Gi0/1"];

  it("reports how an interface was matched", () => {
    expect(resolvePacketTracerInterface("Gi0/0", routerPorts)).toEqual({ id: "Gi0/0", match: "exact" });
    expect(resolvePacketTracerInterface("GigabitEthernet0/1", routerPorts))
      .toEqual({ id: "Gi0/1", match: "abbreviated" });
  });

  it("substitutes another Ethernet speed at the same position", () => {
    expect(resolvePacketTracerInterface("FastEthernet0/0", routerPorts))
      .toEqual({ id: "Gi0/0", match: "ethernet-speed" });
    expect(resolvePacketTracerInterface("Ethernet0/1", routerPorts))
      .toEqual({ id: "Gi0/1", match: "ethernet-speed" });
  });

  it("never moves the cable to a different position", () => {
    // 0/2 does not exist; the answer is nothing, not the nearest free port.
    expect(resolvePacketTracerInterface("FastEthernet0/2", routerPorts)).toBeUndefined();
    expect(resolvePacketTracerInterface("FastEthernet1/0", routerPorts)).toBeUndefined();
  });

  it("never crosses a medium", () => {
    // SimulatorNet has no serial interface, so a serial link stays unplaced
    // rather than becoming an Ethernet one.
    expect(resolvePacketTracerInterface("Serial0/0", routerPorts)).toBeUndefined();
    expect(resolvePacketTracerInterface("Serial0/0/0", ["Gi0/0/0"])).toBeUndefined();
    expect(resolvePacketTracerInterface("Loopback0/1", ["Gi0/1"])).toBeUndefined();
    expect(resolvePacketTracerInterface("Vlan0/1", ["Gi0/1"])).toBeUndefined();
  });

  it("leaves an unslotted host port to the positional rule", () => {
    // "FastEthernet0" against "eth0" is a coincidence of digits, not a slot,
    // and the second host port must still be reachable by ordinal.
    expect(resolvePacketTracerInterface("FastEthernet0", ["eth0", "eth1"], 1))
      .toEqual({ id: "eth1", match: "positional" });
  });

  it("prefers an exact media match over a substitution", () => {
    // Both Fa0/1 and Gi0/1 exist; the name says Fast, so it must not be moved
    // onto the uplink just because Gi is listed first.
    expect(resolvePacketTracerInterface("FastEthernet0/1", ["Gi0/1", "Fa0/1"]))
      .toEqual({ id: "Fa0/1", match: "abbreviated" });
  });

  it("picks a stable speed when several could serve", () => {
    // Ordered by the prefix table, not by however the profile listed its ports.
    expect(resolvePacketTracerInterface("FastEthernet0/1", ["Eth0/1", "Gi0/1", "Te0/1"]))
      .toEqual({ id: "Te0/1", match: "ethernet-speed" });
    expect(resolvePacketTracerInterface("FastEthernet0/1", ["Eth0/1", "Gi0/1"]))
      .toEqual({ id: "Gi0/1", match: "ethernet-speed" });
  });
});

describe("normalizeCoordinates", () => {
  it("translates to a margin while preserving relative placement", () => {
    const result = normalizeCoordinates([{ x: 300, y: 400 }, { x: 500, y: 400 }, { x: 300, y: 600 }]);
    expect(result.empty).toBe(false);
    expect(result.scale).toBe(1);
    const [a, b, c] = result.points as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    expect(b.x - a.x).toBe(200);
    expect(c.y - a.y).toBe(200);
    expect(a.x).toBe(80);
  });

  it("shrinks a sprawling canvas but never magnifies a compact one", () => {
    const sprawling = normalizeCoordinates([{ x: 0, y: 0 }, { x: 8_000, y: 0 }]);
    expect(sprawling.scale).toBeLessThan(1);
    const compact = normalizeCoordinates([{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    expect(compact.scale).toBe(1);
  });

  it("reports an absence of coordinates instead of piling devices at the origin", () => {
    const result = normalizeCoordinates([undefined, { x: undefined, y: undefined }]);
    expect(result.empty).toBe(true);
    expect(result.points).toEqual([undefined, undefined]);
  });

  it("ignores an absurd coordinate without discarding the rest", () => {
    const result = normalizeCoordinates([{ x: 10, y: 10 }, { x: 1e12, y: 0 }]);
    expect(result.empty).toBe(false);
    expect(result.points[1]).toBeUndefined();
  });
});

import type { LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { createSimulationWorkerRuntime } from "../src/runtime";
import type {
  DiscoveryNeighborsView,
  EtherChannelView,
  OspfDatabaseView,
  OspfInterfacesView,
  OspfNeighborsView,
  OspfOverviewView,
  SimWorkerRequest,
  SpanningTreeView,
} from "../src/protocol";

const switchPorts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `Gi0/${index + 1}` }));

function labWithSwitches(): LabDocument {
  return canonicalizeLabDocument({
    schemaVersion: 1,
    id: "worker-protocols",
    title: "Worker control protocols",
    simulation: { seed: 21 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: switchPorts(3) },
        { id: "sw2", kind: "l2-switch", name: "SW2", interfaces: switchPorts(3) },
      ],
      links: [
        { id: "l1", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } },
        { id: "l2", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "sw2", iface: "Gi0/2" } },
      ],
    },
    configurations: {
      sw1: {
        kind: "l2-switch",
        hostname: "SW1",
        vlans: [],
        interfaces: [],
        spanningTree: { mode: "stp" },
        etherChannels: [],
        discovery: { cdpEnabled: true, lldpEnabled: true },
      },
      sw2: {
        kind: "l2-switch",
        hostname: "SW2",
        vlans: [],
        interfaces: [],
        spanningTree: { mode: "stp", ports: [{ interfaceId: "Gi0/2", portFast: true, bpduGuard: true }] },
        etherChannels: [],
        discovery: { cdpEnabled: true, lldpEnabled: true },
      },
    },
  } as unknown as LabDocument);
}

function labWithRouters(): LabDocument {
  const ospf = (hostname: string, routerId: string, address: string) => ({
    kind: "router",
    hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address, prefixLength: 24 } }],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: routerId, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 }],
      passiveInterfaces: ["Loopback0"],
      interfaces: [{ interfaceId: "Gi0/0", networkType: "point-to-point" }],
    },
  });
  return canonicalizeLabDocument({
    schemaVersion: 1,
    id: "worker-ospf",
    title: "Worker OSPF",
    simulation: { seed: 23 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      ],
      links: [{ id: "l1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } }],
    },
    configurations: {
      r1: ospf("R1", "1.1.1.1", "10.0.12.1"),
      r2: ospf("R2", "2.2.2.2", "10.0.12.2"),
    },
  } as unknown as LabDocument);
}

function runtimeFor(document: LabDocument) {
  const runtime = createSimulationWorkerRuntime();
  const send = <T>(request: Omit<SimWorkerRequest, "requestId">): T => {
    const response = runtime.handleRequest({ ...request, requestId: `req-${Math.random()}` });
    if (response.type === "REQUEST_FAILED") throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.payload as T;
  };
  send({ type: "INITIALIZE_LAB", document } as Omit<SimWorkerRequest, "requestId">);
  send({ type: "RUN_UNTIL_IDLE" } as Omit<SimWorkerRequest, "requestId">);
  return { runtime, send };
}

describe("Worker spanning-tree and EtherChannel views", () => {
  it("returns the spanning-tree state as plain JSON", () => {
    const { send } = runtimeFor(labWithSwitches());
    const view = send<SpanningTreeView>({ type: "GET_SPANNING_TREE_STATE", deviceId: "sw1" } as never);

    expect(view.deviceId).toBe("sw1");
    expect(view.summary.mode).toBe("stp");
    expect(view.summary.instances[0]!.ports.map((port) => port.port)).toContain("Gi0/1");
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("resets an error-disabled port and reconverges", () => {
    const { send } = runtimeFor(labWithSwitches());
    const before = send<SpanningTreeView>({ type: "GET_SPANNING_TREE_STATE", deviceId: "sw2" } as never);
    expect(before.summary.errorDisabledPorts).toEqual(["Gi0/2"]);

    const after = send<SpanningTreeView>({
      type: "RESET_BPDU_GUARD_PORT",
      deviceId: "sw2",
      interfaceId: "Gi0/2",
    } as never);
    expect(after.summary.errorDisabledPorts).not.toContain("Gi0/2");
  });

  it("rejects resetting a port that is not error-disabled", () => {
    const runtime = createSimulationWorkerRuntime();
    runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "r1", document: labWithSwitches() });
    runtime.handleRequest({ type: "RUN_UNTIL_IDLE", requestId: "r2" });
    const response = runtime.handleRequest({
      type: "RESET_BPDU_GUARD_PORT",
      requestId: "r3",
      deviceId: "sw1",
      interfaceId: "Gi0/1",
    });
    expect(response.type).toBe("REQUEST_FAILED");
  });

  it("returns the EtherChannel state", () => {
    const { send } = runtimeFor(labWithSwitches());
    const view = send<EtherChannelView>({ type: "GET_ETHERCHANNEL_STATE", deviceId: "sw1" } as never);
    expect(view).toEqual({ deviceId: "sw1", channels: [] });
  });
});

describe("Worker discovery views", () => {
  it("returns neighbours and per-interface status", () => {
    const { send } = runtimeFor(labWithSwitches());
    const view = send<DiscoveryNeighborsView>({ type: "GET_DISCOVERY_NEIGHBORS", deviceId: "sw1" } as never);

    expect(view.cdpRunning).toBe(true);
    expect(view.lldpRunning).toBe(true);
    expect(view.neighbors.map((neighbor) => neighbor.deviceId)).toContain("SW2");
    expect(view.interfaces.map((iface) => iface.id)).toContain("Gi0/3");
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("clears one protocol's table without touching the other", () => {
    const { send } = runtimeFor(labWithSwitches());
    const cleared = send<DiscoveryNeighborsView>({
      type: "CLEAR_DISCOVERY_NEIGHBORS",
      deviceId: "sw1",
      protocol: "cdp",
    } as never);
    expect(cleared.neighbors.every((neighbor) => neighbor.protocol === "lldp")).toBe(true);
    expect(cleared.neighbors.length).toBeGreaterThan(0);
  });
});

describe("Worker OSPF views", () => {
  it("returns the overview, neighbours, interfaces and database", () => {
    const { send } = runtimeFor(labWithRouters());

    const overview = send<OspfOverviewView>({ type: "GET_OSPF_OVERVIEW", deviceId: "r1" } as never);
    expect(overview.overview).toMatchObject({ running: true, routerId: "1.1.1.1", area: 0 });

    const neighbors = send<OspfNeighborsView>({ type: "GET_OSPF_NEIGHBORS", deviceId: "r1" } as never);
    expect(neighbors.neighbors[0]).toMatchObject({ neighborRouterId: "2.2.2.2", state: "full" });

    const interfaces = send<OspfInterfacesView>({ type: "GET_OSPF_INTERFACES", deviceId: "r1" } as never);
    expect(interfaces.interfaces.map((iface) => iface.interfaceId)).toEqual(["Gi0/0", "Loopback0"]);

    const database = send<OspfDatabaseView>({ type: "GET_OSPF_DATABASE", deviceId: "r1" } as never);
    expect(database.entries.length).toBeGreaterThanOrEqual(2);
    expect(database.routes.some((route) => route.network === "2.2.2.2")).toBe(true);
    expect(JSON.parse(JSON.stringify(database))).toEqual(database);
  });

  it("restarts the process and keeps the configuration", () => {
    const { send } = runtimeFor(labWithRouters());
    const restarted = send<OspfOverviewView>({ type: "RESTART_OSPF_PROCESS", deviceId: "r1" } as never);
    expect(restarted.overview.running).toBe(true);
    expect(restarted.overview.routerId).toBe("1.1.1.1");

    const neighbors = send<OspfNeighborsView>({ type: "GET_OSPF_NEIGHBORS", deviceId: "r1" } as never);
    expect(neighbors.neighbors[0]?.state).toBe("full");
  });

  it("refuses OSPF on a device that cannot run it", () => {
    const runtime = createSimulationWorkerRuntime();
    runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "r1", document: labWithSwitches() });
    const response = runtime.handleRequest({ type: "GET_OSPF_OVERVIEW", requestId: "r2", deviceId: "sw1" });
    expect(response.type).toBe("REQUEST_FAILED");
    if (response.type === "REQUEST_FAILED") expect(response.error.code).toBe("ospf-not-supported");
  });
});

describe("Worker serialization keeps runtime out of the document", () => {
  it("never writes elected roles, neighbours or the LSDB into the lab", () => {
    const { send } = runtimeFor(labWithRouters());
    const document = send<LabDocument>({ type: "SERIALIZE_LAB" } as never);
    const text = JSON.stringify(document);

    for (const runtimeField of ["\"full\"", "designatedRouter", "checksum", "linkStateId", "spfRuns", "lastSeenNs"]) {
      expect(text).not.toContain(runtimeField);
    }
    const r1 = document.configurations.r1!;
    if (r1.kind !== "router") throw new Error("expected a router");
    expect(r1.ospf).toMatchObject({ processId: 1, routerId: "1.1.1.1" });
  });
});

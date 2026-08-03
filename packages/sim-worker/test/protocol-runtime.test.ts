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
  BgpStateView,
  MplsL3VpnView,
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

function labWithBgpRouters(): LabDocument {
  const router = (hostname: string, address: string, localAs: number, remoteAddress: string, remoteAs: number, prefix: string) => ({
    kind: "router" as const, hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address, prefixLength: 30 } }],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: `${prefix}.1`, prefixLength: 24 } }],
    bgp: { localAs, routerId: localAs === 65_001 ? "1.1.1.1" : "2.2.2.2", neighbors: [{ address: remoteAddress, remoteAs, enabled: true }], networks: [{ network: `${prefix}.0`, prefixLength: 24 }] },
  });
  return canonicalizeLabDocument({
    schemaVersion: 1, id: "worker-bgp", title: "Worker BGP", simulation: { seed: 101 },
    topology: { schemaVersion: 1, nodes: [
      { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
      { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }] },
    ], links: [{ id: "r1-r2", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } }] },
    configurations: {
      r1: router("R1", "192.0.2.1", 65_001, "192.0.2.2", 65_002, "10.1.0"),
      r2: router("R2", "192.0.2.2", 65_002, "192.0.2.1", 65_001, "10.2.0"),
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

function labWithMplsRouters(): LabDocument {
  const router = (hostname: string, routerId: string, address: string) => ({
    kind: "router" as const,
    hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address, prefixLength: 30 }, mplsEnabled: true }],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: routerId, prefixLength: 32 } }],
    ospf: {
      processId: 1, routerId,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
      passiveInterfaces: ["Loopback0"],
      interfaces: [{ interfaceId: "Gi0/0", networkType: "point-to-point" as const }],
    },
    ldp: { routerIdInterface: "Loopback0" },
  });
  return canonicalizeLabDocument({
    schemaVersion: 1, id: "worker-mpls", title: "Worker MPLS", simulation: { seed: 10_111 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
        { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }] },
      ],
      links: [{ id: "core", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } }],
    },
    configurations: { r1: router("R1", "1.1.1.1", "192.0.2.1"), r2: router("R2", "2.2.2.2", "192.0.2.2") },
  } as unknown as LabDocument);
}

describe("Worker MPLS, LDP and L3VPN views", () => {
  it("returns plain JSON inspection with Operational LDP and deterministic LFIB data", () => {
    const { send } = runtimeFor(labWithMplsRouters());
    const view = send<MplsL3VpnView>({ type: "GET_MPLS_FORWARDING_TABLE", deviceId: "r1" } as never);
    expect(view.interfaces).toEqual([{ interfaceId: "Gi0/0", enabled: true, operational: true }]);
    expect(view.ldpNeighbors).toEqual([expect.objectContaining({ routerId: "2.2.2.2", state: "operational" })]);
    expect(view.ldpBindings.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("restarts LDP and reconstructs the same label bindings", () => {
    const { send } = runtimeFor(labWithMplsRouters());
    const before = send<MplsL3VpnView>({ type: "GET_LDP_BINDINGS", deviceId: "r1" } as never);
    const after = send<MplsL3VpnView>({ type: "RESTART_LDP", deviceId: "r1" } as never);
    expect(after.ldpNeighbors.map((entry) => entry.state)).toEqual(["operational"]);
    expect(after.ldpBindings).toEqual(before.ldpBindings);
    const reset = send<MplsL3VpnView>({ type: "RESET_MPLS_RUNTIME", deviceId: "r1" } as never);
    expect(reset.ldpBindings).toEqual(before.ldpBindings);
    expect(reset.forwardingTable).toEqual(after.forwardingTable);
  });

  it("rejects MPLS inspection for a non-Router with a stable typed error", () => {
    const runtime = createSimulationWorkerRuntime();
    const initialized = runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "init", document: labWithSwitches() });
    expect(initialized.type).toBe("REQUEST_SUCCEEDED");
    const response = runtime.handleRequest({ type: "GET_MPLS_INTERFACES", requestId: "inspect", deviceId: "sw1" });
    expect(response).toMatchObject({ type: "REQUEST_FAILED", error: { code: "mpls-not-supported" } });
  });
});

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

describe("Worker BGP inspection and actions", () => {
  it("returns plain-JSON summary, RIBs and policy counters", () => {
    const { send } = runtimeFor(labWithBgpRouters());
    const state = send<BgpStateView>({ type: "GET_BGP_STATE", deviceId: "r1" } as never);
    expect(state.configuration?.localAs).toBe(65_001);
    expect(state.neighbors[0]).toMatchObject({ address: "192.0.2.2", state: "established" });
    expect(state.adjRibIn.some((route) => route.network === "10.2.0.0")).toBe(true);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("supports the typed overview/table/policy adapter requests", () => {
    const { send } = runtimeFor(labWithBgpRouters());
    for (const type of ["GET_BGP_OVERVIEW", "GET_BGP_SUMMARY", "GET_BGP_NEIGHBORS", "GET_BGP_TABLE", "GET_PREFIX_LIST_STATUS", "GET_ROUTE_MAP_STATUS"] as const) {
      expect(send<BgpStateView>({ type, deviceId: "r1" } as never).deviceId).toBe("r1");
    }
  });

  it("resets one neighbor or the whole process without changing configuration", () => {
    const { send } = runtimeFor(labWithBgpRouters());
    const neighbor = send<BgpStateView>({ type: "RESET_BGP_NEIGHBOR", deviceId: "r1", neighbor: "192.0.2.2" } as never);
    expect(neighbor.neighbors[0]?.state).toBe("established");
    const process = send<BgpStateView>({ type: "RESET_BGP_PROCESS", deviceId: "r1" } as never);
    expect(process.configuration?.neighbors).toHaveLength(1);
    expect(process.neighbors[0]?.state).toBe("established");
  });

  it("serializes configuration but excludes sessions and learned RIB state", () => {
    const { send } = runtimeFor(labWithBgpRouters());
    const document = send<LabDocument>({ type: "SERIALIZE_LAB" } as never);
    const text = JSON.stringify(document);
    expect(document.configurations.r1 && "bgp" in document.configurations.r1 ? document.configurations.r1.bgp?.localAs : undefined).toBe(65_001);
    expect(text).not.toMatch(/adjRib|locRib|established|messagesReceived|policyCounters/i);
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

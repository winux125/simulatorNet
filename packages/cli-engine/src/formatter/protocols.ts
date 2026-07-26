import {
  type L2Switch,
  type Layer3Switch,
  type NeighborDiscovery,
  NS_PER_S,
  type Router,
} from "@sim/sim-core";
import { table } from "./tables";

/**
 * `show` output for the M10.4 control protocols. The formatters only read
 * public inspection APIs — no protocol logic lives here.
 */

const seconds = (value: number): string => `${Math.round(value / NS_PER_S)}`;

function maskLength(maskInt: number): number {
  let value = maskInt >>> 0;
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}

// --- spanning tree ---------------------------------------------------------

function renderInstance(device: L2Switch, vlanId: number): string[] {
  const summary = device.spanningTreeSummary();
  const instance = summary.instances.find((entry) => entry.vlanId === vlanId);
  if (!instance) return [`% No spanning tree instance for VLAN ${vlanId}.`];
  const label = summary.mode === "rstp" ? "RSTP" : "STP";
  const lines = [
    `VLAN${String(vlanId).padStart(4, "0")}`,
    `  Spanning tree enabled protocol ${summary.mode === "rstp" ? "rstp" : "ieee"} (${label})`,
    instance.isRoot
      ? `  Root ID    Priority ${instance.bridgePriority + vlanId}  This bridge is the root`
      : `  Root ID    Priority/Address ${instance.rootId}  Cost ${instance.rootPathCost}  Port ${instance.rootPort ?? "-"}`,
    `  Bridge ID  Priority/Address ${instance.bridgeId}`,
    `  Timers     Hello ${seconds(instance.helloTimeNs)}  Max age ${seconds(instance.maxAgeNs)}  Forward delay ${seconds(instance.forwardDelayNs)}`,
    `  Topology changes ${instance.topologyChanges}`,
    "",
  ];
  lines.push(table(
    ["Interface", "Role", "State", "Cost", "Prio.Nbr", "Type"],
    instance.ports.map((port) => [
      port.port,
      port.role,
      port.state,
      String(port.cost),
      port.portId,
      port.errorDisabled ? "err-disabled" : port.edge ? "edge" : "p2p",
    ]),
  ));
  return lines;
}

export function showSpanningTree(device: L2Switch): string {
  const summary = device.spanningTreeSummary();
  if (summary.mode === "disabled") return "% Spanning tree is disabled. Use 'spanning-tree mode pvst' to enable it.";
  if (summary.instances.length === 0) return "% No active spanning tree instances.";
  return summary.instances.flatMap((instance) => renderInstance(device, instance.vlanId)).join("\n").trimEnd();
}

export function showSpanningTreeVlan(device: L2Switch, vlanId: number): string {
  if (device.spanningTreeMode === "disabled") return "% Spanning tree is disabled.";
  return renderInstance(device, vlanId).join("\n").trimEnd();
}

export function showSpanningTreeSummary(device: L2Switch): string {
  const summary = device.spanningTreeSummary();
  if (summary.mode === "disabled") return "% Spanning tree is disabled.";
  const rows = summary.instances.map((instance) => {
    const counts = { blocking: 0, listening: 0, learning: 0, forwarding: 0 };
    for (const port of instance.ports) {
      if (port.state === "blocking" || port.state === "discarding") counts.blocking++;
      else if (port.state === "listening") counts.listening++;
      else if (port.state === "learning") counts.learning++;
      else if (port.state === "forwarding") counts.forwarding++;
    }
    return [
      `VLAN${String(instance.vlanId).padStart(4, "0")}`,
      String(counts.blocking),
      String(counts.listening),
      String(counts.learning),
      String(counts.forwarding),
      instance.isRoot ? "root" : "non-root",
    ];
  });
  return [
    `Switch is in ${summary.mode === "rstp" ? "rapid-pvst" : "pvst"} mode`,
    `Bridge MAC address is ${summary.bridgeMac}`,
    summary.errorDisabledPorts.length > 0
      ? `Error-disabled ports: ${summary.errorDisabledPorts.join(", ")}`
      : "No error-disabled ports",
    "",
    table(["Name", "Blocking", "Listening", "Learning", "Forwarding", "Role"], rows),
  ].join("\n");
}

export function showSpanningTreeInterface(device: L2Switch, interfaceName: string): string {
  const summary = device.spanningTreeSummary();
  if (summary.mode === "disabled") return "% Spanning tree is disabled.";
  const rows = summary.instances.flatMap((instance) => instance.ports
    .filter((port) => port.port.toLowerCase() === interfaceName.toLowerCase())
    .map((port) => [
      `VLAN${String(instance.vlanId).padStart(4, "0")}`,
      port.role,
      port.state,
      String(port.cost),
      port.portId,
    ]));
  if (rows.length === 0) return `% ${interfaceName} does not take part in spanning tree.`;
  return table(["Vlan", "Role", "State", "Cost", "Prio.Nbr"], rows);
}

// --- EtherChannel ----------------------------------------------------------

const MEMBER_FLAGS: Readonly<Record<string, string>> = {
  distributing: "P",
  collecting: "C",
  attached: "w",
  waiting: "w",
  detached: "D",
  suspended: "s",
};

export function showEtherChannelSummary(device: L2Switch): string {
  const channels = device.etherChannelSummaries();
  if (channels.length === 0) return "% No EtherChannel is configured.";
  const rows = channels.map((channel) => [
    String(channel.channelId),
    `${channel.name}(${channel.status === "up" ? "SU" : "SD"})`,
    channel.protocol === "static" ? "-" : channel.protocol.toUpperCase(),
    channel.members.map((member) => `${member.port}(${MEMBER_FLAGS[member.state] ?? "?"})`).join(" "),
  ]);
  return [
    "Flags:  P - bundled in port-channel   s - suspended",
    "        D - down                      w - waiting to be aggregated",
    "",
    table(["Group", "Port-channel", "Protocol", "Ports"], rows),
  ].join("\n");
}

export function showEtherChannelPortChannel(device: L2Switch): string {
  const channels = device.etherChannelSummaries();
  if (channels.length === 0) return "% No EtherChannel is configured.";
  return channels.flatMap((channel) => [
    `${channel.name}`,
    `  Protocol       ${channel.protocol === "static" ? "-  (static on)" : channel.protocol.toUpperCase()}`,
    `  Mode           ${channel.mode}`,
    `  Status         ${channel.status}`,
    `  Minimum links  ${channel.minimumLinks}`,
    "",
    table(
      ["Port", "Mode", "State", "Bundled", "Partner", "Reason"],
      channel.members.map((member) => [
        member.port,
        member.mode,
        member.state,
        member.bundled ? "yes" : "no",
        member.partnerSystemId ?? "-",
        member.reason ?? "-",
      ]),
    ),
    "",
  ]).join("\n").trimEnd();
}

export function showInterfacesPortChannel(device: L2Switch): string {
  const channels = device.etherChannelSummaries();
  if (channels.length === 0) return "% No EtherChannel is configured.";
  return table(
    ["Port-channel", "Status", "Protocol", "Members", "Suspended"],
    channels.map((channel) => [
      channel.name,
      channel.status,
      channel.protocol,
      channel.activeMembers.join(", ") || "-",
      channel.suspendedMembers.join(", ") || "-",
    ]),
  );
}

function negotiationNeighbors(device: L2Switch, protocol: "lacp" | "pagp"): string {
  const rows = device.etherChannelSummaries()
    .filter((channel) => channel.protocol === protocol)
    .flatMap((channel) => channel.members
      .filter((member) => member.partnerSystemId !== undefined)
      .map((member) => [
        channel.name,
        member.port,
        member.partnerSystemId ?? "-",
        member.partnerPortId === undefined ? "-" : String(member.partnerPortId),
        member.partnerMode ?? "-",
        member.state,
      ]));
  if (rows.length === 0) return `% No ${protocol.toUpperCase()} neighbours have been learned.`;
  return table(["Channel", "Port", "Partner Device", "Partner Port", "Mode", "State"], rows);
}

export function showLacpNeighbor(device: L2Switch): string {
  return negotiationNeighbors(device, "lacp");
}

export function showPagpNeighbor(device: L2Switch): string {
  return negotiationNeighbors(device, "pagp");
}

// --- neighbour discovery ---------------------------------------------------

const CAPABILITY_CODES: Readonly<Record<string, string>> = {
  router: "R",
  switch: "S",
  bridge: "B",
  host: "H",
  station: "H",
};

function neighborRows(discovery: NeighborDiscovery, protocol: "cdp" | "lldp") {
  return discovery.neighborTable().filter((neighbor) => neighbor.protocol === protocol);
}

export function showCdpNeighbors(discovery: NeighborDiscovery, detail: boolean): string {
  if (!discovery.cdpRunning) return "% CDP is not enabled. Use 'cdp run' to start it.";
  const neighbors = neighborRows(discovery, "cdp");
  if (neighbors.length === 0) return "% No CDP neighbours have been discovered yet.";
  if (!detail) {
    return [
      "Capability Codes: R - Router, S - Switch, B - Bridge, H - Host",
      "",
      table(
        ["Device ID", "Local Intrfce", "Holdtme", "Capability", "Platform", "Port ID"],
        neighbors.map((neighbor) => [
          neighbor.deviceId,
          neighbor.localInterface,
          seconds(neighbor.holdTimeNs),
          neighbor.capabilities.map((capability) => CAPABILITY_CODES[capability] ?? "?").join(" "),
          neighbor.platform,
          neighbor.remoteInterface,
        ]),
      ),
    ].join("\n");
  }
  return neighbors.flatMap((neighbor) => [
    "-------------------------",
    `Device ID: ${neighbor.deviceId}`,
    `Entry address(es): ${neighbor.managementAddress ?? "not advertised"}`,
    `Platform: ${neighbor.platform},  Capabilities: ${neighbor.capabilities.join(" ")}`,
    `Interface: ${neighbor.localInterface},  Port ID (outgoing port): ${neighbor.remoteInterface}`,
    `Holdtime: ${seconds(neighbor.holdTimeNs)} sec`,
    `Native VLAN: ${neighbor.nativeVlan ?? "not advertised"}`,
    `Version: ${neighbor.softwareVersion ?? "-"}`,
    "",
  ]).join("\n").trimEnd();
}

export function showCdpInterface(discovery: NeighborDiscovery): string {
  if (!discovery.cdpRunning) return "% CDP is not enabled.";
  return table(
    ["Interface", "Status", "CDP"],
    discovery.interfaceStatuses().map((iface) => [
      iface.id,
      iface.operationalUp ? "up" : "down",
      iface.cdpEnabled ? "enabled" : "disabled",
    ]),
  );
}

export function showLldpNeighbors(discovery: NeighborDiscovery, detail: boolean): string {
  if (!discovery.lldpRunning) return "% LLDP is not enabled. Use 'lldp run' to start it.";
  const neighbors = neighborRows(discovery, "lldp");
  if (neighbors.length === 0) return "% No LLDP neighbours have been discovered yet.";
  if (!detail) {
    return [
      "Capability codes: R - Router, S - Switch, B - Bridge, H - Station",
      "",
      table(
        ["Device ID", "Local Intf", "Hold-time", "Capability", "Port ID"],
        neighbors.map((neighbor) => [
          neighbor.deviceId,
          neighbor.localInterface,
          seconds(neighbor.holdTimeNs),
          neighbor.capabilities.map((capability) => CAPABILITY_CODES[capability] ?? "?").join(" "),
          neighbor.remoteInterface,
        ]),
      ),
    ].join("\n");
  }
  return neighbors.flatMap((neighbor) => [
    "------------------------------------------------",
    `Local Intf: ${neighbor.localInterface}`,
    `Chassis id: ${neighbor.deviceId}`,
    `Port id: ${neighbor.remoteInterface}`,
    `Port Description: ${neighbor.portDescription ?? "-"}`,
    `System Name: ${neighbor.deviceId}`,
    `System Description: ${neighbor.systemDescription ?? "-"}`,
    `Management Address: ${neighbor.managementAddress ?? "not advertised"}`,
    `Time remaining: ${seconds(Math.max(0, neighbor.expiresAtNs - neighbor.lastSeenNs))} seconds`,
    "",
  ]).join("\n").trimEnd();
}

export function showLldpInterface(discovery: NeighborDiscovery): string {
  if (!discovery.lldpRunning) return "% LLDP is not enabled.";
  return table(
    ["Interface", "Status", "Tx", "Rx"],
    discovery.interfaceStatuses().map((iface) => [
      iface.id,
      iface.operationalUp ? "up" : "down",
      iface.lldpTransmit ? "enabled" : "disabled",
      iface.lldpReceive ? "enabled" : "disabled",
    ]),
  );
}

// --- OSPF ------------------------------------------------------------------

export function showOspfOverview(device: Router | Layer3Switch): string {
  const overview = device.ospf.overview();
  if (!overview.running) return "% OSPF is not running. Use 'router ospf <process-id>' to start it.";
  const lines = [
    `Routing Process "ospf ${overview.processId}" with ID ${overview.routerId ?? "unassigned"}`,
    `  Router ID source: ${overview.routerIdSource}`,
    `  Area ${overview.area} (backbone) — the only area this release supports`,
    `  Number of LSAs in the database: ${overview.lsaCount}`,
    `  Number of neighbours: ${overview.neighborCount}`,
    `  SPF algorithm executed ${overview.spfRuns} times`,
    `  Default interface cost: ${overview.defaultCost}`,
  ];
  if (overview.problems.length > 0) {
    lines.push("  Problems:");
    for (const problem of overview.problems) lines.push(`    ${problem}`);
  }
  return lines.join("\n");
}

export function showOspfNeighbor(device: Router | Layer3Switch, detail: boolean): string {
  const neighbors = device.ospf.neighborSummaries();
  if (!device.ospf.enabled) return "% OSPF is not running.";
  if (neighbors.length === 0) return "% No OSPF neighbours.";
  if (!detail) {
    return table(
      ["Neighbor ID", "Pri", "State", "Dead Time", "Address", "Interface"],
      neighbors.map((neighbor) => [
        neighbor.neighborRouterId,
        String(neighbor.priority),
        `${neighbor.state}/${neighbor.role.toUpperCase()}`,
        seconds(neighbor.deadTimeNs),
        neighbor.address,
        neighbor.interfaceId,
      ]),
    );
  }
  return neighbors.flatMap((neighbor) => [
    ` Neighbor ${neighbor.neighborRouterId}, interface address ${neighbor.address}`,
    `    In the area 0 via interface ${neighbor.interfaceId}`,
    `    Neighbor priority is ${neighbor.priority}, State is ${neighbor.state}, role ${neighbor.role}`,
    `    Dead timer due in ${seconds(neighbor.deadTimeNs)} sec`,
    "",
  ]).join("\n").trimEnd();
}

export function showOspfInterface(device: Router | Layer3Switch): string {
  if (!device.ospf.enabled) return "% OSPF is not running.";
  const interfaces = device.ospf.interfaceSummaries();
  if (interfaces.length === 0) return "% No interfaces are running OSPF.";
  return interfaces.flatMap((iface) => [
    `${iface.interfaceId} is ${iface.state === "down" ? "down" : "up"}, line protocol is ${iface.state === "down" ? "down" : "up"}`,
    `  Internet Address ${iface.address ?? "unassigned"}, Area ${iface.area}`,
    `  Process ID ${device.ospf.currentProcessId}, Cost ${iface.cost}, Network type ${iface.networkType}`,
    `  State ${iface.state}, Priority ${iface.priority}${iface.passive ? " (passive)" : ""}`,
    `  Designated Router id ${iface.designatedRouter ?? "none"}, Backup ${iface.backupDesignatedRouter ?? "none"}`,
    `  Timer intervals: Hello ${seconds(iface.helloIntervalNs)}, Dead ${seconds(iface.deadIntervalNs)}`,
    `  Neighbour count is ${iface.neighborCount}`,
    "",
  ]).join("\n").trimEnd();
}

export function showOspfInterfaceBrief(device: Router | Layer3Switch): string {
  if (!device.ospf.enabled) return "% OSPF is not running.";
  const interfaces = device.ospf.interfaceSummaries();
  if (interfaces.length === 0) return "% No interfaces are running OSPF.";
  return table(
    ["Interface", "PID", "Area", "IP Address/Mask", "Cost", "State", "Nbrs F/C"],
    interfaces.map((iface) => [
      iface.interfaceId,
      String(device.ospf.currentProcessId),
      String(iface.area),
      iface.address ?? "-",
      String(iface.cost),
      iface.state.toUpperCase(),
      `${iface.neighborCount}/${iface.neighborCount}`,
    ]),
  );
}

export function showOspfDatabase(device: Router | Layer3Switch): string {
  if (!device.ospf.enabled) return "% OSPF is not running.";
  const entries = device.ospf.database();
  if (entries.length === 0) return "% The link-state database is empty.";
  const overview = device.ospf.overview();
  return [
    `            OSPF Router with ID (${overview.routerId ?? "unassigned"})`,
    "",
    table(
      ["Type", "Link ID", "ADV Router", "Age", "Seq#", "Checksum", "Link count"],
      entries.map((entry) => [
        entry.type,
        entry.linkStateId,
        entry.advertisingRouter,
        seconds(entry.ageNs),
        `0x${entry.sequence.toString(16).toUpperCase()}`,
        `0x${entry.checksum.toString(16).toUpperCase()}`,
        String(entry.linkCount),
      ]),
    ),
  ].join("\n");
}

export { maskLength };

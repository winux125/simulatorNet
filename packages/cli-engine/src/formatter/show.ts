import {
  type Device,
  EndHost,
  EthernetBridge,
  L2Switch,
  Layer3Switch,
  Router,
} from "@sim/sim-core";
import { dashes, row } from "./tables";

function maskLen(maskInt: number): number {
  let n = maskInt >>> 0;
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

function ifStatus(adminUp: boolean, operUp: boolean): { status: string; protocol: string } {
  if (!adminUp) return { status: "administratively down", protocol: "down" };
  return { status: operUp ? "up" : "down", protocol: operUp ? "up" : "down" };
}

// --- switch shows --------------------------------------------------------

export function showVlanBrief(sw: L2Switch): string {
  const header = row([
    ["VLAN", 5],
    ["Name", 33],
    ["Status", 10],
    ["Ports", 0],
  ]);
  const underline = `${dashes(4)} ${dashes(32)} ${dashes(9)} ${dashes(31)}`;
  const lines = sw.vlanBrief().map((v) =>
    row([
      [String(v.id), 5],
      [v.name, 33],
      ["active", 10],
      [v.ports.join(", "), 0],
    ]),
  );
  return [header, underline, ...lines].join("\n");
}

export function showInterfacesTrunk(sw: L2Switch): string {
  const rows = sw.trunkSummary();
  if (rows.length === 0) return "";
  const header = row([
    ["Port", 12],
    ["Mode", 8],
    ["Native vlan", 14],
    ["Allowed vlans", 0],
  ]);
  const lines = rows.map((t) =>
    row([
      [t.port, 12],
      ["on", 8],
      [String(t.nativeVlan), 14],
      [t.allowedVlans === "all" ? "ALL" : t.allowedVlans.join(","), 0],
    ]),
  );
  return [header, ...lines].join("\n");
}

export function showMacAddressTable(sw: L2Switch): string {
  const header = row([
    ["Vlan", 6],
    ["Mac Address", 20],
    ["Type", 10],
    ["Ports", 0],
  ]);
  const underline = `${dashes(4)}   ${dashes(11)}         ${dashes(5)}    ${dashes(5)}`;
  const lines = sw.macAddressTable().map((e) =>
    row([
      [String(e.vlan), 6],
      [e.mac, 20],
      ["DYNAMIC", 10],
      [e.port, 0],
    ]),
  );
  return [header, underline, ...lines].join("\n");
}

export function showBridgeMacAddressTable(bridge: EthernetBridge): string {
  const header = row([["Mac Address", 20], ["Type", 10], ["Port", 0]]);
  const lines = bridge.macAddressTable().map((entry) =>
    row([[entry.mac, 20], ["DYNAMIC", 10], [entry.port, 0]]));
  return [header, ...lines].join("\n");
}

// --- router shows --------------------------------------------------------

export function showIpRoute(r: Router | Layer3Switch): string {
  const rows = r.routingTable();
  const body = rows.map((rt) => {
    const net = `${rt.network}/${maskLen(rt.maskInt)}`;
    if (rt.kind === "connected") {
      return `C    ${net} is directly connected, ${rt.egressName}`;
    }
    return `S    ${net} [1/0] via ${rt.viaIp}`;
  });
  const legend = "Codes: C - connected, S - static";
  return [legend, "", ...body].join("\n");
}

// --- shared shows --------------------------------------------------------

export function showIpInterfaceBrief(device: Device): string {
  const header = row([
    ["Interface", 24],
    ["IP-Address", 16],
    ["Status", 24],
    ["Protocol", 0],
  ]);
  const lines: string[] = [];
  if (device instanceof Layer3Switch) {
    const physical = new Map(device.routedInterfaceSummaries().map((entry) => [entry.name, entry]));
    for (const [name, iface] of device.interfaces) {
      const routed = physical.get(name);
      const { status, protocol } = ifStatus(iface.adminUp, iface.operationalUp);
      lines.push(row([[name, 24], [routed?.ip ?? "unassigned", 16], [status, 24], [protocol, 0]]));
    }
    for (const svi of device.sviSummaries()) {
      const { status, protocol } = ifStatus(svi.adminUp, svi.operUp);
      lines.push(row([[svi.name, 24], [svi.ip ?? "unassigned", 16], [status, 24], [protocol, 0]]));
    }
  } else if (device instanceof Router) {
    for (const i of device.interfaceSummaries()) {
      const { status, protocol } = ifStatus(i.adminUp, i.operUp);
      lines.push(row([[i.name, 24], [i.ip ?? "unassigned", 16], [status, 24], [protocol, 0]]));
    }
  } else if (device instanceof EndHost) {
    const iface = device.primary;
    const up = iface?.operationalUp ?? false;
    lines.push(row([[iface?.name ?? "eth0", 24], [device.ip ?? "unassigned", 16], [up ? "up" : "down", 24], [up ? "up" : "down", 0]]));
  } else {
    for (const [name, iface] of device.interfaces) {
      const { status, protocol } = ifStatus(iface.adminUp, iface.operationalUp);
      lines.push(row([[name, 24], ["unassigned", 16], [status, 24], [protocol, 0]]));
    }
  }
  return [header, ...lines].join("\n");
}

export function showInterfaces(device: Device): string {
  const blocks: string[] = [];
  for (const [name, iface] of device.interfaces) {
    const { status, protocol } = ifStatus(iface.adminUp, iface.operationalUp);
    const block = [`${name} is ${status}, line protocol is ${protocol}`];
    if (iface.description !== undefined) block.push(`  Description: ${iface.description}`);
    block.push(`  Hardware address is ${iface.mac}`);
    blocks.push(block.join("\n"));
  }
  return blocks.join("\n");
}

export function showArp(device: Device): string {
  const header = row([
    ["Protocol", 10],
    ["Address", 18],
    ["Age (min)", 12],
    ["Hardware Addr", 20],
    ["Type", 0],
  ]);
  const entries: Array<[string, string]> = [];
  if (device instanceof EndHost || device instanceof Router || device instanceof Layer3Switch) {
    for (const [ip, mac] of device.arpTable) entries.push([ip, mac]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const lines = entries.map(([ip, mac]) =>
    row([["Internet", 10], [ip, 18], ["-", 12], [mac, 20], ["ARPA", 0]]),
  );
  return [header, ...lines].join("\n");
}

// --- running-config ------------------------------------------------------
//
// `show running-config` is no longer rendered here. Configuration text is a
// projection of structured `DeviceConfig` produced by `@sim/device-config`, so
// the browser, the verifier, a `.cfg` export and a startup snapshot all read
// the same bytes. The CLI reaches it through the injected
// `DeviceConfigurationService` (see `commands/configuration.ts`).


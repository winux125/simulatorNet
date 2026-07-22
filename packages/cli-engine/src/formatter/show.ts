import { type Device, intToIp, L2Switch, Pc, Router } from "@sim/sim-core";
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

// --- router shows --------------------------------------------------------

export function showIpRoute(r: Router): string {
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
  if (device instanceof Router) {
    for (const i of device.interfaceSummaries()) {
      const { status, protocol } = ifStatus(i.adminUp, i.operUp);
      lines.push(row([[i.name, 24], [i.ip ?? "unassigned", 16], [status, 24], [protocol, 0]]));
    }
  } else if (device instanceof Pc) {
    const iface = [...device.interfaces.values()][0];
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
  if (device instanceof Pc || device instanceof Router) {
    for (const [ip, mac] of device.arpTable) entries.push([ip, mac]);
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const lines = entries.map(([ip, mac]) =>
    row([["Internet", 10], [ip, 18], ["-", 12], [mac, 20], ["ARPA", 0]]),
  );
  return [header, ...lines].join("\n");
}

// --- running-config ------------------------------------------------------

export function showRunningConfig(device: Device): string {
  const out: string[] = ["!", `hostname ${device.name}`, "!"];
  if (device instanceof L2Switch) {
    for (const v of device.vlanBrief()) {
      if (v.id === 1) continue;
      out.push(`vlan ${v.id}`, ` name ${v.name}`, "!");
    }
    for (const p of device.portSummaries()) {
      out.push(`interface ${p.name}`);
      if (p.description !== undefined) out.push(` description ${p.description}`);
      if (p.mode === "access") {
        if (p.accessVlan !== 1) {
          out.push(" switchport mode access", ` switchport access vlan ${p.accessVlan}`);
        }
      } else {
        out.push(" switchport mode trunk");
        if (p.nativeVlan !== 1) out.push(` switchport trunk native vlan ${p.nativeVlan}`);
        if (p.allowedVlans !== "all") out.push(` switchport trunk allowed vlan ${p.allowedVlans.join(",")}`);
      }
      if (!p.adminUp) out.push(" shutdown");
      out.push("!");
    }
  } else if (device instanceof Router) {
    for (const i of device.interfaceSummaries()) {
      out.push(`interface ${i.name}`);
      if (i.description !== undefined) out.push(` description ${i.description}`);
      if (i.vlan !== undefined) out.push(` encapsulation dot1Q ${i.vlan}${i.native ? " native" : ""}`);
      if (i.ip !== undefined) out.push(` ip address ${i.ip} ${intToIp(i.maskInt)}`);
      else out.push(" no ip address");
      if (!i.adminUp) out.push(" shutdown");
      out.push("!");
    }
    for (const rt of device.routingTable()) {
      if (rt.kind === "static") out.push(`ip route ${rt.network} ${intToIp(rt.maskInt)} ${rt.viaIp}`);
    }
    out.push("!");
  }
  out.push("end");
  return out.join("\n");
}

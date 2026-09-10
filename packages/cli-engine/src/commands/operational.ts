import { normalizeInterfaceName } from "@sim/contracts";
import { DEFAULT_OSPF_COST, ipToInt, ipv6Network, maskToInt, intToIp, type Device } from "@sim/sim-core";
import { ValidationError } from "../errors/errors";
import { showInterfaces, showIpRoute } from "../formatter/show";
import { table } from "../formatter/tables";
import type { CommandSpec } from "../types";
import { isLayer3Switch, isOspfDevice, isRouter, isRoutingDevice, isSwitch, parseIpv4, parseIpv6Prefix } from "./helpers";
import { securityCommands } from "./security";
import { managementCommands } from "./management";

function interfaceId(device: Device, input: string): string {
  const names = [...device.interfaces.keys()];
  if (isRoutingDevice(device)) names.push(...(isRouter(device) ? device.interfaceSummaries() : device.routedInterfaceSummaries()).map((r) => r.name));
  if (isSwitch(device)) names.push(...device.etherChannelConfigurations().map((c) => `Port-channel${c.channelId}`));
  if (isSwitch(device) && !isLayer3Switch(device)) {
    const svi = device.managementSviSummary();
    if (svi) names.push(svi.name);
  }
  if (isLayer3Switch(device)) names.push(...device.sviSummaries().map((svi) => `Vlan${svi.vlanId}`));
  const id = names.find((name) => normalizeInterfaceName(name) === normalizeInterfaceName(input));
  if (!id) throw new ValidationError(`Interface ${input} not found.`);
  return id;
}

export const operationalCommands: CommandSpec[] = [
  {
    pattern: "show version", modes: ["exec", "privileged"], device: "network",
    run: (s) => [
      "SimulatorNet IOS-compatible CLI (educational simulation)",
      `Device: ${s.device.name} (${s.device.profile.displayName})`,
      `Interfaces: ${s.device.interfaces.size}`,
      `Simulation time: ${(s.engine.now() / 1e9).toFixed(3)} seconds`,
    ].join("\n"),
  },
  {
    pattern: "show history", modes: ["exec", "privileged"], device: "network",
    run: (s) => s.commandHistory().map((line) => "  " + line).join("\n"),
  },
  {
    pattern: "show interfaces {interface}", modes: ["exec", "privileged"], device: "network",
    run: (s, p) => {
      const id = interfaceId(s.device, p.interface!);
      if (s.device.interfaces.has(id)) return showInterfaces(s.device, id);
      if (isSwitch(s.device) && id.startsWith("Port-channel")) {
        const row = s.device.etherChannelSummaries().find((c) => c.channelId === Number(id.slice(12)));
        return row ? `${id} is ${row.status}, protocol ${row.protocol}\n  Members: ${row.members.map((member) => member.port).join(", ")}` : `${id}: no members`;
      }
      const row = isRouter(s.device) ? s.device.interfaceSummaries().find((r) => r.name === id)
        : isLayer3Switch(s.device) ? [...s.device.routedInterfaceSummaries(), ...s.device.sviSummaries()].find((r) => r.name === id) : isSwitch(s.device) ? s.device.managementSviSummary() : undefined;
      return row ? `${id} is ${row.adminUp ? row.operUp ? "up" : "down" : "administratively down"}\n  Internet address is ${row.ip ?? "unassigned"}`
        : `${id}: no interface status available`;
    },
  },
  {
    pattern: "show interfaces status", modes: ["exec", "privileged"], device: "switch",
    run: (s) => !isSwitch(s.device) ? "" : table(["Port", "Name", "Status", "Vlan"],
      [...s.device.interfaces].map(([name, iface]) => [name, iface.description ?? "",
        !iface.adminUp ? "disabled" : iface.operationalUp ? "connected" : "notconnect",
        isLayer3Switch(s.device) && s.device.isRoutedPort(name) ? "routed"
          : isSwitch(s.device) && s.device.portConfigOf(name).mode === "trunk" ? "trunk"
          : String(isSwitch(s.device) ? s.device.portConfigOf(name).accessVlan : "")])),
  },
  {
    pattern: "show interfaces switchport", modes: ["exec", "privileged"], device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => !isSwitch(s.device) ? "" : [...s.device.interfaces.keys()].map((name) => {
      if (!isSwitch(s.device)) return "";
      if (isLayer3Switch(s.device) && s.device.isRoutedPort(name)) return `Name: ${name}\nSwitchport: Disabled`;
      const cfg = s.device.portConfigOf(name);
      return [`Name: ${name}`, "Switchport: Enabled", `Administrative Mode: ${cfg.mode}`,
        `Access Mode VLAN: ${cfg.accessVlan}`, `Trunking Native Mode VLAN: ${cfg.nativeVlan}`,
        `Trunking VLANs Enabled: ${cfg.allowedVlans ? [...cfg.allowedVlans].sort((a,b) => a-b).join(",") || "none" : "all"}`].join("\n");
    }).join("\n\n"),
  },
  {
    pattern: "show ip route {prefix}", modes: ["exec", "privileged"], device: "router", capabilities: ["ipv4-routing"],
    run: (s, p) => {
      if (!isRoutingDevice(s.device)) return "";
      const [address, length] = p.prefix!.split("/");
      parseIpv4(address!);
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 32)) throw new ValidationError("Invalid IPv4 prefix.");
      const mask = length === undefined ? undefined : maskToInt(Number(length));
      const rows = s.device.routingTable().filter((row) => mask === undefined
        ? ((ipToInt(address!) & row.maskInt) >>> 0) === ipToInt(row.network)
        : row.maskInt === mask && ipToInt(row.network) === ((ipToInt(address!) & mask) >>> 0));
      const longest = length === undefined ? Math.max(...rows.map((r) => r.maskInt >>> 0)) : undefined;
      const selected = rows.filter((r) => longest === undefined || (r.maskInt >>> 0) === longest);
      return selected.length ? showIpRoute(s.device, selected) : "% Network not in table";
    },
  },
  {
    pattern: "show ipv6 route {prefix}", modes: ["exec", "privileged"], device: "router",
    run: (s, p) => {
      if (!isRoutingDevice(s.device)) return "";
      const prefix = parseIpv6Prefix(p.prefix!);
      const rows = s.device.ipv6RoutingTable().filter((r) => r.prefixLength === prefix.prefixLength
        && r.network === ipv6Network(prefix.network, prefix.prefixLength));
      return rows.length ? rows.map((r) => `${r.kind} ${r.network}/${r.prefixLength} via ${r.viaIp ?? "directly connected"}, ${r.egressName}`).join("\n") : "% Network not in table";
    },
  },
  {
    pattern: "show ip protocols", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => {
      if (!isOspfDevice(s.device)) return "";
      const ospf = s.device.ospf.overview();
      const bgp = s.device.bgp.configurationSnapshot();
      return [s.device.ospf.enabled ? `Routing Protocol is "ospf ${ospf.processId}", Router ID ${ospf.routerId}` : "",
        bgp ? `Routing Protocol is "bgp ${bgp.localAs}", ${(bgp.neighbors?.length ?? 0)} configured neighbors` : ""]
        .filter(Boolean).join("\n") || "No dynamic IPv4 routing protocols configured.";
    },
  },
  {
    pattern: "show ipv6 ospf neighbor detail", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => !isOspfDevice(s.device) ? "" : s.device.ospfv3.neighborSummaries().map((n) =>
      `Neighbor ${n.neighborRouterId}, interface ${n.interfaceId}\n  Address ${n.address}, state ${n.state}, role ${n.role}, priority ${n.priority}\n  Dead time ${(n.deadTimeNs / 1e9).toFixed(1)} seconds`).join("\n") || "No OSPFv3 neighbors.",
  },
  ...(["show ipv6 ospf interface", "show ipv6 ospf interface brief"] as const).map((pattern): CommandSpec => ({
    pattern, modes: ["exec", "privileged"], device: "ospf",
    run: (s) => !isOspfDevice(s.device) ? "" : table(["Interface", "Status", "OSPFv3", "Cost"],
      s.device.ipv6InterfaceSummaries().map((iface) => {
        const config = isOspfDevice(s.device) ? s.device.ospfv3.interfaceConfigurationOf(iface.name) : {};
        return [iface.name, iface.operUp ? "up" : "down", config.enabled ? "enabled" : "disabled", String(config.cost ?? DEFAULT_OSPF_COST)];
      })),
  })),
  {
    pattern: "show ip access-lists", modes: ["exec", "privileged"], device: "router",
    run: (s, p) => securityCommands.find((c) => c.pattern === "show access-lists")!.run(s, p),
  },
  {
    pattern: "show aaa", modes: ["exec", "privileged"], device: "managed",
    run: (s, p) => ["show aaa servers", "show aaa method-lists"].map((pattern) =>
      managementCommands.find((c) => c.pattern === pattern)!.run(s, p)).join("\n"),
  },
  {
    pattern: "show logging", modes: ["exec", "privileged"], device: "managed",
    run: (s) => ["SimulatorNet device event log (retained simulation trace)",
      ...s.engine.traceLog.filter((entry) => entry.device === s.device.id).slice(-100)
        .map((entry) => `${(entry.time / 1e9).toFixed(3)}: ${entry.type}`)].join("\n"),
  },
  {
    pattern: "show ip dhcp pool", modes: ["exec", "privileged"], device: "router", capabilities: ["dhcp-server"],
    run: (s) => !isRouter(s.device) ? "" : table(["Pool", "Network", "Range", "Leased"],
      s.device.dhcpPoolConfigurations().map((p) => [p.id, `${p.network} ${intToIp(p.maskInt)}`,
        `${p.rangeStart} - ${p.rangeEnd}`, String(isRouter(s.device) ? s.device.dhcpBindings().filter((b) => b.pool === p.id).length : 0)])),
  },
  {
    pattern: "show ip dhcp binding", modes: ["exec", "privileged"], device: "router", capabilities: ["dhcp-server"],
    run: (s) => !isRouter(s.device) ? "" : table(["IP address", "Client-ID/Hardware address", "Pool"],
      s.device.dhcpBindings().map((b) => [b.address, b.mac, b.pool])),
  },
  {
    pattern: "copy startup-config running-config", modes: ["privileged"], device: "network",
    run: () => { throw new ValidationError("Live startup-to-running configuration merge is not supported. Use reload to boot the saved configuration."); },
  },
];

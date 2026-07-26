import { IpProtocol } from "@sim/contracts";
import {
  Layer3Switch,
  Router,
  maskToInt,
  type AclAction,
  type AclDirection,
  type ExtendedAclRule,
  type Ipv4Acl,
  type Ipv4AddressMatcher,
  type NatRule,
  type PolicyProtocol,
  type StaticNatRule,
  type DynamicNatRule,
  type PatNatRule,
  type PortMatcher,
  type StandardAclRule,
} from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi } from "../types";
import { isLayer3Switch, isRoutingDevice, parseIpv4 } from "./helpers";

const SHOW_MODES = ["exec", "privileged"] as const;

function routingDevice(session: SessionApi): Router | Layer3Switch {
  if (!isRoutingDevice(session.device)) throw new InvalidModeError("A routing device is required.");
  return session.device;
}

function routerWithNat(session: SessionApi): Router {
  if (isLayer3Switch(session.device)) {
    throw new ValidationError("NAT is not supported on an L3 Switch.");
  }
  if (!(session.device instanceof Router)) throw new InvalidModeError("A Router or Firewall is required.");
  return session.device;
}

function action(token: string): AclAction {
  if (token === "permit" || token === "deny") return token;
  throw new ValidationError("ACL action must be permit or deny.");
}

function protocol(token: string): PolicyProtocol {
  if (token === "ip") return "ip";
  if (token === "icmp") return IpProtocol.ICMP;
  if (token === "tcp") return IpProtocol.TCP;
  if (token === "udp") return IpProtocol.UDP;
  throw new ValidationError(`Unsupported ACL protocol '${token}'.`);
}

function aclType(id: string): "standard" | "extended" {
  const number = Number(id);
  if (!Number.isInteger(number)) throw new ValidationError("Numbered ACL ID must be an integer.");
  if ((number >= 1 && number <= 99) || (number >= 1_300 && number <= 1_999)) {
    return "standard";
  }
  if ((number >= 100 && number <= 199) || (number >= 2_000 && number <= 2_699)) {
    return "extended";
  }
  throw new ValidationError("Numbered ACL ID must be in 1-199 or 1300-2699.");
}

function address(kind: "any"): Ipv4AddressMatcher;
function address(kind: "host", value: string): Ipv4AddressMatcher;
function address(kind: "network", value: string, wildcard: string): Ipv4AddressMatcher;
function address(kind: "any" | "host" | "network", value?: string, wildcard?: string): Ipv4AddressMatcher {
  if (kind === "any") return { kind };
  if (kind === "host") return { kind, address: parseIpv4(value!) };
  return { kind, address: parseIpv4(value!), wildcard: parseIpv4(wildcard!) };
}

function nextSequence(acl: Ipv4Acl | undefined): number {
  return Math.max(0, ...(acl?.rules.map((rule) => rule.sequence) ?? [])) + 10;
}

function replaceAcl(
  session: SessionApi,
  id: string,
  type: "standard",
  rule: Omit<StandardAclRule, "sequence">,
): void;
function replaceAcl(
  session: SessionApi,
  id: string,
  type: "extended",
  rule: Omit<ExtendedAclRule, "sequence">,
): void;
function replaceAcl(
  session: SessionApi,
  id: string,
  type: "standard" | "extended",
  rule: Omit<StandardAclRule, "sequence"> | Omit<ExtendedAclRule, "sequence">,
): void {
  const device = routingDevice(session);
  const existing = device.aclConfigurations().find((acl) => acl.id === id);
  if (existing && existing.type !== type) {
    throw new ValidationError(`ACL '${id}' is already defined as ${existing.type}.`);
  }
  const sequence = nextSequence(existing);
  if (type === "standard") {
    const prior = existing?.type === "standard" ? existing.rules : [];
    device.defineAcl({ id, type, rules: [...prior, { ...rule as Omit<StandardAclRule, "sequence">, sequence }] });
  } else {
    const prior = existing?.type === "extended" ? existing.rules : [];
    device.defineAcl({ id, type, rules: [...prior, { ...rule as Omit<ExtendedAclRule, "sequence">, sequence }] });
  }
}

function port(token: string): PortMatcher {
  const parsed = Number(token);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ValidationError("Port must be between 1 and 65535.");
  }
  return { kind: "eq", port: parsed };
}

function namedContext(session: SessionApi, expected: "standard" | "extended") {
  if (!session.aclCtx || session.aclCtx.type !== expected) {
    throw new InvalidModeError(`A named ${expected} ACL context is required.`);
  }
  return session.aclCtx;
}

function interfaceName(session: SessionApi): string {
  const context = session.ifaceCtx;
  if (!context) throw new InvalidModeError("No interface selected.");
  if (context.sviVlan !== undefined) return `Vlan${context.sviVlan}`;
  if (context.isSubinterface) {
    if (!context.subCreated || context.subVlan === undefined) {
      throw new ValidationError("Configure encapsulation before applying interface policy.");
    }
    return `${context.physical}.${context.subVlan}`;
  }
  return context.physical;
}

function showAccessLists(session: SessionApi): string {
  const device = routingDevice(session);
  const counters = device.aclCounters();
  const lines: string[] = [];
  for (const acl of device.aclConfigurations()) {
    lines.push(`${acl.type === "standard" ? "Standard" : "Extended"} IP access list ${acl.id}`);
    if (acl.type === "standard") {
      for (const rule of acl.rules) {
        const count = counters.find((entry) => entry.aclId === acl.id && entry.sequence === rule.sequence)?.matches ?? 0;
        lines.push(`    ${rule.sequence} ${rule.action} ${formatAddress(rule.source)} (${count} matches)`);
      }
    } else {
      for (const rule of acl.rules) {
        const count = counters.find((entry) => entry.aclId === acl.id && entry.sequence === rule.sequence)?.matches ?? 0;
        lines.push(
          `    ${rule.sequence} ${rule.action} ${formatProtocol(rule.protocol)} `
          + `${formatAddress(rule.source)} ${formatAddress(rule.destination)}`
          + `${rule.destinationPort ? ` ${formatPort(rule.destinationPort)}` : ""} (${count} matches)`,
        );
      }
    }
    const implicit = counters.find((entry) => entry.aclId === acl.id && entry.sequence === undefined)?.matches ?? 0;
    lines.push(`    implicit deny (${implicit} matches)`);
  }
  return lines.length > 0 ? lines.join("\n") : "No IPv4 access lists configured.";
}

function showIpInterface(session: SessionApi): string {
  const device = routingDevice(session);
  const bindings = device.aclBindings();
  const names = device instanceof Router
    ? device.interfaceSummaries().map((entry) => entry.name)
    : [
        ...device.routedInterfaceSummaries().map((entry) => entry.name),
        ...device.sviSummaries().map((entry) => entry.name),
      ];
  return names.sort().flatMap((name) => {
    const input = bindings.find((binding) => binding.interfaceName === name && binding.direction === "in");
    const output = bindings.find((binding) => binding.interfaceName === name && binding.direction === "out");
    const role = device instanceof Router ? device.natRole(name) : undefined;
    return [
      `${name} is configured`,
      `  Inbound access list is ${input?.aclId ?? "not set"}`,
      `  Outbound access list is ${output?.aclId ?? "not set"}`,
      ...(role ? [`  NAT role is ${role}`] : []),
    ];
  }).join("\n");
}

function formatAddress(matcher: Ipv4AddressMatcher): string {
  if (matcher.kind === "any") return "any";
  if (matcher.kind === "host") return `host ${matcher.address}`;
  return `${matcher.address} ${matcher.wildcard}`;
}

function formatProtocol(value: PolicyProtocol): string {
  if (value === "ip") return value;
  if (value === IpProtocol.ICMP) return "icmp";
  if (value === IpProtocol.TCP) return "tcp";
  return "udp";
}

function formatPort(matcher: PortMatcher): string {
  if (matcher.kind === "any") return "any";
  if (matcher.kind === "eq") return `eq ${matcher.port}`;
  return `range ${matcher.start} ${matcher.end}`;
}

function nextNatSequence(device: Router): number {
  return Math.max(0, ...device.natRuleConfigurations().map((rule) => rule.sequence)) + 10;
}

type NatRuleDraft =
  | Omit<StaticNatRule, "id" | "sequence">
  | Omit<DynamicNatRule, "id" | "sequence">
  | Omit<PatNatRule, "id" | "sequence">;

function defineNatRule(device: Router, rule: NatRuleDraft, id: string): void {
  device.defineNatRule({ ...rule, id, sequence: nextNatSequence(device) } as NatRule);
}

function showNatTranslations(session: SessionApi): string {
  const rows = routerWithNat(session).natTranslations();
  if (rows.length === 0) return "No active NAT translations.";
  return [
    "Pro  Inside global         Inside local          Outside",
    ...rows.map((entry) =>
      `${formatProtocol(entry.protocol)}  ${entry.insideGlobalAddress}:${entry.insideGlobalToken ?? ""}`
      + `  ${entry.insideLocalAddress}:${entry.insideLocalToken ?? ""}`
      + `  ${entry.remoteAddress ?? ""}:${entry.remoteToken ?? ""}`),
  ].join("\n");
}

function showNatStatistics(session: SessionApi): string {
  const device = routerWithNat(session);
  return [
    `Total active translations: ${device.natTranslations().length}`,
    `Configured pools: ${device.natPoolConfigurations().length}`,
    `Configured rules: ${device.natRuleConfigurations().length}`,
    `Inside interfaces: ${device.interfaceSummaries().filter((entry) => device.natRole(entry.name) === "inside").map((entry) => entry.name).join(", ") || "none"}`,
    `Outside interfaces: ${device.interfaceSummaries().filter((entry) => device.natRole(entry.name) === "outside").map((entry) => entry.name).join(", ") || "none"}`,
  ].join("\n");
}

export const securityCommands: CommandSpec[] = [
  {
    pattern: "ip access-list standard {name}",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const name = params.name!;
      const device = routingDevice(session);
      const current = device.aclConfigurations().find((acl) => acl.id === name);
      if (!current) device.defineAcl({ id: name, type: "standard", rules: [] });
      else if (current.type !== "standard") throw new ValidationError(`ACL '${name}' is extended.`);
      session.aclCtx = { id: name, type: "standard" };
      session.enter("config-acl");
    },
  },
  {
    pattern: "ip access-list extended {name}",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const name = params.name!;
      const device = routingDevice(session);
      const current = device.aclConfigurations().find((acl) => acl.id === name);
      if (!current) device.defineAcl({ id: name, type: "extended", rules: [] });
      else if (current.type !== "extended") throw new ValidationError(`ACL '${name}' is standard.`);
      session.aclCtx = { id: name, type: "extended" };
      session.enter("config-acl");
    },
  },
  {
    pattern: "access-list {acl} {action} any",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const type = aclType(params.acl!);
      if (type !== "standard") throw new ValidationError("Extended ACL requires protocol and destination.");
      replaceAcl(session, params.acl!, type, { action: action(params.action!), source: address("any") });
    },
  },
  {
    pattern: "access-list {acl} {action} host {source}",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const type = aclType(params.acl!);
      if (type !== "standard") throw new ValidationError("Extended ACL requires protocol and destination.");
      replaceAcl(session, params.acl!, type, {
        action: action(params.action!),
        source: address("host", params.source!),
      });
    },
  },
  {
    pattern: "access-list {acl} {action} {source} {wildcard}",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const type = aclType(params.acl!);
      if (type !== "standard") throw new ValidationError("Extended ACL requires protocol and destination.");
      replaceAcl(session, params.acl!, type, {
        action: action(params.action!),
        source: address("network", params.source!, params.wildcard!),
      });
    },
  },
  {
    pattern: "access-list {acl} {action} {protocol} any any",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      if (aclType(params.acl!) !== "extended") throw new ValidationError("Standard ACL cannot match a protocol.");
      replaceAcl(session, params.acl!, "extended", {
        action: action(params.action!),
        protocol: protocol(params.protocol!),
        source: address("any"),
        destination: address("any"),
      });
    },
  },
  {
    pattern: "access-list {acl} {action} {protocol} {source} {wildcard} any eq {port}",
    modes: ["config"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      if (aclType(params.acl!) !== "extended") throw new ValidationError("Standard ACL cannot match a protocol.");
      replaceAcl(session, params.acl!, "extended", {
        action: action(params.action!),
        protocol: protocol(params.protocol!),
        source: address("network", params.source!, params.wildcard!),
        destination: address("any"),
        destinationPort: port(params.port!),
      });
    },
  },
  {
    pattern: "permit any",
    modes: ["config-acl"],
    device: "router",
    run: (session) => {
      const context = namedContext(session, "standard");
      replaceAcl(session, context.id, "standard", { action: "permit", source: address("any") });
    },
  },
  {
    pattern: "deny any",
    modes: ["config-acl"],
    device: "router",
    run: (session) => {
      const context = namedContext(session, "standard");
      replaceAcl(session, context.id, "standard", { action: "deny", source: address("any") });
    },
  },
  {
    pattern: "permit {source} {wildcard}",
    modes: ["config-acl"],
    device: "router",
    run: (session, params) => {
      const context = namedContext(session, "standard");
      replaceAcl(session, context.id, "standard", {
        action: "permit",
        source: address("network", params.source!, params.wildcard!),
      });
    },
  },
  {
    pattern: "deny {source} {wildcard}",
    modes: ["config-acl"],
    device: "router",
    run: (session, params) => {
      const context = namedContext(session, "standard");
      replaceAcl(session, context.id, "standard", {
        action: "deny",
        source: address("network", params.source!, params.wildcard!),
      });
    },
  },
  {
    pattern: "permit {protocol} any host {destination} eq {port}",
    modes: ["config-acl"],
    device: "router",
    run: (session, params) => {
      const context = namedContext(session, "extended");
      replaceAcl(session, context.id, "extended", {
        action: "permit",
        protocol: protocol(params.protocol!),
        source: address("any"),
        destination: address("host", params.destination!),
        destinationPort: port(params.port!),
      });
    },
  },
  {
    pattern: "deny {protocol} any any",
    modes: ["config-acl"],
    device: "router",
    run: (session, params) => {
      const context = namedContext(session, "extended");
      replaceAcl(session, context.id, "extended", {
        action: "deny",
        protocol: protocol(params.protocol!),
        source: address("any"),
        destination: address("any"),
      });
    },
  },
  {
    pattern: "ip access-group {acl} {direction}",
    modes: ["config-if"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const direction = params.direction;
      if (direction !== "in" && direction !== "out") throw new ValidationError("Direction must be in or out.");
      routingDevice(session).applyAcl(interfaceName(session), direction as AclDirection, params.acl!);
    },
  },
  {
    pattern: "no ip access-group {acl} {direction}",
    modes: ["config-if"],
    device: "router",
    capabilities: ["packet-policy"],
    run: (session, params) => {
      const direction = params.direction;
      if (direction !== "in" && direction !== "out") throw new ValidationError("Direction must be in or out.");
      routingDevice(session).removeAclBinding(interfaceName(session), direction as AclDirection);
    },
  },
  {
    pattern: "show access-lists",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["packet-policy"],
    run: showAccessLists,
  },
  {
    pattern: "show ip interface",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["packet-policy"],
    run: showIpInterface,
  },
  {
    pattern: "ip nat inside",
    modes: ["config-if"],
    device: "router",
    capabilities: ["nat"],
    run: (session) => routerWithNat(session).setNatRole(interfaceName(session), "inside"),
  },
  {
    pattern: "ip nat outside",
    modes: ["config-if"],
    device: "router",
    capabilities: ["nat"],
    run: (session) => routerWithNat(session).setNatRole(interfaceName(session), "outside"),
  },
  {
    pattern: "no ip nat inside",
    modes: ["config-if"],
    device: "router",
    capabilities: ["nat"],
    run: (session) => routerWithNat(session).setNatRole(interfaceName(session), undefined),
  },
  {
    pattern: "no ip nat outside",
    modes: ["config-if"],
    device: "router",
    capabilities: ["nat"],
    run: (session) => routerWithNat(session).setNatRole(interfaceName(session), undefined),
  },
  {
    pattern: "ip nat inside source static {local} {global}",
    modes: ["config"],
    device: "router",
    capabilities: ["nat"],
    run: (session, params) => {
      const local = parseIpv4(params.local!);
      const global = parseIpv4(params.global!);
      defineNatRule(routerWithNat(session), {
        kind: "static",
        insideLocal: local,
        insideGlobal: global,
      }, `static:${local}`);
    },
  },
  {
    pattern: "ip nat pool {name} {start} {end} netmask {mask}",
    modes: ["config"],
    device: "router",
    capabilities: ["nat"],
    run: (session, params) => {
      const mask = maskToInt(parseIpv4(params.mask!));
      const inverse = (~mask) >>> 0;
      if ((inverse & ((inverse + 1) >>> 0)) !== 0) {
        throw new ValidationError("NAT pool netmask must contain contiguous bits.");
      }
      routerWithNat(session).defineNatPool({
        id: params.name!,
        startAddress: parseIpv4(params.start!),
        endAddress: parseIpv4(params.end!),
      });
    },
  },
  {
    pattern: "ip nat inside source list {acl} pool {pool}",
    modes: ["config"],
    device: "router",
    capabilities: ["nat"],
    run: (session, params) => defineNatRule(routerWithNat(session), {
      kind: "dynamic",
      source: { kind: "acl", aclId: params.acl! },
      poolId: params.pool!,
    }, `dynamic:${params.acl!}:${params.pool!}`),
  },
  {
    pattern: "ip nat inside source list {acl} interface {iface} overload",
    modes: ["config"],
    device: "router",
    capabilities: ["nat"],
    run: (session, params) => {
      const device = routerWithNat(session);
      if (!device.interfaceSummaries().some((entry) => entry.name.toLowerCase() === params.iface!.toLowerCase())) {
        throw new ValidationError(`Outside interface '${params.iface}' was not found.`);
      }
      defineNatRule(device, {
        kind: "pat",
        source: { kind: "acl", aclId: params.acl! },
        outsideAddress: "interface",
      }, `pat:${params.acl!}:${params.iface!}`);
    },
  },
  {
    pattern: "show ip nat translations",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["nat"],
    run: showNatTranslations,
  },
  {
    pattern: "show ip nat statistics",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["nat"],
    run: showNatStatistics,
  },
  {
    pattern: "clear ip nat translation *",
    modes: ["privileged"],
    device: "router",
    capabilities: ["nat"],
    run: (session) => {
      routerWithNat(session).resetNatRuntime();
      return "Dynamic NAT translations cleared.";
    },
  },
];

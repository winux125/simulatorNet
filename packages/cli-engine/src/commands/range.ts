import type { EtherChannelMode } from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { Params } from "../parser/matcher";
import type { CommandSpec, SessionApi } from "../types";
import { isLayer3Switch, isSwitch, parseVlanId, parseVlanList } from "./helpers";

/** Bounded preflight for supported physical-port operations, then existing handlers. */
export function executeRangeCommand(s: SessionApi, spec: CommandSpec, params: Params): string {
  const ctx = s.ifaceCtx;
  if (!ctx?.range || spec.pattern.startsWith("do ") || ["exit", "end"].includes(spec.pattern)) {
    return spec.run(s, params) ?? "";
  }
  const pattern = spec.pattern.replace(/^no /, "");
  // These existing protocol handlers already validate every physical member
  // before applying the same bounded setting to the range.
  if (/^(spanning-tree (cost|port-priority|portfast|bpduguard)|cdp enable|lldp (transmit|receive))/.test(pattern)) {
    return spec.run(s, params) ?? "";
  }
  if (!/^(description(?: |$)|shutdown$|switchport (?:mode |access vlan|trunk (?:allowed|native) vlan)|channel-group(?: |$))/.test(pattern)) {
    throw new InvalidModeError("This command is not supported in interface range mode.");
  }
  for (const port of ctx.range) {
    if (!s.device.interfaces.has(port)) throw new ValidationError(`Interface ${port} not found.`);
    if (pattern.startsWith("switchport ") && isLayer3Switch(s.device) && s.device.isRoutedPort(port)) {
      throw new InvalidModeError(`Interface ${port} is a routed port; use 'switchport' first.`);
    }
  }
  if (params.id && pattern.startsWith("switchport ")) parseVlanId(params.id);
  if (params.list) parseVlanList(params.list);
  if (pattern.startsWith("channel-group ") && !s.negated && isSwitch(s.device)) {
    const id = Number(params.id);
    const mode = params.mode?.toLowerCase();
    if (!Number.isInteger(id) || id < 1 || id > 64) throw new ValidationError("Channel group must be between 1 and 64.");
    if (!mode || !["on", "active", "passive", "desirable", "auto"].includes(mode)) {
      throw new ValidationError(`Unsupported EtherChannel mode '${params.mode}'.`);
    }
    s.device.etherChannel.validateMembers(id, ctx.range, mode as EtherChannelMode);
  }
  try {
    const output: string[] = [];
    for (const port of ctx.range) {
      s.ifaceCtx = { ...ctx, physical: port, label: port, range: undefined };
      const result = spec.run(s, params);
      if (result) output.push(result);
    }
    return output.join("\n");
  } finally { s.ifaceCtx = ctx; }
}

import { allCommands } from "./index";
import { deviceMatches } from "./helpers";
import type { CliMode } from "../session/mode";
import type { CommandSpec, SessionApi } from "../types";

/** Operators compose the current tree; they are never hand-written aliases. */
export function commandsForMode(session: SessionApi, mode: CliMode): CommandSpec[] {
  const config = mode.startsWith("config");
  const commands = allCommands.filter((spec) => spec.modes.includes(mode)
    && deviceMatches(spec.device, session.device)
    && (spec.capabilities?.every((capability) => session.device.hasCapability(capability)) ?? true)
    && (!spec.negated || config))
    .map((spec) => spec.negated ? { ...spec, pattern: `no ${spec.pattern}` } : spec);
  if (config) {
    commands.push(...commandsForMode(session, "privileged")
      .filter((spec) => /^(show|ping|traceroute)( |$)/.test(spec.pattern))
      .map((spec): CommandSpec => ({
        ...spec, pattern: `do ${spec.pattern}`, modes: [mode],
        run: (s, p) => {
          const previous = s.mode;
          s.mode = "privileged";
          try { return spec.run(s, p); } finally { s.mode = previous; }
        },
      })));
  }
  return commands;
}

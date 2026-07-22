import type { CommandSpec } from "../types";
import { isSwitch } from "./helpers";

/** VLAN configuration mode (`config-vlan`). */
export const vlanCommands: CommandSpec[] = [
  {
    pattern: "name {name}",
    modes: ["config-vlan"],
    device: "switch",
    capabilities: ["vlan"],
    run: (s, p) => {
      if (isSwitch(s.device) && s.vlanId !== undefined) s.device.setVlanName(s.vlanId, p.name!);
    },
  },
];

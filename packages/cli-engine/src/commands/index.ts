import type { CommandSpec } from "../types";
import { configurationCommands } from "./configuration";
import { interfaceCommands } from "./interface";
import { navigationCommands } from "./navigation";
import { showCommands } from "./show";
import { vlanCommands } from "./vlan";
import { applicationCommands } from "./applications";
import { managementCommands } from "./management";
import { protocolCommands } from "./protocols";
import { qosCommands } from "./qos";
import { securityCommands } from "./security";
import { vpnCommands } from "./vpn";
import { bgpCommands } from "./bgp";

/** Every command the CLI understands, across all modes. */
export const allCommands: CommandSpec[] = [
  ...navigationCommands,
  ...interfaceCommands,
  ...vlanCommands,
  ...showCommands,
  ...configurationCommands,
  ...applicationCommands,
  ...securityCommands,
  ...qosCommands,
  ...vpnCommands,
  ...bgpCommands,
  ...protocolCommands,
  ...managementCommands,
];

import type { CommandSpec } from "../types";
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

/** Every command the CLI understands, across all modes. */
export const allCommands: CommandSpec[] = [
  ...navigationCommands,
  ...interfaceCommands,
  ...vlanCommands,
  ...showCommands,
  ...applicationCommands,
  ...securityCommands,
  ...qosCommands,
  ...vpnCommands,
  ...protocolCommands,
  ...managementCommands,
];

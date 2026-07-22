import type { CommandSpec } from "../types";
import { interfaceCommands } from "./interface";
import { navigationCommands } from "./navigation";
import { showCommands } from "./show";
import { vlanCommands } from "./vlan";
import { applicationCommands } from "./applications";

/** Every command the CLI understands, across all modes. */
export const allCommands: CommandSpec[] = [
  ...navigationCommands,
  ...interfaceCommands,
  ...vlanCommands,
  ...showCommands,
  ...applicationCommands,
];

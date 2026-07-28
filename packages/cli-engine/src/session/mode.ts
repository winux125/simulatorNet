/** The CLI mode stack the session can be in. */
export type CliMode =
  | "exec" // user EXEC: Switch>
  | "privileged" // privileged EXEC: Switch#
  | "config" // global config: Switch(config)#
  | "config-if" // interface config: Switch(config-if)#
  | "config-vlan" // VLAN config: Switch(config-vlan)#
  | "config-acl" // named IPv4 ACL config
  | "config-line" // VTY line config: Router(config-line)#
  | "config-router"; // routing process config: Router(config-router)#

/** The prompt suffix for a mode, appended after the device hostname. */
export function promptSuffix(mode: CliMode): string {
  switch (mode) {
    case "exec":
      return ">";
    case "privileged":
      return "#";
    case "config":
      return "(config)#";
    case "config-if":
      return "(config-if)#";
    case "config-vlan":
      return "(config-vlan)#";
    case "config-acl":
      return "(config-acl)#";
    case "config-line":
      return "(config-line)#";
    case "config-router":
      return "(config-router)#";
  }
}

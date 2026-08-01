/** The CLI mode stack the session can be in. */
export type CliMode =
  | "exec" // user EXEC: Switch>
  | "privileged" // privileged EXEC: Switch#
  | "config" // global config: Switch(config)#
  | "config-if" // interface config: Switch(config-if)#
  | "config-vlan" // VLAN config: Switch(config-vlan)#
  | "config-acl" // named IPv4 ACL config
  | "config-line" // VTY line config: Router(config-line)#
  | "config-aaa-server" // radius/tacacs server config: Router(config-radius-server)#
  | "config-cmap" // QoS class map: Router(config-cmap)#
  | "config-pmap" // QoS policy map: Router(config-pmap)#
  | "config-pmap-c" // QoS policy-map class: Router(config-pmap-c)#
  | "config-ikev2-proposal" // IKEv2 proposal: Router(config-ikev2-proposal)#
  | "config-ikev2-peer" // IKEv2 peer: Router(config-ikev2-peer)#
  | "config-ipsec-profile" // IPsec profile: Router(ipsec-profile)#
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
    case "config-aaa-server":
      return "(config-aaa-server)#";
    case "config-cmap":
      return "(config-cmap)#";
    case "config-pmap":
      return "(config-pmap)#";
    case "config-pmap-c":
      return "(config-pmap-c)#";
    case "config-ikev2-proposal":
      return "(config-ikev2-proposal)#";
    case "config-ikev2-peer":
      return "(config-ikev2-peer)#";
    case "config-ipsec-profile":
      return "(ipsec-profile)#";
    case "config-router":
      return "(config-router)#";
  }
}

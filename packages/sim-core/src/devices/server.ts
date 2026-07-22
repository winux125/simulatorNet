import { EndHost } from "./pc";

/**
 * Server reuses the end-host IPv4/ARP/ICMP/DHCP stack. Application protocols
 * are intentionally absent in M10.1; the empty registry is exposed for UI
 * inspection and future service modules.
 */
export class Server extends EndHost {
  readonly deviceType = "server" as const;
  readonly enabledServices: readonly never[] = [];
}

import type { DhcpMessageType } from "@sim/contracts";
import type { Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";

/**
 * A simplified DHCP/BOOTP message. Rather than model raw option bytes we carry
 * the handful of fields the CCNA labs exercise as named properties. Enough to
 * drive the full DISCOVER/OFFER/REQUEST/ACK (DORA) exchange.
 */
export interface DhcpMessage {
  readonly kind: "dhcp";
  readonly messageType: DhcpMessageType;
  /** Correlates the four messages of one transaction (BOOTP xid). */
  readonly transactionId: number;
  /** The client's hardware address (chaddr). */
  readonly clientMac: Mac;
  /** Address the server is offering/assigning (yiaddr). */
  readonly yourIp?: Ipv4;
  /** Server identifier (option 54). */
  readonly serverIp?: Ipv4;
  /** Address the client asks to (re)use (option 50). */
  readonly requestedIp?: Ipv4;
  /** Subnet mask option (option 1), dotted form. */
  readonly subnetMask?: Ipv4;
  /** Default gateway / router option (option 3). */
  readonly gateway?: Ipv4;
  /** Lease duration in seconds (option 51). */
  readonly leaseSeconds?: number;
}

import { WirelessEndHost } from "./wireless-end-host";

/** Wireless-only EndHost used by the compact educational Apps panel. */
export class Smartphone extends WirelessEndHost {
  readonly deviceType = "smartphone" as const;
}

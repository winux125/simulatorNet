import { WirelessEndHost } from "./wireless-end-host";

/** Portable EndHost with wlan0 plus an optional cabled eth0 interface. */
export class Laptop extends WirelessEndHost {
  readonly deviceType = "laptop" as const;
}

import type { Ipv4 } from "../util/ipv4";

export const LDP_DISCOVERY_PORT = 646;
export const LDP_SESSION_PORT = 646;

export type LdpMessage =
  | { readonly kind: "ldp-hello"; readonly routerId: Ipv4; readonly holdTimeSeconds: number }
  | { readonly kind: "ldp-initialization"; readonly routerId: Ipv4 }
  | { readonly kind: "ldp-keepalive"; readonly routerId: Ipv4 }
  | { readonly kind: "ldp-label-mapping"; readonly fec: string; readonly label: number }
  | { readonly kind: "ldp-label-withdraw"; readonly fec: string; readonly label: number }
  | { readonly kind: "ldp-label-release"; readonly fec: string; readonly label: number };

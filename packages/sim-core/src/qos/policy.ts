import type {
  Ipv4AddressMatcher,
  Ipv6AddressMatcher,
  PortMatcher,
} from "../policy/packet-policy-engine";

/** The class every unmatched packet falls into; it always exists. */
export const QOS_CLASS_DEFAULT = "class-default";

export type QosMatchProtocol = "icmp" | "tcp" | "udp";

/**
 * What a `class-map` can look at. Deliberately a closed structural union: no
 * regular expression, no user-supplied predicate, no deep-packet inspection.
 */
export type QosMatchRule =
  | { readonly kind: "any" }
  | { readonly kind: "access-group"; readonly aclId: string }
  | { readonly kind: "ipv6-access-group"; readonly aclId: string }
  | { readonly kind: "protocol"; readonly protocol: QosMatchProtocol }
  | { readonly kind: "source-port"; readonly port: PortMatcher }
  | { readonly kind: "destination-port"; readonly port: PortMatcher }
  | { readonly kind: "dscp"; readonly values: readonly number[] }
  | { readonly kind: "precedence"; readonly values: readonly number[] }
  | { readonly kind: "cos"; readonly values: readonly number[] }
  | {
      readonly kind: "source-prefix";
      readonly ipv4?: Ipv4AddressMatcher;
      readonly ipv6?: Ipv6AddressMatcher;
    }
  | {
      readonly kind: "destination-prefix";
      readonly ipv4?: Ipv4AddressMatcher;
      readonly ipv6?: Ipv6AddressMatcher;
    }
  /**
   * Internal test metadata: the Traffic Generator flow that produced the packet.
   * It is deliberately not part of the Cisco-like CLI surface — a real router
   * cannot see which tool sent a packet.
   */
  | { readonly kind: "traffic-flow"; readonly flowId: string };

export type QosClassMatchType = "match-all" | "match-any";

export interface QosClassMap {
  readonly id: string;
  readonly matchType: QosClassMatchType;
  readonly matches: readonly QosMatchRule[];
}

/** `set dscp` / `set precedence` / `set cos` inside a policy class. */
export interface QosMarkingAction {
  readonly dscp?: number;
  readonly precedence?: number;
  readonly cos?: number;
}

export type QosPolicerExceedAction = "drop" | "set-dscp-transmit";

/** `police <bps> <burst> conform-action transmit exceed-action drop`. */
export interface QosPolicerConfiguration {
  readonly rateBps: number;
  readonly burstBytes: number;
  readonly exceedAction: QosPolicerExceedAction;
  /** Required when `exceedAction` is `set-dscp-transmit`. */
  readonly exceedDscp?: number;
}

/** `shape average <bps>`. Adaptive shaping is deliberately out of scope. */
export interface QosShaperConfiguration {
  readonly averageRateBps: number;
  readonly burstBytes?: number;
}

/** `priority percent <n>` — strict priority with a built-in bounded policer. */
export interface QosPriorityConfiguration {
  readonly percent?: number;
  readonly rateBps?: number;
}

export interface QosPolicyClass {
  /** A `class-map` id, or `class-default`. */
  readonly className: string;
  readonly marking?: QosMarkingAction;
  readonly priority?: QosPriorityConfiguration;
  /** `bandwidth percent <n>` share among the non-priority classes. */
  readonly bandwidthPercent?: number;
  readonly police?: QosPolicerConfiguration;
  readonly shape?: QosShaperConfiguration;
  readonly queueLimitPackets?: number;
}

export interface QosPolicyMap {
  readonly id: string;
  /** Evaluated in this order; `class-default` is always considered last. */
  readonly classes: readonly QosPolicyClass[];
}

export type QosDirection = "input" | "output";

export interface QosServicePolicyBinding {
  readonly interfaceName: string;
  readonly direction: QosDirection;
  readonly policyMapId: string;
}

/** What a classifier decided about one packet. Runtime only; never serialized. */
export interface QosClassificationResult {
  readonly policyMapId: string;
  readonly interfaceName: string;
  readonly direction: QosDirection;
  readonly className: string;
  /** False when no class map matched and the packet fell to `class-default`. */
  readonly matched: boolean;
  readonly matchIndex: number | undefined;
  readonly policyClass: QosPolicyClass;
}

export interface QosClassCounter {
  readonly policyMapId: string;
  readonly direction: QosDirection;
  readonly interfaceName: string;
  readonly className: string;
  readonly matchedPackets: number;
  readonly matchedBytes: number;
  readonly markedPackets: number;
  readonly droppedPackets: number;
  readonly lastMatchAtNs: number | undefined;
}

export type QosProblemCode =
  | "policy-missing-class-map"
  | "policy-bandwidth-exceeded"
  | "policy-priority-exceeded"
  | "service-policy-missing-policy-map"
  | "service-policy-type-mismatch";

export interface QosProblem {
  readonly code: QosProblemCode;
  readonly message: string;
  readonly policyMapId?: string;
  readonly className?: string;
  readonly interfaceName?: string;
}

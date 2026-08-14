import { z } from "zod";
import { DeviceCapabilitySchema, DeviceTypeSchema } from "./devices";
import { WirelessSecurityModeSchema } from "./wireless";
import { IpAddressSchema, MacAddressSchema } from "./primitives";
import { CosValueSchema, DscpValueSchema } from "./qos";
import {
  BgpCommunitySchema,
  EsiSchema,
  RouteDistinguisherSchema,
  RouteTargetSchema,
  VniSchema,
} from "./protocols";
import {
  Ipv4Schema,
  Ipv6CidrSchema,
  Ipv6PrefixLengthSchema,
  Ipv6Schema,
  LabSubmissionDocumentSchema,
  PrefixLengthSchema,
  VlanIdSchema,
} from "./lab";

export const GradingVisibilitySchema = z.enum(["hidden", "visible"]);
export type GradingVisibility = z.infer<typeof GradingVisibilitySchema>;

const CheckIdentitySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  points: z.number().nonnegative(),
  visibility: GradingVisibilitySchema,
});

export const PingGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ping"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    expected: z.enum(["success", "failure"]),
  }),
});

export const InterfaceStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("interface-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedAdminUp: z.boolean(),
  }),
});

export const SwitchportGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("switchport"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedMode: z.enum(["access", "trunk"]),
    expectedAccessVlan: VlanIdSchema.optional(),
  }),
});

export const VlanExistsGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vlan-exists"),
  configuration: z.object({ deviceId: z.string().min(1), vlanId: VlanIdSchema }),
});

export const RouteExistsGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("route-exists"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: Ipv4Schema,
    prefixLength: PrefixLengthSchema,
  }),
});

export const Ipv4CidrSchema = z.string().refine((value) => {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  return Ipv4Schema.safeParse(parts[0]).success && PrefixLengthSchema.safeParse(Number(parts[1])).success;
}, "Invalid IPv4 CIDR");

export const DhcpAddressGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("dhcp-address"),
  configuration: z.object({ deviceId: z.string().min(1), expectedSubnet: Ipv4CidrSchema }),
});

export const DeviceTypeGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("device-type"),
  configuration: z.object({ deviceId: z.string().min(1), expectedType: DeviceTypeSchema }),
});

export const CapabilityPresentGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("capability-present"),
  configuration: z.object({ deviceId: z.string().min(1), capability: DeviceCapabilitySchema }),
});

export const SviStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("svi-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vlanId: VlanIdSchema,
    expectedAdminUp: z.boolean(),
    expectedOperationalUp: z.boolean(),
  }),
});

export const IpRoutingEnabledGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ip-routing-enabled"),
  configuration: z.object({ deviceId: z.string().min(1), expected: z.boolean() }),
});

export const DnsRecordGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("dns-record"),
  configuration: z.object({
    deviceId: z.string().min(1),
    hostname: z.string().min(1),
    expectedAddress: Ipv4Schema,
  }),
});

export const DnsResolutionGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("dns-resolution"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    hostname: z.string().min(1),
    dnsServer: Ipv4Schema.optional(),
    expectedAddress: Ipv4Schema,
  }),
});

export const HttpResponseGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("http-response"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    url: z.string().min(1),
    expectedStatus: z.number().int().min(100).max(599),
    expectedBody: z.string().optional(),
  }),
});

export const TftpFileGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("tftp-file"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    serverIp: Ipv4Schema,
    filename: z.string().min(1),
    expectedContent: z.string().optional(),
  }),
});

export const NtpResponseGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ntp-response"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    serverIp: Ipv4Schema,
    expected: z.enum(["success", "failure"]).default("success"),
  }),
});

export const SyslogReceivedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("syslog-received"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    serverDeviceId: z.string().min(1),
    severity: z.enum(["emergency", "alert", "critical", "error", "warning", "notice", "informational", "debug"]),
    message: z.string().min(1),
  }),
});

export const TcpListenerGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("tcp-listener"),
  configuration: z.object({
    deviceId: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  }),
});

export const AclRuleGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("acl-rule"),
  configuration: z.object({
    deviceId: z.string().min(1),
    aclId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    expectedAction: z.enum(["permit", "deny"]),
  }),
});

export const AclBindingGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("acl-binding"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    direction: z.enum(["in", "out"]),
    aclId: z.string().min(1),
  }),
});

const PacketPolicyActionSchema = z.object({
  sourceDeviceId: z.string().min(1),
  destinationIp: Ipv4Schema,
});

export const PacketPermittedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("packet-permitted"),
  configuration: PacketPolicyActionSchema,
});

export const PacketDeniedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("packet-denied"),
  configuration: PacketPolicyActionSchema,
});

export const NatRuleGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("nat-rule"),
  configuration: z.object({
    deviceId: z.string().min(1),
    ruleId: z.string().min(1),
    expectedKind: z.enum(["static", "dynamic", "pat"]),
  }),
});

export const NatTranslationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("nat-translation"),
  configuration: z.object({
    deviceId: z.string().min(1),
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    expectedInsideGlobalAddress: Ipv4Schema.optional(),
  }),
});

export const FirewallRuleGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("firewall-rule"),
  configuration: z.object({
    deviceId: z.string().min(1),
    ruleId: z.string().min(1),
    expectedAction: z.enum(["permit", "deny"]),
  }),
});

export const FirewallSessionGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("firewall-session"),
  configuration: z.object({
    deviceId: z.string().min(1),
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
  }),
});

export const ExternalConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("external-connectivity"),
  configuration: PacketPolicyActionSchema.extend({
    expected: z.enum(["success", "failure"]).default("success"),
  }),
});

export const TrafficFlowResultGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("traffic-flow-result"),
  configuration: z.object({
    deviceId: z.string().min(1),
    flowId: z.string().min(1),
    minimumReceived: z.number().int().nonnegative().default(1),
    maximumDropped: z.number().int().nonnegative().optional(),
  }),
});

// --- M10.4 control-protocol checks -----------------------------------------

export const StpRootGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("stp-root"),
  configuration: z.object({ vlanId: VlanIdSchema, expectedDeviceId: z.string().min(1) }),
});

export const StpModeGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("stp-mode"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedMode: z.enum(["disabled", "stp", "rstp"]),
  }),
});

export const SpanningTreePortRoleSchema = z.enum(["root", "designated", "alternate", "backup", "disabled"]);
export const SpanningTreePortStateSchema = z.enum([
  "disabled",
  "blocking",
  "listening",
  "learning",
  "forwarding",
  "discarding",
]);

export const StpPortRoleGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("stp-port-role"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    vlanId: VlanIdSchema.default(1),
    expectedRole: SpanningTreePortRoleSchema,
  }),
});

export const StpPortStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("stp-port-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    vlanId: VlanIdSchema.default(1),
    expectedState: SpanningTreePortStateSchema,
  }),
});

export const StpPortFastGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("stp-portfast"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expected: z.boolean().default(true),
  }),
});

export const BpduGuardStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bpdu-guard-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedErrorDisabled: z.boolean().default(true),
  }),
});

export const EtherChannelFormedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("etherchannel-formed"),
  configuration: z.object({
    deviceId: z.string().min(1),
    channelId: z.number().int().min(1).max(64),
    expectedMembers: z.array(z.string().min(1)).max(8).optional(),
  }),
});

export const EtherChannelProtocolGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("etherchannel-protocol"),
  configuration: z.object({
    deviceId: z.string().min(1),
    channelId: z.number().int().min(1).max(64),
    expectedProtocol: z.enum(["static", "lacp", "pagp"]),
    expectedMode: z.enum(["on", "active", "passive", "desirable", "auto"]).optional(),
  }),
});

export const EtherChannelMemberStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("etherchannel-member-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    channelId: z.number().int().min(1).max(64),
    interfaceId: z.string().min(1),
    expectedState: z.enum(["detached", "waiting", "attached", "collecting", "distributing", "suspended"]),
  }),
});

const DiscoveryNeighborConfigurationSchema = z.object({
  deviceId: z.string().min(1),
  localInterfaceId: z.string().min(1),
  expectedNeighborId: z.string().min(1),
  expectedRemoteInterfaceId: z.string().min(1).optional(),
});

export const CdpNeighborGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("cdp-neighbor"),
  configuration: DiscoveryNeighborConfigurationSchema,
});

export const LldpNeighborGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("lldp-neighbor"),
  configuration: DiscoveryNeighborConfigurationSchema,
});

export const OspfRouterIdGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-router-id"),
  configuration: z.object({ deviceId: z.string().min(1), expectedRouterId: Ipv4Schema }),
});

export const OspfNeighborStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-neighbor-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    neighborRouterId: Ipv4Schema,
    expectedState: z.enum(["down", "init", "two-way", "exstart", "exchange", "loading", "full"]),
  }),
});

export const OspfInterfaceGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-interface"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedCost: z.number().int().min(1).max(65_535).optional(),
    expectedPassive: z.boolean().optional(),
    expectedNetworkType: z.enum(["broadcast", "point-to-point"]).optional(),
  }),
});

export const OspfDrGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-dr"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedDesignatedRouter: Ipv4Schema,
  }),
});

export const OspfBdrGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-bdr"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedBackupDesignatedRouter: Ipv4Schema,
  }),
});

export const OspfRouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: Ipv4Schema,
    prefixLength: PrefixLengthSchema,
    expectedNextHop: Ipv4Schema.optional(),
  }),
});

export const OspfLsdbEntryGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-lsdb-entry"),
  configuration: z.object({
    deviceId: z.string().min(1),
    lsaType: z.enum(["router", "network"]),
    advertisingRouter: Ipv4Schema,
  }),
});

export const OspfPathCostGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospf-path-cost"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: Ipv4Schema,
    prefixLength: PrefixLengthSchema,
    expectedCost: z.number().int().min(0),
  }),
});

export const Ipv6AddressGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-address"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1).optional(),
    expectedAddress: Ipv6Schema,
    expectedPrefixLength: Ipv6PrefixLengthSchema.optional(),
  }),
});

export const Ipv6NeighborGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-neighbor"),
  configuration: z.object({
    deviceId: z.string().min(1),
    neighborAddress: Ipv6Schema,
  }),
});

export const SlaacAddressGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("slaac-address"),
  configuration: z.object({ deviceId: z.string().min(1), expectedPrefix: Ipv6CidrSchema }),
});

export const Dhcpv6AddressGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("dhcpv6-address"),
  configuration: z.object({ deviceId: z.string().min(1), expectedPrefix: Ipv6CidrSchema }),
});

export const Ipv6RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: Ipv6Schema,
    prefixLength: Ipv6PrefixLengthSchema,
    expectedNextHop: Ipv6Schema.optional(),
  }),
});

export const Ipv6ConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-connectivity"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destination: Ipv6Schema,
    expected: z.enum(["success", "failure"]).default("success"),
  }),
});

export const Ospfv3NeighborGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospfv3-neighbor"),
  configuration: z.object({
    deviceId: z.string().min(1),
    neighborRouterId: Ipv4Schema,
    expectedState: z.enum(["two-way", "full"]).default("full"),
  }),
});

export const Ospfv3RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ospfv3-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: Ipv6Schema,
    prefixLength: Ipv6PrefixLengthSchema,
  }),
});

export const Ipv6AclRuleGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-acl-rule"),
  configuration: z.object({
    deviceId: z.string().min(1),
    aclId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    expectedAction: z.enum(["permit", "deny"]),
  }),
});

const Ipv6PacketPolicyActionSchema = z.object({
  sourceDeviceId: z.string().min(1),
  destination: Ipv6Schema,
  nextHeader: z.union([z.literal(6), z.literal(17), z.literal(58)]).default(58),
  destinationPort: z.number().int().min(1).max(65_535).optional(),
});

export const Ipv6PacketPermittedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-packet-permitted"),
  configuration: Ipv6PacketPolicyActionSchema,
});

export const Ipv6PacketDeniedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-packet-denied"),
  configuration: Ipv6PacketPolicyActionSchema,
});

// --- M10.6 deterministic wireless checks ----------------------------------

export const WirelessAssociatedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-associated"),
  configuration: z.object({
    stationDeviceId: z.string().min(1),
    accessPointDeviceId: z.string().min(1).optional(),
  }),
});

export const WirelessSsidGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-ssid"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedSsid: z.string().min(1).max(32),
  }),
});

export const WirelessSecurityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-security"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedMode: WirelessSecurityModeSchema,
  }),
});

export const WirelessClientCountGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-client-count"),
  configuration: z.object({
    deviceId: z.string().min(1),
    minimumClients: z.number().int().nonnegative().default(1),
    maximumClients: z.number().int().nonnegative().optional(),
  }),
});

export const WirelessIpv4GradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-ipv4"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedSubnet: Ipv4CidrSchema,
  }),
});

export const WirelessIpv6GradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-ipv6"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedPrefix: Ipv6CidrSchema,
  }),
});

export const WirelessConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-connectivity"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destination: z.union([Ipv4Schema, Ipv6Schema]),
    expected: z.enum(["success", "failure"]).default("success"),
  }),
});

export const WirelessRoamedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-roamed"),
  configuration: z.object({
    stationDeviceId: z.string().min(1),
    expectedFromBssid: z.string().min(11).max(32).optional(),
    expectedToAccessPointDeviceId: z.string().min(1).optional(),
    /** Optional hidden deterministic action used to grade failover behavior. */
    triggerAccessPointShutdownDeviceId: z.string().min(1).optional(),
  }),
});

export const WirelessRouterNatGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("wireless-router-nat"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedEnabled: z.boolean().default(true),
  }),
});

// --- M10.7 management plane ---------------------------------------------------
// A student result never reveals a password, enable secret, community string,
// shared key, verifier or hidden command policy: these checks compare
// configuration and observable outcomes, never credential material.

export const RemoteServiceEnabledGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("remote-service-enabled"),
  configuration: z.object({
    deviceId: z.string().min(1),
    service: z.enum(["telnet", "ssh"]),
    expected: z.boolean().default(true),
  }).strict(),
}).strict();

export const VtyTransportGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vty-transport"),
  configuration: z.object({
    deviceId: z.string().min(1),
    line: z.number().int().min(0).max(15),
    /** Transports the line must permit, exactly. */
    expected: z.array(z.enum(["telnet", "ssh"])).max(2),
    loginMode: z.enum(["none", "password", "local"]).optional(),
  }).strict(),
}).strict();

const RemoteSessionConfigurationSchema = z.object({
  clientDeviceId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  targetAddress: IpAddressSchema,
  /** The local user the check logs in as; its stored credential is used. */
  username: z.string().min(1).max(64),
  expected: z.enum(["success", "failure"]).default("success"),
}).strict();

export const SshSessionEstablishedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ssh-session-established"),
  configuration: RemoteSessionConfigurationSchema,
}).strict();

export const TelnetSessionEstablishedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("telnet-session-established"),
  configuration: RemoteSessionConfigurationSchema,
}).strict();

export const AaaMethodListGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("aaa-method-list"),
  configuration: z.object({
    deviceId: z.string().min(1),
    purpose: z.enum(["authentication-login", "authorization-exec", "authorization-commands", "accounting-exec", "accounting-commands"]),
    listName: z.string().min(1).max(64).default("default"),
    privilegeLevel: z.number().int().min(0).max(15).optional(),
    expectedMethods: z.array(z.enum(["local", "group radius", "group tacacs+", "none"])).min(1).max(4),
  }).strict(),
}).strict();

const AaaAuthenticationConfigurationSchema = z.object({
  clientDeviceId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  targetAddress: IpAddressSchema,
  username: z.string().min(1).max(64),
  /** The AAA server that must answer, so a lab can prove which one decided. */
  serverDeviceId: z.string().min(1).optional(),
  expected: z.enum(["success", "failure"]).default("success"),
}).strict();

export const RadiusAuthenticationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("radius-authentication"),
  configuration: AaaAuthenticationConfigurationSchema,
}).strict();

export const TacacsAuthenticationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("tacacs-authentication"),
  configuration: AaaAuthenticationConfigurationSchema,
}).strict();

const CommandAuthorizationConfigurationSchema = z.object({
  clientDeviceId: z.string().min(1),
  targetDeviceId: z.string().min(1),
  targetAddress: IpAddressSchema,
  username: z.string().min(1).max(64),
  command: z.string().min(1).max(200),
}).strict();

export const CommandAuthorizedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("command-authorized"),
  configuration: CommandAuthorizationConfigurationSchema,
}).strict();

export const CommandDeniedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("command-denied"),
  configuration: CommandAuthorizationConfigurationSchema,
}).strict();

export const SnmpAgentConfiguredGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("snmp-agent-configured"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectCommunity: z.boolean().default(true),
    expectTraps: z.boolean().optional(),
    location: z.string().max(255).optional(),
    contact: z.string().max(255).optional(),
  }).strict(),
}).strict();

export const SnmpValueGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("snmp-value"),
  configuration: z.object({
    deviceId: z.string().min(1),
    oid: z.string().min(1).max(128),
    /** Compared as text so Integer, Counter32 and OctetString all work. */
    expectedValue: z.string().max(255),
  }).strict(),
}).strict();

export const SnmpTrapReceivedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("snmp-trap-received"),
  configuration: z.object({
    /** The NMS Server that must have received the trap. */
    managerDeviceId: z.string().min(1),
    sourceDeviceId: z.string().min(1).optional(),
    trapType: z.enum([
      "coldStart",
      "warmStart",
      "linkUp",
      "linkDown",
      "authenticationFailure",
      "stpRootChange",
      "ospfNeighborDown",
      "wirelessClientAssociated",
      "wirelessClientDisassociated",
    ]),
    /** Interface whose state change must have produced the trap. */
    interfaceId: z.string().min(1).optional(),
  }).strict(),
}).strict();

// --- M10.8 quality of service ----------------------------------------------

export const QosClassMapGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("qos-class-map"),
  configuration: z.object({
    deviceId: z.string().min(1),
    classMapId: z.string().min(1),
    expectedMatchType: z.enum(["match-all", "match-any"]).optional(),
    minimumMatches: z.number().int().nonnegative().default(1),
  }).strict(),
}).strict();

export const QosPolicyMapGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("qos-policy-map"),
  configuration: z.object({
    deviceId: z.string().min(1),
    policyMapId: z.string().min(1),
    className: z.string().min(1),
    expectedAction: z.enum(["priority", "bandwidth", "police", "shape", "set-dscp", "set-cos"]),
    /** Percent, bits per second, DSCP or CoS, depending on `expectedAction`. */
    expectedValue: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export const QosPolicyAttachedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("qos-policy-attached"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    direction: z.enum(["input", "output"]),
    policyMapId: z.string().min(1),
  }).strict(),
}).strict();

const MarkedPacketSchema = z.object({
  sourceDeviceId: z.string().min(1),
  destinationIp: Ipv4Schema,
  /** The QoS device whose marking is being graded. */
  deviceId: z.string().min(1),
});

export const PacketDscpGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("packet-dscp"),
  configuration: MarkedPacketSchema.extend({ expectedDscp: DscpValueSchema }).strict(),
}).strict();

export const PacketCosGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("packet-cos"),
  configuration: MarkedPacketSchema.extend({ expectedCos: CosValueSchema }).strict(),
}).strict();

export const TrafficClassifiedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("traffic-classified"),
  configuration: z.object({
    deviceId: z.string().min(1),
    className: z.string().min(1),
    sourceDeviceId: z.string().min(1).optional(),
    destinationIp: Ipv4Schema.optional(),
    minimumPackets: z.number().int().positive().default(1),
  }).strict(),
}).strict();

export const PolicerResultGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("policer-result"),
  configuration: z.object({
    deviceId: z.string().min(1),
    className: z.string().min(1),
    trafficDeviceId: z.string().min(1).optional(),
    flowId: z.string().min(1).optional(),
    minimumDropped: z.number().int().nonnegative().default(1),
    maximumDropped: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export const ShaperResultGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("shaper-result"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    trafficDeviceId: z.string().min(1).optional(),
    flowId: z.string().min(1).optional(),
    minimumDelayedPackets: z.number().int().positive().default(1),
    /** A shaper delays; it must not drop while the queue still has room. */
    maximumDroppedPackets: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export const QueueDropCountGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("queue-drop-count"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    trafficDeviceId: z.string().min(1).optional(),
    flowId: z.string().min(1).optional(),
    minimumDrops: z.number().int().nonnegative().default(0),
    maximumDrops: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export const TrafficPriorityOrderGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("traffic-priority-order"),
  configuration: z.object({
    deviceId: z.string().min(1),
    priorityFlowId: z.string().min(1),
    bulkFlowId: z.string().min(1),
  }).strict(),
}).strict();

// --- M10.9 site-to-site VPN -------------------------------------------------
//
// A VPN check never carries a pre-shared key, a verifier or a hidden peer
// identity, and a student result never exposes an SPI or internal diagnostics
// from a hidden check.

export const GreTunnelConfiguredGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("gre-tunnel-configured"),
  configuration: z.object({
    deviceId: z.string().min(1),
    tunnelId: z.number().int().nonnegative(),
    expectedDestination: Ipv4Schema.optional(),
    expectedSourceInterface: z.string().min(1).optional(),
    expectedOverlayAddress: Ipv4Schema.optional(),
  }).strict(),
}).strict();

export const GreTunnelOperationalGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("gre-tunnel-operational"),
  configuration: z.object({
    deviceId: z.string().min(1),
    tunnelId: z.number().int().nonnegative(),
    expected: z.boolean().default(true),
  }).strict(),
}).strict();

export const TunnelConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("tunnel-connectivity"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destination: IpAddressSchema,
    expected: z.enum(["success", "failure"]).default("success"),
    /** The device whose tunnel must have carried the traffic. */
    tunnelDeviceId: z.string().min(1).optional(),
  }).strict(),
}).strict();

export const IkePeerConfiguredGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ike-peer-configured"),
  configuration: z.object({
    deviceId: z.string().min(1),
    peerId: z.string().min(1),
    expectedAddress: Ipv4Schema.optional(),
    /** Only that *a* key is configured is ever checked, never its value. */
    expectPreSharedKey: z.boolean().default(true),
    expectedProposalId: z.string().min(1).optional(),
  }).strict(),
}).strict();

export const IkeStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ike-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    peerId: z.string().min(1),
    expectedState: z.enum([
      "DOWN", "INITIATING", "NEGOTIATING", "ESTABLISHED", "REKEYING", "FAILED", "EXPIRED",
    ]),
  }).strict(),
}).strict();

export const IpsecProfileGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipsec-profile"),
  configuration: z.object({
    deviceId: z.string().min(1),
    profileId: z.string().min(1),
    expectedPeerId: z.string().min(1).optional(),
    expectedProposalId: z.string().min(1).optional(),
    /** The tunnel this profile must protect. */
    boundTunnelId: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export const IpsecSaEstablishedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipsec-sa-established"),
  configuration: z.object({
    deviceId: z.string().min(1),
    peerId: z.string().min(1),
    /** Both directions must exist for the tunnel to carry return traffic. */
    expectBothDirections: z.boolean().default(true),
  }).strict(),
}).strict();

export const ProtectedPacketDeliveredGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("protected-packet-delivered"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destination: IpAddressSchema,
    /** The device that must have applied simulated ESP protection. */
    deviceId: z.string().min(1),
  }).strict(),
}).strict();

export const EspReplayRejectedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("esp-replay-rejected"),
  configuration: z.object({
    deviceId: z.string().min(1),
    peerId: z.string().min(1),
  }).strict(),
}).strict();

export const VpnRouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vpn-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: IpAddressSchema,
    prefixLength: z.number().int().min(0).max(128),
    /** The tunnel the route must egress through. */
    tunnelId: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const BgpPrefixExpectationSchema = z.object({
  network: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
});

export const BgpNeighborStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-neighbor-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    neighborAddress: Ipv4Schema,
    expectedState: z.enum(["idle", "connect", "active", "open-sent", "open-confirm", "established"]),
  }).strict(),
}).strict();

export const BgpLocalAsGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-local-as"),
  configuration: z.object({ deviceId: z.string().min(1), expectedLocalAs: z.number().int().min(1).max(4_294_967_295) }).strict(),
}).strict();

export const BgpNetworkGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-network"),
  configuration: z.object({ deviceId: z.string().min(1) }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpRouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedNextHop: Ipv4Schema.optional(),
    expectedAdministrativeDistance: z.union([z.literal(20), z.literal(200)]).optional(),
  }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpBestPathGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-best-path"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedNeighborAddress: Ipv4Schema.optional(),
    expectedAsPath: z.array(z.number().int().min(1).max(4_294_967_295)).optional(),
  }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpNextHopGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-next-hop"),
  configuration: z.object({ deviceId: z.string().min(1), expectedNextHop: Ipv4Schema })
    .merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const PrefixListEntryGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("prefix-list-entry"),
  configuration: z.object({
    deviceId: z.string().min(1),
    prefixListId: z.string().min(1),
    sequence: z.number().int().min(1),
    expectedAction: z.enum(["permit", "deny"]),
  }).strict(),
}).strict();

export const RouteMapSequenceGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("route-map-sequence"),
  configuration: z.object({
    deviceId: z.string().min(1),
    routeMapId: z.string().min(1),
    sequence: z.number().int().min(1),
    expectedAction: z.enum(["permit", "deny"]),
  }).strict(),
}).strict();

export const RoutePolicyResultGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("route-policy-result"),
  configuration: z.object({
    deviceId: z.string().min(1),
    neighborAddress: Ipv4Schema,
    direction: z.enum(["in", "out"]),
    expected: z.enum(["permitted", "denied"]),
  }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpAdvertisedRouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-advertised-route"),
  configuration: z.object({ deviceId: z.string().min(1), neighborAddress: Ipv4Schema })
    .merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpReceivedRouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-received-route"),
  configuration: z.object({ deviceId: z.string().min(1), neighborAddress: Ipv4Schema })
    .merge(BgpPrefixExpectationSchema).strict(),
}).strict();

// --- M10.12 route reflection, communities and advanced policy -------------

export const BgpRouteReflectorClientGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-route-reflector-client"),
  configuration: z.object({ deviceId: z.string().min(1), neighborAddress: Ipv4Schema }).strict(),
}).strict();

export const BgpClusterIdGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-cluster-id"),
  configuration: z.object({ deviceId: z.string().min(1), expectedClusterId: Ipv4Schema }).strict(),
}).strict();

/** A reflected path reached this device with the expected reflection attributes. */
export const BgpRouteReflectedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-route-reflected"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedOriginatorId: Ipv4Schema.optional(),
    expectedClusterId: Ipv4Schema.optional(),
  }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpOriginatorLoopPreventedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-originator-loop-prevented"),
  configuration: z.object({ deviceId: z.string().min(1) }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpCommunityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-community"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedCommunity: BgpCommunitySchema,
    expected: z.enum(["present", "absent"]).default("present"),
  }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpCommunityListGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-community-list"),
  configuration: z.object({
    deviceId: z.string().min(1),
    communityListId: z.string().min(1),
    sequence: z.number().int().min(1),
    expectedAction: z.enum(["permit", "deny"]),
  }).strict(),
}).strict();

export const BgpAsPathListGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-as-path-list"),
  configuration: z.object({
    deviceId: z.string().min(1),
    asPathListId: z.string().min(1),
    sequence: z.number().int().min(1),
    expectedAction: z.enum(["permit", "deny"]),
  }).strict(),
}).strict();

export const BgpRoutePolicyResultGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-route-policy-result"),
  configuration: z.object({
    deviceId: z.string().min(1),
    routeMapId: z.string().min(1),
    sequence: z.number().int().min(1),
    expectedMatches: z.number().int().min(0).optional(),
  }).strict(),
}).strict();

export const BgpAggregateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-aggregate"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedSummaryOnly: z.boolean().optional(),
    expectedActive: z.boolean().default(true),
  }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpSpecificSuppressedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-specific-suppressed"),
  configuration: z.object({ deviceId: z.string().min(1) }).merge(BgpPrefixExpectationSchema).strict(),
}).strict();

export const BgpDefaultAdvertisedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-default-advertised"),
  configuration: z.object({
    deviceId: z.string().min(1),
    neighborAddress: Ipv4Schema,
    expected: z.enum(["advertised", "withheld"]).default("advertised"),
  }).strict(),
}).strict();

// --- MPLS, LDP and Layer 3 VPN ------------------------------------------

export const MplsInterfaceEnabledGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("mpls-interface-enabled"), deviceId: z.string().min(1), interfaceId: z.string().min(1),
}).strict();
export const LdpNeighborStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ldp-neighbor-state"), deviceId: z.string().min(1), neighborRouterId: Ipv4Schema, expectedState: z.literal("operational").default("operational"),
}).strict();
export const LdpBindingGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ldp-binding"), deviceId: z.string().min(1), fec: z.string().min(1), expectedRemoteLabel: z.number().int().min(3).max(1_048_575).optional(),
}).strict();
export const MplsLfibEntryGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("mpls-lfib-entry"), deviceId: z.string().min(1), fec: z.string().min(1), expectedOperation: z.enum(["push", "swap", "pop", "deliver", "drop"]).optional(),
}).strict();
export const MplsLabelOperationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("mpls-label-operation"), deviceId: z.string().min(1), operation: z.enum(["push", "swap", "pop", "deliver"]),
}).strict();
export const VrfExistsGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vrf-exists"), deviceId: z.string().min(1), vrfId: z.string().min(1),
}).strict();
export const VrfInterfaceGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vrf-interface"), deviceId: z.string().min(1), vrfId: z.string().min(1), interfaceId: z.string().min(1),
}).strict();
export const VrfRouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vrf-route"), deviceId: z.string().min(1), vrfId: z.string().min(1), network: Ipv4Schema, prefixLength: z.number().int().min(0).max(32), expectedSource: z.enum(["connected", "static", "bgp-vpn"]).optional(),
}).strict();
export const Vpnv4RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vpnv4-route"), deviceId: z.string().min(1), routeDistinguisher: RouteDistinguisherSchema, network: Ipv4Schema, prefixLength: z.number().int().min(0).max(32),
}).strict();
export const RouteTargetImportGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("route-target-import"), deviceId: z.string().min(1), vrfId: z.string().min(1), routeTarget: RouteTargetSchema,
}).strict();
export const RouteTargetExportGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("route-target-export"), deviceId: z.string().min(1), vrfId: z.string().min(1), routeTarget: RouteTargetSchema,
}).strict();
export const L3vpnConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("l3vpn-connectivity"), sourceDeviceId: z.string().min(1), destinationIp: Ipv4Schema, expected: z.enum(["success", "failure"]).default("success"),
}).strict();
export const CustomerIsolationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("customer-isolation"), deviceId: z.string().min(1), sourceVrfId: z.string().min(1), destinationVrfId: z.string().min(1), network: Ipv4Schema, prefixLength: z.number().int().min(0).max(32),
}).strict();
export const OverlappingPrefixIsolationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("overlapping-prefix-isolation"), deviceId: z.string().min(1), firstVrfId: z.string().min(1), secondVrfId: z.string().min(1), network: Ipv4Schema, prefixLength: z.number().int().min(0).max(32),
}).strict();

// --- M10.13 MP-BGP IPv6 unicast and MPLS VPNv6 ---------------------------

const BgpIpv6PrefixExpectationSchema = z.object({
  network: Ipv6Schema,
  prefixLength: Ipv6PrefixLengthSchema,
});

export const BgpIpv6NeighborStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-ipv6-neighbor-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    /** The peer's transport address: an IPv6 session, or IPv6 over IPv4 transport. */
    neighborAddress: IpAddressSchema,
    expectedState: z.enum(["idle", "connect", "active", "open-sent", "open-confirm", "established"]),
  }).strict(),
}).strict();

export const BgpIpv6RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-ipv6-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedNextHop: Ipv6Schema.optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).merge(BgpIpv6PrefixExpectationSchema).strict(),
}).strict();

export const BgpIpv6BestPathGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-ipv6-best-path"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedNeighborAddress: IpAddressSchema.optional(),
    expectedAsPath: z.array(z.number().int().min(1).max(4_294_967_295)).optional(),
  }).merge(BgpIpv6PrefixExpectationSchema).strict(),
}).strict();

export const Ipv6PrefixListEntryGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ipv6-prefix-list-entry"),
  configuration: z.object({
    deviceId: z.string().min(1),
    prefixListId: z.string().min(1),
    sequence: z.number().int().min(1),
    expectedAction: z.enum(["permit", "deny"]),
  }).strict(),
}).strict();

export const BgpIpv6PolicyResultGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("bgp-ipv6-policy-result"),
  configuration: z.object({
    deviceId: z.string().min(1),
    neighborAddress: IpAddressSchema,
    direction: z.enum(["in", "out"]),
    expected: z.enum(["permitted", "denied"]),
  }).merge(BgpIpv6PrefixExpectationSchema).strict(),
}).strict();

/**
 * A VPNv6 NLRI reached this PE with the expected RD. RD, route targets and the
 * VPN label are hidden expected values: a student result never echoes them.
 */
export const Vpnv6RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vpnv6-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    routeDistinguisher: RouteDistinguisherSchema,
    expectedRouteTarget: RouteTargetSchema.optional(),
  }).merge(BgpIpv6PrefixExpectationSchema).strict(),
}).strict();

export const Vpnv6LabelGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vpnv6-label"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vrfId: z.string().min(1),
    /** Optional: an exact label value is a hidden expectation when present. */
    expectedLabel: z.number().int().min(16).max(1_048_575).optional(),
  }).strict(),
}).strict();

export const VrfIpv6RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vrf-ipv6-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vrfId: z.string().min(1),
    expectedSource: z.enum(["connected", "static", "bgp-vpn"]).optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).merge(BgpIpv6PrefixExpectationSchema).strict(),
}).strict();

export const Vpnv6ConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vpnv6-connectivity"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv6Schema,
    expected: z.enum(["success", "failure"]).default("success"),
  }).strict(),
}).strict();

/**
 * The same IPv6 prefix lives in two VRFs and stays separate. Both VRFs must
 * hold it and the two entries must not resolve to the same next hop.
 */
export const OverlappingIpv6PrefixIsolationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("overlapping-ipv6-prefix-isolation"),
  configuration: z.object({
    deviceId: z.string().min(1),
    firstVrfId: z.string().min(1),
    secondVrfId: z.string().min(1),
  }).merge(BgpIpv6PrefixExpectationSchema).strict(),
}).strict();

// --- M10.14 VXLAN and BGP EVPN Layer 2 overlays -------------------------

/**
 * Every VXLAN/EVPN expectation is a *hidden* value: an RD, a route target and a
 * MAC address name the answer, so a student result reports only whether the
 * check passed and never echoes the expected value back.
 */
const VniExpectationSchema = z.object({ vni: VniSchema });

export const NveConfiguredGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("nve-configured"),
  configuration: z.object({
    deviceId: z.string().min(1),
    /** The Loopback the NVE sources from, e.g. "Loopback0". */
    expectedSourceInterfaceId: z.string().min(1).max(64).optional(),
    expected: z.enum(["operational", "configured", "down"]).default("operational"),
  }).strict(),
}).strict();

export const VxlanVniMappingGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vxlan-vni-mapping"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vlanId: VlanIdSchema,
    expectedReplication: z.enum(["static", "bgp-evpn"]).optional(),
  }).merge(VniExpectationSchema).strict(),
}).strict();

export const VxlanPeerStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vxlan-peer-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    peerAddress: Ipv4Schema,
    expected: z.enum(["reachable", "unreachable", "absent"]).default("reachable"),
  }).merge(VniExpectationSchema).strict(),
}).strict();

export const VxlanRemoteMacGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vxlan-remote-mac"),
  configuration: z.object({
    deviceId: z.string().min(1),
    macAddress: MacAddressSchema,
    expectedRemoteVtep: Ipv4Schema.optional(),
    expectedSource: z.enum(["data-plane", "bgp-evpn"]).optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).merge(VniExpectationSchema).strict(),
}).strict();

export const EvpnType2RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-type2-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    macAddress: MacAddressSchema,
    routeDistinguisher: RouteDistinguisherSchema.optional(),
    expectedNextHop: Ipv4Schema.optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).merge(VniExpectationSchema).strict(),
}).strict();

export const EvpnType3RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-type3-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    /** The VTEP that originated the Inclusive Multicast route. */
    originatingVtep: Ipv4Schema.optional(),
    routeDistinguisher: RouteDistinguisherSchema.optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).merge(VniExpectationSchema).strict(),
}).strict();

export const EvpnRouteTargetGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-route-target"),
  configuration: z.object({
    deviceId: z.string().min(1),
    direction: z.enum(["import", "export"]),
    routeTarget: RouteTargetSchema,
  }).merge(VniExpectationSchema).strict(),
}).strict();

export const VxlanL2ConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vxlan-l2-connectivity"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    expected: z.enum(["success", "failure"]).default("success"),
    /** Require the delivery to have actually crossed a VXLAN tunnel. */
    requireEncapsulation: z.boolean().default(true),
  }).strict(),
}).strict();

/**
 * An EVPN route reached this device *through* a reflector, evidenced by the
 * `ORIGINATOR_ID` and `CLUSTER_LIST` the reflector stamped on it. Like
 * `bgp-route-reflected`, the device named here is the one holding the
 * reflected route — the reflector itself is identified by `expectedClusterId`.
 */
export const EvpnRouteReflectedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-route-reflected"),
  configuration: z.object({
    deviceId: z.string().min(1),
    /** Every type rides the same family and the same reflector. */
    routeType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    expectedOriginatorId: Ipv4Schema.optional(),
    expectedClusterId: Ipv4Schema.optional(),
  }).strict(),
}).strict();

// --- M10.15 routed EVPN: anycast gateway, L3VNI and symmetric IRB ---------
// Every expectation below stays in the hidden spec: a student result reports
// only whether the check passed, never the expected MAC, RD, route target or
// VNI that would name the answer.

/**
 * A distributed anycast gateway on one leaf.
 *
 * Two leaves presenting the same gateway IP and MAC is the point of the
 * feature, so this check never treats that as a conflict; it verifies that the
 * SVI adopted the fabric MAC and answers for the tenant's gateway address.
 */
export const EvpnAnycastGatewayGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-anycast-gateway"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vlanId: VlanIdSchema,
    expectedGatewayAddress: Ipv4Schema.optional(),
    expectedGatewayMac: MacAddressSchema.optional(),
    expectedVrfId: z.string().min(1).max(64).optional(),
    expected: z.enum(["operational", "configured", "absent"]).default("operational"),
  }).strict(),
}).strict();

/** `member vni <n> associate-vrf <name>`: the routed transit segment. */
export const EvpnL3VniGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-l3vni"),
  configuration: z.object({
    deviceId: z.string().min(1),
    expectedVrfId: z.string().min(1).max(64).optional(),
    expectedRouteDistinguisher: RouteDistinguisherSchema.optional(),
    /** `advertise l2vpn evpn` on the tenant's IPv4 address family. */
    expectedAdvertiseEvpn: z.boolean().optional(),
    expected: z.enum(["operational", "configured", "down", "absent"]).default("operational"),
  }).merge(VniExpectationSchema).strict(),
}).strict();

/** A Type 5 prefix this device originated or holds in its EVPN RIB. */
export const EvpnType5RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-type5-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: Ipv4Schema,
    prefixLength: z.number().int().min(0).max(32),
    routeDistinguisher: RouteDistinguisherSchema.optional(),
    expectedL3Vni: VniSchema.optional(),
    expectedNextHopVtep: Ipv4Schema.optional(),
    /** `local` requires this VTEP to be the originator rather than a receiver. */
    expectedOrigin: z.enum(["local", "remote"]).optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).strict(),
}).strict();

/**
 * A Type 5 prefix that actually became tenant forwarding state.
 *
 * Import is decided by the VRF's route targets alone, so `absent` is exactly
 * how tenant isolation is graded: the route may sit in the EVPN RIB while
 * installing nothing.
 */
export const EvpnType5ImportedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-type5-imported"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vrfId: z.string().min(1).max(64),
    network: Ipv4Schema,
    prefixLength: z.number().int().min(0).max(32),
    expectedRemoteVtep: Ipv4Schema.optional(),
    expectedL3Vni: VniSchema.optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).strict(),
}).strict();

/** End-to-end symmetric IRB: routed at both ends, over the L3VNI. */
export const EvpnIrbConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-irb-connectivity"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    expected: z.enum(["success", "failure"]).default("success"),
    /** Require the delivery to have crossed the routed overlay, not a bridge. */
    requireL3VniTransit: z.boolean().default(true),
  }).strict(),
}).strict();

/**
 * Two tenants stay two tenants.
 *
 * A VRF must not hold a prefix that belongs to another tenant, and the underlay
 * device named here must hold no tenant route at all — it sees only the outer
 * IPv4/UDP 4789 datagram.
 */
export const EvpnVrfIsolationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-vrf-isolation"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vrfId: z.string().min(1).max(64),
    /** A prefix belonging to another tenant that must not be installed here. */
    foreignNetwork: Ipv4Schema,
    foreignPrefixLength: z.number().int().min(0).max(32),
    /** Optional underlay device that must carry no tenant route at all. */
    underlayDeviceId: z.string().min(1).optional(),
  }).strict(),
}).strict();

/** A tenant prefix learned from a remote VTEP and usable for forwarding. */
export const EvpnRemotePrefixGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-remote-prefix"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vrfId: z.string().min(1).max(64),
    network: Ipv4Schema,
    prefixLength: z.number().int().min(0).max(32),
    expectedRemoteVtep: Ipv4Schema.optional(),
    /** Require the underlay to actually reach the advertising VTEP. */
    requireUnderlayReachable: z.boolean().default(true),
  }).strict(),
}).strict();

/** The routed overlay as a whole: L3VNI up and carrying tenant prefixes. */
export const EvpnRoutedOverlayOperationalGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-routed-overlay-operational"),
  configuration: z.object({
    deviceId: z.string().min(1),
    minimumImportedPrefixes: z.number().int().min(0).max(4_096).default(1),
    minimumOriginatedPrefixes: z.number().int().min(0).max(4_096).default(1),
    expected: z.enum(["operational", "down"]).default("operational"),
  }).strict(),
}).strict();

/**
 * A tenant's Layer 2 segment stays inside its VNI: the underlay Spine/P device
 * learns no tenant MAC, and a VTEP holds no remote MAC whose route target it
 * never imported.
 */
export const EvpnCustomerIsolationGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-customer-isolation"),
  configuration: z.object({
    /** An underlay device that must not hold any tenant MAC of this VNI. */
    underlayDeviceId: z.string().min(1),
    /** Optional VTEP that must not have imported the foreign VNI. */
    vtepDeviceId: z.string().min(1).optional(),
    foreignVni: VniSchema.optional(),
  }).strict(),
}).strict();

// --- M10.16 EVPN Single-Active multihoming --------------------------------
// Every expectation below stays in the hidden spec: a student result reports
// only whether the check passed, never the expected ESI, the DF candidate list
// or which leaf was supposed to win.

/** One Ethernet Segment's configuration and operational state on one leaf. */
export const EvpnEthernetSegmentGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-ethernet-segment"),
  configuration: z.object({
    deviceId: z.string().min(1),
    segmentId: z.string().min(1).max(64),
    /** The access switchports the segment must attach. */
    expectedInterfaces: z.array(z.string().min(1).max(64)).max(8).optional(),
    expected: z.enum(["operational", "configured", "down", "absent"]).default("operational"),
  }).strict(),
}).strict();

/** The ESI itself: a hidden expected value, never echoed back to a student. */
export const EvpnEsiGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-esi"),
  configuration: z.object({
    deviceId: z.string().min(1),
    segmentId: z.string().min(1).max(64),
    esi: EsiSchema,
  }).strict(),
}).strict();

/**
 * Who forwards toward the CE for one `<ESI, VLAN>`.
 *
 * `non-df` is as meaningful as `df`: in Single-Active exactly one leaf forwards,
 * so grading the standby side is how a lab proves there is no second one.
 */
export const EvpnDfRoleGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-df-role"),
  configuration: z.object({
    deviceId: z.string().min(1),
    esi: EsiSchema,
    vlanId: VlanIdSchema,
    expectedRole: z.enum(["df", "non-df"]),
    /** The VTEP address that must have won, when the lab pins it. */
    expectedDesignatedForwarder: Ipv4Schema.optional(),
  }).strict(),
}).strict();

/** An Ethernet A-D route, in one of its two scopes. */
export const EvpnType1RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-type1-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    esi: EsiSchema,
    scope: z.enum(["per-es", "per-evi"]),
    /** Required for a per-EVI route; ignored for a per-ES one. */
    vni: VniSchema.optional(),
    originatingVtep: Ipv4Schema.optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).strict(),
}).strict();

/** An Ethernet Segment route: how two leaves discover they share a CE. */
export const EvpnType4RouteGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-type4-route"),
  configuration: z.object({
    deviceId: z.string().min(1),
    esi: EsiSchema,
    originatingVtep: Ipv4Schema.optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).strict(),
}).strict();

/** Which VTEP a multihomed MAC is actually forwarded to. */
export const EvpnMultihomingPrimaryGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-multihoming-primary"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vni: VniSchema,
    macAddress: MacAddressSchema,
    expectedPrimary: Ipv4Schema.optional(),
    expectedEsi: EsiSchema.optional(),
    expected: z.enum(["present", "absent"]).default("present"),
  }).strict(),
}).strict();

/**
 * The deterministic backup a multihomed MAC keeps.
 *
 * Single-Active never forwards over it — that would be aliasing, which M10.16
 * deliberately does not model — so this grades the *state* that makes a
 * failover a selection rather than a relearn.
 */
export const EvpnMultihomingBackupGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-multihoming-backup"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vni: VniSchema,
    macAddress: MacAddressSchema,
    expectedBackup: Ipv4Schema.optional(),
    minimumBackups: z.number().int().min(0).max(8).default(1),
  }).strict(),
}).strict();

/**
 * End-to-end Single-Active failover as a bounded deterministic action.
 *
 * The check pings, shuts the named attachment, lets the fabric reconverge in
 * virtual time and pings again. Everything it does is bounded and reproducible,
 * so the browser and the verifier reach the same verdict.
 */
export const EvpnSingleActiveFailoverGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-single-active-failover"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    /** The leaf whose CE-facing attachment is taken down. */
    failDeviceId: z.string().min(1),
    failInterfaceId: z.string().min(1).max(64),
    /** The leaf that must take the Designated Forwarder role over. */
    expectedNewDesignatedForwarderDeviceId: z.string().min(1).optional(),
    /** Require the mass withdrawal to be observable in the trace. */
    requireMassWithdraw: z.boolean().default(true),
  }).strict(),
}).strict();

/**
 * A frame that entered the fabric on one Ethernet Segment never comes back to
 * it, so a dual-attached CE never sees its own frame return.
 */
export const EvpnSplitHorizonGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-split-horizon"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    /** The leaf that must refuse to hand the frame back to the segment. */
    nonDesignatedDeviceId: z.string().min(1),
  }).strict(),
}).strict();

// --- M10.17 All-Active multihoming, aliasing, MAC mobility and HRW ---------
//
// As with the M10.16 checks above, every expected value here stays server-side:
// a student result never echoes back the ESI, the mobility sequence, an HRW
// weight or the candidate set that was supposed to win.

/** One Ethernet Segment's redundancy mode, on one leaf. */
export const EvpnAllActiveModeGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-all-active-mode"),
  configuration: z.object({
    deviceId: z.string().min(1),
    segmentId: z.string().min(1).max(64),
    expectedMode: z.enum(["single-active", "all-active"]).default("all-active"),
    /** Require every discovered peer of the segment to agree on the mode. */
    requirePeerAgreement: z.boolean().default(false),
  }).strict(),
}).strict();

/**
 * An aliasing path set: a MAC one leaf advertised that another leaf can still
 * reach over a second VTEP.
 *
 * `minimumEligibleVteps` is what makes this an aliasing check rather than a
 * reachability one — a single eligible path is just an ordinary remote MAC.
 */
export const EvpnAliasingPathGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-aliasing-path"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vni: VniSchema,
    macAddress: MacAddressSchema,
    expectedEsi: EsiSchema.optional(),
    /** The leaf that originated the Type 2, when the lab pins it. */
    expectedAdvertisingVtep: Ipv4Schema.optional(),
    /** Every VTEP that must appear as eligible, in any order. */
    expectedEligibleVteps: z.array(Ipv4Schema).max(8).optional(),
    minimumEligibleVteps: z.number().int().min(1).max(8).default(2),
    expected: z.enum(["present", "absent"]).default("present"),
  }).strict(),
}).strict();

/**
 * End-to-end reachability over an All-Active segment.
 *
 * `requireAliasedPath` additionally demands that the MAC was reached over a
 * leaf that never advertised it, which is the thing Single-Active cannot do.
 */
export const EvpnAllActiveConnectivityGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-all-active-connectivity"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    requireAliasedPath: z.boolean().default(false),
  }).strict(),
}).strict();

/** The mobility sequence a MAC currently carries in one leaf's EVPN state. */
export const EvpnMacMobilitySequenceGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-mac-mobility-sequence"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vni: VniSchema,
    macAddress: MacAddressSchema,
    expectedSequence: z.number().int().min(0).max(4_294_967_295).optional(),
    minimumSequence: z.number().int().min(0).max(4_294_967_295).optional(),
  }).strict(),
}).strict();

/**
 * Which leaf actually owns a MAC after a move.
 *
 * `requirePreviousOwnerStale` is how a lab proves the older advertisement lost
 * rather than merely that a newer one exists.
 */
export const EvpnMacOwnerGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-mac-owner"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vni: VniSchema,
    macAddress: MacAddressSchema,
    /** The VTEP that must own the address now. */
    expectedOwner: Ipv4Schema.optional(),
    expectedPreviousOwner: Ipv4Schema.optional(),
    requirePreviousOwnerStale: z.boolean().default(false),
  }).strict(),
}).strict();

/**
 * An HRW election result on one leaf.
 *
 * Grading the BDF matters as much as the DF: it is what proves the election
 * produced a full deterministic order rather than one lucky winner.
 */
export const EvpnHrwDfGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-hrw-df"),
  configuration: z.object({
    deviceId: z.string().min(1),
    esi: EsiSchema,
    vlanId: z.number().int().min(1).max(4_094),
    expectedDesignatedForwarder: Ipv4Schema.optional(),
    expectedBackupDesignatedForwarder: Ipv4Schema.optional(),
    /** The role this leaf itself must hold, when the lab pins it. */
    expectedLocalRole: z.enum(["df", "non-df"]).optional(),
    requireHrwEffective: z.boolean().default(true),
  }).strict(),
}).strict();

/**
 * The capability agreement itself: a segment whose participants disagree must
 * fall back to the modulus election *consistently*, never leave two leaves
 * computing different forwarders.
 */
export const EvpnHrwFallbackGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-hrw-fallback"),
  configuration: z.object({
    deviceId: z.string().min(1),
    esi: EsiSchema,
    vlanId: z.number().int().min(1).max(4_094),
    expectedRequestedAlgorithm: z.enum(["default", "hrw"]).default("hrw"),
    expectedEffectiveAlgorithm: z.enum(["default", "hrw"]).default("default"),
    requireFallbackReason: z.boolean().default(true),
  }).strict(),
}).strict();

/**
 * End-to-end All-Active failover as a bounded deterministic action.
 *
 * It pings, takes the named attachment down, reconverges in virtual time and
 * pings again — and, unlike the Single-Active check, it asserts the address was
 * never relearned, because a surviving alias means no relearn is needed.
 */
export const EvpnAllActiveFailoverGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("evpn-all-active-failover"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    /** The leaf whose CE-facing attachment is taken down. */
    failDeviceId: z.string().min(1),
    failInterfaceId: z.string().min(1).max(64),
    /** The leaf that must still carry the traffic afterwards. */
    expectedSurvivingVtep: Ipv4Schema.optional(),
    /** Require the MAC to survive without a single relearn. */
    requireNoRelearn: z.boolean().default(true),
  }).strict(),
}).strict();

/**
 * `copy running-config startup-config` was actually run on this device.
 *
 * It compares the canonical structured snapshots, never rendered text, so it
 * cannot be fooled by formatting and cannot break when the renderer changes.
 */
export const ConfigurationSavedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("configuration-saved"),
  configuration: z.object({ deviceId: z.string().min(1) }).strict(),
}).strict();

export const GradingCheckSchema = z.discriminatedUnion("type", [
  MplsInterfaceEnabledGradingCheckSchema,
  LdpNeighborStateGradingCheckSchema,
  LdpBindingGradingCheckSchema,
  MplsLfibEntryGradingCheckSchema,
  MplsLabelOperationGradingCheckSchema,
  VrfExistsGradingCheckSchema,
  VrfInterfaceGradingCheckSchema,
  VrfRouteGradingCheckSchema,
  Vpnv4RouteGradingCheckSchema,
  RouteTargetImportGradingCheckSchema,
  RouteTargetExportGradingCheckSchema,
  L3vpnConnectivityGradingCheckSchema,
  CustomerIsolationGradingCheckSchema,
  OverlappingPrefixIsolationGradingCheckSchema,
  BgpNeighborStateGradingCheckSchema,
  BgpLocalAsGradingCheckSchema,
  BgpNetworkGradingCheckSchema,
  BgpRouteGradingCheckSchema,
  BgpBestPathGradingCheckSchema,
  BgpNextHopGradingCheckSchema,
  PrefixListEntryGradingCheckSchema,
  RouteMapSequenceGradingCheckSchema,
  RoutePolicyResultGradingCheckSchema,
  BgpAdvertisedRouteGradingCheckSchema,
  BgpReceivedRouteGradingCheckSchema,
  BgpRouteReflectorClientGradingCheckSchema,
  BgpClusterIdGradingCheckSchema,
  BgpRouteReflectedGradingCheckSchema,
  BgpOriginatorLoopPreventedGradingCheckSchema,
  BgpCommunityGradingCheckSchema,
  BgpCommunityListGradingCheckSchema,
  BgpAsPathListGradingCheckSchema,
  BgpRoutePolicyResultGradingCheckSchema,
  BgpAggregateGradingCheckSchema,
  BgpSpecificSuppressedGradingCheckSchema,
  BgpDefaultAdvertisedGradingCheckSchema,
  BgpIpv6NeighborStateGradingCheckSchema,
  BgpIpv6RouteGradingCheckSchema,
  BgpIpv6BestPathGradingCheckSchema,
  Ipv6PrefixListEntryGradingCheckSchema,
  BgpIpv6PolicyResultGradingCheckSchema,
  Vpnv6RouteGradingCheckSchema,
  Vpnv6LabelGradingCheckSchema,
  VrfIpv6RouteGradingCheckSchema,
  Vpnv6ConnectivityGradingCheckSchema,
  OverlappingIpv6PrefixIsolationGradingCheckSchema,
  NveConfiguredGradingCheckSchema,
  VxlanVniMappingGradingCheckSchema,
  VxlanPeerStateGradingCheckSchema,
  VxlanRemoteMacGradingCheckSchema,
  EvpnType2RouteGradingCheckSchema,
  EvpnType3RouteGradingCheckSchema,
  EvpnRouteTargetGradingCheckSchema,
  VxlanL2ConnectivityGradingCheckSchema,
  EvpnRouteReflectedGradingCheckSchema,
  EvpnCustomerIsolationGradingCheckSchema,
  EvpnEthernetSegmentGradingCheckSchema,
  EvpnEsiGradingCheckSchema,
  EvpnDfRoleGradingCheckSchema,
  EvpnType1RouteGradingCheckSchema,
  EvpnType4RouteGradingCheckSchema,
  EvpnMultihomingPrimaryGradingCheckSchema,
  EvpnMultihomingBackupGradingCheckSchema,
  EvpnSingleActiveFailoverGradingCheckSchema,
  EvpnSplitHorizonGradingCheckSchema,
  EvpnAllActiveModeGradingCheckSchema,
  EvpnAliasingPathGradingCheckSchema,
  EvpnAllActiveConnectivityGradingCheckSchema,
  EvpnMacMobilitySequenceGradingCheckSchema,
  EvpnMacOwnerGradingCheckSchema,
  EvpnHrwDfGradingCheckSchema,
  EvpnHrwFallbackGradingCheckSchema,
  EvpnAllActiveFailoverGradingCheckSchema,
  EvpnAnycastGatewayGradingCheckSchema,
  EvpnL3VniGradingCheckSchema,
  EvpnType5RouteGradingCheckSchema,
  EvpnType5ImportedGradingCheckSchema,
  EvpnIrbConnectivityGradingCheckSchema,
  EvpnVrfIsolationGradingCheckSchema,
  EvpnRemotePrefixGradingCheckSchema,
  EvpnRoutedOverlayOperationalGradingCheckSchema,
  ConfigurationSavedGradingCheckSchema,
  GreTunnelConfiguredGradingCheckSchema,
  GreTunnelOperationalGradingCheckSchema,
  TunnelConnectivityGradingCheckSchema,
  IkePeerConfiguredGradingCheckSchema,
  IkeStateGradingCheckSchema,
  IpsecProfileGradingCheckSchema,
  IpsecSaEstablishedGradingCheckSchema,
  ProtectedPacketDeliveredGradingCheckSchema,
  EspReplayRejectedGradingCheckSchema,
  VpnRouteGradingCheckSchema,
  QosClassMapGradingCheckSchema,
  QosPolicyMapGradingCheckSchema,
  QosPolicyAttachedGradingCheckSchema,
  PacketDscpGradingCheckSchema,
  PacketCosGradingCheckSchema,
  TrafficClassifiedGradingCheckSchema,
  PolicerResultGradingCheckSchema,
  ShaperResultGradingCheckSchema,
  QueueDropCountGradingCheckSchema,
  TrafficPriorityOrderGradingCheckSchema,
  RemoteServiceEnabledGradingCheckSchema,
  VtyTransportGradingCheckSchema,
  SshSessionEstablishedGradingCheckSchema,
  TelnetSessionEstablishedGradingCheckSchema,
  AaaMethodListGradingCheckSchema,
  RadiusAuthenticationGradingCheckSchema,
  TacacsAuthenticationGradingCheckSchema,
  CommandAuthorizedGradingCheckSchema,
  CommandDeniedGradingCheckSchema,
  SnmpAgentConfiguredGradingCheckSchema,
  SnmpValueGradingCheckSchema,
  SnmpTrapReceivedGradingCheckSchema,
  PingGradingCheckSchema,
  InterfaceStateGradingCheckSchema,
  SwitchportGradingCheckSchema,
  VlanExistsGradingCheckSchema,
  RouteExistsGradingCheckSchema,
  DhcpAddressGradingCheckSchema,
  DeviceTypeGradingCheckSchema,
  CapabilityPresentGradingCheckSchema,
  SviStateGradingCheckSchema,
  IpRoutingEnabledGradingCheckSchema,
  DnsRecordGradingCheckSchema,
  DnsResolutionGradingCheckSchema,
  HttpResponseGradingCheckSchema,
  TftpFileGradingCheckSchema,
  NtpResponseGradingCheckSchema,
  SyslogReceivedGradingCheckSchema,
  TcpListenerGradingCheckSchema,
  AclRuleGradingCheckSchema,
  AclBindingGradingCheckSchema,
  PacketPermittedGradingCheckSchema,
  PacketDeniedGradingCheckSchema,
  NatRuleGradingCheckSchema,
  NatTranslationGradingCheckSchema,
  FirewallRuleGradingCheckSchema,
  FirewallSessionGradingCheckSchema,
  ExternalConnectivityGradingCheckSchema,
  TrafficFlowResultGradingCheckSchema,
  StpRootGradingCheckSchema,
  StpModeGradingCheckSchema,
  StpPortRoleGradingCheckSchema,
  StpPortStateGradingCheckSchema,
  StpPortFastGradingCheckSchema,
  BpduGuardStateGradingCheckSchema,
  EtherChannelFormedGradingCheckSchema,
  EtherChannelProtocolGradingCheckSchema,
  EtherChannelMemberStateGradingCheckSchema,
  CdpNeighborGradingCheckSchema,
  LldpNeighborGradingCheckSchema,
  OspfRouterIdGradingCheckSchema,
  OspfNeighborStateGradingCheckSchema,
  OspfInterfaceGradingCheckSchema,
  OspfDrGradingCheckSchema,
  OspfBdrGradingCheckSchema,
  OspfRouteGradingCheckSchema,
  OspfLsdbEntryGradingCheckSchema,
  OspfPathCostGradingCheckSchema,
  Ipv6AddressGradingCheckSchema,
  Ipv6NeighborGradingCheckSchema,
  SlaacAddressGradingCheckSchema,
  Dhcpv6AddressGradingCheckSchema,
  Ipv6RouteGradingCheckSchema,
  Ipv6ConnectivityGradingCheckSchema,
  Ospfv3NeighborGradingCheckSchema,
  Ospfv3RouteGradingCheckSchema,
  Ipv6AclRuleGradingCheckSchema,
  Ipv6PacketPermittedGradingCheckSchema,
  Ipv6PacketDeniedGradingCheckSchema,
  WirelessAssociatedGradingCheckSchema,
  WirelessSsidGradingCheckSchema,
  WirelessSecurityGradingCheckSchema,
  WirelessClientCountGradingCheckSchema,
  WirelessIpv4GradingCheckSchema,
  WirelessIpv6GradingCheckSchema,
  WirelessConnectivityGradingCheckSchema,
  WirelessRoamedGradingCheckSchema,
  WirelessRouterNatGradingCheckSchema,
]);
export type GradingCheck = z.infer<typeof GradingCheckSchema>;

export const GradingSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  checks: z.array(GradingCheckSchema),
});
export type GradingSpec = z.infer<typeof GradingSpecSchema>;

export const VerificationResultViewSchema = z.enum(["student", "instructor"]);
export type VerificationResultView = z.infer<typeof VerificationResultViewSchema>;

export const VerificationRequestSchema = z.object({
  submission: LabSubmissionDocumentSchema,
  gradingSpec: GradingSpecSchema,
  resultView: VerificationResultViewSchema.default("student"),
  /** Deliberately ignored untrusted browser claim, retained for boundary tests. */
  score: z.unknown().optional(),
});
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export const VerificationCheckResultSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed", "error"]),
  awardedPoints: z.number().nonnegative(),
  maximumPoints: z.number().nonnegative(),
  message: z.string(),
  title: z.string().optional(),
  visibility: GradingVisibilitySchema.optional(),
  diagnostics: z.record(z.unknown()).optional(),
});
export type VerificationCheckResult = z.infer<typeof VerificationCheckResultSchema>;

export const VerificationResultSchema = z.object({
  verificationId: z.string().min(1),
  status: z.literal("completed"),
  resultView: VerificationResultViewSchema,
  score: z.number().min(0).max(100),
  awardedPoints: z.number().nonnegative(),
  maximumPoints: z.number().nonnegative(),
  checks: z.array(VerificationCheckResultSchema),
  engine: z.object({
    schemaVersion: z.literal(1),
    simulationSeed: z.number().int().nonnegative(),
    processedEvents: z.number().int().nonnegative(),
    virtualTimeNs: z.number().nonnegative(),
  }),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

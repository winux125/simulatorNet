import { z } from "zod";
import { DeviceCapabilitySchema, DeviceTypeSchema } from "./devices";
import { WirelessSecurityModeSchema } from "./wireless";
import { IpAddressSchema } from "./primitives";
import { CosValueSchema, DscpValueSchema } from "./qos";
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

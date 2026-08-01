import type { LabDocument, PasswordVerifier, VpnConfiguration } from "@sim/contracts";

/**
 * M10.9 site-to-site VPN demos.
 *
 * Like every demo they are only ever opened from the Demo Labs dialog, never
 * loaded automatically. Each one states its objective, underlay and overlay
 * addressing, the configuration steps, the expected result and troubleshooting
 * hints.
 *
 * SimulatorNet models deterministic educational GRE and site-to-site IPsec
 * behaviour. Its simulated ESP/IKE implementation does not provide real
 * cryptographic protection.
 *
 * The teaching key is printed in Instructions only. It is never stored here as
 * plaintext and never reaches grading metadata: a demo ships with the derived
 * verifier, and the learner types the key once at the no-echo prompt or in the
 * VPN panel, where it is converted to the same verifier.
 */

/** The teaching key for the demos, as its derived verifier. */
export const DEMO_PRE_SHARED_KEY_HINT = "simulatornet-site-vpn";

/**
 * Verifier for `DEMO_PRE_SHARED_KEY_HINT`, derived with the fixed VPN scope so
 * both peers compare equal. It is authentication material, not a key: it cannot
 * be reversed and it decrypts nothing.
 */
const DEMO_PSK_VERIFIER: PasswordVerifier = {
  algorithm: "pbkdf2-sha256",
  iterations: 120_000,
  saltBase64: "U2ltdWxhdG9yTmV0VlBOdg==",
  hashBase64: "nXIG8cAVe4Giftg0/+SpN1hShejknOWaBWb5/j3DIo4=",
};

const emptyRoutedSecurity = () => ({
  acls: [],
  aclBindings: [],
  natPools: [],
  natRules: [],
  natInterfaceRoles: [],
});

/**
 * LAN A — R1 — ISP — R2 — LAN B, the shared underlay for all three demos.
 * `branchKind` lets the IPsec demo put a web server behind the tunnel.
 */
function siteToSiteTopology(branchKind: "pc" | "server" = "pc") {
  return {
    schemaVersion: 1 as const,
    nodes: [
      { id: "pc-a", kind: "pc" as const, name: "PC-A", position: { x: 80, y: 220 }, interfaces: [{ id: "eth0" }] },
      {
        id: "r1",
        kind: "router" as const,
        name: "R1",
        position: { x: 320, y: 220 },
        interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }],
      },
      {
        id: "isp",
        kind: "cloud" as const,
        name: "ISP",
        position: { x: 560, y: 220 },
        interfaces: [{ id: "Eth0/0" }, { id: "Eth0/1" }, { id: "Eth0/2" }, { id: "Eth0/3" }],
      },
      {
        id: "r2",
        kind: "router" as const,
        name: "R2",
        position: { x: 800, y: 220 },
        interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }],
      },
      { id: "pc-b", kind: branchKind, name: "PC-B", position: { x: 1040, y: 220 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [
      { id: "pca-r1", a: { node: "pc-a", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } },
      { id: "r1-isp", a: { node: "r1", iface: "Gi0/1" }, b: { node: "isp", iface: "Eth0/0" } },
      { id: "isp-r2", a: { node: "isp", iface: "Eth0/1" }, b: { node: "r2", iface: "Gi0/1" } },
      { id: "r2-pcb", a: { node: "r2", iface: "Gi0/0" }, b: { node: "pc-b", iface: "eth0" } },
    ],
  };
}

function hostConfig(address: string, gateway: string, ipv6?: { address: string; router: string }) {
  return {
    kind: "pc" as const,
    interfaces: [],
    ipv4: { address, prefixLength: 24, defaultGateway: gateway },
    dhcpEnabled: false,
    ipv6: ipv6
      ? { mode: "static" as const, address: ipv6.address, prefixLength: 64, defaultRouter: ipv6.router }
      : undefined,
  };
}

function ispConfig() {
  return {
    kind: "cloud" as const,
    hostname: "ISP",
    interfaces: [
      { id: "Eth0/0", shutdown: false, routed: true, ipv4: { address: "203.0.113.2", prefixLength: 30 } },
      { id: "Eth0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.5", prefixLength: 30 } },
      { id: "Eth0/2", shutdown: false, routed: false },
      { id: "Eth0/3", shutdown: false, routed: false },
    ],
    subinterfaces: [],
    staticRoutes: [],
    dhcpPools: [],
    ...emptyRoutedSecurity(),
    impairments: [],
  };
}

// --- 1. GRE site-to-site ----------------------------------------------------

export const GRE_SITE_TO_SITE_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-vpn-gre-site-to-site",
  title: "VPN: GRE Site-to-Site",
  description:
    "Objective: join LAN A and LAN B over an untrusted provider with a plain GRE tunnel,"
    + " then carry both IPv4 and IPv6 across it.",
  instructions: [
    "Underlay addressing: R1 Gi0/1 203.0.113.1/30, ISP .2 and .5, R2 Gi0/1 203.0.113.6/30.",
    "  R1 and R2 each hold a static route to the far /30 through the provider.",
    "Overlay addressing: Tunnel0 10.255.0.1/30 on R1 and 10.255.0.2/30 on R2;",
    "  IPv6 overlay 2001:db8:ffff::1/64 and ::2/64. LAN A is 10.1.0.0/24, LAN B is 10.2.0.0/24.",
    "Configuration steps on R1 (mirror them on R2):",
    "  interface Tunnel0 / ip address 10.255.0.1 255.255.255.252 /",
    "  ipv6 address 2001:db8:ffff::1/64 / tunnel source Gi0/1 /",
    "  tunnel destination 203.0.113.6 / tunnel mode gre ip / no shutdown;",
    "  ip route 10.2.0.0 255.255.255.0 10.255.0.2 and ipv6 route 2001:db8:2::/64 2001:db8:ffff::2.",
    "Expected result: `show interfaces tunnel` reports Tunnel0 up, PC-A pings 10.2.0.10 and",
    "  2001:db8:2::10, and the Packet Trace filtered by GRE shows encapsulation on R1 and",
    "  decapsulation on R2 while the provider only ever routes 203.0.113.x.",
    "Troubleshooting hints: a tunnel is down when its source has no usable address, when the",
    "  underlay has no route to the destination, or when the route to the destination would",
    "  egress the tunnel itself — `show interfaces tunnel` names the reason.",
  ].join("\n"),
  expectedOutcome:
    "Tunnel0 is up on both routers and carries IPv4 and IPv6 traffic between the two LANs,"
    + " while the provider sees only outer GRE packets.",
  simulation: { seed: 10_901 },
  topology: siteToSiteTopology(),
  configurations: {
    "pc-a": {
      ...hostConfig("10.1.0.10", "10.1.0.1", { address: "2001:db8:1::10", router: "2001:db8:1::1" }),
      hostname: "PC-A",
    },
    "pc-b": {
      ...hostConfig("10.2.0.10", "10.2.0.1", { address: "2001:db8:2::10", router: "2001:db8:2::1" }),
      hostname: "PC-B",
    },
    isp: ispConfig(),
    r1: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        {
          id: "Gi0/0",
          shutdown: false,
          routed: true,
          ipv4: { address: "10.1.0.1", prefixLength: 24 },
          ipv6: [{ address: "2001:db8:1::1", prefixLength: 64 }],
        },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.1", prefixLength: 30 } },
      ],
      subinterfaces: [],
      staticRoutes: [
        { network: "203.0.113.4", prefixLength: 30, nextHop: "203.0.113.2" },
        { network: "10.2.0.0", prefixLength: 24, nextHop: "10.255.0.2" },
      ],
      dhcpPools: [],
      ipv6UnicastRoutingEnabled: true,
      ipv6StaticRoutes: [{ network: "2001:db8:2::", prefixLength: 64, nextHop: "2001:db8:ffff::2" }],
      ...emptyRoutedSecurity(),
      vpn: {
        tunnels: [{
          id: 0,
          shutdown: false,
          source: { type: "interface", interfaceId: "Gi0/1" },
          destinationAddress: "203.0.113.6",
          mode: "gre-ipv4",
          ipv4: { address: "10.255.0.1", prefixLength: 30 },
          ipv6: [{ address: "2001:db8:ffff::1", prefixLength: 64 }],
          mtu: 1_476,
          ttl: 255,
        }],
        proposals: [],
        ikePeers: [],
        ipsecProfiles: [],
      },
    },
    r2: {
      kind: "router",
      hostname: "R2",
      interfaces: [
        {
          id: "Gi0/0",
          shutdown: false,
          routed: true,
          ipv4: { address: "10.2.0.1", prefixLength: 24 },
          ipv6: [{ address: "2001:db8:2::1", prefixLength: 64 }],
        },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.6", prefixLength: 30 } },
      ],
      subinterfaces: [],
      staticRoutes: [
        { network: "203.0.113.0", prefixLength: 30, nextHop: "203.0.113.5" },
        { network: "10.1.0.0", prefixLength: 24, nextHop: "10.255.0.1" },
      ],
      dhcpPools: [],
      ipv6UnicastRoutingEnabled: true,
      ipv6StaticRoutes: [{ network: "2001:db8:1::", prefixLength: 64, nextHop: "2001:db8:ffff::1" }],
      ...emptyRoutedSecurity(),
      vpn: {
        tunnels: [{
          id: 0,
          shutdown: false,
          source: { type: "interface", interfaceId: "Gi0/1" },
          destinationAddress: "203.0.113.1",
          mode: "gre-ipv4",
          ipv4: { address: "10.255.0.2", prefixLength: 30 },
          ipv6: [{ address: "2001:db8:ffff::2", prefixLength: 64 }],
          mtu: 1_476,
          ttl: 255,
        }],
        proposals: [],
        ikePeers: [],
        ipsecProfiles: [],
      },
    },
  },
};

// --- 2. GRE over IPsec ------------------------------------------------------

function protectedVpn(destination: string, overlay: string): VpnConfiguration {
  return {
    tunnels: [{
      id: 0,
      shutdown: false,
      source: { type: "interface" as const, interfaceId: "Gi0/1" },
      destinationAddress: destination,
      mode: "gre-ipv4" as const,
      ipv4: { address: overlay, prefixLength: 30 },
      mtu: 1_400,
      ttl: 255,
      ipsecProfileId: "SITE-VPN",
    }],
    proposals: [{ id: "IKE-PROP", encryption: "sim-aes256" as const, integrity: "sim-sha256" as const }],
    ikePeers: [{
      id: destination === "203.0.113.6" ? "BRANCH" : "HQ",
      address: destination,
      preSharedKeyVerifier: DEMO_PSK_VERIFIER,
      proposalId: "IKE-PROP",
      lifetimeSeconds: 3_600,
      credentialResetRequired: false,
    }],
    ipsecProfiles: [{
      id: "SITE-VPN",
      ikePeerId: destination === "203.0.113.6" ? "BRANCH" : "HQ",
      proposalId: "IKE-PROP",
      lifetimeSeconds: 3_600,
    }],
  };
}

export const GRE_OVER_IPSEC_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-vpn-gre-over-ipsec",
  title: "VPN: GRE over IPsec",
  description:
    "Objective: protect the same GRE tunnel with an IKEv2 pre-shared key and an IPsec profile,"
    + " then confirm the provider can no longer see the inner HTTP conversation.",
  instructions: [
    "Underlay addressing: unchanged from the GRE demo — 203.0.113.0/30 and 203.0.113.4/30.",
    "Overlay addressing: Tunnel0 10.255.0.1/30 on R1(HQ) and 10.255.0.2/30 on R2(BRANCH),",
    "  MTU 1400 to leave room for the simulated ESP envelope. LAN A 10.1.0.0/24, LAN B 10.2.0.0/24.",
    `Teaching pre-shared key: ${DEMO_PRE_SHARED_KEY_HINT} — type it once per router. It is never`,
    "  stored in the clear: the VPN panel and the CLI prompt both convert it to a verifier.",
    "Configuration steps on R1 (mirror them on R2 with the opposite address):",
    "  crypto ikev2 proposal IKE-PROP / encryption sim-aes256 / integrity sim-sha256;",
    "  crypto ikev2 peer BRANCH / address 203.0.113.6 / pre-shared-key / proposal IKE-PROP / lifetime 3600;",
    "  crypto ipsec profile SITE-VPN / set ikev2-peer BRANCH / set proposal IKE-PROP / lifetime 3600;",
    "  interface Tunnel0 / tunnel protection ipsec profile SITE-VPN.",
    "Expected result: `show crypto ikev2 sa` reports ESTABLISHED and `show crypto ipsec sa` lists an",
    "  inbound and an outbound SA. PC-A fetches http://10.2.0.10/ across the tunnel, and the Packet",
    "  Trace filtered by ESP shows protection on R1 and unprotection on R2 while the provider sees",
    "  only outer ESP packets — never the inner TCP ports.",
    "Troubleshooting hints: a protected tunnel carries no traffic until an SA is active, so check",
    "  the IKE state first. `show interfaces tunnel` reports protection-unavailable while the peers",
    "  disagree about the key or the proposal.",
  ].join("\n"),
  expectedOutcome:
    "IKEv2 establishes with a matching pre-shared key and proposal, GRE packets are wrapped in"
    + " simulated ESP, and the inner HTTP exchange is invisible to the provider.",
  simulation: { seed: 10_902 },
  topology: siteToSiteTopology("server"),
  configurations: {
    "pc-a": { ...hostConfig("10.1.0.10", "10.1.0.1"), hostname: "PC-A" },
    "pc-b": {
      kind: "server",
      hostname: "PC-B",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.2.0.10", prefixLength: 24 } }],
      defaultGateway: "10.2.0.1",
      dhcpClientEnabled: false,
      enabledServices: [{
        id: "branch-web",
        type: "http",
        enabled: true,
        port: 80,
        resources: [{ path: "/", contentType: "text/plain", body: "branch intranet over the protected tunnel" }],
      }],
    },
    isp: ispConfig(),
    r1: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.1.0.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.1", prefixLength: 30 } },
      ],
      subinterfaces: [],
      staticRoutes: [
        { network: "203.0.113.4", prefixLength: 30, nextHop: "203.0.113.2" },
        { network: "10.2.0.0", prefixLength: 24, nextHop: "10.255.0.2" },
      ],
      dhcpPools: [],
      ...emptyRoutedSecurity(),
      vpn: protectedVpn("203.0.113.6", "10.255.0.1"),
    },
    r2: {
      kind: "router",
      hostname: "R2",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.2.0.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.6", prefixLength: 30 } },
      ],
      subinterfaces: [],
      staticRoutes: [
        { network: "203.0.113.0", prefixLength: 30, nextHop: "203.0.113.5" },
        { network: "10.1.0.0", prefixLength: 24, nextHop: "10.255.0.1" },
      ],
      dhcpPools: [],
      ...emptyRoutedSecurity(),
      vpn: protectedVpn("203.0.113.1", "10.255.0.2"),
    },
  },
};

// --- 3. VPN failure and rekey ----------------------------------------------

/**
 * R2 deliberately ships without a pre-shared key, so the tunnel starts broken.
 * Setting the same teaching key on both ends is the lesson.
 */
function branchVpnWithoutKey() {
  const base = protectedVpn("203.0.113.1", "10.255.0.2");
  return {
    ...base,
    ikePeers: base.ikePeers.map((peer) => ({
      ...peer,
      preSharedKeyVerifier: undefined,
      credentialResetRequired: true,
    })),
  };
}

export const VPN_FAILURE_AND_REKEY_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "demo-vpn-failure-and-rekey",
  title: "VPN: Failure and Rekey",
  description:
    "Objective: diagnose a VPN that will not come up, fix the credentials, watch a deterministic"
    + " rekey happen in virtual time, and see an ACL take the tunnel down again.",
  instructions: [
    "Underlay addressing: unchanged — 203.0.113.0/30 and 203.0.113.4/30 through the provider.",
    "Overlay addressing: Tunnel0 10.255.0.1/30 on R1(HQ) and 10.255.0.2/30 on R2(BRANCH),",
    "  protected by IPsec profile SITE-VPN with a 120-second lifetime so a rekey is quick to reach.",
    `Teaching pre-shared key: ${DEMO_PRE_SHARED_KEY_HINT}. R1 already has it; R2 ships without one.`,
    "Configuration steps:",
    "  1. Start the lab and read `show crypto ikev2 sa` on both routers — R2 reports no pre-shared key.",
    "  2. On R2: crypto ikev2 peer HQ / pre-shared-key, then type the key at the no-echo prompt",
    "     (or use VPN → IKE Peers → Set Key in the device window).",
    "  3. Confirm ESTABLISHED and an inbound/outbound SA pair, then ping 10.2.0.10 from PC-A.",
    "  4. Advance virtual time past 108 s (90% of the lifetime) and confirm `ipsec-sa-rekeyed`.",
    "  5. Apply ACL BLOCK-ESP outbound on R1 Gi0/1 (`deny esp`, then `permit ip`) and ping again.",
    "     The ping fails and the Packet Trace shows acl-denied for protocol 50 — but IKE runs over",
    "     UDP 500, which the ACL still permits, so `show crypto ikev2 sa` stays ESTABLISHED. A live",
    "     session and a working data path are two different things.",
    "  6. Remove the ACL binding and confirm protected traffic flows again.",
    "Expected result: authentication failure is visible and named, the corrected key establishes an",
    "  SA, the rekey installs a new SPI pair without losing traffic, and denying ESP stops protected",
    "  traffic while leaving the IKE session up.",
    "Troubleshooting hints: Problems names the exact reason — authentication-failed,",
    "  proposal-mismatch, peer-unreachable or rekey-failed. IPsec keeps no periodic timer, so a",
    "  rekey becomes due when you advance virtual time or send the next protected packet.",
  ].join("\n"),
  expectedOutcome:
    "The wrong-credential failure is diagnosable, the corrected key establishes an SA, a"
    + " deterministic rekey installs a new SPI pair, and an ACL denying ESP stops protected traffic"
    + " while the IKE session itself stays up.",
  simulation: { seed: 10_903 },
  topology: siteToSiteTopology(),
  configurations: {
    "pc-a": { ...hostConfig("10.1.0.10", "10.1.0.1"), hostname: "PC-A" },
    "pc-b": { ...hostConfig("10.2.0.10", "10.2.0.1"), hostname: "PC-B" },
    isp: ispConfig(),
    r1: {
      kind: "router",
      hostname: "R1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.1.0.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.1", prefixLength: 30 } },
      ],
      subinterfaces: [],
      staticRoutes: [
        { network: "203.0.113.4", prefixLength: 30, nextHop: "203.0.113.2" },
        { network: "10.2.0.0", prefixLength: 24, nextHop: "10.255.0.2" },
      ],
      dhcpPools: [],
      // The ACL is defined but deliberately not bound: step 5 binds it.
      acls: [{
        id: "BLOCK-ESP",
        type: "extended",
        rules: [
          {
            sequence: 10,
            action: "deny",
            protocol: 50,
            source: { kind: "any" },
            destination: { kind: "any" },
          },
          {
            sequence: 20,
            action: "permit",
            protocol: "ip",
            source: { kind: "any" },
            destination: { kind: "any" },
          },
        ],
      }],
      aclBindings: [],
      natPools: [],
      natRules: [],
      natInterfaceRoles: [],
      vpn: shortLifetime(protectedVpn("203.0.113.6", "10.255.0.1")),
    },
    r2: {
      kind: "router",
      hostname: "R2",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "10.2.0.1", prefixLength: 24 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "203.0.113.6", prefixLength: 30 } },
      ],
      subinterfaces: [],
      staticRoutes: [
        { network: "203.0.113.0", prefixLength: 30, nextHop: "203.0.113.5" },
        { network: "10.1.0.0", prefixLength: 24, nextHop: "10.255.0.1" },
      ],
      dhcpPools: [],
      ...emptyRoutedSecurity(),
      vpn: shortLifetime(branchVpnWithoutKey()),
    },
  },
};

/** A 120-second lifetime, so the deterministic rekey is quick to reach. */
function shortLifetime(vpn: VpnConfiguration): VpnConfiguration {
  return {
    ...vpn,
    ikePeers: vpn.ikePeers.map((peer) => ({ ...peer, lifetimeSeconds: 120 })),
    ipsecProfiles: vpn.ipsecProfiles.map((profile) => ({ ...profile, lifetimeSeconds: 120 })),
  };
}

export const VPN_DEMO_LABS = [
  GRE_SITE_TO_SITE_DEMO,
  GRE_OVER_IPSEC_DEMO,
  VPN_FAILURE_AND_REKEY_DEMO,
] as const;

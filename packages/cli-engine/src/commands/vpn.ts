import {
  VPN_PRE_SHARED_KEY_SCOPE,
  vpnPreSharedKeyVerifierFromFingerprint,
} from "@sim/console-auth";
import {
  DEFAULT_VPN_LIMITS,
  NS_PER_S,
  Router,
  type IkeSessionSummary,
  type IpsecSecurityAssociation,
  type TunnelSummary,
} from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi } from "../types";
import { isRouter, parseIpv4 } from "./helpers";

const SHOW_MODES = ["exec", "privileged"] as const;

/**
 * The site-to-site VPN CLI: a Cisco IOS-like *educational subset*, not vendor
 * parity. Only what SimulatorNet actually simulates is offered, so contextual
 * help never advertises crypto maps, IKEv1, certificates, transport mode or
 * NAT traversal. A Firewall uses this same SimulatorNet VPN configuration; no
 * ASA compatibility is claimed.
 */
function vpnDevice(session: SessionApi): Router {
  if (!isRouter(session.device) || !session.device.supportsTunnels()) {
    throw new InvalidModeError("A Router or Firewall is required for tunnel and IPsec configuration.");
  }
  return session.device;
}

/** The tunnel currently selected by `interface Tunnel<n>`. */
function tunnelContext(session: SessionApi): number {
  const context = session.ifaceCtx;
  if (!context || context.tunnel === undefined) {
    throw new InvalidModeError("Tunnel commands require a Tunnel interface.");
  }
  return context.tunnel;
}

function cryptoContext(session: SessionApi, kind: "ikev2-proposal" | "ikev2-peer" | "ipsec-profile") {
  const context = session.cryptoCtx;
  if (!context || context.kind !== kind) {
    throw new InvalidModeError(`A ${kind.replace("-", " ")} context is required.`);
  }
  return context;
}

function lifetimeSeconds(token: string): number {
  const value = Number(token);
  if (
    !Number.isInteger(value)
    || value < DEFAULT_VPN_LIMITS.minimumLifetimeSeconds
    || value > DEFAULT_VPN_LIMITS.maximumLifetimeSeconds
  ) {
    throw new ValidationError(
      `Lifetime must be between ${DEFAULT_VPN_LIMITS.minimumLifetimeSeconds}`
      + ` and ${DEFAULT_VPN_LIMITS.maximumLifetimeSeconds} seconds.`,
    );
  }
  return value;
}

function boundedInteger(token: string, minimum: number, maximum: number, label: string): number {
  const value = Number(token);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

/** Resolve `tunnel source Gi0/1` to a real interface, or accept a local address. */
function tunnelSource(session: SessionApi, token: string) {
  const device = vpnDevice(session);
  const compact = token.trim();
  for (const iface of device.l3Interfaces) {
    if (iface.name.toLowerCase() === compact.toLowerCase()) {
      return { type: "interface" as const, interfaceId: iface.name };
    }
  }
  for (const name of device.interfaces.keys()) {
    if (name.toLowerCase() === compact.toLowerCase()) {
      return { type: "interface" as const, interfaceId: name };
    }
  }
  // Anything that parses as an address is treated as an explicit source address.
  return { type: "address" as const, address: parseIpv4(compact) };
}

// --- show formatters --------------------------------------------------------

function describeTunnelState(row: TunnelSummary): string {
  if (!row.adminUp) return "administratively down";
  if (row.operUp) return "up";
  return `down (${row.reason ?? "unknown"})`;
}

function showTunnelInterfaces(session: SessionApi): string {
  const rows = vpnDevice(session).tunnelSummaries();
  if (rows.length === 0) return "No tunnel interfaces are configured.";
  return rows.flatMap((row) => {
    const lines = [
      `${row.name} is ${describeTunnelState(row)}, line protocol is ${row.operUp ? "up" : "down"}`,
      `  Tunnel source ${row.sourceAddress ?? "unresolved"}`
      + `${row.source.type === "interface" ? ` (${row.source.interfaceId})` : ""}`
      + `, destination ${row.destinationAddress}`,
      `  Tunnel protocol/transport ${row.mode.toUpperCase()}, MTU ${row.mtu} bytes, TTL ${row.ttl}`,
    ];
    if (row.ipv4) lines.push(`  Internet address is ${row.ipv4.address}/${row.ipv4.prefixLength}`);
    for (const address of row.ipv6) lines.push(`  IPv6 address is ${address.address}/${address.prefixLength}`);
    lines.push(row.ipsecProfileId === undefined
      ? "  Tunnel protection: none (plain GRE)"
      : `  Tunnel protection via IPsec profile ${row.ipsecProfileId}`);
    return lines;
  }).join("\n");
}

function showIkeSa(session: SessionApi): string {
  const rows = vpnDevice(session).ikeSessionSummaries();
  if (rows.length === 0) return "No IKEv2 peers are configured.";
  const header = " Peer             Local            Remote           Status        Role";
  return [header, ...rows.map((row) =>
    ` ${row.peerId.padEnd(16)} ${(row.localAddress ?? "-").padEnd(16)}`
    + ` ${row.remoteAddress.padEnd(16)} ${row.state.padEnd(13)} ${row.role ?? "-"}`
    + (row.failureReason ? `\n   Last failure: ${row.failureReason}` : ""))].join("\n");
}

function showIpsecSa(session: SessionApi): string {
  const rows = vpnDevice(session).ipsecSecurityAssociations();
  if (rows.length === 0) return "No IPsec security associations are established.";
  return rows.map((row) => [
    ` ${row.direction} SA to ${row.peerAddress}`,
    `   spi: 0x${row.spi.toString(16)} (${row.spi}), transform: ${row.proposalId}, state: ${row.state}`,
    `   generation ${row.generation}, seq ${row.sequenceNumber},`
    + ` pkts ${row.packetCount}, bytes ${row.byteCount}`,
  ].join("\n")).join("\n");
}

/** `show crypto session`: one line per protected tunnel, config plus live state. */
function showCryptoSession(session: SessionApi): string {
  const device = vpnDevice(session);
  const sessions = new Map(device.ikeSessionSummaries().map((row) => [row.peerId, row]));
  const associations = device.ipsecSecurityAssociations();
  const rows = device.tunnelSummaries().filter((row) => row.ipsecProfileId !== undefined);
  if (rows.length === 0) return "No protected tunnels are configured.";
  return rows.flatMap((row) => {
    const profile = device.ipsecProfileConfigurations().find((entry) => entry.id === row.ipsecProfileId);
    const ike = profile ? sessions.get(profile.ikePeerId) : undefined;
    const active = associations.filter((entry) =>
      entry.state === "active" && entry.peerAddress === row.destinationAddress);
    return [
      `Interface: ${row.name}`,
      `  Profile: ${row.ipsecProfileId}  Peer: ${ike?.peerId ?? "unresolved"}`,
      `  Session status: ${ike?.state ?? "DOWN"}`,
      `  IKEv2 SA: local ${ike?.localAddress ?? "-"} remote ${row.destinationAddress}`,
      `  IPsec flow: ${active.length} active SA(s) protecting ${row.name}`,
    ];
  }).join("\n");
}

// --- commands ---------------------------------------------------------------

export const vpnCommands: CommandSpec[] = [
  // --- tunnel interface configuration -------------------------------------
  {
    pattern: "tunnel source {spec}",
    usage: "tunnel source <interface-name|ip-address>",
    modes: ["config-if"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      vpnDevice(session).configureTunnel(tunnelContext(session), {
        source: tunnelSource(session, params.spec!),
      });
    },
  },
  {
    pattern: "tunnel destination {ip}",
    usage: "tunnel destination <ip-address>",
    modes: ["config-if"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      vpnDevice(session).configureTunnel(tunnelContext(session), {
        destinationAddress: parseIpv4(params.ip!),
      });
    },
  },
  {
    pattern: "tunnel mode gre ip",
    modes: ["config-if"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session) => {
      vpnDevice(session).configureTunnel(tunnelContext(session), { mode: "gre-ipv4" });
    },
  },
  {
    pattern: "tunnel mtu {bytes}",
    usage: `tunnel mtu <${DEFAULT_VPN_LIMITS.minimumTunnelMtu}-${DEFAULT_VPN_LIMITS.maximumTunnelMtu}>`,
    modes: ["config-if"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      vpnDevice(session).configureTunnel(tunnelContext(session), {
        mtu: boundedInteger(
          params.bytes!,
          DEFAULT_VPN_LIMITS.minimumTunnelMtu,
          DEFAULT_VPN_LIMITS.maximumTunnelMtu,
          "Tunnel MTU",
        ),
      });
    },
  },
  {
    pattern: "tunnel ttl {value}",
    usage: "tunnel ttl <1-255>",
    modes: ["config-if"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      vpnDevice(session).configureTunnel(tunnelContext(session), {
        ttl: boundedInteger(params.value!, 1, 255, "Tunnel TTL"),
      });
    },
  },
  {
    pattern: "tunnel protection ipsec profile {name}",
    usage: "tunnel protection ipsec profile <profile-name>",
    modes: ["config-if"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      const device = vpnDevice(session);
      if (!device.ipsec.profile(params.name!)) {
        throw new ValidationError(`IPsec profile '${params.name}' is not defined.`);
      }
      device.configureTunnel(tunnelContext(session), { ipsecProfileId: params.name! });
    },
  },
  {
    negated: true, pattern: "tunnel protection ipsec profile",
    modes: ["config-if"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session) => {
      vpnDevice(session).configureTunnel(tunnelContext(session), { ipsecProfileId: undefined });
    },
  },

  // --- IKEv2 proposal -----------------------------------------------------
  {
    pattern: "crypto ikev2 proposal {name}",
    usage: "crypto ikev2 proposal <name>",
    modes: ["config"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      const device = vpnDevice(session);
      const existing = device.ipsecProposalConfigurations().find((entry) => entry.id === params.name);
      device.defineIpsecProposal({
        id: params.name!,
        encryption: existing?.encryption ?? "sim-aes256",
        integrity: existing?.integrity ?? "sim-sha256",
      });
      session.cryptoCtx = { kind: "ikev2-proposal", id: params.name! };
      session.enter("config-ikev2-proposal");
    },
  },
  {
    pattern: "encryption {algorithm}",
    usage: "encryption <sim-aes128|sim-aes256>",
    modes: ["config-ikev2-proposal"],
    device: "router",
    run: (session, params) => {
      const device = vpnDevice(session);
      const context = cryptoContext(session, "ikev2-proposal");
      const existing = device.ipsecProposalConfigurations().find((entry) => entry.id === context.id);
      const algorithm = params.algorithm!.toLowerCase();
      if (algorithm !== "sim-aes128" && algorithm !== "sim-aes256") {
        throw new ValidationError(
          "Supported encryption transforms are sim-aes128 and sim-aes256."
          + " The sim- prefix marks a simulated transform: SimulatorNet performs no encryption.",
        );
      }
      device.defineIpsecProposal({
        id: context.id,
        encryption: algorithm,
        integrity: existing?.integrity ?? "sim-sha256",
      });
    },
  },
  {
    pattern: "integrity {algorithm}",
    usage: "integrity <sim-sha256>",
    modes: ["config-ikev2-proposal"],
    device: "router",
    run: (session, params) => {
      const device = vpnDevice(session);
      const context = cryptoContext(session, "ikev2-proposal");
      const existing = device.ipsecProposalConfigurations().find((entry) => entry.id === context.id);
      if (params.algorithm!.toLowerCase() !== "sim-sha256") {
        throw new ValidationError(
          "The only supported integrity transform is sim-sha256."
          + " SimulatorNet computes no cryptographic message authentication code.",
        );
      }
      device.defineIpsecProposal({
        id: context.id,
        encryption: existing?.encryption ?? "sim-aes256",
        integrity: "sim-sha256",
      });
    },
  },
  {
    negated: true, pattern: "crypto ikev2 proposal {name}",
    modes: ["config"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => vpnDevice(session).ipsec.removeProposal(params.name!),
  },

  // --- IKEv2 peer ---------------------------------------------------------
  {
    pattern: "crypto ikev2 peer {name}",
    usage: "crypto ikev2 peer <name>",
    modes: ["config"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      vpnDevice(session).ipsec.updatePeer(params.name!, {});
      session.cryptoCtx = { kind: "ikev2-peer", id: params.name! };
      session.enter("config-ikev2-peer");
    },
  },
  {
    pattern: "address {ip}",
    usage: "address <ip-address>",
    modes: ["config-ikev2-peer"],
    device: "router",
    run: (session, params) => {
      const context = cryptoContext(session, "ikev2-peer");
      vpnDevice(session).ipsec.updatePeer(context.id, { remoteAddress: parseIpv4(params.ip!) });
    },
  },
  {
    pattern: "proposal {name}",
    usage: "proposal <ikev2-proposal-name>",
    modes: ["config-ikev2-peer"],
    device: "router",
    run: (session, params) => {
      const device = vpnDevice(session);
      const context = cryptoContext(session, "ikev2-peer");
      if (!device.ipsecProposalConfigurations().some((entry) => entry.id === params.name)) {
        throw new ValidationError(`IKEv2 proposal '${params.name}' is not defined.`);
      }
      device.ipsec.updatePeer(context.id, { proposalId: params.name! });
    },
  },
  {
    pattern: "lifetime {seconds}",
    usage: "lifetime <60-86400>",
    modes: ["config-ikev2-peer"],
    device: "router",
    run: (session, params) => {
      const context = cryptoContext(session, "ikev2-peer");
      vpnDevice(session).ipsec.updatePeer(context.id, {
        lifetimeNs: lifetimeSeconds(params.seconds!) * NS_PER_S,
      });
    },
  },
  {
    pattern: "identity local {value}",
    usage: "identity local <name>",
    modes: ["config-ikev2-peer"],
    device: "router",
    run: (session, params) => {
      const context = cryptoContext(session, "ikev2-peer");
      vpnDevice(session).ipsec.updatePeer(context.id, { localIdentity: params.value! });
    },
  },
  {
    pattern: "identity remote {value}",
    usage: "identity remote <name>",
    modes: ["config-ikev2-peer"],
    device: "router",
    run: (session, params) => {
      const context = cryptoContext(session, "ikev2-peer");
      vpnDevice(session).ipsec.updatePeer(context.id, { remoteIdentity: params.value! });
    },
  },
  {
    /**
     * The key is never typed on the command line. The terminal collects it at a
     * no-echo prompt and derives the opaque, scope-bound verifier in the main
     * thread; only that fingerprint reaches the CLI, the engine and the saved
     * document, and `show running-config` redacts it.
     */
    pattern: "pre-shared-key",
    modes: ["config-ikev2-peer"],
    device: "router",
    run: (session) => {
      const device = vpnDevice(session);
      const context = cryptoContext(session, "ikev2-peer");
      return session.requestCredential(
        "Pre-shared key:",
        VPN_PRE_SHARED_KEY_SCOPE,
        (fingerprint) => {
          device.ipsec.updatePeer(context.id, {
            preSharedKeyVerifier: vpnPreSharedKeyVerifierFromFingerprint(fingerprint),
          });
          device.ipsec.clearPeer(context.id);
          return `Pre-shared key stored for peer ${context.id}. It is never displayed.`;
        },
      );
    },
  },
  {
    negated: true, pattern: "crypto ikev2 peer {name}",
    modes: ["config"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => vpnDevice(session).ipsec.removePeer(params.name!),
  },

  // --- IPsec profile ------------------------------------------------------
  {
    pattern: "crypto ipsec profile {name}",
    usage: "crypto ipsec profile <name>",
    modes: ["config"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => {
      vpnDevice(session).ipsec.updateProfile(params.name!, {});
      session.cryptoCtx = { kind: "ipsec-profile", id: params.name! };
      session.enter("config-ipsec-profile");
    },
  },
  {
    pattern: "set ikev2-peer {name}",
    usage: "set ikev2-peer <peer-name>",
    modes: ["config-ipsec-profile"],
    device: "router",
    run: (session, params) => {
      const device = vpnDevice(session);
      const context = cryptoContext(session, "ipsec-profile");
      if (!device.ipsec.peer(params.name!)) {
        throw new ValidationError(`IKEv2 peer '${params.name}' is not defined.`);
      }
      device.ipsec.updateProfile(context.id, { ikePeerId: params.name! });
    },
  },
  {
    pattern: "set proposal {name}",
    usage: "set proposal <ikev2-proposal-name>",
    modes: ["config-ipsec-profile"],
    device: "router",
    run: (session, params) => {
      const device = vpnDevice(session);
      const context = cryptoContext(session, "ipsec-profile");
      if (!device.ipsecProposalConfigurations().some((entry) => entry.id === params.name)) {
        throw new ValidationError(`IKEv2 proposal '${params.name}' is not defined.`);
      }
      device.ipsec.updateProfile(context.id, { proposalId: params.name! });
    },
  },
  {
    pattern: "lifetime {seconds}",
    usage: "lifetime <60-86400>",
    modes: ["config-ipsec-profile"],
    device: "router",
    run: (session, params) => {
      const context = cryptoContext(session, "ipsec-profile");
      vpnDevice(session).ipsec.updateProfile(context.id, {
        lifetimeNs: lifetimeSeconds(params.seconds!) * NS_PER_S,
      });
    },
  },
  {
    negated: true, pattern: "crypto ipsec profile {name}",
    modes: ["config"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session, params) => vpnDevice(session).ipsec.removeProfile(params.name!),
  },

  // --- inspection ---------------------------------------------------------
  {
    pattern: "show interfaces tunnel",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: showTunnelInterfaces,
  },
  {
    pattern: "show crypto ikev2 sa",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: showIkeSa,
  },
  {
    pattern: "show crypto ipsec sa",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: showIpsecSa,
  },
  {
    pattern: "show crypto session",
    modes: [...SHOW_MODES],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: showCryptoSession,
  },
  {
    pattern: "clear crypto ikev2 sa",
    modes: ["privileged"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session) => clearVpnRuntime(
      session,
      "IKEv2 sessions cleared and renegotiated.",
    ),
  },
  {
    pattern: "clear crypto ipsec sa",
    modes: ["privileged"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (session) => clearVpnRuntime(
      session,
      "IPsec security associations cleared and renegotiated.",
    ),
  },
];

/**
 * Discard the negotiated runtime and let the bounded renegotiation run. It is a
 * network operation, so Auto drains it before the result is rendered and Step
 * queues the exchange for inspection — the same contract as `ping`.
 */
function clearVpnRuntime(session: SessionApi, message: string): string {
  const device = vpnDevice(session);
  return session.runNetworkOperation(
    () => device.resetVpnRuntime(),
    () => {
      const sessions = device.ikeSessionSummaries();
      // Nothing to negotiate: report immediately rather than waiting for events.
      if (sessions.length === 0) return message;
      // Wait until no peer is still mid-exchange.
      const pending = sessions.some((entry) =>
        entry.state === "INITIATING" || entry.state === "NEGOTIATING");
      if (pending) return undefined;
      return [message, ...sessions.map((entry) => ` ${entry.peerId}: ${entry.state}`)].join("\n");
    },
  );
}

export type { IkeSessionSummary, IpsecSecurityAssociation, TunnelSummary };

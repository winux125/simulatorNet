import type { GradingCheck } from "@sim/contracts/grading";
import type { BuiltLab } from "@sim/lab-format";
import {
  EndHost,
  Layer3Switch,
  Router,
  ipToInt,
  ipv6InPrefix,
  maskToInt,
  normalizeIpv6,
  tunnelName,
  type TraceEntry,
} from "@sim/sim-core";

/**
 * Site-to-site VPN grading.
 *
 * A check never carries a pre-shared key, a verifier or a hidden peer identity,
 * and its diagnostics stay bounded and sanitized: SPIs and internal reasons are
 * reported for the instructor view only, through the same redaction the rest of
 * grading uses. Everything is recomputed by rebuilding the submitted lab, so a
 * browser claim can never influence the result.
 */
const VPN_CHECK_TYPES = new Set([
  "gre-tunnel-configured",
  "gre-tunnel-operational",
  "tunnel-connectivity",
  "ike-peer-configured",
  "ike-state",
  "ipsec-profile",
  "ipsec-sa-established",
  "protected-packet-delivered",
  "esp-replay-rejected",
  "vpn-route",
]);

export type VpnGradingCheck = Extract<GradingCheck, { type: string }> & {
  type:
    | "gre-tunnel-configured" | "gre-tunnel-operational" | "tunnel-connectivity"
    | "ike-peer-configured" | "ike-state" | "ipsec-profile" | "ipsec-sa-established"
    | "protected-packet-delivered" | "esp-replay-rejected" | "vpn-route";
};

export function isVpnCheck(check: GradingCheck): check is VpnGradingCheck {
  return VPN_CHECK_TYPES.has(check.type);
}

export interface VpnCheckOutcome {
  readonly passed: boolean;
  readonly message: string;
  readonly diagnostics: Record<string, unknown>;
  readonly error?: string;
}

/** Drain the shared event queue for one bounded operation. */
export type DrainOperation = () => void;

function vpnDevice(built: BuiltLab, deviceId: string): Router | undefined {
  const device = built.getDevice(deviceId);
  return device instanceof Router && device.supportsTunnels() ? device : undefined;
}

function failure(message: string, diagnostics: Record<string, unknown> = {}): VpnCheckOutcome {
  return { passed: false, message, diagnostics, error: message };
}

/**
 * Send one bounded ping across the overlay and hand back the trace window it
 * produced. Grading what the network *did* keeps a VPN check honest: a tunnel
 * that is merely typed in but never carries a packet does not pass.
 */
function runOverlayTraffic(
  built: BuiltLab,
  drain: DrainOperation,
  sourceDeviceId: string,
  destination: string,
): { success: boolean; trace: TraceEntry[]; failure?: string } {
  const candidate = built.getDevice(sourceDeviceId);
  const source = candidate instanceof EndHost || candidate instanceof Router || candidate instanceof Layer3Switch
    ? candidate
    : undefined;
  if (!source) {
    return { success: false, trace: [], failure: `Ping-capable device '${sourceDeviceId}' was not found` };
  }
  const start = built.engine.traceLog.length;
  const sequence = 900 + (built.engine.traceLog.length % 90);
  try {
    if (destination.includes(":")) {
      source.ping6(normalizeIpv6(destination), sequence);
      drain();
      return {
        success: source.ipv6PingResults.find((entry) => entry.sequence === sequence)?.success ?? false,
        trace: built.engine.traceLog.slice(start),
      };
    }
    source.ping(destination, sequence);
    drain();
    return {
      success: source.pingResults.find((entry) => entry.sequence === sequence)?.success ?? false,
      trace: built.engine.traceLog.slice(start),
    };
  } catch (error) {
    return {
      success: false,
      trace: built.engine.traceLog.slice(start),
      failure: error instanceof Error ? error.message : "Overlay traffic failed",
    };
  }
}

export function runVpnCheck(
  check: VpnGradingCheck,
  built: BuiltLab,
  drain: DrainOperation,
): VpnCheckOutcome {
  switch (check.type) {
    case "gre-tunnel-configured": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const name = tunnelName(check.configuration.tunnelId);
      const tunnel = device.tunnelConfigurations().find((entry) => entry.id === name);
      if (!tunnel) {
        return {
          passed: false,
          message: `${name} is not configured`,
          diagnostics: { configured: device.tunnelConfigurations().map((entry) => entry.id) },
        };
      }
      const expected = check.configuration;
      const overlay = tunnel.ipv4Addresses[0]?.address;
      const mismatches: string[] = [];
      if (expected.expectedDestination !== undefined && tunnel.destinationAddress !== expected.expectedDestination) {
        mismatches.push("destination");
      }
      if (expected.expectedSourceInterface !== undefined
        && !(tunnel.source.type === "interface" && tunnel.source.interfaceId === expected.expectedSourceInterface)) {
        mismatches.push("source");
      }
      if (expected.expectedOverlayAddress !== undefined && overlay !== expected.expectedOverlayAddress) {
        mismatches.push("overlay address");
      }
      return {
        passed: mismatches.length === 0,
        message: mismatches.length === 0
          ? `${name} is configured to ${tunnel.destinationAddress}`
          : `${name} has an unexpected ${mismatches.join(", ")}`,
        diagnostics: {
          destination: tunnel.destinationAddress,
          source: tunnel.source,
          overlayAddress: overlay,
          mode: tunnel.mode,
        },
      };
    }

    case "gre-tunnel-operational": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const name = tunnelName(check.configuration.tunnelId);
      const summary = device.tunnelSummaries().find((entry) => entry.name === name);
      if (!summary) return { passed: false, message: `${name} is not configured`, diagnostics: {} };
      const passed = summary.operUp === check.configuration.expected;
      return {
        passed,
        message: summary.operUp
          ? `${name} is up`
          : `${name} is down (${summary.reason ?? "unknown"})`,
        diagnostics: {
          adminUp: summary.adminUp,
          operationalUp: summary.operUp,
          reason: summary.reason,
          sourceAddress: summary.sourceAddress,
        },
      };
    }

    case "tunnel-connectivity": {
      const outcome = runOverlayTraffic(
        built,
        drain,
        check.configuration.sourceDeviceId,
        check.configuration.destination,
      );
      if (outcome.failure) return failure(outcome.failure);
      const expected = check.configuration.expected === "success";
      let carriedByTunnel = true;
      if (check.configuration.tunnelDeviceId !== undefined) {
        carriedByTunnel = outcome.trace.some((entry) =>
          entry.device === check.configuration.tunnelDeviceId && entry.type === "gre-packet-sent");
      }
      const passed = outcome.success === expected && (!expected || carriedByTunnel);
      return {
        passed,
        message: outcome.success
          ? `${check.configuration.sourceDeviceId} reached ${check.configuration.destination}`
            + `${carriedByTunnel ? " through the tunnel" : " without using the tunnel"}`
          : `${check.configuration.sourceDeviceId} could not reach ${check.configuration.destination}`,
        diagnostics: {
          reachable: outcome.success,
          expected: check.configuration.expected,
          carriedByTunnel,
          encapsulations: outcome.trace.filter((entry) => entry.type === "gre-packet-sent").length,
        },
      };
    }

    case "ike-peer-configured": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const peer = device.ikePeerConfigurations().find((entry) => entry.id === check.configuration.peerId);
      if (!peer) {
        return {
          passed: false,
          message: `IKEv2 peer ${check.configuration.peerId} is not configured`,
          diagnostics: { configured: device.ikePeerConfigurations().map((entry) => entry.id) },
        };
      }
      const hasKey = peer.preSharedKeyVerifier !== undefined;
      const addressMatches = check.configuration.expectedAddress === undefined
        || peer.remoteAddress === check.configuration.expectedAddress;
      const proposalMatches = check.configuration.expectedProposalId === undefined
        || peer.proposalId === check.configuration.expectedProposalId;
      const keyMatches = !check.configuration.expectPreSharedKey || hasKey;
      const passed = addressMatches && proposalMatches && keyMatches;
      return {
        passed,
        message: passed
          ? `IKEv2 peer ${peer.id} is configured for ${peer.remoteAddress}`
          : `IKEv2 peer ${peer.id} does not match the expected configuration`,
        // Only *whether* a key exists is ever reported; never the key or verifier.
        diagnostics: {
          remoteAddress: peer.remoteAddress,
          proposalId: peer.proposalId,
          preSharedKeyConfigured: hasKey,
        },
      };
    }

    case "ike-state": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const session = device.ikeSessionSummaries().find((entry) => entry.peerId === check.configuration.peerId);
      if (!session) {
        return {
          passed: false,
          message: `IKEv2 peer ${check.configuration.peerId} is not configured`,
          diagnostics: {},
        };
      }
      const passed = session.state === check.configuration.expectedState;
      return {
        passed,
        message: `IKEv2 peer ${session.peerId} is ${session.state}`,
        diagnostics: {
          state: session.state,
          expectedState: check.configuration.expectedState,
          role: session.role,
          failureReason: session.failureReason,
        },
      };
    }

    case "ipsec-profile": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const profile = device.ipsecProfileConfigurations()
        .find((entry) => entry.id === check.configuration.profileId);
      if (!profile) {
        return {
          passed: false,
          message: `IPsec profile ${check.configuration.profileId} is not configured`,
          diagnostics: { configured: device.ipsecProfileConfigurations().map((entry) => entry.id) },
        };
      }
      const peerMatches = check.configuration.expectedPeerId === undefined
        || profile.ikePeerId === check.configuration.expectedPeerId;
      const proposalMatches = check.configuration.expectedProposalId === undefined
        || profile.proposalId === check.configuration.expectedProposalId;
      let boundMatches = true;
      if (check.configuration.boundTunnelId !== undefined) {
        const name = tunnelName(check.configuration.boundTunnelId);
        boundMatches = device.tunnelConfigurations()
          .some((tunnel) => tunnel.id === name && tunnel.ipsecProfileId === profile.id);
      }
      const passed = peerMatches && proposalMatches && boundMatches;
      return {
        passed,
        message: passed
          ? `IPsec profile ${profile.id} binds peer ${profile.ikePeerId}`
          : `IPsec profile ${profile.id} does not match the expected configuration`,
        diagnostics: {
          ikePeerId: profile.ikePeerId,
          proposalId: profile.proposalId,
          boundToTunnel: boundMatches,
        },
      };
    }

    case "ipsec-sa-established": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const peer = device.ikePeerConfigurations().find((entry) => entry.id === check.configuration.peerId);
      if (!peer) {
        return { passed: false, message: `IKEv2 peer ${check.configuration.peerId} is not configured`, diagnostics: {} };
      }
      const active = device.ipsecSecurityAssociations()
        .filter((entry) => entry.state === "active" && entry.peerAddress === peer.remoteAddress);
      const directions = new Set(active.map((entry) => entry.direction));
      const passed = check.configuration.expectBothDirections
        ? directions.has("inbound") && directions.has("outbound")
        : active.length > 0;
      return {
        passed,
        message: passed
          ? `${active.length} active security association(s) with ${peer.id}`
          : `No usable security association with ${peer.id}`,
        // SPIs are diagnostics, not a student-visible value; the verifier
        // redacts hidden-check diagnostics before a student ever sees them.
        diagnostics: {
          activeCount: active.length,
          directions: [...directions].sort(),
          spis: active.map((entry) => entry.spi),
        },
      };
    }

    case "protected-packet-delivered": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const outcome = runOverlayTraffic(
        built,
        drain,
        check.configuration.sourceDeviceId,
        check.configuration.destination,
      );
      if (outcome.failure) return failure(outcome.failure);
      const protectedHere = outcome.trace.filter((entry) =>
        entry.device === check.configuration.deviceId && entry.type === "esp-packet-protected").length;
      const unprotectedAnywhere = outcome.trace.some((entry) => entry.type === "esp-packet-unprotected");
      const passed = outcome.success && protectedHere > 0 && unprotectedAnywhere;
      return {
        passed,
        message: passed
          ? `${protectedHere} packet(s) were protected on ${check.configuration.deviceId} and delivered`
          : outcome.success
            ? "Traffic was delivered without simulated ESP protection"
            : `${check.configuration.sourceDeviceId} could not reach ${check.configuration.destination}`,
        diagnostics: {
          reachable: outcome.success,
          protectedPackets: protectedHere,
          unprotectedAtPeer: unprotectedAnywhere,
        },
      };
    }

    case "esp-replay-rejected": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const peer = device.ikePeerConfigurations().find((entry) => entry.id === check.configuration.peerId);
      if (!peer) {
        return { passed: false, message: `IKEv2 peer ${check.configuration.peerId} is not configured`, diagnostics: {} };
      }
      const inbound = device.ipsecSecurityAssociations()
        .find((entry) => entry.direction === "inbound" && entry.peerAddress === peer.remoteAddress);
      if (!inbound) {
        return {
          passed: false,
          message: `No inbound security association with ${peer.id} to replay against`,
          diagnostics: {},
        };
      }
      // Replay one sequence number the SA has already accepted. The bounded
      // window must reject it; nothing else about the SA is disturbed.
      const start = built.engine.traceLog.length;
      const replayed = Math.max(1, inbound.highestSequence);
      const result = device.ipsec.unprotect(
        {
          kind: "esp",
          spi: inbound.spi,
          sequenceNumber: replayed,
          protectedProtocol: "gre",
          protectedPayload: {
            kind: "gre",
            protocol: "ipv4",
            tunnelId: "Tunnel0",
            innerPacket: {
              kind: "ipv4",
              src: peer.remoteAddress,
              dst: peer.remoteAddress,
              protocol: 1,
              ttl: 64,
              payload: { kind: "icmp", type: 8, code: 0, identifier: 0, sequence: replayed },
            },
          },
          integrityTag: "sim-replayed",
        },
        peer.remoteAddress,
        0,
      );
      const rejected = !("payload" in result);
      const traced = built.engine.traceLog.slice(start)
        .some((entry) => entry.type === "esp-replay-dropped" || entry.type === "esp-invalid-spi");
      return {
        passed: rejected,
        message: rejected
          ? `The replayed sequence number was rejected by the anti-replay window`
          : "A replayed packet was accepted",
        diagnostics: {
          rejected,
          traced,
          highestSequence: inbound.highestSequence,
        },
      };
    }

    case "vpn-route": {
      const device = vpnDevice(built, check.configuration.deviceId);
      if (!device) return failure(`VPN-capable device '${check.configuration.deviceId}' was not found`);
      const name = tunnelName(check.configuration.tunnelId);
      const wanted = check.configuration.network;
      if (wanted.includes(":")) {
        const network = normalizeIpv6(wanted);
        const matched = device.ipv6RoutingTable().some((route) =>
          route.egressName === name
          && route.prefixLength === check.configuration.prefixLength
          && ipv6InPrefix(network, route.network, route.prefixLength));
        return {
          passed: matched,
          message: matched
            ? `${wanted}/${check.configuration.prefixLength} is routed through ${name}`
            : `${wanted}/${check.configuration.prefixLength} is not routed through ${name}`,
          diagnostics: {
            routes: device.ipv6RoutingTable()
              .filter((route) => route.egressName === name)
              .map((route) => `${route.network}/${route.prefixLength}`),
          },
        };
      }
      const mask = maskToInt(check.configuration.prefixLength);
      const network = (ipToInt(wanted) & mask) >>> 0;
      const matched = device.routingTable().some((route) =>
        route.egressName === name
        && route.maskInt === mask
        && ((ipToInt(route.network) & mask) >>> 0) === network);
      return {
        passed: matched,
        message: matched
          ? `${wanted}/${check.configuration.prefixLength} is routed through ${name}`
          : `${wanted}/${check.configuration.prefixLength} is not routed through ${name}`,
        diagnostics: {
          routes: device.routingTable()
            .filter((route) => route.egressName === name)
            .map((route) => `${route.network} via ${route.viaIp ?? "connected"}`),
        },
      };
    }
  }
}

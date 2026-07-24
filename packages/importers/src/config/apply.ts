/**
 * Turn parsed IOS/VPCS config into a structured DeviceConfig for the mapped
 * device. Only settings that cannot fail SimulatorNet's semantic validation are
 * applied (hostname, interface addressing, VLANs, switchports, and static routes
 * whose next hop is directly connected). Anything else is left for the caller to
 * preserve as an unparsed artifact, so an import can never produce a lab that
 * refuses to open.
 */
import type { DeviceConfig, DeviceType } from "@sim/contracts";
import type { ImportedDeviceConfiguration } from "./ios-config";

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0) >>> 0;
const maskToInt = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
const inSubnet = (ip: string, networkIp: string, prefix: number): boolean =>
  ((ipToInt(ip) & maskToInt(prefix)) >>> 0) === ((ipToInt(networkIp) & maskToInt(prefix)) >>> 0);
const isNetworkAddress = (network: string, prefix: number): boolean =>
  ((ipToInt(network) & maskToInt(prefix)) >>> 0) === ipToInt(network);

export interface BuiltConfig {
  readonly config?: DeviceConfig;
  /** Static routes recognised but not applied (unreachable next hop). */
  readonly droppedRoutes: number;
}

export function buildDeviceConfigFromIos(
  deviceType: DeviceType,
  applied: ImportedDeviceConfiguration,
  interfaceIds: readonly string[],
  fallbackHostname: string,
): BuiltConfig {
  const hostname = applied.hostname ?? fallbackHostname;
  const byId = new Map(applied.interfaces.map((iface) => [iface.id, iface]));
  const connected = interfaceIds
    .map((id) => byId.get(id)?.ipv4)
    .filter((ipv4): ipv4 is NonNullable<typeof ipv4> => ipv4 !== undefined);
  const safeRoutes = applied.staticRoutes.filter((route) =>
    isNetworkAddress(route.network, route.prefixLength)
    && connected.some((iface) => inSubnet(route.nextHop, iface.address, iface.prefixLength)));
  const droppedRoutes = applied.staticRoutes.length - safeRoutes.length;

  if (deviceType === "pc") {
    const primary = interfaceIds.map((id) => byId.get(id)).find((iface) => iface?.ipv4);
    const gateway = applied.staticRoutes.find((route) => route.network === "0.0.0.0" && route.prefixLength === 0)?.nextHop;
    return {
      droppedRoutes: 0,
      config: {
        kind: "pc",
        hostname,
        interfaces: interfaceIds.map((id) => ({ id, shutdown: byId.get(id)?.shutdown ?? false, description: byId.get(id)?.description })),
        ipv4: primary?.ipv4
          ? {
              address: primary.ipv4.address,
              prefixLength: primary.ipv4.prefixLength,
              defaultGateway: gateway && inSubnet(gateway, primary.ipv4.address, primary.ipv4.prefixLength) ? gateway : undefined,
            }
          : undefined,
        dhcpEnabled: false,
      },
    };
  }

  if (deviceType === "server") {
    const primary = interfaceIds.map((id) => byId.get(id)).find((iface) => iface?.ipv4);
    const gateway = applied.staticRoutes.find((route) => route.network === "0.0.0.0" && route.prefixLength === 0)?.nextHop;
    return {
      droppedRoutes: 0,
      config: {
        kind: "server",
        hostname,
        interfaces: interfaceIds.map((id) => {
          const iface = byId.get(id);
          const isPrimary = iface === primary && iface?.ipv4 !== undefined;
          return { id, shutdown: iface?.shutdown ?? false, description: iface?.description, ipv4: isPrimary && iface?.ipv4 ? { address: iface.ipv4.address, prefixLength: iface.ipv4.prefixLength } : undefined };
        }),
        defaultGateway: gateway && primary?.ipv4 && inSubnet(gateway, primary.ipv4.address, primary.ipv4.prefixLength) ? gateway : undefined,
        dhcpClientEnabled: false,
        enabledServices: [],
      },
    };
  }

  if (deviceType === "router" || deviceType === "firewall") {
    const routed = {
      hostname,
      interfaces: interfaceIds.map((id) => {
        const iface = byId.get(id);
        return { id, shutdown: iface?.shutdown ?? false, description: iface?.description, routed: iface?.ipv4 !== undefined, ipv4: iface?.ipv4 };
      }),
      subinterfaces: [],
      staticRoutes: safeRoutes.map((route) => ({ network: route.network, prefixLength: route.prefixLength, nextHop: route.nextHop })),
      dhcpPools: [],
      acls: [],
      aclBindings: [],
      natPools: [],
      natRules: [],
      natInterfaceRoles: [],
    };
    if (deviceType === "firewall") {
      return { droppedRoutes, config: { kind: "firewall", ...routed, zones: [], firewallPolicies: [], defaultPolicy: "deny" } };
    }
    return { droppedRoutes, config: { kind: "router", ...routed } };
  }

  if (deviceType === "l2-switch") {
    return {
      droppedRoutes: 0,
      config: {
        kind: "l2-switch",
        hostname,
        vlans: applied.vlans,
        interfaces: interfaceIds.map((id) => {
          const iface = byId.get(id);
          return { id, shutdown: iface?.shutdown ?? false, description: iface?.description, mode: iface?.switchportMode ?? "access", accessVlan: iface?.accessVlan ?? 1, nativeVlan: 1 };
        }),
      },
    };
  }

  return { droppedRoutes: 0, config: undefined };
}

export interface VpcsConfig {
  readonly address?: string;
  readonly prefixLength?: number;
  readonly gateway?: string;
}

/** Parse a VPCS `ip <addr>[/prefix|mask] [gateway]` line. */
export function parseVpcsConfig(text: string): VpcsConfig {
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const tokens = raw.trim().split(/\s+/u);
    if (tokens[0]?.toLowerCase() !== "ip" || !tokens[1]) continue;
    let address = tokens[1];
    let prefixLength = 24;
    if (address.includes("/")) {
      const [addr, prefix] = address.split("/");
      address = addr!;
      prefixLength = Number(prefix);
    } else if (tokens[2] && tokens[2].includes(".")) {
      prefixLength = maskToPrefixLocal(tokens[2]) ?? 24;
    }
    const gateway = tokens.find((token, index) => index >= 2 && /^\d+\.\d+\.\d+\.\d+$/u.test(token) && token !== address);
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(address)) return { address, prefixLength, gateway };
  }
  return {};
}

function maskToPrefixLocal(mask: string): number | undefined {
  const octets = mask.split(".");
  if (octets.length !== 4) return undefined;
  let bits = 0;
  for (const octet of octets) {
    const value = Number(octet);
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
    for (let bit = 7; bit >= 0; bit--) bits += (value >> bit) & 1;
  }
  return bits;
}

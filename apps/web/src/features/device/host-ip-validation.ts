import type { HostStaticConfiguration, LabDocument } from "@sim/contracts";

export interface HostIpFormFields {
  address: string;
  subnetMask: string;
  defaultGateway: string;
  dnsServer: string;
}

export type HostIpFieldErrors = Partial<Record<keyof HostIpFormFields, string>>;

function parseIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return undefined;
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

export function prefixLengthToMask(prefixLength: number): string {
  const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return [24, 16, 8, 0].map((shift) => String((mask >>> shift) & 255)).join(".");
}

export function subnetMaskToPrefix(mask: string): number | undefined {
  const value = parseIpv4(mask);
  if (value === undefined) return undefined;
  let zeroSeen = false;
  let prefixLength = 0;
  for (let bit = 31; bit >= 0; bit--) {
    const set = (value & (1 << bit)) !== 0;
    if (!set) zeroSeen = true;
    else if (zeroSeen) return undefined;
    else prefixLength++;
  }
  return prefixLength;
}

export function validateHostIpFields(fields: HostIpFormFields): {
  errors: HostIpFieldErrors;
  configuration?: HostStaticConfiguration;
} {
  const errors: HostIpFieldErrors = {};
  const addressText = fields.address.trim();
  const address = parseIpv4(addressText);
  const prefixLength = subnetMaskToPrefix(fields.subnetMask.trim());
  if (!addressText) errors.address = "IPv4 address is required.";
  else if (address === undefined) errors.address = "IPv4 address must be valid.";
  if (prefixLength === undefined) errors.subnetMask = "Subnet mask must contain contiguous bits.";

  if (address !== undefined && prefixLength !== undefined) {
    const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
    const network = (address & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    if (prefixLength < 32 && address === network) errors.address = "The address is the network address.";
    else if (prefixLength < 31 && address === broadcast) errors.address = "The address is the broadcast address.";

    const gatewayText = fields.defaultGateway.trim();
    const gateway = gatewayText ? parseIpv4(gatewayText) : undefined;
    if (gatewayText && gateway === undefined) errors.defaultGateway = "Default gateway must be a valid IPv4 address.";
    else if (gateway !== undefined && ((gateway & mask) >>> 0) !== network) {
      errors.defaultGateway = "Default gateway must be in the same subnet.";
    }
  }

  const dnsText = fields.dnsServer.trim();
  if (dnsText && parseIpv4(dnsText) === undefined) errors.dnsServer = "DNS server must be a valid IPv4 address.";
  if (Object.keys(errors).length > 0 || prefixLength === undefined || address === undefined) return { errors };
  return {
    errors,
    configuration: {
      address: addressText,
      prefixLength,
      defaultGateway: fields.defaultGateway.trim() || undefined,
      dnsServer: dnsText || undefined,
    },
  };
}

export function nextExampleAddress(document: LabDocument, deviceId: string): string {
  const used = new Set<string>();
  for (const [id, config] of Object.entries(document.configurations)) {
    if (id === deviceId) continue;
    if (config.kind === "pc" && config.ipv4) used.add(config.ipv4.address);
    if (config.kind === "server") {
      for (const iface of config.interfaces) if (iface.ipv4) used.add(iface.ipv4.address);
    }
  }
  for (let host = 10; host <= 250; host += 10) {
    const address = `192.168.10.${host}`;
    if (!used.has(address)) return address;
  }
  return "192.168.10.10";
}

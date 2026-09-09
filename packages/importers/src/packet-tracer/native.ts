/**
 * Native Packet Tracer import: `.pkt`/`.pka` bytes to an `ImportPlan`.
 *
 * The pipeline is deliberately layered so no stage knows more than it must:
 *
 *   bytes -> @sim/packet-tracer-format decoder -> XML text
 *         -> this package's one hardened XML parser -> tree
 *         -> buildPacketTracerDocument -> normalized Packet Tracer model
 *         -> here: mapping onto SimulatorNet -> ParsedSourceTopology
 *         -> planFromParsed -> ImportPlan -> LabDocument
 *
 * Everything Packet Tracer-specific stops at the normalized model; everything
 * SimulatorNet-specific starts here. Device configuration is *not* reparsed by
 * this file — an IOS running-config is handed to the existing shared parser via
 * `configFamily: "ios-like"`, so every feature the CLI already understands is
 * supported for free and can never drift from it.
 */
import {
  DEVICE_HARDWARE_PROFILES,
  DEVICE_PROFILES,
  type DeviceConfig,
  type DeviceHardwareProfileId,
  type DeviceType,
} from "@sim/contracts";
import {
  buildPacketTracerDocument,
  classifyPacketTracerModel,
  decodePacketTracer,
  DEFAULT_PACKET_TRACER_LIMITS,
  normalizeCoordinates,
  PacketTracerDecodeError,
  resolveInterfaceOnDevice,
  type DecodedPacketTracerFile,
  type PacketTracerDecodeErrorCode,
  type PacketTracerDecodeStage,
  type PacketTracerDevice,
  type PacketTracerDocument,
  type PacketTracerLimits,
  type PacketTracerNetwork,
  type PacketTracerNetworkRole,
} from "@sim/packet-tracer-format";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { slugify } from "../plan/slug";
import { parseXml } from "../xml/xml";
import type {
  ImportReportEntry,
  ImportSource,
  ImportSourceLink,
  ImportSourceNode,
  LabImportFormat,
  ParsedSourceTopology,
} from "../types";
import { resolveDeviceMapping } from "../mapping/registry";

/**
 * Re-exported so a consumer that only ever holds an `ImportPlan` — the web
 * import wizard, its decode worker — never has to depend on the container
 * package to name a progress stage or a refusal.
 */
export type { PacketTracerDecodeErrorCode, PacketTracerDecodeStage, PacketTracerNetworkRole };

const PLATFORM = "packet-tracer";

export interface PacketTracerNetworkSummary {
  readonly id: string;
  readonly name: string;
  readonly role: PacketTracerNetworkRole;
  readonly deviceCount: number;
  readonly linkCount: number;
  /** Devices carrying an IOS running-config or host addressing. */
  readonly configuredDeviceCount: number;
}

/**
 * Everything a Packet Tracer file yields short of the plan itself. The planner
 * builds the `ImportPlan` from `parsed`; keeping that step out of this module
 * is what lets `plan.ts` depend on this file without the two becoming cyclic.
 */
export interface PacketTracerSourceRead {
  readonly format: LabImportFormat;
  readonly packetTracerVersion?: string;
  readonly containerVariant: DecodedPacketTracerFile["variant"];
  readonly networks: readonly PacketTracerNetworkSummary[];
  readonly selectedNetworkId: string;
  /** Why this network is the default, shown so the choice is never implicit. */
  readonly selectionReason: string;
  /** True when the user must confirm which network to import. */
  readonly requiresNetworkChoice: boolean;
  readonly activityTitle?: string;
  readonly activityInstructions?: string;
  readonly parsed: ParsedSourceTopology;
}

export interface PacketTracerInspectOptions {
  readonly limits?: ImportLimits;
  readonly packetTracerLimits?: PacketTracerLimits;
  /** Which contained network to build a plan for. Defaults per the rules below. */
  readonly networkId?: string;
  readonly signal?: AbortSignal;
  readonly onStage?: (stage: PacketTracerDecodeStage) => void;
}

/** Hardware profile for a switch of the given density. */
function switchProfile(
  deviceType: DeviceType,
  accessPorts: number | undefined,
): DeviceHardwareProfileId | undefined {
  if (deviceType !== "l2-switch" && deviceType !== "l3-switch") return undefined;
  const density = accessPorts === undefined ? 24 : accessPorts >= 48 ? 48 : accessPorts >= 24 ? 24 : 8;
  if (deviceType === "l2-switch") {
    return density === 48 ? "access-48" : density === 24 ? "access-24" : "compact-8";
  }
  return density === 48 ? "multilayer-48" : density === 24 ? "multilayer-24" : "multilayer-8";
}

/** The interface ids a mapped device will really have. */
function interfaceTemplatesFor(
  deviceType: DeviceType,
  profileId: DeviceHardwareProfileId | undefined,
): string[] {
  if (profileId !== undefined) {
    return DEVICE_HARDWARE_PROFILES[profileId].interfaceTemplates.map((template) => template.id);
  }
  return DEVICE_PROFILES[deviceType].interfaceTemplates.map((template) => template.id);
}

/** Build a host `DeviceConfig` from Packet Tracer's structured port fields. */
function hostConfigFor(
  device: PacketTracerDevice,
  deviceType: DeviceType,
  interfaceIds: readonly string[],
): DeviceConfig | undefined {
  const host = device.hostConfiguration;
  if (!host) return undefined;
  const prefixLength = host.subnetMask !== undefined ? maskToPrefix(host.subnetMask) : undefined;
  const hasIpv4 = host.ipv4 !== undefined && prefixLength !== undefined;
  if (!hasIpv4 && host.dhcpEnabled !== true) return undefined;

  const interfaces = interfaceIds.map((id) => ({ id, shutdown: false }));
  if (deviceType === "pc" || deviceType === "laptop") {
    return {
      kind: deviceType,
      hostname: device.hostname,
      interfaces,
      ipv4: hasIpv4
        ? { address: host.ipv4!, prefixLength: prefixLength!, defaultGateway: host.gateway }
        : undefined,
      dhcpEnabled: host.dhcpEnabled ?? false,
      dnsServer: host.dns?.[0],
    } as DeviceConfig;
  }
  if (deviceType === "server") {
    return {
      kind: "server",
      hostname: device.hostname,
      interfaces: interfaceIds.map((id, index) => ({
        id,
        shutdown: false,
        ipv4: index === 0 && hasIpv4
          ? { address: host.ipv4!, prefixLength: prefixLength! }
          : undefined,
      })),
      defaultGateway: host.gateway,
      dhcpClientEnabled: host.dhcpEnabled ?? false,
      dnsServer: host.dns?.[0],
      enabledServices: [],
    } as DeviceConfig;
  }
  return undefined;
}

/** Dotted mask to prefix length; undefined when it is not contiguous. */
function maskToPrefix(mask: string): number | undefined {
  const octets = mask.trim().split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  const bits = octets.map((octet) => octet.toString(2).padStart(8, "0")).join("");
  if (!/^1*0*$/u.test(bits)) return undefined;
  const zero = bits.indexOf("0");
  return zero < 0 ? 32 : zero;
}

/** Cable kinds Packet Tracer distinguishes, reported for the record. */
const CABLE_LABELS: Readonly<Record<string, string>> = {
  eStraightThrough: "copper straight-through",
  eCrossOver: "copper crossover",
  eFiber: "fiber",
  eSerial: "serial",
  eCoaxial: "coaxial",
  eConsole: "console",
  ePhone: "phone",
};

interface MappedDevice {
  readonly node: ImportSourceNode;
  readonly templates: readonly string[];
  readonly deviceType: DeviceType;
  readonly placeholder: boolean;
}

/** Map one Packet Tracer network onto a `ParsedSourceTopology`. */
export function mapNetworkToTopology(
  network: PacketTracerNetwork,
  document: PacketTracerDocument,
  labTitle: string,
): ParsedSourceTopology {
  const notes: ImportReportEntry[] = document.warnings.map((warning) => ({
    level: warning.code.includes("limit") ? "warning" as const : "info" as const,
    code: `packet-tracer-${warning.code}`,
    message: warning.message,
    nodeId: warning.deviceId,
  }));

  const positions = normalizeCoordinates(network.devices.map((device) => ({ x: device.x, y: device.y })));
  if (positions.empty && network.devices.length > 0) {
    notes.push({
      level: "info",
      code: "packet-tracer-no-coordinates",
      message: "The source carried no usable canvas coordinates; the standard layout was applied instead.",
    });
  }

  const usedIds = new Set<string>();
  const mapped = new Map<string, MappedDevice>();

  network.devices.forEach((device, index) => {
    const classification = classifyPacketTracerModel(
      device.packetTracerType,
      device.packetTracerModel,
      device.portCount,
    );
    const mapping = resolveDeviceMapping(PLATFORM, classification.sourceKind);
    const deviceType = mapping.targetDeviceType;
    const placeholder = deviceType === undefined;

    if (!classification.matched) {
      notes.push({
        level: "warning",
        code: "packet-tracer-unsupported-model",
        message: classification.note ?? `Unsupported Packet Tracer model on ${device.hostname ?? device.id}`,
        nodeId: device.id,
      });
    } else if (classification.note !== undefined) {
      notes.push({
        level: "warning",
        code: "packet-tracer-profile-widened",
        message: `${device.hostname ?? device.id}: ${classification.note}`,
        nodeId: device.id,
      });
    }

    const profileId = deviceType !== undefined ? switchProfile(deviceType, classification.accessPorts) : undefined;
    const templates = deviceType !== undefined ? interfaceTemplatesFor(deviceType, profileId) : [];

    const label = device.hostname ?? device.id;
    const baseId = slugify(label, `pt-device-${index + 1}`);
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${baseId}-${suffix}`;
    usedIds.add(id);

    const position = positions.points[index];
    const isIosLike = deviceType === "router" || deviceType === "l2-switch" || deviceType === "l3-switch"
      || deviceType === "firewall";

    // A mapped device gets its real interface set, so a link lands on an
    // interface the device actually has and the hardware profile is inferred
    // correctly. A placeholder keeps the source's own names instead.
    const interfaces = placeholder
      ? device.interfaces.map((entry) => entry.name)
      : templates;

    mapped.set(device.id, {
      deviceType: deviceType ?? "external-appliance",
      placeholder,
      templates,
      node: {
        id,
        label,
        sourceKind: classification.sourceKind,
        sourceTemplate: device.packetTracerModel,
        vendor: "Cisco",
        position,
        interfaces,
        startupConfig: device.runningConfig,
        configFamily: device.runningConfig !== undefined && isIosLike ? "ios-like" : undefined,
        deviceConfig: deviceType !== undefined
          ? hostConfigFor(device, deviceType, templates)
          : undefined,
        // Packet Tracer devices are simulated, not virtualised: there is no
        // appliance console to log into.
        authLikelyRequired: false,
      },
    });
  });

  const links: ImportSourceLink[] = [];
  const ordinals = new Map<string, number>();
  const nextOrdinal = (deviceId: string): number => {
    const value = ordinals.get(deviceId) ?? 0;
    ordinals.set(deviceId, value + 1);
    return value;
  };

  for (const link of network.links) {
    const source = mapped.get(link.sourceDeviceId);
    const target = mapped.get(link.targetDeviceId);
    if (!source || !target) continue;

    const resolve = (
      side: MappedDevice,
      name: string | undefined,
      deviceId: string,
    ): string | undefined => {
      if (name === undefined) return undefined;
      if (side.placeholder) return name;
      return resolveInterfaceOnDevice(name, side.templates, nextOrdinal(deviceId));
    };

    const a = resolve(source, link.sourceInterface, link.sourceDeviceId);
    const b = resolve(target, link.targetInterface, link.targetDeviceId);

    if (a === undefined || b === undefined) {
      // Never attach a cable to an arbitrary free port: report it precisely
      // enough that the user can reconnect it by hand.
      notes.push({
        level: "warning",
        code: "packet-tracer-link-unmapped",
        message: `Could not place the link ${source.node.label} ${link.sourceInterface ?? "?"}`
          + ` to ${target.node.label} ${link.targetInterface ?? "?"};`
          + " the interface has no equivalent on the mapped device and the link was not created.",
      });
      continue;
    }

    const cableLabel = link.packetTracerCableType !== undefined
      ? CABLE_LABELS[link.packetTracerCableType]
      : undefined;
    if (link.packetTracerCableType !== undefined && cableLabel === undefined) {
      notes.push({
        level: "info",
        code: "packet-tracer-cable-generic",
        message: `Cable type ${link.packetTracerCableType} was imported as a generic Ethernet link.`,
      });
    }

    links.push({
      id: link.id,
      a: { node: source.node.id, iface: a },
      b: { node: target.node.id, iface: b },
    });
  }

  return {
    platform: PLATFORM,
    format: document.format === "pka" ? "packet-tracer-pka" : "packet-tracer-pkt",
    sourceVersion: document.version,
    labTitle,
    nodes: [...mapped.values()].map((entry) => entry.node),
    links,
    annotations: [],
    assets: [],
    ignoredFiles: [],
    ignoredVendorImages: [],
    notes,
  };
}

function summarize(
  network: PacketTracerNetwork,
  role: PacketTracerNetworkRole,
  name: string,
): PacketTracerNetworkSummary {
  return {
    id: network.id,
    name,
    role,
    deviceCount: network.devices.length,
    linkCount: network.links.length,
    configuredDeviceCount: network.devices.filter(
      (device) => device.runningConfig !== undefined || device.hostConfiguration !== undefined,
    ).length,
  };
}

/**
 * Choose the network to offer first. Never the answer network: importing a
 * solved topology because it happened to be listed first would hand a student
 * the answers. Preference is initial, then current, then the first of anything
 * else; an activity with a real choice always asks.
 */
function chooseDefaultNetwork(
  summaries: readonly PacketTracerNetworkSummary[],
): { readonly id: string; readonly reason: string; readonly requiresChoice: boolean } {
  if (summaries.length === 1) {
    return { id: summaries[0]!.id, reason: "The file contains one network.", requiresChoice: false };
  }
  const byRole = (role: PacketTracerNetworkRole): PacketTracerNetworkSummary | undefined =>
    summaries.find((summary) => summary.role === role);

  const initial = byRole("initial");
  if (initial) {
    return {
      id: initial.id,
      reason: "Defaulted to the activity's initial network. Choose another below if you want a different one.",
      requiresChoice: true,
    };
  }
  const current = byRole("current");
  if (current) {
    return {
      id: current.id,
      reason: "Defaulted to the activity's current network. Choose another below if you want a different one.",
      requiresChoice: true,
    };
  }
  const firstNonAnswer = summaries.find((summary) => summary.role !== "answer") ?? summaries[0]!;
  return {
    id: firstNonAnswer.id,
    reason: firstNonAnswer.role === "answer"
      ? "This activity contains only an answer network. Confirm before importing it."
      : "Defaulted to the first network in the file. Choose another below if you want a different one.",
    requiresChoice: true,
  };
}

/**
 * Decode a Packet Tracer file and map the selected network. Returns the parsed
 * topology plus the summaries the wizard needs to offer a different choice;
 * `inspectPacketTracerFile` turns that into an `ImportPlan`.
 */
export async function readPacketTracerSource(
  source: ImportSource,
  options: PacketTracerInspectOptions = {},
): Promise<PacketTracerSourceRead> {
  const importLimits = options.limits ?? DEFAULT_IMPORT_LIMITS;
  const packetTracerLimits = options.packetTracerLimits ?? DEFAULT_PACKET_TRACER_LIMITS;

  const decoded = await decodePacketTracer(source.bytes, {
    filename: source.filename,
    limits: packetTracerLimits,
    signal: options.signal,
    onStage: options.onStage,
  });

  // Whitespace is preserved because a `<LINE>` of a running-config carries its
  // indentation as meaning; every other read here trims explicitly.
  const root = parseXml(decoded.xml, importLimits, { preserveTextWhitespace: true });
  const document = buildPacketTracerDocument(root, {
    format: decoded.format,
    version: decoded.packetTracerVersion,
    limits: packetTracerLimits,
  });

  const roles = new Map(
    (document.activity?.networks ?? []).map((entry) => [entry.networkId, entry] as const),
  );
  const summaries = document.networks.map((network, index) => {
    const entry = roles.get(network.id);
    return summarize(network, entry?.kind ?? "unknown", entry?.name ?? network.name ?? `Network ${index + 1}`);
  });

  if (summaries.length === 0) {
    throw new Error("The Packet Tracer file decoded but contains no network");
  }

  const fallback = chooseDefaultNetwork(summaries);
  const requested = options.networkId !== undefined
    ? summaries.find((summary) => summary.id === options.networkId)
    : undefined;
  const selectedNetworkId = requested?.id ?? fallback.id;
  const selected = document.networks.find((network) => network.id === selectedNetworkId)!;

  const baseTitle = document.activity?.title
    ?? source.filename?.replace(/\.(?:pkt|pka)$/iu, "")
    ?? "Packet Tracer import";
  const selectedSummary = summaries.find((summary) => summary.id === selectedNetworkId)!;
  const labTitle = summaries.length > 1 ? `${baseTitle} — ${selectedSummary.name}` : baseTitle;

  const parsed = mapNetworkToTopology(selected, document, labTitle);
  const withDecodeNotes: ParsedSourceTopology = {
    ...parsed,
    notes: [
      ...decoded.warnings.map((warning): ImportReportEntry => ({
        level: "warning",
        code: `packet-tracer-${warning.code}`,
        message: warning.message,
      })),
      ...(summaries.length > 1
        ? [{
            level: "info" as const,
            code: "packet-tracer-network-selected",
            message: `Imported "${selectedSummary.name}" of ${summaries.length} networks in this activity.`,
          }]
        : []),
      ...parsed.notes,
    ],
  };

  return {
    format: decoded.format === "pka" ? "packet-tracer-pka" : "packet-tracer-pkt",
    packetTracerVersion: decoded.packetTracerVersion,
    containerVariant: decoded.variant,
    networks: summaries,
    selectedNetworkId,
    selectionReason: requested !== undefined
      ? `Importing "${requested.name}" as chosen.`
      : fallback.reason,
    requiresNetworkChoice: fallback.requiresChoice,
    activityTitle: document.activity?.title,
    activityInstructions: document.activity?.instructions,
    parsed: withDecodeNotes,
  };
}

/** Why a Packet Tracer read failed, as plain data. */
export interface PacketTracerFailure {
  readonly message: string;
  /** The decoder's typed reason, absent when the failure came from elsewhere. */
  readonly reason?: PacketTracerDecodeErrorCode;
  /** True when a different file — or companion data — could still succeed. */
  readonly suggestsCompanionFallback: boolean;
  /** True when the caller aborted the read; not an error to report. */
  readonly cancelled: boolean;
}

/**
 * Describe a failed Packet Tracer read without keeping the exception.
 *
 * An `Error` loses its subclass and its own fields to structured cloning, so a
 * decode running in a Web Worker cannot post one back. Every caller — the
 * planner here, that worker, the wizard — classifies a refusal through this one
 * function, so they cannot disagree about which files the companion Migration
 * Assistant is still worth offering for.
 */
export function describePacketTracerFailure(cause: unknown): PacketTracerFailure {
  if (cause instanceof PacketTracerDecodeError) {
    return {
      message: cause.message,
      reason: cause.code,
      suggestsCompanionFallback: cause.suggestsCompanionFallback,
      cancelled: cause.code === "PACKET_TRACER_CANCELLED",
    };
  }
  // A decoded container that then fails to map is a SimulatorNet-side problem,
  // and companion files would not fix it. Say so rather than blaming the file.
  return {
    message: cause instanceof Error ? cause.message : "The Packet Tracer file could not be read",
    suggestsCompanionFallback: false,
    cancelled: false,
  };
}

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
  getDeviceProfile,
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
  planPacketTracerInterfaces,
  type DecodedPacketTracerFile,
  type InterfaceUnresolvedReason,
  type PacketTracerDecodeErrorCode,
  type PacketTracerDecodeStage,
  type PacketTracerDevice,
  type PacketTracerDocument,
  type PacketTracerInterfaceAssignment,
  type PacketTracerLimits,
  type PacketTracerNetwork,
  type PacketTracerNetworkRole,
} from "@sim/packet-tracer-format";
import { LabValidationError } from "@sim/lab-format";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { ImportError, ImportSecurityError, LIMIT_ERROR_CODES } from "../errors/errors";
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
    const common = {
      hostname: device.hostname,
      interfaces,
      ipv4: hasIpv4
        ? { address: host.ipv4!, prefixLength: prefixLength!, defaultGateway: host.gateway }
        : undefined,
      dhcpEnabled: host.dhcpEnabled ?? false,
      dnsServer: host.dns?.[0],
    };
    // A Laptop is a wireless station, so its configuration is only complete with
    // a radio block — without one the whole document fails schema validation and
    // the import dies at the very last step. Packet Tracer states no radio for a
    // cabled laptop, so this is the standby radio a Laptop dropped on the canvas
    // starts with: never an association, an SSID or a credential inferred from
    // the source.
    return deviceType === "laptop"
      ? {
          kind: "laptop",
          ...common,
          wireless: {
            radio: { enabled: true, band: "2.4ghz", supportedChannels: [1, 6, 11], radioDomainId: "local-lab" },
            savedNetworks: [],
            autoConnect: true,
          },
        } as DeviceConfig
      : { kind: "pc", ...common } as DeviceConfig;
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
  /** Source interface name -> where it landed. Empty until links are planned. */
  interfaces: ReadonlyMap<string, PacketTracerInterfaceAssignment>;
}

/** Why one endpoint could not be placed, in words the user can act on. */
const UNRESOLVED_REASONS: Readonly<Record<InterfaceUnresolvedReason, string>> = {
  "unsupported-medium":
    "SimulatorNet models one Ethernet data plane and has no interface of this medium"
    + " (a Serial WAN port, for example), so there is no port to attach the cable to",
  "no-free-interface":
    "the mapped device has no free Ethernet port left; the source chassis carries more"
    + " cabled ports than the device it was mapped onto",
  "unknown-interface-name":
    "the interface name is outside the vocabulary this importer understands, so nothing"
    + " can be inferred about which port it is",
};

/** Every interface name this device's cables use, in the source's own order. */
function cabledInterfaceNames(
  network: PacketTracerNetwork,
  deviceId: string,
): string[] {
  const names: string[] = [];
  for (const link of network.links) {
    if (link.sourceDeviceId === deviceId && link.sourceInterface !== undefined) names.push(link.sourceInterface);
    if (link.targetDeviceId === deviceId && link.targetInterface !== undefined) names.push(link.targetInterface);
  }
  return names;
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
      // Kept, never dropped: a device SimulatorNet cannot simulate is still part
      // of the lab's topology, and the cables into it are still real. Say both
      // halves of that plainly — what was lost, and what was not.
      const identity = device.packetTracerModel ?? device.packetTracerType;
      notes.push({
        level: "warning",
        code: "packet-tracer-unsupported-model",
        message: `${device.hostname ?? device.id}: Packet Tracer ${identity !== undefined ? `model "${identity}"` : "device"}`
          + " is not simulated by SimulatorNet. It was kept on the topology as an External Appliance"
          + " with its cabled ports preserved; its behaviour is not simulated.",
        nodeId: device.id,
        detail: {
          hostname: device.hostname,
          packetTracerType: device.packetTracerType,
          packetTracerModel: device.packetTracerModel,
        },
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
    // correctly. A placeholder is an External Appliance with no port inventory
    // of its own, so it keeps exactly the ports the source file gave it —
    // whatever the chassis listed, plus anything a cable named.
    const interfaces = placeholder
      ? dedupe([...device.interfaces.map((entry) => entry.name), ...cabledInterfaceNames(network, device.id)])
      : templates;

    mapped.set(device.id, {
      deviceType: deviceType ?? "external-appliance",
      placeholder,
      templates,
      interfaces: new Map(),
      node: {
        id,
        label,
        sourceKind: classification.sourceKind,
        sourceTemplate: device.packetTracerModel,
        // Kept so an unsupported device's own identity survives the import even
        // though its behaviour does not.
        iconHint: device.packetTracerType,
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

  // Interfaces are planned per device, before any cable is placed: two cables on
  // one device may compete for the same port, and which of them keeps its own
  // position must not depend on the order they appear in the file.
  for (const [deviceId, entry] of mapped) {
    if (entry.placeholder) continue;
    entry.interfaces = planPacketTracerInterfaces(cabledInterfaceNames(network, deviceId), entry.templates);
    for (const assignment of entry.interfaces.values()) {
      if (assignment.id === undefined) continue;
      if (assignment.kind !== "ethernet-speed" && assignment.kind !== "compatibility") continue;
      // The cable survives, but the interface is now named differently from the
      // source, so a configuration line naming the original will not find it.
      // Say so rather than letting it be discovered later.
      notes.push({
        level: "warning",
        code: assignment.kind === "compatibility"
          ? "packet-tracer-interface-renumbered"
          : "packet-tracer-interface-speed-substituted",
        message: `${entry.node.label} ${assignment.sourceName} was imported as ${assignment.id}; `
          + (assignment.kind === "compatibility"
            ? `${getDeviceProfile(entry.deviceType).displayName} has no port at that position, so the cable was`
              + " kept on the next free port of the same medium."
            : "SimulatorNet models that position at a different Ethernet speed. The cable is unchanged.")
          + " Configuration naming the original interface was not applied to it.",
        nodeId: entry.node.id,
        detail: { sourceInterface: assignment.sourceName, importedInterface: assignment.id },
      });
    }
  }

  const links: ImportSourceLink[] = [];
  /** Where one endpoint landed, or why it did not. */
  const endpoint = (
    side: MappedDevice,
    name: string | undefined,
  ): { readonly id: string; readonly compatibility: boolean } | { readonly detail: string } => {
    if (name === undefined) return { detail: "the source cable does not name this interface" };
    // A placeholder is an External Appliance: its ports are whatever the file
    // said they were, so every name it uses resolves by definition.
    if (side.placeholder) return { id: name, compatibility: false };
    const assignment = side.interfaces.get(name.trim().toLowerCase());
    if (assignment?.id !== undefined) return { id: assignment.id, compatibility: assignment.kind === "compatibility" };
    return { detail: UNRESOLVED_REASONS[assignment?.reason ?? "unknown-interface-name"] };
  };

  for (const link of network.links) {
    const source = mapped.get(link.sourceDeviceId);
    const target = mapped.get(link.targetDeviceId);
    if (!source || !target) continue;

    const a = endpoint(source, link.sourceInterface);
    const b = endpoint(target, link.targetInterface);

    if (!("id" in a) || !("id" in b)) {
      // Never attach a cable to an arbitrary port on a device that has one at
      // the right position free: report it precisely enough that the user can
      // reconnect it by hand, and count it so it cannot vanish quietly.
      const failing = !("id" in a)
        ? { device: source.node, name: link.sourceInterface, detail: a.detail }
        : { device: target.node, name: link.targetInterface, detail: (b as { detail: string }).detail };
      notes.push({
        level: "warning",
        code: "packet-tracer-link-unresolved",
        message: `Link ${source.node.label} ${link.sourceInterface ?? "?"}`
          + ` to ${target.node.label} ${link.targetInterface ?? "?"} was not created:`
          + ` on ${failing.device.label}, ${failing.detail}.`,
        nodeId: failing.device.id,
        detail: {
          sourceLinkId: link.id,
          device: failing.device.label,
          sourceInterface: failing.name,
          reason: failing.detail,
        },
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
      a: { node: source.node.id, iface: a.id },
      b: { node: target.node.id, iface: b.id },
      mappingKind: a.compatibility || b.compatibility ? "compatibility" : undefined,
    });
  }

  return {
    platform: PLATFORM,
    format: document.format === "pka" ? "packet-tracer-pka" : "packet-tracer-pkt",
    sourceVersion: document.version,
    labTitle,
    nodes: [...mapped.values()].map((entry) => entry.node),
    links,
    sourceLinkCount: network.links.length,
    annotations: [],
    assets: [],
    ignoredFiles: [],
    ignoredVendorImages: [],
    notes,
  };
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
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

  // The XML bounds come from the Packet Tracer limits, not the shared import
  // ones. `assertSafeXml` has already measured this document against them
  // during the decode, and they are the ceiling calibrated for *this* format:
  // an activity carries several complete network documents, so a real `.pka`
  // legitimately holds several times the elements of a hand-written UNL or
  // VIRL topology. Re-applying the generic ceiling here would refuse an
  // ordinary `.pka` for being an ordinary `.pka`. Taking the larger of the two
  // still honours a caller who raised the import bound, and can never exceed
  // what the decode already allowed through. Every other import bound —
  // nodes, links, annotations, configuration lines — stays the shared one.
  const parseLimits: ImportLimits = {
    ...importLimits,
    maxXmlDepth: Math.max(importLimits.maxXmlDepth, packetTracerLimits.maxXmlDepth),
    maxXmlNodes: Math.max(importLimits.maxXmlNodes, packetTracerLimits.maxXmlNodes),
  };
  // Whitespace is preserved because a `<LINE>` of a running-config carries its
  // indentation as meaning; every other read here trims explicitly.
  const root = parseXml(decoded.xml, parseLimits, { preserveTextWhitespace: true });
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

/**
 * Which stage of the import gave up. The container, the mapping onto
 * SimulatorNet and the resulting document fail for entirely different reasons,
 * and telling a user their file "could not be decoded" when it decoded
 * perfectly and then failed schema validation sends them to re-export a file
 * that was never the problem.
 */
export type PacketTracerFailureStage =
  /** The bytes are not a container this decoder can read. */
  | "decode"
  /** A bound was exceeded. Only ever a real, named limit — never a fallback. */
  | "safety-limit"
  /** The container was read, but its network could not be mapped. */
  | "mapping"
  /** Everything mapped, but the assembled LabDocument is not valid. */
  | "validation";

/** Why a Packet Tracer read failed, as plain data. */
export interface PacketTracerFailure {
  readonly message: string;
  readonly stage: PacketTracerFailureStage;
  /** The decoder's typed reason, absent when the failure came from elsewhere. */
  readonly reason?: PacketTracerDecodeErrorCode;
  /** True when a different file — or companion data — could still succeed. */
  readonly suggestsCompanionFallback: boolean;
  /** True when the caller aborted the read; not an error to report. */
  readonly cancelled: boolean;
  /** Bounded, sanitized specifics for a validation failure; never a stack trace. */
  readonly details?: readonly string[];
}

/** Decode codes that are a bound being hit rather than a broken container. */
const LIMIT_CODES: ReadonlySet<PacketTracerDecodeErrorCode> = new Set([
  "PACKET_TRACER_INPUT_TOO_LARGE",
  "PACKET_TRACER_DECOMPRESSION_LIMIT",
  "PACKET_TRACER_XML_LIMIT",
]);

const MAX_FAILURE_DETAILS = 10;

/** `configurations.laptop0.wireless: Required`, bounded and free of values. */
function describeValidationIssues(error: LabValidationError): string[] {
  return error.issues
    .slice(0, MAX_FAILURE_DETAILS)
    .map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`.slice(0, 200));
}

/**
 * Describe a failed Packet Tracer read without keeping the exception.
 *
 * An `Error` loses its subclass and its own fields to structured cloning, so a
 * decode running in a Web Worker cannot post one back. Every caller — the
 * planner here, that worker, the wizard — classifies a refusal through this one
 * function, so they cannot disagree about which stage failed or which files the
 * companion Migration Assistant is still worth offering for.
 */
export function describePacketTracerFailure(cause: unknown): PacketTracerFailure {
  if (cause instanceof PacketTracerDecodeError) {
    return {
      message: cause.message,
      stage: LIMIT_CODES.has(cause.code) ? "safety-limit" : "decode",
      reason: cause.code,
      suggestsCompanionFallback: cause.suggestsCompanionFallback,
      cancelled: cause.code === "PACKET_TRACER_CANCELLED",
    };
  }
  // A bound in the shared import guards — XML nodes, node/link counts, archive
  // sizes. Named only when a limit was genuinely the reason.
  if (cause instanceof ImportSecurityError || (cause instanceof ImportError && LIMIT_ERROR_CODES.has(cause.code))) {
    return { message: cause.message, stage: "safety-limit", suggestsCompanionFallback: false, cancelled: false };
  }
  // Everything mapped and the document was assembled, then refused by the
  // canonical schema. That is ours to fix, so report the offending paths rather
  // than sending the user back to Packet Tracer.
  if (cause instanceof LabValidationError) {
    return {
      message: cause.message,
      stage: "validation",
      suggestsCompanionFallback: false,
      cancelled: false,
      details: describeValidationIssues(cause),
    };
  }
  // A decoded container that then fails to map is a SimulatorNet-side problem,
  // and companion files would not fix it. Say so rather than blaming the file.
  return {
    message: cause instanceof Error ? cause.message : "The Packet Tracer file could not be read",
    stage: "mapping",
    suggestsCompanionFallback: false,
    cancelled: false,
  };
}

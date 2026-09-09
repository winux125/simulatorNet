/**
 * Packet Tracer's device vocabulary, classified.
 *
 * This maps Packet Tracer's own naming — the `<TYPE>` engine class and its
 * `model` attribute — onto a normalized token and a port budget. It stops
 * short of naming a SimulatorNet `DeviceType`: that decision belongs to the
 * importer's mapping registry, so a wrong device choice is a mapping bug in one
 * reviewable table rather than a parsing bug spread through this file.
 *
 * The table is matched most-specific-first: an exact model, then a model
 * family, then the engine class. An unrecognised device still classifies — as
 * `external-appliance` — because losing a device outright is never acceptable.
 */

export interface PacketTracerModelClassification {
  /** Normalized token consumed by the importer's mapping registry. */
  readonly sourceKind: string;
  /** Access-port count the real chassis has, when the model implies one. */
  readonly accessPorts?: number;
  /** Uplink-port count the real chassis has, when the model implies one. */
  readonly uplinkPorts?: number;
  /** True when this classification came from a fallback rather than a match. */
  readonly matched: boolean;
  /** Human-readable note when the match was approximate. */
  readonly note?: string;
}

interface ModelRule {
  /** Matched against the model, case-insensitively. */
  readonly model?: RegExp;
  /** Matched against the engine class, case-insensitively. */
  readonly engine?: RegExp;
  readonly sourceKind: string;
  readonly accessPorts?: number;
  readonly uplinkPorts?: number;
}

/**
 * Model rules first, engine rules second. Deliberately a data table: adding a
 * chassis is a row, not a branch.
 */
const MODEL_RULES: readonly ModelRule[] = [
  // Layer-2 access switches. Port counts come from the real chassis so the
  // importer can pick a hardware profile that is not smaller than the lab uses.
  { model: /^2960-24|^2950-24|^2960-?24tt/iu, sourceKind: "l2-switch", accessPorts: 24, uplinkPorts: 2 },
  { model: /^2960-48|^2950-48/iu, sourceKind: "l2-switch", accessPorts: 48, uplinkPorts: 4 },
  { model: /^2960|^2950|^switch-pt/iu, sourceKind: "l2-switch", accessPorts: 24, uplinkPorts: 2 },
  // Multilayer switches.
  { model: /^3560-24|^3650-24|^3560/iu, sourceKind: "l3-switch", accessPorts: 24, uplinkPorts: 2 },
  { model: /^3650|^3750/iu, sourceKind: "l3-switch", accessPorts: 48, uplinkPorts: 4 },
  // Routers.
  { model: /^(?:1841|1941|2811|2901|2911|2621|2620|4321|4331|isr)/iu, sourceKind: "router" },
  { model: /^router-pt/iu, sourceKind: "router" },
  // Wireless.
  { model: /^(?:wrt300n|home\s*router|wireless\s*router)/iu, sourceKind: "wireless-router" },
  { model: /^(?:ap-pt|access\s*point|wrt)/iu, sourceKind: "access-point" },
  // End devices and infrastructure.
  { model: /^pc-pt/iu, sourceKind: "pc" },
  { model: /^laptop-pt/iu, sourceKind: "laptop" },
  { model: /^server-pt/iu, sourceKind: "server" },
  { model: /^tablet-pt|^tabletpc/iu, sourceKind: "smartphone" },
  { model: /^(?:smartphone|phone)/iu, sourceKind: "smartphone" },
  { model: /^hub-pt|^repeater/iu, sourceKind: "hub" },
  { model: /^bridge-pt/iu, sourceKind: "bridge" },
  { model: /^cloud-pt|^cloud/iu, sourceKind: "cloud" },

  // Engine classes, used when the model is absent or unknown.
  { engine: /^pc$/iu, sourceKind: "pc" },
  { engine: /^laptop$/iu, sourceKind: "laptop" },
  { engine: /^server$/iu, sourceKind: "server" },
  { engine: /^tablet$|^smartphone$|^phone$/iu, sourceKind: "smartphone" },
  { engine: /^switch$/iu, sourceKind: "l2-switch", accessPorts: 24, uplinkPorts: 2 },
  { engine: /^multilayerswitch$|^multi.?layer/iu, sourceKind: "l3-switch", accessPorts: 24, uplinkPorts: 2 },
  { engine: /^router$/iu, sourceKind: "router" },
  { engine: /^hub$|^repeater$/iu, sourceKind: "hub" },
  { engine: /^bridge$/iu, sourceKind: "bridge" },
  { engine: /^cloud$/iu, sourceKind: "cloud" },
  { engine: /^accesspoint$|^access point$/iu, sourceKind: "access-point" },
  { engine: /^wirelessrouter$/iu, sourceKind: "wireless-router" },
];

/**
 * Classify one Packet Tracer device. `portCount` refines a switch's density
 * when the model itself did not state one.
 */
export function classifyPacketTracerModel(
  packetTracerType: string | undefined,
  packetTracerModel: string | undefined,
  portCount = 0,
): PacketTracerModelClassification {
  const model = packetTracerModel?.trim() ?? "";
  const engine = packetTracerType?.trim() ?? "";

  for (const rule of MODEL_RULES) {
    if (rule.model !== undefined && (model.length === 0 || !rule.model.test(model))) continue;
    if (rule.engine !== undefined && (engine.length === 0 || !rule.engine.test(engine))) continue;
    if (rule.model === undefined && rule.engine === undefined) continue;

    // A switch whose chassis reports more ports than the matched rule assumed
    // must not be given a smaller profile than the lab actually uses.
    let { accessPorts, uplinkPorts } = rule;
    let note: string | undefined;
    if (accessPorts !== undefined && portCount > accessPorts + (uplinkPorts ?? 0)) {
      accessPorts = portCount > 50 ? 48 : 24;
      uplinkPorts = accessPorts === 48 ? 4 : 2;
      note = `Chassis reports ${portCount} ports; widened to a ${accessPorts}-port profile.`;
    }

    return { sourceKind: rule.sourceKind, accessPorts, uplinkPorts, matched: true, note };
  }

  return {
    sourceKind: "external-appliance",
    matched: false,
    note: model.length > 0 || engine.length > 0
      ? `Unsupported Packet Tracer model: ${model.length > 0 ? model : engine}`
      : "Packet Tracer device declares no model or engine type",
  };
}

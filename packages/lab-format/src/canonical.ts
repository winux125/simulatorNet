import type {
  DeviceConfig,
  BridgeDeviceConfig,
  HubDeviceConfig,
  Layer3SwitchDeviceConfig,
  Layer3SwitchInterfaceConfig,
  LabDocument,
  NodeSpec,
  PcDeviceConfig,
  PhysicalInterfaceConfig,
  RouterDeviceConfig,
  RouterPhysicalInterfaceConfig,
  ServerDeviceConfig,
  SwitchDeviceConfig,
  SwitchInterfaceConfig,
} from "@sim/contracts";
import { ipToInt, macFromIndex, normalizeServiceConfiguration } from "@sim/sim-core";
import { parseLabDocument } from "./parse";
import { validateLabSemantics } from "./semantic";

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

function canonicalInterfaces(nodes: readonly NodeSpec[]): NodeSpec[] {
  const used = new Set(
    nodes.flatMap((node) => node.interfaces.flatMap((iface) => (iface.mac ? [iface.mac.toLowerCase()] : []))),
  );
  let generatedIndex = 1;
  const nextMac = (): string => {
    for (;;) {
      const candidate = macFromIndex(generatedIndex++);
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };

  return [...nodes].sort(byId).map((node) => ({
    ...node,
    interfaces: [...node.interfaces]
      .sort(byId)
      .map((iface) => ({ ...iface, mac: iface.mac?.toLowerCase() ?? nextMac() })),
  }));
}

function commonInterface(
  id: string,
  existing: PhysicalInterfaceConfig | undefined,
): PhysicalInterfaceConfig {
  return {
    id,
    description: existing?.description,
    shutdown: existing?.shutdown ?? false,
  };
}

function pcConfiguration(node: NodeSpec, config: PcDeviceConfig | undefined): PcDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "pc",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    ipv4: config?.ipv4,
    dhcpEnabled: config?.dhcpEnabled ?? false,
    dnsServer: config?.dnsServer,
  };
}

function serverConfiguration(node: NodeSpec, config: ServerDeviceConfig | undefined): ServerDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "server",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => ({
      ...commonInterface(iface.id, interfaces.get(iface.id)),
      ipv4: interfaces.get(iface.id)?.ipv4,
    })),
    defaultGateway: config?.defaultGateway,
    dhcpClientEnabled: config?.dhcpClientEnabled ?? false,
    dnsServer: config?.dnsServer,
    enabledServices: [...(config?.enabledServices ?? [])]
      .sort(byId)
      .map((service) => normalizeServiceConfiguration(service)),
  };
}

function hubConfiguration(node: NodeSpec, config: HubDeviceConfig | undefined): HubDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "hub",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
  };
}

function bridgeConfiguration(node: NodeSpec, config: BridgeDeviceConfig | undefined): BridgeDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "bridge",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface) => commonInterface(iface.id, interfaces.get(iface.id))),
    agingTimeNs: config?.agingTimeNs ?? 300_000_000_000,
  };
}

function switchConfiguration(node: NodeSpec, config: SwitchDeviceConfig | undefined): SwitchDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  const vlans = new Map((config?.vlans ?? []).map((vlan) => [vlan.id, vlan]));
  if (!vlans.has(1)) vlans.set(1, { id: 1, name: "default" });
  return {
    kind: "l2-switch",
    hostname: config?.hostname ?? node.name ?? node.id,
    vlans: [...vlans.values()].sort((a, b) => a.id - b.id),
    interfaces: node.interfaces.map((iface): SwitchInterfaceConfig => {
      const current = interfaces.get(iface.id);
      return {
        ...commonInterface(iface.id, current),
        mode: current?.mode ?? "access",
        accessVlan: current?.accessVlan ?? 1,
        nativeVlan: current?.nativeVlan ?? 1,
        allowedVlans: current?.allowedVlans
          ? [...current.allowedVlans].sort((a, b) => a - b)
          : undefined,
      };
    }),
  };
}

function routerConfiguration(node: NodeSpec, config: RouterDeviceConfig | undefined): RouterDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  return {
    kind: "router",
    hostname: config?.hostname ?? node.name ?? node.id,
    interfaces: node.interfaces.map((iface): RouterPhysicalInterfaceConfig => {
      const current = interfaces.get(iface.id);
      return {
        ...commonInterface(iface.id, current),
        routed: current?.routed ?? false,
        ipv4: current?.ipv4,
      };
    }),
    subinterfaces: [...(config?.subinterfaces ?? [])].sort(byId).map((iface) => ({ ...iface })),
    staticRoutes: [...(config?.staticRoutes ?? [])]
      .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength || a.nextHop.localeCompare(b.nextHop))
      .map((route) => ({ ...route })),
    dhcpPools: [...(config?.dhcpPools ?? [])].sort(byId).map((pool) => ({ ...pool })),
  };
}

function layer3SwitchConfiguration(
  node: NodeSpec,
  config: Layer3SwitchDeviceConfig | undefined,
): Layer3SwitchDeviceConfig {
  const interfaces = new Map(config?.interfaces.map((iface) => [iface.id, iface]));
  const vlans = new Map((config?.vlans ?? []).map((vlan) => [vlan.id, vlan]));
  if (!vlans.has(1)) vlans.set(1, { id: 1, name: "default" });
  return {
    kind: "l3-switch",
    hostname: config?.hostname ?? node.name ?? node.id,
    vlans: [...vlans.values()].sort((a, b) => a.id - b.id),
    interfaces: node.interfaces.map((iface): Layer3SwitchInterfaceConfig => {
      const current = interfaces.get(iface.id);
      if (current?.mode === "routed") {
        return { ...commonInterface(iface.id, current), mode: "routed", ipv4: current.ipv4 };
      }
      return {
        ...commonInterface(iface.id, current),
        mode: current?.mode ?? "access",
        accessVlan: current?.accessVlan ?? 1,
        nativeVlan: current?.nativeVlan ?? 1,
        allowedVlans: current?.allowedVlans ? [...current.allowedVlans].sort((a, b) => a - b) : undefined,
      };
    }),
    svis: [...(config?.svis ?? [])].sort((a, b) => a.vlanId - b.vlanId).map((svi) => ({ ...svi })),
    staticRoutes: [...(config?.staticRoutes ?? [])]
      .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength || a.nextHop.localeCompare(b.nextHop))
      .map((route) => ({ ...route })),
    ipRoutingEnabled: config?.ipRoutingEnabled ?? false,
  };
}

function configurationFor(node: NodeSpec, existing: DeviceConfig | undefined): DeviceConfig {
  if (node.kind === "pc") return pcConfiguration(node, existing?.kind === "pc" ? existing : undefined);
  if (node.kind === "server") return serverConfiguration(node, existing?.kind === "server" ? existing : undefined);
  if (node.kind === "hub") return hubConfiguration(node, existing?.kind === "hub" ? existing : undefined);
  if (node.kind === "bridge") return bridgeConfiguration(node, existing?.kind === "bridge" ? existing : undefined);
  if (node.kind === "l2-switch") {
    return switchConfiguration(node, existing?.kind === "l2-switch" ? existing : undefined);
  }
  if (node.kind === "l3-switch") {
    return layer3SwitchConfiguration(node, existing?.kind === "l3-switch" ? existing : undefined);
  }
  return routerConfiguration(node, existing?.kind === "router" ? existing : undefined);
}

export function canonicalizeLabDocument(document: LabDocument): LabDocument {
  const parsed = parseLabDocument(document);
  const nodes = canonicalInterfaces(parsed.topology.nodes);
  const configurations: Record<string, DeviceConfig> = {};
  for (const node of nodes) configurations[node.id] = configurationFor(node, parsed.configurations[node.id]);

  const canonical: LabDocument = {
    schemaVersion: 1,
    id: parsed.id,
    title: parsed.title,
    description: parsed.description,
    instructions: parsed.instructions,
    expectedOutcome: parsed.expectedOutcome,
    diagram: parsed.diagram === undefined
      ? undefined
      : {
          annotations: [...parsed.diagram.annotations].sort(byId).map((annotation) => (
            "position" in annotation
              ? { ...annotation, position: { ...annotation.position } }
              : { ...annotation, start: { ...annotation.start }, end: { ...annotation.end } }
          )),
          linkLabels: [...parsed.diagram.linkLabels]
            .sort((a, b) => a.linkId.localeCompare(b.linkId))
            .map((label) => ({ ...label })),
        },
    simulation: { seed: parsed.simulation.seed },
    topology: {
      schemaVersion: 1,
      nodes,
      links: [...parsed.topology.links].sort(byId).map((link) => ({
        id: link.id,
        a: { ...link.a },
        b: { ...link.b },
        propagationDelayNs: link.propagationDelayNs,
      })),
    },
    configurations,
  };
  validateLabSemantics(canonical);
  return canonical;
}

export function stringifyLabDocument(document: LabDocument): string {
  return `${JSON.stringify(canonicalizeLabDocument(document), null, 2)}\n`;
}

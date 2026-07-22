import type { ServerServiceConfig } from "@sim/contracts";
import { EndHost } from "./pc";
import { ServerServiceRegistry, type ServerServiceRuntimeSnapshot, type ServerServiceSummary } from "../services/server-services";

/**
 * Server reuses the end-host IPv4/ARP/ICMP/DHCP/transport stack and owns the
 * deterministic application-service registry. Runtime state is never part of
 * the persistent lab document.
 */
export class Server extends EndHost {
  readonly deviceType = "server" as const;
  readonly services: ServerServiceRegistry;

  constructor(id: string, name: string) {
    super(id, name);
    this.services = new ServerServiceRegistry({
      deviceId: this.id,
      hostname: () => this.name,
      engine: () => this.engine,
      localAddress: () => this.ip,
      transport: this.transport,
    });
  }

  get enabledServices(): ServerServiceConfig[] {
    return this.services.configurations().filter((service) => service.enabled);
  }

  configureServices(configurations: readonly ServerServiceConfig[]): void {
    this.services.configureAll(configurations);
  }

  configureService(configuration: ServerServiceConfig): void {
    this.services.configure(configuration);
  }

  enableService(id: string): void {
    this.services.enable(id);
  }

  disableService(id: string): void {
    this.services.disable(id);
  }

  listServices(): ServerServiceSummary[] {
    return this.services.summaries();
  }

  serviceRuntimeSnapshot(): ServerServiceRuntimeSnapshot {
    return this.services.runtimeSnapshot();
  }
}

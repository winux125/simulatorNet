import type { SimulatorDatabase } from "../database";
import { sanitizeAuditMetadata } from "../audit";
import { auditEvents, type AuditEventRecord } from "../schema/index";

/** Explicit cross-tenant audit writer for failures before a tenant is established. */
export class AuthenticationAuditRepository {
  constructor(private readonly database: SimulatorDatabase) {}

  async record(input: {
    organizationId?: string;
    actorType?: "service" | "system";
    actorId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord> {
    const [event] = await this.database.insert(auditEvents).values({
      organizationId: input.organizationId,
      actorType: input.actorType ?? "system",
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId,
      metadata: sanitizeAuditMetadata(input.metadata ?? {}),
    }).returning();
    return event!;
  }
}

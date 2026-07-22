import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { SimulatorDatabase } from "../database";
import { sanitizeAuditMetadata } from "../audit";
import { DatabaseConflictError, DatabaseForbiddenError, DatabaseNotFoundError, hasPostgresErrorCode } from "../errors/index";
import {
  auditEvents,
  browserSessions,
  externalUserLinks,
  integrationClients,
  launchCodes,
  organizationMemberships,
  users,
  type AuditEventRecord,
  type BrowserSessionRecord,
  type ExternalUserLinkRecord,
  type IntegrationClientRecord,
  type LaunchCodeRecord,
  type MembershipRecord,
} from "../schema/index";
import {
  ExternalUserInputSchema,
  TenantContextSchema,
  type ExternalUserInput,
  type ExternalUserRecord,
  type OrganizationRole,
  type TenantContext,
} from "../types/index";

function tenant(context: TenantContext): TenantContext {
  return TenantContextSchema.parse(context);
}

export class TenantRepository {
  constructor(private readonly database: SimulatorDatabase) {}

  async createIntegrationClientMapping(
    context: TenantContext,
    input: { keycloakClientId: string; name: string; allowedScopes: string[]; allowedReturnUrls: string[] },
  ): Promise<IntegrationClientRecord> {
    const scope = tenant(context);
    try {
      const [client] = await this.database.insert(integrationClients).values({
        organizationId: scope.organizationId,
        keycloakClientId: input.keycloakClientId,
        name: input.name,
        allowedScopes: [...new Set(input.allowedScopes)].sort(),
        allowedReturnUrls: [...new Set(input.allowedReturnUrls)].sort(),
      }).returning();
      return client!;
    } catch (error) {
      if (hasPostgresErrorCode(error, "23505")) throw new DatabaseConflictError("Keycloak client id already exists");
      throw error;
    }
  }

  async getIntegrationClient(context: TenantContext, id: string): Promise<IntegrationClientRecord | undefined> {
    const scope = tenant(context);
    const [client] = await this.database.select().from(integrationClients).where(and(
      eq(integrationClients.id, id),
      eq(integrationClients.organizationId, scope.organizationId),
    )).limit(1);
    return client;
  }

  async disableIntegrationClient(context: TenantContext, id: string): Promise<IntegrationClientRecord | undefined> {
    const scope = tenant(context);
    const [client] = await this.database.update(integrationClients).set({ status: "disabled", updatedAt: new Date() }).where(and(
      eq(integrationClients.id, id),
      eq(integrationClients.organizationId, scope.organizationId),
    )).returning();
    return client;
  }

  async upsertExternalUser(
    context: TenantContext,
    integrationClientId: string,
    externalUserId: string,
    rawInput: ExternalUserInput,
  ): Promise<ExternalUserRecord> {
    const scope = tenant(context);
    const input = ExternalUserInputSchema.parse(rawInput);
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${integrationClientId}:${externalUserId}`}, 0))`);
      const [client] = await tx.select({ id: integrationClients.id }).from(integrationClients).where(and(
        eq(integrationClients.id, integrationClientId),
        eq(integrationClients.organizationId, scope.organizationId),
        eq(integrationClients.status, "active"),
      )).limit(1);
      if (!client) throw new DatabaseNotFoundError("Integration client was not found in this organization");

      const [existing] = await tx.select({
        externalUserId: externalUserLinks.externalUserId,
        integrationClientId: externalUserLinks.integrationClientId,
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
      }).from(externalUserLinks)
        .innerJoin(users, eq(externalUserLinks.userId, users.id))
        .where(and(
          eq(externalUserLinks.integrationClientId, integrationClientId),
          eq(externalUserLinks.externalUserId, externalUserId),
        )).limit(1);
      if (existing) {
        const [updated] = await tx.update(users).set({
          email: input.email,
          displayName: input.displayName,
          updatedAt: new Date(),
        }).where(eq(users.id, existing.userId)).returning();
        return { ...existing, email: updated!.email, displayName: updated!.displayName, status: updated!.status };
      }

      const [user] = await tx.insert(users).values({ email: input.email, displayName: input.displayName }).returning();
      await tx.insert(externalUserLinks).values({ integrationClientId, externalUserId, userId: user!.id });
      return {
        externalUserId,
        integrationClientId,
        userId: user!.id,
        email: user!.email,
        displayName: user!.displayName,
        status: user!.status,
      };
    });
  }

  async getExternalUser(
    context: TenantContext,
    integrationClientId: string,
    externalUserId: string,
  ): Promise<ExternalUserRecord | undefined> {
    const scope = tenant(context);
    const [record] = await this.database.select({
      externalUserId: externalUserLinks.externalUserId,
      integrationClientId: externalUserLinks.integrationClientId,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      status: users.status,
    }).from(externalUserLinks)
      .innerJoin(users, eq(externalUserLinks.userId, users.id))
      .innerJoin(integrationClients, eq(externalUserLinks.integrationClientId, integrationClients.id))
      .where(and(
        eq(integrationClients.organizationId, scope.organizationId),
        eq(externalUserLinks.integrationClientId, integrationClientId),
        eq(externalUserLinks.externalUserId, externalUserId),
      )).limit(1);
    return record;
  }

  async getOrganizationUser(context: TenantContext, userId: string) {
    const scope = tenant(context);
    const [record] = await this.database.select({ user: users, membership: organizationMemberships })
      .from(organizationMemberships)
      .innerJoin(users, eq(organizationMemberships.userId, users.id))
      .where(and(
        eq(organizationMemberships.organizationId, scope.organizationId),
        eq(organizationMemberships.userId, userId),
      )).limit(1);
    return record;
  }

  async setOrganizationMembership(
    context: TenantContext,
    userId: string,
    role: OrganizationRole,
  ): Promise<MembershipRecord> {
    const scope = tenant(context);
    if (role === "platform_admin" && scope.actor.kind === "service") {
      throw new DatabaseForbiddenError("Service integrations cannot assign platform_admin");
    }
    const [linked] = await this.database.select({ userId: externalUserLinks.userId }).from(externalUserLinks)
      .innerJoin(integrationClients, eq(externalUserLinks.integrationClientId, integrationClients.id))
      .where(and(
        eq(externalUserLinks.userId, userId),
        eq(integrationClients.organizationId, scope.organizationId),
      )).limit(1);
    const existing = await this.getOrganizationMembership(scope, userId);
    if (!linked && !existing) throw new DatabaseNotFoundError("User is not linked to this organization");

    const [membership] = await this.database.insert(organizationMemberships).values({
      organizationId: scope.organizationId,
      userId,
      role,
      status: "active",
    }).onConflictDoUpdate({
      target: [organizationMemberships.organizationId, organizationMemberships.userId],
      set: { role, status: "active", updatedAt: new Date() },
    }).returning();
    return membership!;
  }

  async getOrganizationMembership(context: TenantContext, userId: string): Promise<MembershipRecord | undefined> {
    const scope = tenant(context);
    const [membership] = await this.database.select().from(organizationMemberships).where(and(
      eq(organizationMemberships.organizationId, scope.organizationId),
      eq(organizationMemberships.userId, userId),
    )).limit(1);
    return membership;
  }

  async setOrganizationMembershipStatus(
    context: TenantContext,
    userId: string,
    status: "active" | "inactive",
  ): Promise<MembershipRecord | undefined> {
    const scope = tenant(context);
    const [membership] = await this.database.update(organizationMemberships).set({
      status,
      updatedAt: new Date(),
    }).where(and(
      eq(organizationMemberships.organizationId, scope.organizationId),
      eq(organizationMemberships.userId, userId),
    )).returning();
    return membership;
  }

  async createLaunchCode(
    context: TenantContext,
    input: { userId: string; integrationClientId: string; codeHash: string; returnUrl: string; expiresAt: Date },
  ): Promise<LaunchCodeRecord> {
    const scope = tenant(context);
    const [record] = await this.database.insert(launchCodes).values({
      organizationId: scope.organizationId,
      userId: input.userId,
      integrationClientId: input.integrationClientId,
      codeHash: input.codeHash,
      returnUrl: input.returnUrl,
      expiresAt: input.expiresAt,
    }).returning();
    return record!;
  }

  async consumeLaunchCode(context: TenantContext, codeHash: string, now = new Date()): Promise<LaunchCodeRecord | undefined> {
    const scope = tenant(context);
    const [record] = await this.database.update(launchCodes).set({ consumedAt: now }).where(and(
      eq(launchCodes.organizationId, scope.organizationId),
      eq(launchCodes.codeHash, codeHash),
      isNull(launchCodes.consumedAt),
      gt(launchCodes.expiresAt, now),
    )).returning();
    return record;
  }

  async createBrowserSession(
    context: TenantContext,
    input: { userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<BrowserSessionRecord> {
    const scope = tenant(context);
    const [record] = await this.database.insert(browserSessions).values({
      organizationId: scope.organizationId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    }).returning();
    return record!;
  }

  async getBrowserSession(context: TenantContext, tokenHash: string, now = new Date()): Promise<BrowserSessionRecord | undefined> {
    const scope = tenant(context);
    const [record] = await this.database.update(browserSessions).set({ lastSeenAt: now }).where(and(
      eq(browserSessions.organizationId, scope.organizationId),
      eq(browserSessions.tokenHash, tokenHash),
      isNull(browserSessions.revokedAt),
      gt(browserSessions.expiresAt, now),
    )).returning();
    return record;
  }

  async revokeBrowserSession(context: TenantContext, tokenHash: string, now = new Date()): Promise<BrowserSessionRecord | undefined> {
    const scope = tenant(context);
    const [record] = await this.database.update(browserSessions).set({ revokedAt: now }).where(and(
      eq(browserSessions.organizationId, scope.organizationId),
      eq(browserSessions.tokenHash, tokenHash),
      isNull(browserSessions.revokedAt),
    )).returning();
    return record;
  }

  async recordAuditEvent(
    context: TenantContext,
    input: {
      action: string;
      resourceType: string;
      resourceId?: string;
      requestId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<AuditEventRecord> {
    const scope = tenant(context);
    const [event] = await this.database.insert(auditEvents).values({
      organizationId: scope.organizationId,
      actorType: scope.actor.kind,
      actorId: scope.actor.id,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId,
      metadata: sanitizeAuditMetadata(input.metadata ?? {}),
    }).returning();
    return event!;
  }

  async rawExternalLink(context: TenantContext, integrationClientId: string, externalUserId: string): Promise<ExternalUserLinkRecord | undefined> {
    const scope = tenant(context);
    const [link] = await this.database.select({ link: externalUserLinks }).from(externalUserLinks)
      .innerJoin(integrationClients, eq(externalUserLinks.integrationClientId, integrationClients.id))
      .where(and(
        eq(integrationClients.organizationId, scope.organizationId),
        eq(externalUserLinks.integrationClientId, integrationClientId),
        eq(externalUserLinks.externalUserId, externalUserId),
      )).limit(1);
    return link?.link;
  }
}

import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthenticationLookupRepository,
  browserSessions,
  createDatabase,
  createOpaqueToken,
  DatabaseConflictError,
  DatabaseForbiddenError,
  DatabaseNotFoundError,
  hashOpaqueToken,
  externalUserLinks,
  integrationClients,
  organizationMemberships,
  organizations,
  PlatformAdminRepository,
  seedDevelopmentDatabase,
  TenantRepository,
  users,
  type DatabaseClient,
  type TenantContext,
} from "../src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

let client: DatabaseClient;
let platform: PlatformAdminRepository;
let authLookup: AuthenticationLookupRepository;

async function createTenant(slug: string, keycloakClientId = `${slug}-client`) {
  const organization = await platform.createOrganization({ slug, name: slug.toUpperCase() });
  const context: TenantContext = {
    organizationId: organization.id,
    actor: { kind: "service", id: keycloakClientId },
  };
  const repository = new TenantRepository(client.db);
  const integrationClient = await repository.createIntegrationClientMapping(context, {
    keycloakClientId,
    name: `${slug} integration`,
    allowedScopes: ["users:read", "users:write", "launch:write"],
    allowedReturnUrls: ["https://academy.example.test"],
  });
  return { organization, context, repository, integrationClient };
}

async function createMember(tenant: Awaited<ReturnType<typeof createTenant>>, externalId = "student-1") {
  const user = await tenant.repository.upsertExternalUser(
    tenant.context,
    tenant.integrationClient.id,
    externalId,
    { email: `${externalId}@example.test`, displayName: externalId },
  );
  const membership = await tenant.repository.setOrganizationMembership(tenant.context, user.userId, "student");
  return { user, membership };
}

integration("PostgreSQL tenant repository", () => {
  beforeAll(() => {
    client = createDatabase({ connectionString: databaseUrl!, maxConnections: 4, applicationName: "simulatornet-db-tests" });
    platform = new PlatformAdminRepository(client.db);
    authLookup = new AuthenticationLookupRepository(client.db);
  });

  beforeEach(async () => {
    await client.db.execute(sql`truncate table audit_events, browser_sessions, launch_codes, external_user_links, integration_clients, organization_memberships, user_identities, users, organizations restart identity cascade`);
  });

  afterAll(async () => client.close());

  it("applies committed migrations to an empty PostgreSQL database", async () => {
    const result = await client.db.execute<{ organizations: string | null; migrations: string | null }>(sql`
      select to_regclass('public.organizations')::text as organizations,
             to_regclass('drizzle.__drizzle_migrations')::text as migrations
    `);
    expect(result.rows[0]).toEqual({ organizations: "organizations", migrations: "drizzle.__drizzle_migrations" });
  });

  it("enforces case-insensitive organization slug uniqueness", async () => {
    await platform.createOrganization({ slug: "ACME", name: "ACME" });
    await expect(platform.createOrganization({ slug: "acme", name: "Duplicate" })).rejects.toBeInstanceOf(DatabaseConflictError);
  });

  it("enforces global Keycloak integration client uniqueness", async () => {
    await createTenant("tenant-a", "shared-client");
    const organization = await platform.createOrganization({ slug: "tenant-b", name: "Tenant B" });
    const context: TenantContext = { organizationId: organization.id, actor: { kind: "system", id: "test" } };
    await expect(new TenantRepository(client.db).createIntegrationClientMapping(context, {
      keycloakClientId: "shared-client",
      name: "Duplicate",
      allowedScopes: [],
      allowedReturnUrls: [],
    })).rejects.toBeInstanceOf(DatabaseConflictError);
  });

  it("keeps one membership row per organization and user", async () => {
    const tenant = await createTenant("membership");
    const { user } = await createMember(tenant);
    await tenant.repository.setOrganizationMembership(tenant.context, user.userId, "instructor");
    const [row] = await client.db.select({ total: count() }).from(organizationMemberships).where(andMembership(tenant.context, user.userId));
    expect(row?.total).toBe(1);
    expect((await tenant.repository.getOrganizationMembership(tenant.context, user.userId))?.role).toBe("instructor");
  });

  it("upserts one external user idempotently", async () => {
    const tenant = await createTenant("upsert");
    const first = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "external-1", {
      email: "old@example.test",
      displayName: "Old Name",
    });
    const second = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "external-1", {
      email: "new@example.test",
      displayName: "New Name",
    });
    expect(second).toMatchObject({ userId: first.userId, email: "new@example.test", displayName: "New Name" });
  });

  it("isolates the same external user id across integration clients", async () => {
    const tenant = await createTenant("external-isolation", "client-one");
    const secondClient = await tenant.repository.createIntegrationClientMapping(tenant.context, {
      keycloakClientId: "client-two",
      name: "Second",
      allowedScopes: [],
      allowedReturnUrls: [],
    });
    const first = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "same-id", {
      email: "first@example.test",
      displayName: "First",
    });
    const second = await tenant.repository.upsertExternalUser(tenant.context, secondClient.id, "same-id", {
      email: "second@example.test",
      displayName: "Second",
    });
    expect(first.userId).not.toBe(second.userId);
  });

  it("prevents Tenant A from reading a Tenant B user", async () => {
    const a = await createTenant("tenant-a");
    const b = await createTenant("tenant-b");
    const { user } = await createMember(b);
    expect(await a.repository.getOrganizationUser(a.context, user.userId)).toBeUndefined();
  });

  it("prevents Tenant A from updating a Tenant B membership", async () => {
    const a = await createTenant("tenant-a");
    const b = await createTenant("tenant-b");
    const { user } = await createMember(b);
    await expect(a.repository.setOrganizationMembership(a.context, user.userId, "instructor"))
      .rejects.toBeInstanceOf(DatabaseNotFoundError);
  });

  it("prevents service actors from assigning platform_admin", async () => {
    const tenant = await createTenant("roles");
    const user = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "admin", {
      email: "admin@example.test",
      displayName: "Admin",
    });
    await expect(tenant.repository.setOrganizationMembership(tenant.context, user.userId, "platform_admin"))
      .rejects.toBeInstanceOf(DatabaseForbiddenError);
  });

  it("stores launch codes only as SHA-256 hashes", async () => {
    const tenant = await createTenant("launch-hash");
    const { user } = await createMember(tenant);
    const token = createOpaqueToken();
    const record = await tenant.repository.createLaunchCode(tenant.context, {
      userId: user.userId,
      integrationClientId: tenant.integrationClient.id,
      codeHash: token.hash,
      returnUrl: "https://academy.example.test",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(record.codeHash).toBe(hashOpaqueToken(token.value));
    expect(JSON.stringify(record)).not.toContain(token.value);
  });

  it("rejects an expired launch code", async () => {
    const tenant = await createTenant("launch-expired");
    const { user } = await createMember(tenant);
    const token = createOpaqueToken();
    await tenant.repository.createLaunchCode(tenant.context, {
      userId: user.userId,
      integrationClientId: tenant.integrationClient.id,
      codeHash: token.hash,
      returnUrl: "https://academy.example.test",
      expiresAt: new Date(Date.now() - 1),
    });
    expect(await tenant.repository.consumeLaunchCode(tenant.context, token.hash)).toBeUndefined();
  });

  it("consumes a launch code only once", async () => {
    const tenant = await createTenant("launch-once");
    const { user } = await createMember(tenant);
    const token = createOpaqueToken();
    await tenant.repository.createLaunchCode(tenant.context, {
      userId: user.userId,
      integrationClientId: tenant.integrationClient.id,
      codeHash: token.hash,
      returnUrl: "https://academy.example.test",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await tenant.repository.consumeLaunchCode(tenant.context, token.hash)).toBeTruthy();
    expect(await tenant.repository.consumeLaunchCode(tenant.context, token.hash)).toBeUndefined();
  });

  it("allows exactly one winner during concurrent launch-code consumption", async () => {
    const tenant = await createTenant("launch-race");
    const { user } = await createMember(tenant);
    const token = createOpaqueToken();
    await tenant.repository.createLaunchCode(tenant.context, {
      userId: user.userId,
      integrationClientId: tenant.integrationClient.id,
      codeHash: token.hash,
      returnUrl: "https://academy.example.test",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const results = await Promise.all([
      tenant.repository.consumeLaunchCode(tenant.context, token.hash),
      tenant.repository.consumeLaunchCode(tenant.context, token.hash),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("stores browser sessions only as hashes", async () => {
    const tenant = await createTenant("session-hash");
    const { user } = await createMember(tenant);
    const token = createOpaqueToken();
    const session = await tenant.repository.createBrowserSession(tenant.context, {
      userId: user.userId,
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(session.tokenHash).toBe(token.hash);
    expect(JSON.stringify(session)).not.toContain(token.value);
  });

  it("rejects revoked browser sessions", async () => {
    const tenant = await createTenant("session-revoke");
    const { user } = await createMember(tenant);
    const token = createOpaqueToken();
    await tenant.repository.createBrowserSession(tenant.context, {
      userId: user.userId,
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await tenant.repository.revokeBrowserSession(tenant.context, token.hash);
    expect(await tenant.repository.getBrowserSession(tenant.context, token.hash)).toBeUndefined();
  });

  it("removes secret fields from audit metadata", async () => {
    const tenant = await createTenant("audit");
    const event = await tenant.repository.recordAuditEvent(tenant.context, {
      action: "test.audit",
      resourceType: "test",
      metadata: {
        safe: "kept",
        accessToken: "raw-access-token",
        nested: { cookie: "raw-cookie", result: "ok" },
      },
    });
    expect(event.metadata).toEqual({ safe: "kept", nested: { result: "ok" } });
    expect(JSON.stringify(event.metadata)).not.toContain("raw-");
  });

  it("rolls transactions back completely on failure", async () => {
    await expect(client.db.transaction(async (transaction) => {
      await transaction.insert(organizations).values({ slug: "rolled-back", name: "Rollback" });
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    expect(await platform.getOrganizationBySlug("rolled-back")).toBeUndefined();
  });

  it("keeps tenant scope correct after pooled connection reuse", async () => {
    const a = await createTenant("pool-a");
    const b = await createTenant("pool-b");
    const aUser = await createMember(a, "shared");
    const bUser = await createMember(b, "shared");
    expect((await a.repository.getExternalUser(a.context, a.integrationClient.id, "shared"))?.userId).toBe(aUser.user.userId);
    expect((await b.repository.getExternalUser(b.context, b.integrationClient.id, "shared"))?.userId).toBe(bUser.user.userId);
    expect(await a.repository.getOrganizationUser(a.context, bUser.user.userId)).toBeUndefined();
    expect((await authLookup.getIntegrationClientByKeycloakClientId("pool-a-client"))?.organization.id).toBe(a.organization.id);
  });

  it("uses unique hash constraints for launch and session credentials", async () => {
    const tenant = await createTenant("hash-constraints");
    const { user } = await createMember(tenant);
    const hash = createOpaqueToken().hash;
    await tenant.repository.createBrowserSession(tenant.context, { userId: user.userId, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) });
    await expect(tenant.repository.createBrowserSession(tenant.context, { userId: user.userId, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) })).rejects.toBeTruthy();
    const [stored] = await client.db.select().from(browserSessions).where(eq(browserSessions.tokenHash, hash));
    expect(stored?.tokenHash).toBe(hash);
  });

  it("seeds the development tenant idempotently without credentials", async () => {
    await seedDevelopmentDatabase(databaseUrl!);
    await seedDevelopmentDatabase(databaseUrl!);
    const [organizationCount] = await client.db.select({ total: count() }).from(organizations);
    const [clientCount] = await client.db.select({ total: count() }).from(integrationClients);
    const [linkCount] = await client.db.select({ total: count() }).from(externalUserLinks);
    const [membershipCount] = await client.db.select({ total: count() }).from(organizationMemberships);
    const [userCount] = await client.db.select({ total: count() }).from(users);
    expect({
      organizations: organizationCount?.total,
      clients: clientCount?.total,
      links: linkCount?.total,
      memberships: membershipCount?.total,
      users: userCount?.total,
    }).toEqual({ organizations: 1, clients: 1, links: 3, memberships: 3, users: 3 });
  });
});

function andMembership(context: TenantContext, userId: string) {
  return sql`${organizationMemberships.organizationId} = ${context.organizationId} and ${organizationMemberships.userId} = ${userId}`;
}

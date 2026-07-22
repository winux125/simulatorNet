import { pathToFileURL } from "node:url";
import { createDatabase } from "./database";
import { AuthenticationLookupRepository } from "./repositories/auth-lookup";
import { PlatformAdminRepository } from "./repositories/platform-admin";
import { TenantRepository } from "./repositories/tenant";

export async function seedDevelopmentDatabase(databaseUrl: string): Promise<void> {
  const client = createDatabase({ connectionString: databaseUrl, applicationName: "simulatornet-dev-seed" });
  try {
    const platform = new PlatformAdminRepository(client.db);
    const authLookup = new AuthenticationLookupRepository(client.db);
    const existing = await platform.getOrganizationBySlug("kai-dev");
    const organization = existing ?? await platform.createOrganization({ slug: "kai-dev", name: "KAI Development" });
    const context = { organizationId: organization.id, actor: { kind: "system" as const, id: "dev-seed" } };
    const tenant = new TenantRepository(client.db);
    const bound = await authLookup.getIntegrationClientByKeycloakClientId("kai-platform-dev");
    const integration = bound?.integrationClient ?? await tenant.createIntegrationClientMapping(context, {
      keycloakClientId: "kai-platform-dev",
      name: "KAI Platform Development",
      allowedScopes: [
        "labs:validate",
        "launch:write",
        "memberships:write",
        "users:read",
        "users:write",
        "verifications:write",
      ],
      allowedReturnUrls: ["http://127.0.0.1:4173", "https://academy.kai.kz"],
    });
    if (integration.organizationId !== organization.id) throw new Error("kai-platform-dev belongs to another organization");

    const seeds = [
      { externalId: "seed-organization-admin", email: "admin@kai.example", displayName: "KAI Organization Admin", role: "organization_admin" as const },
      { externalId: "seed-instructor", email: "instructor@kai.example", displayName: "KAI Instructor", role: "instructor" as const },
      { externalId: "seed-student", email: "student@kai.example", displayName: "KAI Student", role: "student" as const },
    ];
    for (const seed of seeds) {
      const user = await tenant.upsertExternalUser(context, integration.id, seed.externalId, seed);
      await tenant.setOrganizationMembership(context, user.userId, seed.role);
    }
  } finally {
    await client.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for db:seed:dev");
  await seedDevelopmentDatabase(databaseUrl);
  console.log("Development tenant seed is ready (kai-dev / kai-platform-dev)");
}

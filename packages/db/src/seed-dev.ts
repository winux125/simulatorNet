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
    const existing = await platform.getOrganizationBySlug("demo-org");
    const organization = existing ?? await platform.createOrganization({ slug: "demo-org", name: "Demo Organization" });
    const context = { organizationId: organization.id, actor: { kind: "system" as const, id: "dev-seed" } };
    const tenant = new TenantRepository(client.db);
    const bound = await authLookup.getIntegrationClientByKeycloakClientId("external-platform-dev");
    const integration = bound?.integrationClient ?? await tenant.createIntegrationClientMapping(context, {
      keycloakClientId: "external-platform-dev",
      name: "External Platform Development",
      allowedScopes: [
        "labs:validate",
        "launch:write",
        "memberships:write",
        "users:read",
        "users:write",
        "verifications:write",
      ],
      allowedReturnUrls: ["http://127.0.0.1:4173", "https://academy.example.test"],
    });
    if (integration.organizationId !== organization.id) throw new Error("external-platform-dev belongs to another organization");

    const seeds = [
      { externalId: "seed-organization-admin", email: "admin@example.test", displayName: "Demo Organization Admin", role: "organization_admin" as const },
      { externalId: "seed-instructor", email: "instructor@example.test", displayName: "Demo Instructor", role: "instructor" as const },
      { externalId: "seed-student", email: "student@example.test", displayName: "Demo Student", role: "student" as const },
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
  console.log("Development tenant seed is ready (demo-org / external-platform-dev)");
}

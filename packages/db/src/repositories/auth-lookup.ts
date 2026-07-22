import { eq } from "drizzle-orm";
import type { SimulatorDatabase } from "../database";
import { browserSessions, integrationClients, launchCodes, organizations } from "../schema/index";

export interface IntegrationClientBinding {
  readonly integrationClient: typeof integrationClients.$inferSelect;
  readonly organization: typeof organizations.$inferSelect;
}

/** Global lookup used only to establish tenant identity from a verified OAuth client id. */
export class AuthenticationLookupRepository {
  constructor(private readonly database: SimulatorDatabase) {}

  async getIntegrationClientByKeycloakClientId(keycloakClientId: string): Promise<IntegrationClientBinding | undefined> {
    const [row] = await this.database.select({ integrationClient: integrationClients, organization: organizations })
      .from(integrationClients)
      .innerJoin(organizations, eq(integrationClients.organizationId, organizations.id))
      .where(eq(integrationClients.keycloakClientId, keycloakClientId))
      .limit(1);
    return row;
  }

  /** Finds only the tenant key needed before the tenant-scoped atomic consume. */
  async findLaunchCodeOrganizationId(codeHash: string): Promise<string | undefined> {
    const [row] = await this.database.select({ organizationId: launchCodes.organizationId })
      .from(launchCodes).where(eq(launchCodes.codeHash, codeHash)).limit(1);
    return row?.organizationId;
  }

  /** Finds only the tenant key needed before tenant-scoped session validation. */
  async findBrowserSessionOrganizationId(tokenHash: string): Promise<string | undefined> {
    const [row] = await this.database.select({ organizationId: browserSessions.organizationId })
      .from(browserSessions).where(eq(browserSessions.tokenHash, tokenHash)).limit(1);
    return row?.organizationId;
  }
}

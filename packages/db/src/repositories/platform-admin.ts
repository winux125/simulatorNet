import { eq, sql } from "drizzle-orm";
import type { SimulatorDatabase } from "../database";
import { DatabaseConflictError, hasPostgresErrorCode } from "../errors/index";
import { organizations, type OrganizationRecord } from "../schema/index";

export class PlatformAdminRepository {
  constructor(private readonly database: SimulatorDatabase) {}

  async createOrganization(input: { slug: string; name: string }): Promise<OrganizationRecord> {
    try {
      const [organization] = await this.database.insert(organizations).values({
        slug: input.slug.trim().toLowerCase(),
        name: input.name.trim(),
      }).returning();
      return organization!;
    } catch (error) {
      if (hasPostgresErrorCode(error, "23505")) throw new DatabaseConflictError("Organization slug already exists");
      throw error;
    }
  }

  async getOrganizationById(id: string): Promise<OrganizationRecord | undefined> {
    const [organization] = await this.database.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return organization;
  }

  async getOrganizationBySlug(slug: string): Promise<OrganizationRecord | undefined> {
    const [organization] = await this.database.select().from(organizations)
      .where(sql`lower(${organizations.slug}) = ${slug.trim().toLowerCase()}`).limit(1);
    return organization;
  }

  async setOrganizationStatus(id: string, status: "active" | "suspended"): Promise<OrganizationRecord | undefined> {
    const [organization] = await this.database.update(organizations)
      .set({ status, updatedAt: new Date() }).where(eq(organizations.id, id)).returning();
    return organization;
  }
}

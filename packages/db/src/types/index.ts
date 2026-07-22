import { z } from "zod";

export const OrganizationRoleSchema = z.enum(["platform_admin", "organization_admin", "instructor", "student"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const ServiceAssignableRoleSchema = z.enum(["organization_admin", "instructor", "student"]);
export type ServiceAssignableRole = z.infer<typeof ServiceAssignableRoleSchema>;

export const AuditActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("service"), id: z.string().min(1) }),
  z.object({ kind: z.literal("user"), id: z.string().uuid() }),
  z.object({ kind: z.literal("system"), id: z.string().min(1).optional() }),
]);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const TenantContextSchema = z.object({
  organizationId: z.string().uuid(),
  actor: AuditActorSchema,
});
export type TenantContext = z.infer<typeof TenantContextSchema>;

export const ExternalUserInputSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
});
export type ExternalUserInput = z.infer<typeof ExternalUserInputSchema>;

export interface ExternalUserRecord {
  readonly externalUserId: string;
  readonly integrationClientId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

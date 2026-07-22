import { sql } from "drizzle-orm";
import {
  char,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const organizationStatusEnum = pgEnum("organization_status", ["active", "suspended"]);
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);
export const membershipRoleEnum = pgEnum("organization_role", [
  "platform_admin",
  "organization_admin",
  "instructor",
  "student",
]);
export const membershipStatusEnum = pgEnum("membership_status", ["active", "inactive"]);
export const integrationClientStatusEnum = pgEnum("integration_client_status", ["active", "disabled"]);
export const auditActorTypeEnum = pgEnum("audit_actor_type", ["service", "user", "system"]);

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: organizationStatusEnum("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  uniqueIndex("organizations_slug_lower_unique").on(sql`lower(${table.slug})`),
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  status: userStatusEnum("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("users_email_lower_idx").on(sql`lower(${table.email})`) ]);

export const userIdentities = pgTable("user_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique("user_identities_issuer_subject_unique").on(table.issuer, table.subject),
  index("user_identities_user_idx").on(table.userId),
]);

export const organizationMemberships = pgTable("organization_memberships", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: membershipRoleEnum("role").notNull(),
  status: membershipStatusEnum("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  primaryKey({ name: "organization_memberships_pk", columns: [table.organizationId, table.userId] }),
  index("organization_memberships_user_idx").on(table.userId),
]);

export const integrationClients = pgTable("integration_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  keycloakClientId: text("keycloak_client_id").notNull().unique("integration_clients_keycloak_client_id_unique"),
  name: text("name").notNull(),
  status: integrationClientStatusEnum("status").notNull().default("active"),
  allowedScopes: jsonb("allowed_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  allowedReturnUrls: jsonb("allowed_return_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("integration_clients_organization_id_id_unique").on(table.organizationId, table.id),
  index("integration_clients_organization_idx").on(table.organizationId),
]);

export const externalUserLinks = pgTable("external_user_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  integrationClientId: uuid("integration_client_id").notNull().references(() => integrationClients.id, { onDelete: "cascade" }),
  externalUserId: text("external_user_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  unique("external_user_links_client_external_unique").on(table.integrationClientId, table.externalUserId),
  index("external_user_links_user_idx").on(table.userId),
]);

export const launchCodes = pgTable("launch_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  integrationClientId: uuid("integration_client_id").notNull(),
  codeHash: char("code_hash", { length: 64 }).notNull().unique("launch_codes_hash_unique"),
  returnUrl: text("return_url").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({
    name: "launch_codes_organization_client_fk",
    columns: [table.organizationId, table.integrationClientId],
    foreignColumns: [integrationClients.organizationId, integrationClients.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "launch_codes_organization_user_fk",
    columns: [table.organizationId, table.userId],
    foreignColumns: [organizationMemberships.organizationId, organizationMemberships.userId],
  }).onDelete("cascade"),
  index("launch_codes_organization_idx").on(table.organizationId),
  index("launch_codes_expires_idx").on(table.expiresAt),
]);

export const browserSessions = pgTable("browser_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: char("token_hash", { length: 64 }).notNull().unique("browser_sessions_token_hash_unique"),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({
    name: "browser_sessions_organization_user_fk",
    columns: [table.organizationId, table.userId],
    foreignColumns: [organizationMemberships.organizationId, organizationMemberships.userId],
  }).onDelete("cascade"),
  index("browser_sessions_organization_idx").on(table.organizationId),
  index("browser_sessions_expires_idx").on(table.expiresAt),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  actorType: auditActorTypeEnum("actor_type").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  requestId: text("request_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}, (table) => [
  index("audit_events_organization_created_idx").on(table.organizationId, table.createdAt),
  index("audit_events_action_idx").on(table.action),
]);

export type OrganizationRecord = typeof organizations.$inferSelect;
export type UserRecord = typeof users.$inferSelect;
export type MembershipRecord = typeof organizationMemberships.$inferSelect;
export type IntegrationClientRecord = typeof integrationClients.$inferSelect;
export type ExternalUserLinkRecord = typeof externalUserLinks.$inferSelect;
export type LaunchCodeRecord = typeof launchCodes.$inferSelect;
export type BrowserSessionRecord = typeof browserSessions.$inferSelect;
export type AuditEventRecord = typeof auditEvents.$inferSelect;

// Academic model (templates, versions, grading specs, assignments, instances,
// submissions, results). Re-exported last so the base tables above are already
// defined when academic.ts imports them.
export * from "./academic";

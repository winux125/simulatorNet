import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { LabDocument } from "@sim/contracts";
import type { GradingSpec, VerificationResult } from "@sim/contracts/grading";
import { organizationMemberships, organizations, users } from "./index";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const labTemplateStatusEnum = pgEnum("lab_template_status", ["draft", "published", "archived"]);
export const assignmentStatusEnum = pgEnum("assignment_status", ["draft", "published", "closed", "archived"]);
export const assignmentStudentStatusEnum = pgEnum("assignment_student_status", ["assigned", "active", "completed", "removed"]);
export const labInstanceStatusEnum = pgEnum("lab_instance_status", ["not_started", "in_progress", "submitted", "completed", "locked"]);
export const submissionStatusEnum = pgEnum("submission_status", ["pending", "verifying", "verified", "failed"]);

/** Stable logical template. Concrete lab content lives in immutable versions. */
export const labTemplates = pgTable("lab_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: labTemplateStatusEnum("status").notNull().default("draft"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  // Composite key that child tables reference so a tenant edge can never be forged.
  unique("lab_templates_organization_id_id_unique").on(table.organizationId, table.id),
  index("lab_templates_organization_idx").on(table.organizationId),
]);

/** Immutable, hashed snapshot of a canonical LabDocument. */
export const labTemplateVersions = pgTable("lab_template_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  labTemplateId: uuid("lab_template_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  labDocument: jsonb("lab_document").$type<LabDocument>().notNull(),
  canonicalHash: char("canonical_hash", { length: 64 }).notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "lab_template_versions_template_fk",
    columns: [table.organizationId, table.labTemplateId],
    foreignColumns: [labTemplates.organizationId, labTemplates.id],
  }).onDelete("cascade"),
  unique("lab_template_versions_template_version_unique").on(table.labTemplateId, table.versionNumber),
  unique("lab_template_versions_organization_id_id_unique").on(table.organizationId, table.id),
  index("lab_template_versions_template_idx").on(table.labTemplateId),
  index("lab_template_versions_organization_idx").on(table.organizationId),
]);

/** Hidden grading rules, append-only and never exposed to a student surface. */
export const gradingSpecs = pgTable("grading_specs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  labTemplateVersionId: uuid("lab_template_version_id").notNull(),
  gradingSpec: jsonb("grading_spec").$type<GradingSpec>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "grading_specs_version_fk",
    columns: [table.organizationId, table.labTemplateVersionId],
    foreignColumns: [labTemplateVersions.organizationId, labTemplateVersions.id],
  }).onDelete("cascade"),
  index("grading_specs_version_idx").on(table.labTemplateVersionId),
  index("grading_specs_organization_idx").on(table.organizationId),
]);

export const assignments = pgTable("assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  labTemplateVersionId: uuid("lab_template_version_id").notNull(),
  title: text("title").notNull(),
  instructions: text("instructions"),
  status: assignmentStatusEnum("status").notNull().default("draft"),
  availableFrom: timestamp("available_from", { withTimezone: true, mode: "date" }),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
  maximumAttempts: integer("maximum_attempts"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({
    name: "assignments_template_version_fk",
    columns: [table.organizationId, table.labTemplateVersionId],
    foreignColumns: [labTemplateVersions.organizationId, labTemplateVersions.id],
  }).onDelete("restrict"),
  unique("assignments_organization_id_id_unique").on(table.organizationId, table.id),
  check("assignments_maximum_attempts_positive", sql`${table.maximumAttempts} is null or ${table.maximumAttempts} > 0`),
  index("assignments_organization_idx").on(table.organizationId),
  index("assignments_template_version_idx").on(table.labTemplateVersionId),
]);

export const assignmentStudents = pgTable("assignment_students", {
  organizationId: uuid("organization_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  studentUserId: uuid("student_user_id").notNull(),
  status: assignmentStudentStatusEnum("status").notNull().default("assigned"),
  assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  primaryKey({ name: "assignment_students_pk", columns: [table.assignmentId, table.studentUserId] }),
  foreignKey({
    name: "assignment_students_assignment_fk",
    columns: [table.organizationId, table.assignmentId],
    foreignColumns: [assignments.organizationId, assignments.id],
  }).onDelete("cascade"),
  // A student can only be assigned if they are a member of the same organization.
  foreignKey({
    name: "assignment_students_membership_fk",
    columns: [table.organizationId, table.studentUserId],
    foreignColumns: [organizationMemberships.organizationId, organizationMemberships.userId],
  }).onDelete("cascade"),
  index("assignment_students_student_idx").on(table.organizationId, table.studentUserId),
]);

export const labInstances = pgTable("lab_instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  studentUserId: uuid("student_user_id").notNull(),
  currentDocument: jsonb("current_document").$type<LabDocument>().notNull(),
  canonicalHash: char("canonical_hash", { length: 64 }).notNull(),
  revision: integer("revision").notNull().default(1),
  status: labInstanceStatusEnum("status").notNull().default("in_progress"),
  createdAt: createdAt(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  lastSavedAt: timestamp("last_saved_at", { withTimezone: true, mode: "date" }),
  submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    name: "lab_instances_assignment_fk",
    columns: [table.organizationId, table.assignmentId],
    foreignColumns: [assignments.organizationId, assignments.id],
  }).onDelete("cascade"),
  // Only an assigned student may hold an instance for the assignment.
  foreignKey({
    name: "lab_instances_assignment_student_fk",
    columns: [table.assignmentId, table.studentUserId],
    foreignColumns: [assignmentStudents.assignmentId, assignmentStudents.studentUserId],
  }).onDelete("cascade"),
  unique("lab_instances_assignment_student_unique").on(table.assignmentId, table.studentUserId),
  unique("lab_instances_organization_id_id_unique").on(table.organizationId, table.id),
  index("lab_instances_organization_idx").on(table.organizationId),
]);

/** Immutable canonical snapshot captured at submit time. */
export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  labInstanceId: uuid("lab_instance_id").notNull(),
  assignmentId: uuid("assignment_id").notNull(),
  studentUserId: uuid("student_user_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  labDocument: jsonb("lab_document").$type<LabDocument>().notNull(),
  canonicalHash: char("canonical_hash", { length: 64 }).notNull(),
  status: submissionStatusEnum("status").notNull().default("pending"),
  submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  verificationStartedAt: timestamp("verification_started_at", { withTimezone: true, mode: "date" }),
  verificationCompletedAt: timestamp("verification_completed_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  foreignKey({
    name: "submissions_lab_instance_fk",
    columns: [table.organizationId, table.labInstanceId],
    foreignColumns: [labInstances.organizationId, labInstances.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "submissions_assignment_fk",
    columns: [table.organizationId, table.assignmentId],
    foreignColumns: [assignments.organizationId, assignments.id],
  }).onDelete("cascade"),
  unique("submissions_instance_attempt_unique").on(table.labInstanceId, table.attemptNumber),
  unique("submissions_organization_id_id_unique").on(table.organizationId, table.id),
  index("submissions_assignment_idx").on(table.organizationId, table.assignmentId),
  index("submissions_student_idx").on(table.organizationId, table.studentUserId),
]);

/** Server-computed verification result. Student and instructor views are separated. */
export const submissionResults = pgTable("submission_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  submissionId: uuid("submission_id").notNull(),
  verificationId: text("verification_id").notNull(),
  score: doublePrecision("score").notNull(),
  awardedPoints: doublePrecision("awarded_points").notNull(),
  maximumPoints: doublePrecision("maximum_points").notNull(),
  studentResult: jsonb("student_result").$type<VerificationResult>().notNull(),
  instructorResult: jsonb("instructor_result").$type<VerificationResult>().notNull(),
  engineSchemaVersion: integer("engine_schema_version").notNull(),
  engineVersion: text("engine_version").notNull(),
  processedEvents: integer("processed_events").notNull(),
  virtualTimeNs: bigint("virtual_time_ns", { mode: "number" }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    name: "submission_results_submission_fk",
    columns: [table.organizationId, table.submissionId],
    foreignColumns: [submissions.organizationId, submissions.id],
  }).onDelete("cascade"),
  unique("submission_results_submission_unique").on(table.submissionId),
  index("submission_results_organization_idx").on(table.organizationId),
]);

export type LabTemplateRecord = typeof labTemplates.$inferSelect;
export type LabTemplateVersionRecord = typeof labTemplateVersions.$inferSelect;
export type GradingSpecRecord = typeof gradingSpecs.$inferSelect;
export type AssignmentRecord = typeof assignments.$inferSelect;
export type AssignmentStudentRecord = typeof assignmentStudents.$inferSelect;
export type LabInstanceRecord = typeof labInstances.$inferSelect;
export type SubmissionRecord = typeof submissions.$inferSelect;
export type SubmissionResultRecord = typeof submissionResults.$inferSelect;

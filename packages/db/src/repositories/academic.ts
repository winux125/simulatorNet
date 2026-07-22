import { and, desc, eq, gte, lte, max, ne, sql } from "drizzle-orm";
import type { SimulatorDatabase } from "../database";
import {
  DatabaseConflictError,
  DatabaseForbiddenError,
  DatabaseLimitReachedError,
  DatabaseNotFoundError,
  DatabaseRevisionConflictError,
  hasPostgresErrorCode,
} from "../errors/index";
import {
  assignments,
  assignmentStudents,
  gradingSpecs,
  labInstances,
  labTemplates,
  labTemplateVersions,
  organizationMemberships,
  submissionResults,
  submissions,
  type AssignmentRecord,
  type AssignmentStudentRecord,
  type GradingSpecRecord,
  type LabInstanceRecord,
  type LabTemplateRecord,
  type LabTemplateVersionRecord,
  type SubmissionRecord,
  type SubmissionResultRecord,
} from "../schema/index";
import { TenantContextSchema, type TenantContext } from "../types/index";
import { canonicalizeLab, validateGradingSpec } from "../academic/canonical";
import {
  CreateAssignmentInputSchema,
  CreateLabTemplateInputSchema,
  UpdateDraftAssignmentInputSchema,
  type AssignmentSubmissionFilter,
  type CreateAssignmentInput,
  type CreateLabTemplateInput,
  type SubmissionResultInput,
  type SubmissionResultView,
  type UpdateDraftAssignmentInput,
} from "../academic/types";
import type { VerificationResult } from "@sim/contracts/grading";

function tenant(context: TenantContext): TenantContext {
  return TenantContextSchema.parse(context);
}

export interface SubmissionResultProjection {
  readonly id: string;
  readonly submissionId: string;
  readonly verificationId: string;
  readonly score: number;
  readonly awardedPoints: number;
  readonly maximumPoints: number;
  readonly view: SubmissionResultView;
  readonly result: VerificationResult;
  readonly engineSchemaVersion: number;
  readonly engineVersion: string;
  readonly processedEvents: number;
  readonly virtualTimeNs: number;
  readonly createdAt: Date;
}

export type AssignmentSubmissionRow = SubmissionRecord & { readonly score: number | null };

export class AcademicRepository {
  constructor(private readonly database: SimulatorDatabase) {}

  // --- Lab templates -------------------------------------------------------

  async createLabTemplate(context: TenantContext, rawInput: CreateLabTemplateInput): Promise<LabTemplateRecord> {
    const scope = tenant(context);
    const input = CreateLabTemplateInputSchema.parse(rawInput);
    const [row] = await this.database.insert(labTemplates).values({
      organizationId: scope.organizationId,
      title: input.title,
      description: input.description,
      createdByUserId: input.createdByUserId,
    }).returning();
    return row!;
  }

  async getLabTemplate(context: TenantContext, templateId: string): Promise<LabTemplateRecord | undefined> {
    const scope = tenant(context);
    const [row] = await this.database.select().from(labTemplates).where(and(
      eq(labTemplates.id, templateId),
      eq(labTemplates.organizationId, scope.organizationId),
    )).limit(1);
    return row;
  }

  async listLabTemplates(context: TenantContext): Promise<LabTemplateRecord[]> {
    const scope = tenant(context);
    return this.database.select().from(labTemplates)
      .where(eq(labTemplates.organizationId, scope.organizationId))
      .orderBy(desc(labTemplates.createdAt));
  }

  async archiveLabTemplate(context: TenantContext, templateId: string): Promise<LabTemplateRecord> {
    const scope = tenant(context);
    const [row] = await this.database.update(labTemplates)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(labTemplates.id, templateId), eq(labTemplates.organizationId, scope.organizationId)))
      .returning();
    if (!row) throw new DatabaseNotFoundError("Lab template was not found in this organization");
    return row;
  }

  // --- Lab template versions (immutable) -----------------------------------

  async createLabTemplateVersion(
    context: TenantContext,
    templateId: string,
    input: { labDocument: unknown; createdByUserId?: string },
  ): Promise<LabTemplateVersionRecord> {
    const scope = tenant(context);
    const canonical = canonicalizeLab(input.labDocument);
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${templateId}, 0))`);
      const [template] = await tx.select({ id: labTemplates.id, status: labTemplates.status }).from(labTemplates).where(and(
        eq(labTemplates.id, templateId),
        eq(labTemplates.organizationId, scope.organizationId),
      )).limit(1);
      if (!template) throw new DatabaseNotFoundError("Lab template was not found in this organization");
      const [aggregate] = await tx.select({ maxVersion: max(labTemplateVersions.versionNumber) }).from(labTemplateVersions).where(and(
        eq(labTemplateVersions.labTemplateId, templateId),
        eq(labTemplateVersions.organizationId, scope.organizationId),
      ));
      const versionNumber = (aggregate?.maxVersion ?? 0) + 1;
      const [row] = await tx.insert(labTemplateVersions).values({
        organizationId: scope.organizationId,
        labTemplateId: templateId,
        versionNumber,
        schemaVersion: canonical.schemaVersion,
        labDocument: canonical.document,
        canonicalHash: canonical.canonicalHash,
        createdByUserId: input.createdByUserId,
      }).returning();
      if (template.status === "draft") {
        await tx.update(labTemplates).set({ status: "published", updatedAt: new Date() }).where(eq(labTemplates.id, templateId));
      }
      return row!;
    });
  }

  async getLabTemplateVersion(context: TenantContext, versionId: string): Promise<LabTemplateVersionRecord | undefined> {
    const scope = tenant(context);
    const [row] = await this.database.select().from(labTemplateVersions).where(and(
      eq(labTemplateVersions.id, versionId),
      eq(labTemplateVersions.organizationId, scope.organizationId),
    )).limit(1);
    return row;
  }

  async listLabTemplateVersions(context: TenantContext, templateId: string): Promise<LabTemplateVersionRecord[]> {
    const scope = tenant(context);
    return this.database.select().from(labTemplateVersions).where(and(
      eq(labTemplateVersions.labTemplateId, templateId),
      eq(labTemplateVersions.organizationId, scope.organizationId),
    )).orderBy(desc(labTemplateVersions.versionNumber));
  }

  // --- Grading specs (server-only, append-only) ----------------------------

  async createGradingSpec(
    context: TenantContext,
    versionId: string,
    input: { gradingSpec: unknown; createdByUserId?: string },
  ): Promise<GradingSpecRecord> {
    const scope = tenant(context);
    const spec = validateGradingSpec(input.gradingSpec);
    const [version] = await this.database.select({ id: labTemplateVersions.id }).from(labTemplateVersions).where(and(
      eq(labTemplateVersions.id, versionId),
      eq(labTemplateVersions.organizationId, scope.organizationId),
    )).limit(1);
    if (!version) throw new DatabaseNotFoundError("Lab template version was not found in this organization");
    const [row] = await this.database.insert(gradingSpecs).values({
      organizationId: scope.organizationId,
      labTemplateVersionId: versionId,
      gradingSpec: spec,
      createdByUserId: input.createdByUserId,
    }).returning();
    return row!;
  }

  async getGradingSpecForTemplateVersion(context: TenantContext, versionId: string): Promise<GradingSpecRecord | undefined> {
    const scope = tenant(context);
    const [row] = await this.database.select().from(gradingSpecs).where(and(
      eq(gradingSpecs.labTemplateVersionId, versionId),
      eq(gradingSpecs.organizationId, scope.organizationId),
    )).orderBy(desc(gradingSpecs.createdAt), desc(gradingSpecs.id)).limit(1);
    return row;
  }

  // --- Assignments ---------------------------------------------------------

  async createAssignment(context: TenantContext, rawInput: CreateAssignmentInput): Promise<AssignmentRecord> {
    const scope = tenant(context);
    const input = CreateAssignmentInputSchema.parse(rawInput);
    const [version] = await this.database.select({ id: labTemplateVersions.id }).from(labTemplateVersions).where(and(
      eq(labTemplateVersions.id, input.labTemplateVersionId),
      eq(labTemplateVersions.organizationId, scope.organizationId),
    )).limit(1);
    if (!version) throw new DatabaseNotFoundError("Lab template version was not found in this organization");
    const [row] = await this.database.insert(assignments).values({
      organizationId: scope.organizationId,
      labTemplateVersionId: input.labTemplateVersionId,
      title: input.title,
      instructions: input.instructions,
      availableFrom: input.availableFrom,
      dueAt: input.dueAt,
      maximumAttempts: input.maximumAttempts ?? null,
      createdByUserId: input.createdByUserId,
    }).returning();
    return row!;
  }

  async updateDraftAssignment(context: TenantContext, assignmentId: string, rawPatch: UpdateDraftAssignmentInput): Promise<AssignmentRecord> {
    const scope = tenant(context);
    const patch = UpdateDraftAssignmentInputSchema.parse(rawPatch);
    return this.database.transaction(async (tx) => {
      const [existing] = await tx.select({ status: assignments.status }).from(assignments).where(and(
        eq(assignments.id, assignmentId),
        eq(assignments.organizationId, scope.organizationId),
      )).limit(1);
      if (!existing) throw new DatabaseNotFoundError("Assignment was not found in this organization");
      if (existing.status !== "draft") throw new DatabaseConflictError("Only draft assignments can be edited");
      const set: Partial<typeof assignments.$inferInsert> = { updatedAt: new Date() };
      if (patch.title !== undefined) set.title = patch.title;
      if ("instructions" in patch) set.instructions = patch.instructions ?? null;
      if ("availableFrom" in patch) set.availableFrom = patch.availableFrom ?? null;
      if ("dueAt" in patch) set.dueAt = patch.dueAt ?? null;
      if ("maximumAttempts" in patch) set.maximumAttempts = patch.maximumAttempts ?? null;
      const [row] = await tx.update(assignments).set(set).where(and(
        eq(assignments.id, assignmentId),
        eq(assignments.organizationId, scope.organizationId),
        eq(assignments.status, "draft"),
      )).returning();
      return row!;
    });
  }

  async publishAssignment(context: TenantContext, assignmentId: string): Promise<AssignmentRecord> {
    const scope = tenant(context);
    return this.database.transaction(async (tx) => {
      const [existing] = await tx.select({ status: assignments.status }).from(assignments).where(and(
        eq(assignments.id, assignmentId),
        eq(assignments.organizationId, scope.organizationId),
      )).limit(1);
      if (!existing) throw new DatabaseNotFoundError("Assignment was not found in this organization");
      if (existing.status !== "draft") throw new DatabaseConflictError("Only draft assignments can be published");
      const [row] = await tx.update(assignments).set({
        status: "published",
        publishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(assignments.id, assignmentId), eq(assignments.organizationId, scope.organizationId), eq(assignments.status, "draft"))).returning();
      return row!;
    });
  }

  async closeAssignment(context: TenantContext, assignmentId: string): Promise<AssignmentRecord> {
    const scope = tenant(context);
    return this.database.transaction(async (tx) => {
      const [existing] = await tx.select({ status: assignments.status }).from(assignments).where(and(
        eq(assignments.id, assignmentId),
        eq(assignments.organizationId, scope.organizationId),
      )).limit(1);
      if (!existing) throw new DatabaseNotFoundError("Assignment was not found in this organization");
      if (existing.status === "archived") throw new DatabaseConflictError("Archived assignments cannot be closed");
      const [row] = await tx.update(assignments).set({
        status: "closed",
        closedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(assignments.id, assignmentId), eq(assignments.organizationId, scope.organizationId))).returning();
      return row!;
    });
  }

  async getAssignment(context: TenantContext, assignmentId: string): Promise<AssignmentRecord | undefined> {
    const scope = tenant(context);
    const [row] = await this.database.select().from(assignments).where(and(
      eq(assignments.id, assignmentId),
      eq(assignments.organizationId, scope.organizationId),
    )).limit(1);
    return row;
  }

  async listAssignments(context: TenantContext): Promise<AssignmentRecord[]> {
    const scope = tenant(context);
    return this.database.select().from(assignments)
      .where(eq(assignments.organizationId, scope.organizationId))
      .orderBy(desc(assignments.createdAt));
  }

  // --- Assignment students -------------------------------------------------

  async assignStudent(context: TenantContext, assignmentId: string, studentUserId: string): Promise<AssignmentStudentRecord> {
    const scope = tenant(context);
    return this.database.transaction(async (tx) => {
      const [assignment] = await tx.select({ id: assignments.id }).from(assignments).where(and(
        eq(assignments.id, assignmentId),
        eq(assignments.organizationId, scope.organizationId),
      )).limit(1);
      if (!assignment) throw new DatabaseNotFoundError("Assignment was not found in this organization");
      const [membership] = await tx.select({ role: organizationMemberships.role, status: organizationMemberships.status })
        .from(organizationMemberships).where(and(
          eq(organizationMemberships.organizationId, scope.organizationId),
          eq(organizationMemberships.userId, studentUserId),
        )).limit(1);
      if (!membership || membership.status !== "active" || membership.role !== "student") {
        throw new DatabaseNotFoundError("An active student membership is required in this organization");
      }
      const [row] = await tx.insert(assignmentStudents).values({
        organizationId: scope.organizationId,
        assignmentId,
        studentUserId,
        status: "assigned",
      }).onConflictDoUpdate({
        target: [assignmentStudents.assignmentId, assignmentStudents.studentUserId],
        set: { status: "assigned", removedAt: null },
      }).returning();
      return row!;
    });
  }

  async removeStudentAssignment(context: TenantContext, assignmentId: string, studentUserId: string): Promise<AssignmentStudentRecord> {
    const scope = tenant(context);
    const [row] = await this.database.update(assignmentStudents).set({
      status: "removed",
      removedAt: new Date(),
    }).where(and(
      eq(assignmentStudents.organizationId, scope.organizationId),
      eq(assignmentStudents.assignmentId, assignmentId),
      eq(assignmentStudents.studentUserId, studentUserId),
    )).returning();
    if (!row) throw new DatabaseNotFoundError("Assignment student was not found in this organization");
    return row;
  }

  async listAssignmentStudents(context: TenantContext, assignmentId: string): Promise<AssignmentStudentRecord[]> {
    const scope = tenant(context);
    return this.database.select().from(assignmentStudents).where(and(
      eq(assignmentStudents.organizationId, scope.organizationId),
      eq(assignmentStudents.assignmentId, assignmentId),
    )).orderBy(assignmentStudents.assignedAt);
  }

  /** Published assignments the student is currently assigned to (not removed). */
  async listStudentAssignments(context: TenantContext, studentUserId: string): Promise<AssignmentRecord[]> {
    const scope = tenant(context);
    const rows = await this.database.select({ assignment: assignments })
      .from(assignmentStudents)
      .innerJoin(assignments, and(
        eq(assignments.id, assignmentStudents.assignmentId),
        eq(assignments.organizationId, assignmentStudents.organizationId),
      ))
      .where(and(
        eq(assignmentStudents.organizationId, scope.organizationId),
        eq(assignmentStudents.studentUserId, studentUserId),
        ne(assignmentStudents.status, "removed"),
        eq(assignments.status, "published"),
      )).orderBy(desc(assignments.createdAt));
    return rows.map((row) => row.assignment);
  }

  /** A single assignment the student is assigned to, regardless of availability. */
  async getStudentAssignment(context: TenantContext, assignmentId: string, studentUserId: string): Promise<AssignmentRecord | undefined> {
    const scope = tenant(context);
    const [row] = await this.database.select({ assignment: assignments })
      .from(assignmentStudents)
      .innerJoin(assignments, and(
        eq(assignments.id, assignmentStudents.assignmentId),
        eq(assignments.organizationId, assignmentStudents.organizationId),
      ))
      .where(and(
        eq(assignmentStudents.organizationId, scope.organizationId),
        eq(assignmentStudents.assignmentId, assignmentId),
        eq(assignmentStudents.studentUserId, studentUserId),
        ne(assignmentStudents.status, "removed"),
      )).limit(1);
    return row?.assignment;
  }

  // --- Lab instances -------------------------------------------------------

  async getOrCreateStudentLabInstance(context: TenantContext, assignmentId: string, studentUserId: string): Promise<LabInstanceRecord> {
    const scope = tenant(context);
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${assignmentId}:${studentUserId}`}, 0))`);
      const [existing] = await tx.select().from(labInstances).where(and(
        eq(labInstances.organizationId, scope.organizationId),
        eq(labInstances.assignmentId, assignmentId),
        eq(labInstances.studentUserId, studentUserId),
      )).limit(1);
      if (existing) return existing;
      const [assignment] = await tx.select({ versionId: assignments.labTemplateVersionId }).from(assignments).where(and(
        eq(assignments.id, assignmentId),
        eq(assignments.organizationId, scope.organizationId),
      )).limit(1);
      if (!assignment) throw new DatabaseNotFoundError("Assignment was not found in this organization");
      const [assigned] = await tx.select({ status: assignmentStudents.status }).from(assignmentStudents).where(and(
        eq(assignmentStudents.assignmentId, assignmentId),
        eq(assignmentStudents.studentUserId, studentUserId),
      )).limit(1);
      if (!assigned || assigned.status === "removed") {
        throw new DatabaseForbiddenError("Student is not assigned to this assignment");
      }
      const [version] = await tx.select({ document: labTemplateVersions.labDocument, hash: labTemplateVersions.canonicalHash })
        .from(labTemplateVersions).where(and(
          eq(labTemplateVersions.id, assignment.versionId),
          eq(labTemplateVersions.organizationId, scope.organizationId),
        )).limit(1);
      if (!version) throw new DatabaseNotFoundError("Lab template version was not found in this organization");
      const now = new Date();
      const [row] = await tx.insert(labInstances).values({
        organizationId: scope.organizationId,
        assignmentId,
        studentUserId,
        currentDocument: version.document,
        canonicalHash: version.hash,
        revision: 1,
        status: "in_progress",
        startedAt: now,
        lastSavedAt: now,
      }).returning();
      return row!;
    });
  }

  async getStudentLabInstance(context: TenantContext, instanceId: string, studentUserId: string): Promise<LabInstanceRecord | undefined> {
    const scope = tenant(context);
    const [row] = await this.database.select().from(labInstances).where(and(
      eq(labInstances.id, instanceId),
      eq(labInstances.organizationId, scope.organizationId),
      eq(labInstances.studentUserId, studentUserId),
    )).limit(1);
    return row;
  }

  async saveStudentLabInstance(
    context: TenantContext,
    instanceId: string,
    studentUserId: string,
    input: { expectedRevision: number; document: unknown },
  ): Promise<LabInstanceRecord> {
    const scope = tenant(context);
    const canonical = canonicalizeLab(input.document);
    return this.database.transaction(async (tx) => {
      const [row] = await tx.update(labInstances).set({
        currentDocument: canonical.document,
        canonicalHash: canonical.canonicalHash,
        revision: sql`${labInstances.revision} + 1`,
        status: "in_progress",
        lastSavedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(labInstances.id, instanceId),
        eq(labInstances.organizationId, scope.organizationId),
        eq(labInstances.studentUserId, studentUserId),
        eq(labInstances.revision, input.expectedRevision),
        ne(labInstances.status, "locked"),
      )).returning();
      if (row) return row;
      const [current] = await tx.select({ revision: labInstances.revision, status: labInstances.status }).from(labInstances).where(and(
        eq(labInstances.id, instanceId),
        eq(labInstances.organizationId, scope.organizationId),
        eq(labInstances.studentUserId, studentUserId),
      )).limit(1);
      if (!current) throw new DatabaseNotFoundError("Lab instance was not found");
      if (current.status === "locked") throw new DatabaseConflictError("Lab instance is locked");
      throw new DatabaseRevisionConflictError("Lab instance revision conflict", current.revision);
    });
  }

  // --- Submissions (immutable) ---------------------------------------------

  async createSubmission(context: TenantContext, instanceId: string, studentUserId: string): Promise<SubmissionRecord> {
    const scope = tenant(context);
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${instanceId}, 0))`);
      const [instance] = await tx.select({
        assignmentId: labInstances.assignmentId,
        currentDocument: labInstances.currentDocument,
        canonicalHash: labInstances.canonicalHash,
      }).from(labInstances).where(and(
        eq(labInstances.id, instanceId),
        eq(labInstances.organizationId, scope.organizationId),
        eq(labInstances.studentUserId, studentUserId),
      )).limit(1);
      if (!instance) throw new DatabaseNotFoundError("Lab instance was not found");
      const [assignment] = await tx.select({ maximumAttempts: assignments.maximumAttempts })
        .from(assignments).where(and(eq(assignments.id, instance.assignmentId), eq(assignments.organizationId, scope.organizationId))).limit(1);
      const [aggregate] = await tx.select({ maxAttempt: max(submissions.attemptNumber) }).from(submissions).where(eq(submissions.labInstanceId, instanceId));
      const attemptNumber = (aggregate?.maxAttempt ?? 0) + 1;
      if (assignment?.maximumAttempts != null && attemptNumber > assignment.maximumAttempts) {
        throw new DatabaseLimitReachedError("Submission attempt limit reached");
      }
      const [row] = await tx.insert(submissions).values({
        organizationId: scope.organizationId,
        labInstanceId: instanceId,
        assignmentId: instance.assignmentId,
        studentUserId,
        attemptNumber,
        labDocument: instance.currentDocument,
        canonicalHash: instance.canonicalHash,
        status: "pending",
      }).returning();
      await tx.update(labInstances).set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() }).where(eq(labInstances.id, instanceId));
      return row!;
    });
  }

  async getSubmission(context: TenantContext, submissionId: string, studentUserId?: string): Promise<SubmissionRecord | undefined> {
    const scope = tenant(context);
    const filters = [eq(submissions.id, submissionId), eq(submissions.organizationId, scope.organizationId)];
    if (studentUserId) filters.push(eq(submissions.studentUserId, studentUserId));
    const [row] = await this.database.select().from(submissions).where(and(...filters)).limit(1);
    return row;
  }

  async listStudentSubmissions(context: TenantContext, instanceId: string, studentUserId: string): Promise<SubmissionRecord[]> {
    const scope = tenant(context);
    return this.database.select().from(submissions).where(and(
      eq(submissions.organizationId, scope.organizationId),
      eq(submissions.labInstanceId, instanceId),
      eq(submissions.studentUserId, studentUserId),
    )).orderBy(desc(submissions.attemptNumber));
  }

  async markSubmissionVerifying(context: TenantContext, submissionId: string): Promise<void> {
    const scope = tenant(context);
    await this.database.update(submissions).set({ status: "verifying", verificationStartedAt: new Date() }).where(and(
      eq(submissions.id, submissionId),
      eq(submissions.organizationId, scope.organizationId),
    ));
  }

  async markSubmissionFailed(context: TenantContext, submissionId: string): Promise<void> {
    const scope = tenant(context);
    await this.database.update(submissions).set({ status: "failed", verificationCompletedAt: new Date() }).where(and(
      eq(submissions.id, submissionId),
      eq(submissions.organizationId, scope.organizationId),
    ));
  }

  async saveSubmissionResult(context: TenantContext, submissionId: string, input: SubmissionResultInput): Promise<SubmissionResultRecord> {
    const scope = tenant(context);
    return this.database.transaction(async (tx) => {
      const [submission] = await tx.select({ id: submissions.id }).from(submissions).where(and(
        eq(submissions.id, submissionId),
        eq(submissions.organizationId, scope.organizationId),
      )).limit(1);
      if (!submission) throw new DatabaseNotFoundError("Submission was not found in this organization");
      let row: SubmissionResultRecord | undefined;
      try {
        [row] = await tx.insert(submissionResults).values({
          organizationId: scope.organizationId,
          submissionId,
          verificationId: input.verificationId,
          score: input.score,
          awardedPoints: input.awardedPoints,
          maximumPoints: input.maximumPoints,
          studentResult: input.studentResult,
          instructorResult: input.instructorResult,
          engineSchemaVersion: input.engineSchemaVersion,
          engineVersion: input.engineVersion,
          processedEvents: input.processedEvents,
          virtualTimeNs: input.virtualTimeNs,
        }).returning();
      } catch (error) {
        if (hasPostgresErrorCode(error, "23505")) throw new DatabaseConflictError("A result already exists for this submission");
        throw error;
      }
      await tx.update(submissions).set({ status: "verified", verificationCompletedAt: new Date() }).where(eq(submissions.id, submissionId));
      return row!;
    });
  }

  async getSubmissionResult(context: TenantContext, submissionId: string, view: SubmissionResultView = "student"): Promise<SubmissionResultProjection | undefined> {
    const scope = tenant(context);
    const [row] = await this.database.select().from(submissionResults).where(and(
      eq(submissionResults.submissionId, submissionId),
      eq(submissionResults.organizationId, scope.organizationId),
    )).limit(1);
    if (!row) return undefined;
    return {
      id: row.id,
      submissionId: row.submissionId,
      verificationId: row.verificationId,
      score: row.score,
      awardedPoints: row.awardedPoints,
      maximumPoints: row.maximumPoints,
      view,
      result: view === "instructor" ? row.instructorResult : row.studentResult,
      engineSchemaVersion: row.engineSchemaVersion,
      engineVersion: row.engineVersion,
      processedEvents: row.processedEvents,
      virtualTimeNs: row.virtualTimeNs,
      createdAt: row.createdAt,
    };
  }

  async listAssignmentSubmissions(
    context: TenantContext,
    assignmentId: string,
    filter: AssignmentSubmissionFilter = {},
  ): Promise<AssignmentSubmissionRow[]> {
    const scope = tenant(context);
    const filters = [
      eq(submissions.organizationId, scope.organizationId),
      eq(submissions.assignmentId, assignmentId),
    ];
    if (filter.studentUserId) filters.push(eq(submissions.studentUserId, filter.studentUserId));
    if (filter.status) filters.push(eq(submissions.status, filter.status));
    if (filter.submittedAfter) filters.push(gte(submissions.submittedAt, filter.submittedAfter));
    if (filter.submittedBefore) filters.push(lte(submissions.submittedAt, filter.submittedBefore));
    if (filter.minimumScore !== undefined) filters.push(gte(submissionResults.score, filter.minimumScore));
    const rows = await this.database.select({ submission: submissions, score: submissionResults.score })
      .from(submissions)
      .leftJoin(submissionResults, eq(submissionResults.submissionId, submissions.id))
      .where(and(...filters))
      .orderBy(desc(submissions.submittedAt));
    return rows.map((row) => ({ ...row.submission, score: row.score ?? null }));
  }
}

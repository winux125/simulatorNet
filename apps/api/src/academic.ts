import { roleAllows, type AuthorizationAction, type ServiceScope } from "@sim/authz";
import type { GradingSpec } from "@sim/contracts/grading";
import { MAX_DIAGRAM_DOCUMENT_JSON_BYTES } from "@sim/contracts";
import {
  AcademicRepository,
  DatabaseInvalidInputError,
  DatabaseLimitReachedError,
  DatabaseRevisionConflictError,
  TenantRepository,
  type AssignmentRecord,
  type AssignmentSubmissionFilter,
  type SimulatorDatabase,
  type SubmissionRecord,
  type TenantContext,
} from "@sim/db";
import { type VerificationLimits } from "@sim/grading-core";
import { executeVerification } from "@simulatornet/verifier";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { FixedWindowRateLimiter } from "./rate-limit";
import { requireServiceScope, type ServiceAuthenticatorLike, type ServicePrincipal } from "./service-auth";
import { resolveUserSession, userTenantContext, type UserSessionPrincipal } from "./session";

declare module "fastify" {
  interface FastifyRequest {
    userSession?: UserSessionPrincipal;
  }
}

/** A stable, tenant-safe academic API error (never distinguishes 403 vs 404 by existence). */
export class AcademicApiError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number, readonly details?: unknown) {
    super(message);
    this.name = "AcademicApiError";
  }
}

export interface AcademicRouteDeps {
  database?: SimulatorDatabase;
  authenticator?: ServiceAuthenticatorLike;
  limits: VerificationLimits;
  now: () => Date;
  webOrigin: string;
  verificationLimiter: FixedWindowRateLimiter;
}

const CreateTemplateBody = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(4000).optional() });
const CreateVersionBody = z.object({ labDocument: z.unknown() });
const GradingSpecBody = z.object({ gradingSpec: z.unknown() });
const CreateAssignmentBody = z.object({
  labTemplateVersionId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  instructions: z.string().max(20_000).optional(),
  availableFrom: z.string().datetime().optional(),
  dueAt: z.string().datetime().optional(),
  maximumAttempts: z.number().int().positive().nullable().optional(),
});
const PatchAssignmentBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  instructions: z.string().max(20_000).nullable().optional(),
  availableFrom: z.string().datetime().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  maximumAttempts: z.number().int().positive().nullable().optional(),
}).strict();
const SaveInstanceBody = z.object({ expectedRevision: z.number().int().nonnegative(), document: z.unknown() });
const AssignExternalStudentBody = z.object({}).passthrough();

function assertAcademicDocumentSize(document: unknown): void {
  const size = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  if (size > MAX_DIAGRAM_DOCUMENT_JSON_BYTES) {
    throw new AcademicApiError(
      "ACADEMIC_DOCUMENT_TOO_LARGE",
      `Academic LabDocument exceeds the ${MAX_DIAGRAM_DOCUMENT_JSON_BYTES}-byte limit`,
      413,
      { size, maximumBytes: MAX_DIAGRAM_DOCUMENT_JSON_BYTES },
    );
  }
}

function requireDatabase(database: SimulatorDatabase | undefined): SimulatorDatabase {
  if (!database) throw new Error("Database is not configured");
  return database;
}

function requireAuthenticator(authenticator: ServiceAuthenticatorLike | undefined): ServiceAuthenticatorLike {
  if (!authenticator) throw new Error("Service authentication is not configured");
  return authenticator;
}

function serviceTenantContext(principal: ServicePrincipal): TenantContext {
  return { organizationId: principal.organizationId, actor: { kind: "service", id: principal.keycloakClientId } };
}

async function audit(database: SimulatorDatabase, context: TenantContext, requestId: string, action: string, resourceType: string, resourceId?: string, metadata?: Record<string, unknown>): Promise<void> {
  await new TenantRepository(database).recordAuditEvent(context, { action, resourceType, resourceId, requestId, metadata });
}

/** Build a verifier submission document from a stored canonical lab document. */
function submissionDocument(document: { id: string; schemaVersion: number; simulation: { seed: number }; topology: unknown; configurations: unknown }, labVersion: number) {
  return {
    labId: document.id,
    labVersion,
    schemaVersion: document.schemaVersion,
    simulation: document.simulation,
    snapshot: { topology: document.topology, configurations: document.configurations },
  };
}

function assertSubmittable(assignment: AssignmentRecord, now: Date): void {
  if (assignment.status === "draft") throw new AcademicApiError("ASSIGNMENT_NOT_PUBLISHED", "Assignment is not published", 409);
  if (assignment.status === "closed" || assignment.status === "archived") throw new AcademicApiError("ASSIGNMENT_CLOSED", "Assignment is closed", 409);
  if (assignment.availableFrom && now < assignment.availableFrom) throw new AcademicApiError("ASSIGNMENT_NOT_AVAILABLE", "Assignment is not yet available", 409);
  if (assignment.dueAt && now > assignment.dueAt) throw new AcademicApiError("ASSIGNMENT_DUE", "Assignment is past its due date", 409);
}

function publicAssignment(assignment: AssignmentRecord) {
  return {
    id: assignment.id,
    title: assignment.title,
    instructions: assignment.instructions,
    status: assignment.status,
    availableFrom: assignment.availableFrom?.toISOString() ?? null,
    dueAt: assignment.dueAt?.toISOString() ?? null,
    maximumAttempts: assignment.maximumAttempts,
  };
}

export function registerAcademicRoutes(app: FastifyInstance, deps: AcademicRouteDeps): void {
  const academic = () => new AcademicRepository(requireDatabase(deps.database));

  const sessionGuard = (action: AuthorizationAction) => async (request: FastifyRequest) => {
    const session = await resolveUserSession(request, requireDatabase(deps.database), deps.now());
    if (!roleAllows(session.role, action)) throw new AcademicApiError("FORBIDDEN", "You do not have permission for this action", 403);
    request.userSession = session;
  };
  const serviceGuard = (scope: ServiceScope, limiter?: FixedWindowRateLimiter) => async (request: FastifyRequest) => {
    const serviceAuth = requireAuthenticator(deps.authenticator);
    const principal = await serviceAuth.authenticate(request.headers.authorization, request.id);
    await requireServiceScope(serviceAuth, principal, scope, request.id);
    limiter?.consume(`${scope}:${principal.keycloakClientId}`);
    request.servicePrincipal = principal;
  };
  const instructorContext = (request: FastifyRequest): { context: TenantContext; session: UserSessionPrincipal } => {
    const session = request.userSession!;
    return { context: userTenantContext(session), session };
  };

  // --- Instructor: lab templates -----------------------------------------

  app.post("/v1/lab-templates", { preHandler: sessionGuard("lab-template:create"), schema: { tags: ["academic"], body: { type: "object", required: ["title"] } } }, async (request) => {
    const { context, session } = instructorContext(request);
    const body = CreateTemplateBody.parse(request.body);
    const template = await academic().createLabTemplate(context, { ...body, createdByUserId: session.userId });
    await audit(requireDatabase(deps.database), context, request.id, "lab_template.created", "lab-template", template.id, { title: template.title });
    return { id: template.id, title: template.title, description: template.description, status: template.status };
  });

  app.get("/v1/lab-templates", { preHandler: sessionGuard("lab-template:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    return { templates: (await academic().listLabTemplates(context)).map((t) => ({ id: t.id, title: t.title, status: t.status })) };
  });

  app.get("/v1/lab-templates/:templateId", { preHandler: sessionGuard("lab-template:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { templateId } = request.params as { templateId: string };
    const template = await academic().getLabTemplate(context, templateId);
    if (!template) throw new AcademicApiError("LAB_TEMPLATE_NOT_FOUND", "Lab template was not found", 404);
    return { id: template.id, title: template.title, description: template.description, status: template.status };
  });

  app.post("/v1/lab-templates/:templateId/versions", { preHandler: sessionGuard("lab-template:create"), schema: { tags: ["academic"], body: { type: "object", required: ["labDocument"] } } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { templateId } = request.params as { templateId: string };
    const body = CreateVersionBody.parse(request.body);
    assertAcademicDocumentSize(body.labDocument);
    // validate -> migrate -> canonicalize -> hash -> persist immutable version (server owns the hash).
    const version = await academic().createLabTemplateVersion(context, templateId, { labDocument: body.labDocument, createdByUserId: session.userId }).catch(mapNotFoundToTemplate);
    await audit(requireDatabase(deps.database), context, request.id, "lab_template.version_created", "lab-template-version", version.id, { templateId, versionNumber: version.versionNumber, canonicalHash: version.canonicalHash });
    return { id: version.id, versionNumber: version.versionNumber, schemaVersion: version.schemaVersion, canonicalHash: version.canonicalHash, labDocument: version.labDocument };
  });

  app.get("/v1/lab-templates/:templateId/versions", { preHandler: sessionGuard("lab-template:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { templateId } = request.params as { templateId: string };
    const versions = await academic().listLabTemplateVersions(context, templateId);
    return { versions: versions.map((v) => ({ id: v.id, versionNumber: v.versionNumber, canonicalHash: v.canonicalHash, createdAt: v.createdAt.toISOString() })) };
  });

  app.get("/v1/lab-templates/:templateId/versions/:versionId", { preHandler: sessionGuard("lab-template:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { versionId } = request.params as { versionId: string };
    const version = await academic().getLabTemplateVersion(context, versionId);
    if (!version) throw new AcademicApiError("LAB_TEMPLATE_VERSION_NOT_FOUND", "Lab template version was not found", 404);
    return { id: version.id, versionNumber: version.versionNumber, schemaVersion: version.schemaVersion, canonicalHash: version.canonicalHash, labDocument: version.labDocument };
  });

  app.post("/v1/lab-templates/:templateId/archive", { preHandler: sessionGuard("lab-template:archive"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { templateId } = request.params as { templateId: string };
    const template = await academic().archiveLabTemplate(context, templateId).catch(mapNotFoundToTemplate);
    await audit(requireDatabase(deps.database), context, request.id, "lab_template.archived", "lab-template", template.id);
    return { id: template.id, status: template.status };
  });

  // --- Instructor: grading specs (server-only) ---------------------------

  app.put("/v1/lab-template-versions/:versionId/grading-spec", { preHandler: sessionGuard("grading-spec:manage"), schema: { tags: ["academic"], body: { type: "object", required: ["gradingSpec"] } } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { versionId } = request.params as { versionId: string };
    const body = GradingSpecBody.parse(request.body);
    const spec = await academic().createGradingSpec(context, versionId, { gradingSpec: body.gradingSpec, createdByUserId: session.userId }).catch((error) => {
      if (isNotFound(error)) throw new AcademicApiError("LAB_TEMPLATE_VERSION_NOT_FOUND", "Lab template version was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "grading_spec.created", "grading-spec", spec.id, { versionId });
    return { id: spec.id, labTemplateVersionId: spec.labTemplateVersionId, createdAt: spec.createdAt.toISOString() };
  });

  app.get("/v1/lab-template-versions/:versionId/grading-spec", { preHandler: sessionGuard("grading-spec:manage"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { versionId } = request.params as { versionId: string };
    const spec = await academic().getGradingSpecForTemplateVersion(context, versionId);
    if (!spec) throw new AcademicApiError("GRADING_SPEC_NOT_FOUND", "Grading specification was not found", 404);
    return { id: spec.id, labTemplateVersionId: spec.labTemplateVersionId, gradingSpec: spec.gradingSpec };
  });

  // --- Instructor: assignments -------------------------------------------

  app.post("/v1/assignments", { preHandler: sessionGuard("assignment:create"), schema: { tags: ["academic"], body: { type: "object", required: ["labTemplateVersionId", "title"] } } }, async (request) => {
    const { context, session } = instructorContext(request);
    const body = CreateAssignmentBody.parse(request.body);
    const assignment = await academic().createAssignment(context, {
      labTemplateVersionId: body.labTemplateVersionId,
      title: body.title,
      instructions: body.instructions,
      availableFrom: body.availableFrom ? new Date(body.availableFrom) : undefined,
      dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
      maximumAttempts: body.maximumAttempts ?? undefined,
      createdByUserId: session.userId,
    }).catch((error) => {
      if (isNotFound(error)) throw new AcademicApiError("LAB_TEMPLATE_VERSION_NOT_FOUND", "Lab template version was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "assignment.created", "assignment", assignment.id, { labTemplateVersionId: assignment.labTemplateVersionId });
    return publicAssignment(assignment);
  });

  app.get("/v1/assignments", { preHandler: sessionGuard("assignment:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    return { assignments: (await academic().listAssignments(context)).map(publicAssignment) };
  });

  app.get("/v1/assignments/:assignmentId", { preHandler: sessionGuard("assignment:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const assignment = await loadAssignment(academic(), context, (request.params as { assignmentId: string }).assignmentId);
    return { ...publicAssignment(assignment), labTemplateVersionId: assignment.labTemplateVersionId };
  });

  app.patch("/v1/assignments/:assignmentId", { preHandler: sessionGuard("assignment:update"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId } = request.params as { assignmentId: string };
    const patch = PatchAssignmentBody.parse(request.body);
    const assignment = await academic().updateDraftAssignment(context, assignmentId, {
      ...patch,
      availableFrom: patch.availableFrom === undefined ? undefined : patch.availableFrom === null ? null : new Date(patch.availableFrom),
      dueAt: patch.dueAt === undefined ? undefined : patch.dueAt === null ? null : new Date(patch.dueAt),
    }).catch((error) => {
      if (isNotFound(error)) throw new AcademicApiError("ASSIGNMENT_NOT_FOUND", "Assignment was not found", 404);
      if (isConflict(error)) throw new AcademicApiError("ASSIGNMENT_NOT_DRAFT", "Only draft assignments can be edited", 409);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "assignment.updated", "assignment", assignment.id);
    return publicAssignment(assignment);
  });

  app.post("/v1/assignments/:assignmentId/publish", { preHandler: sessionGuard("assignment:publish"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId } = request.params as { assignmentId: string };
    const repo = academic();
    const assignment = await loadAssignment(repo, context, assignmentId);
    // publish requires a grading spec unless explicitly marked ungraded.
    const ungraded = (request.query as { ungraded?: string })?.ungraded === "true";
    if (!ungraded) {
      const spec = await repo.getGradingSpecForTemplateVersion(context, assignment.labTemplateVersionId);
      if (!spec) throw new AcademicApiError("GRADING_SPEC_NOT_FOUND", "A grading specification is required before publishing", 409);
    }
    const published = await repo.publishAssignment(context, assignmentId).catch((error) => {
      if (isConflict(error)) throw new AcademicApiError("ASSIGNMENT_NOT_DRAFT", "Only draft assignments can be published", 409);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "assignment.published", "assignment", published.id);
    return publicAssignment(published);
  });

  app.post("/v1/assignments/:assignmentId/close", { preHandler: sessionGuard("assignment:close"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId } = request.params as { assignmentId: string };
    const closed = await academic().closeAssignment(context, assignmentId).catch((error) => {
      if (isNotFound(error)) throw new AcademicApiError("ASSIGNMENT_NOT_FOUND", "Assignment was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "assignment.closed", "assignment", closed.id);
    return publicAssignment(closed);
  });

  app.put("/v1/assignments/:assignmentId/students/:studentUserId", { preHandler: sessionGuard("assignment:manage-students"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId, studentUserId } = request.params as { assignmentId: string; studentUserId: string };
    const row = await academic().assignStudent(context, assignmentId, studentUserId).catch((error) => {
      if (isNotFound(error)) throw new AcademicApiError("ASSIGNMENT_STUDENT_NOT_ASSIGNED", "Assignment or active student membership was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "assignment.student_assigned", "assignment-student", assignmentId, { studentUserId });
    return { assignmentId, studentUserId: row.studentUserId, status: row.status };
  });

  app.delete("/v1/assignments/:assignmentId/students/:studentUserId", { preHandler: sessionGuard("assignment:manage-students"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId, studentUserId } = request.params as { assignmentId: string; studentUserId: string };
    const row = await academic().removeStudentAssignment(context, assignmentId, studentUserId).catch((error) => {
      if (isNotFound(error)) throw new AcademicApiError("ASSIGNMENT_STUDENT_NOT_ASSIGNED", "Assignment student was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "assignment.student_removed", "assignment-student", assignmentId, { studentUserId });
    return { assignmentId, studentUserId: row.studentUserId, status: row.status };
  });

  app.get("/v1/assignments/:assignmentId/students", { preHandler: sessionGuard("assignment:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId } = request.params as { assignmentId: string };
    const students = await academic().listAssignmentStudents(context, assignmentId);
    return { students: students.map((s) => ({ studentUserId: s.studentUserId, status: s.status, assignedAt: s.assignedAt.toISOString() })) };
  });

  // --- Instructor: submissions -------------------------------------------

  app.get("/v1/assignments/:assignmentId/submissions", { preHandler: sessionGuard("submission:read-organization"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId } = request.params as { assignmentId: string };
    const rows = await academic().listAssignmentSubmissions(context, assignmentId, parseSubmissionFilter(request.query));
    return { submissions: rows.map(submissionSummary) };
  });

  app.get("/v1/assignments/:assignmentId/students/:studentUserId/submissions", { preHandler: sessionGuard("submission:read-organization"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { assignmentId, studentUserId } = request.params as { assignmentId: string; studentUserId: string };
    const rows = await academic().listAssignmentSubmissions(context, assignmentId, { ...parseSubmissionFilter(request.query), studentUserId });
    return { submissions: rows.map(submissionSummary) };
  });

  app.get("/v1/submissions/:submissionId/instructor-result", { preHandler: sessionGuard("result:read-organization"), schema: { tags: ["academic"] } }, async (request) => {
    const { context } = instructorContext(request);
    const { submissionId } = request.params as { submissionId: string };
    const submission = await academic().getSubmission(context, submissionId);
    if (!submission) throw new AcademicApiError("SUBMISSION_NOT_FOUND", "Submission was not found", 404);
    const result = await academic().getSubmissionResult(context, submissionId, "instructor");
    if (!result) throw new AcademicApiError("SUBMISSION_NOT_FOUND", "Submission result was not found", 404);
    await audit(requireDatabase(deps.database), context, request.id, "submission.result_viewed", "submission", submissionId, { view: "instructor", score: result.score });
    return { submissionId, status: submission.status, score: result.score, awardedPoints: result.awardedPoints, maximumPoints: result.maximumPoints, result: result.result, engine: { schemaVersion: result.engineSchemaVersion, version: result.engineVersion, processedEvents: result.processedEvents, virtualTimeNs: result.virtualTimeNs } };
  });

  // --- Student: assignments and lab instances ----------------------------

  app.get("/v1/student/assignments", { preHandler: sessionGuard("assignment:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context, session } = instructorContext(request);
    const assignments = await academic().listStudentAssignments(context, session.userId);
    return { assignments: assignments.map(publicAssignment) };
  });

  app.get("/v1/student/assignments/:assignmentId", { preHandler: sessionGuard("assignment:read"), schema: { tags: ["academic"] } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { assignmentId } = request.params as { assignmentId: string };
    const assignment = await academic().getStudentAssignment(context, assignmentId, session.userId);
    if (!assignment) throw new AcademicApiError("ASSIGNMENT_STUDENT_NOT_ASSIGNED", "Assignment was not found", 404);
    return publicAssignment(assignment);
  });

  app.post("/v1/student/assignments/:assignmentId/open", { preHandler: sessionGuard("lab-instance:save-own"), schema: { tags: ["academic"] } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { assignmentId } = request.params as { assignmentId: string };
    const repo = academic();
    const assignment = await repo.getStudentAssignment(context, assignmentId, session.userId);
    if (!assignment) throw new AcademicApiError("ASSIGNMENT_STUDENT_NOT_ASSIGNED", "Assignment was not found", 404);
    if (assignment.status !== "published") throw new AcademicApiError("ASSIGNMENT_NOT_PUBLISHED", "Assignment is not published", 409);
    if (assignment.availableFrom && deps.now() < assignment.availableFrom) throw new AcademicApiError("ASSIGNMENT_NOT_AVAILABLE", "Assignment is not yet available", 409);
    const instance = await repo.getOrCreateStudentLabInstance(context, assignmentId, session.userId).catch((error) => {
      if (isForbidden(error) || isNotFound(error)) throw new AcademicApiError("ASSIGNMENT_STUDENT_NOT_ASSIGNED", "Assignment was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "lab_instance.created", "lab-instance", instance.id, { assignmentId, revision: instance.revision });
    return { assignment: publicAssignment(assignment), instance: { id: instance.id, revision: instance.revision, status: instance.status }, document: instance.currentDocument };
  });

  app.get("/v1/student/lab-instances/:instanceId", { preHandler: sessionGuard("lab-instance:read-own"), schema: { tags: ["academic"] } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { instanceId } = request.params as { instanceId: string };
    const instance = await academic().getStudentLabInstance(context, instanceId, session.userId);
    if (!instance) throw new AcademicApiError("LAB_INSTANCE_NOT_FOUND", "Lab instance was not found", 404);
    return { id: instance.id, assignmentId: instance.assignmentId, revision: instance.revision, status: instance.status, document: instance.currentDocument };
  });

  app.put("/v1/student/lab-instances/:instanceId", { preHandler: sessionGuard("lab-instance:save-own"), schema: { tags: ["academic"], body: { type: "object", required: ["expectedRevision", "document"] } } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { instanceId } = request.params as { instanceId: string };
    const body = SaveInstanceBody.parse(request.body);
    assertAcademicDocumentSize(body.document);
    const instance = await academic().saveStudentLabInstance(context, instanceId, session.userId, { expectedRevision: body.expectedRevision, document: body.document }).catch((error) => {
      if (error instanceof DatabaseRevisionConflictError) throw new AcademicApiError("LAB_INSTANCE_REVISION_CONFLICT", "The lab instance was modified since your last read", 409, { currentRevision: error.currentRevision });
      if (error instanceof DatabaseInvalidInputError) throw new AcademicApiError("invalid-request", error.message, 400, error.details);
      if (isConflict(error)) throw new AcademicApiError("LAB_INSTANCE_LOCKED", "Lab instance is locked", 409);
      if (isNotFound(error)) throw new AcademicApiError("LAB_INSTANCE_NOT_FOUND", "Lab instance was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "lab_instance.saved", "lab-instance", instance.id, { revision: instance.revision, canonicalHash: instance.canonicalHash });
    return { id: instance.id, revision: instance.revision, status: instance.status, canonicalHash: instance.canonicalHash };
  });

  app.post("/v1/student/lab-instances/:instanceId/submissions", { preHandler: sessionGuard("submission:create-own"), schema: { tags: ["academic"] } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { instanceId } = request.params as { instanceId: string };
    return runSubmission(deps, context, instanceId, session.userId, request.id);
  });

  app.get("/v1/student/lab-instances/:instanceId/submissions", { preHandler: sessionGuard("submission:read-own"), schema: { tags: ["academic"] } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { instanceId } = request.params as { instanceId: string };
    const rows = await academic().listStudentSubmissions(context, instanceId, session.userId);
    return { submissions: rows.map(submissionSummary) };
  });

  app.get("/v1/student/submissions/:submissionId", { preHandler: sessionGuard("result:read-own"), schema: { tags: ["academic"] } }, async (request) => {
    const { context, session } = instructorContext(request);
    const { submissionId } = request.params as { submissionId: string };
    const submission = await academic().getSubmission(context, submissionId, session.userId);
    if (!submission) throw new AcademicApiError("SUBMISSION_NOT_FOUND", "Submission was not found", 404);
    const result = await academic().getSubmissionResult(context, submissionId, "student");
    await audit(requireDatabase(deps.database), context, request.id, "submission.result_viewed", "submission", submissionId, { view: "student", score: result?.score });
    return { id: submission.id, attemptNumber: submission.attemptNumber, status: submission.status, result: result?.result ?? null, score: result?.score ?? null };
  });

  // --- Integration (service-to-server) -----------------------------------

  app.put("/v1/integrations/assignments/:assignmentId/users/:externalUserId", { preHandler: serviceGuard("assignments:students:write"), schema: { tags: ["integrations"] } }, async (request) => {
    const principal = request.servicePrincipal!;
    const context = serviceTenantContext(principal);
    const { assignmentId, externalUserId } = request.params as { assignmentId: string; externalUserId: string };
    AssignExternalStudentBody.parse(request.body ?? {});
    const tenantRepo = new TenantRepository(requireDatabase(deps.database));
    const user = await tenantRepo.getExternalUser(context, principal.integrationClientId, externalUserId);
    if (!user) throw new AcademicApiError("ASSIGNMENT_STUDENT_NOT_ASSIGNED", "External user was not found", 404);
    const row = await academic().assignStudent(context, assignmentId, user.userId).catch((error) => {
      if (isNotFound(error)) throw new AcademicApiError("ASSIGNMENT_STUDENT_NOT_ASSIGNED", "Assignment or active student membership was not found", 404);
      throw error;
    });
    await audit(requireDatabase(deps.database), context, request.id, "assignment.student_assigned", "assignment-student", assignmentId, { studentUserId: user.userId, externalUserId });
    return { assignmentId, studentUserId: row.studentUserId, status: row.status };
  });

  app.get("/v1/integrations/assignments/:assignmentId/results/:externalUserId", { preHandler: serviceGuard("submissions:read"), schema: { tags: ["integrations"] } }, async (request) => {
    const principal = request.servicePrincipal!;
    const context = serviceTenantContext(principal);
    const { assignmentId, externalUserId } = request.params as { assignmentId: string; externalUserId: string };
    const tenantRepo = new TenantRepository(requireDatabase(deps.database));
    const user = await tenantRepo.getExternalUser(context, principal.integrationClientId, externalUserId);
    if (!user) throw new AcademicApiError("SUBMISSION_NOT_FOUND", "External user was not found", 404);
    const rows = await academic().listAssignmentSubmissions(context, assignmentId, { studentUserId: user.userId });
    const latest = rows[0];
    if (!latest) throw new AcademicApiError("SUBMISSION_NOT_FOUND", "No submission was found", 404);
    const result = await academic().getSubmissionResult(context, latest.id, "instructor");
    return { assignmentId, externalUserId, submissionId: latest.id, status: latest.status, attemptNumber: latest.attemptNumber, score: result?.score ?? null, result: result?.result ?? null };
  });
}

function submissionSummary(submission: SubmissionRecord & { score?: number | null }) {
  return {
    id: submission.id,
    studentUserId: submission.studentUserId,
    attemptNumber: submission.attemptNumber,
    status: submission.status,
    submittedAt: submission.submittedAt.toISOString(),
    canonicalHash: submission.canonicalHash,
    score: submission.score ?? null,
  };
}

const SUBMISSION_STATUSES = new Set(["pending", "verifying", "verified", "failed"]);

function parseSubmissionFilter(query: unknown): AssignmentSubmissionFilter {
  const q = (query ?? {}) as Record<string, string | undefined>;
  const status = q.status && SUBMISSION_STATUSES.has(q.status) ? (q.status as AssignmentSubmissionFilter["status"]) : undefined;
  const minimumScore = q.minimumScore !== undefined && Number.isFinite(Number(q.minimumScore)) ? Number(q.minimumScore) : undefined;
  return {
    status,
    minimumScore,
    submittedAfter: q.submittedAfter ? new Date(q.submittedAfter) : undefined,
    submittedBefore: q.submittedBefore ? new Date(q.submittedBefore) : undefined,
  };
}

async function loadAssignment(repo: AcademicRepository, context: TenantContext, assignmentId: string): Promise<AssignmentRecord> {
  const assignment = await repo.getAssignment(context, assignmentId);
  if (!assignment) throw new AcademicApiError("ASSIGNMENT_NOT_FOUND", "Assignment was not found", 404);
  return assignment;
}

/** Run the deterministic submission verification flow and persist the result. */
async function runSubmission(deps: AcademicRouteDeps, context: TenantContext, instanceId: string, studentUserId: string, requestId: string) {
  const database = requireDatabase(deps.database);
  const repo = new AcademicRepository(database);
  const instance = await repo.getStudentLabInstance(context, instanceId, studentUserId);
  if (!instance) throw new AcademicApiError("LAB_INSTANCE_NOT_FOUND", "Lab instance was not found", 404);
  const assignment = await repo.getAssignment(context, instance.assignmentId);
  if (!assignment) throw new AcademicApiError("ASSIGNMENT_NOT_FOUND", "Assignment was not found", 404);
  assertSubmittable(assignment, deps.now());
  const version = await repo.getLabTemplateVersion(context, assignment.labTemplateVersionId);
  if (!version) throw new AcademicApiError("LAB_TEMPLATE_VERSION_NOT_FOUND", "Lab template version was not found", 404);
  const gradingSpecRecord = await repo.getGradingSpecForTemplateVersion(context, assignment.labTemplateVersionId);
  if (!gradingSpecRecord) throw new AcademicApiError("GRADING_SPEC_NOT_FOUND", "Grading specification was not found", 409);

  const submission = await repo.createSubmission(context, instanceId, studentUserId).catch((error) => {
    if (error instanceof DatabaseLimitReachedError) throw new AcademicApiError("SUBMISSION_LIMIT_REACHED", "Submission attempt limit reached", 409);
    throw error;
  });
  deps.verificationLimiter.consume(`submission:${studentUserId}`);
  await repo.markSubmissionVerifying(context, submission.id);
  await audit(database, context, requestId, "submission.created", "submission", submission.id, { attemptNumber: submission.attemptNumber, canonicalHash: submission.canonicalHash });

  try {
    // The browser is never trusted: rebuild deterministically from the stored
    // canonical document + the server-only grading spec and recompute the score.
    const document = submission.labDocument;
    const submissionDoc = submissionDocument(document, version.versionNumber);
    const gradingSpec: GradingSpec = gradingSpecRecord.gradingSpec;
    const studentResult = executeVerification({ submission: submissionDoc, gradingSpec, resultView: "student" }, deps.limits).result;
    const instructorResult = executeVerification({ submission: submissionDoc, gradingSpec, resultView: "instructor" }, deps.limits).result;
    await repo.saveSubmissionResult(context, submission.id, {
      verificationId: instructorResult.verificationId,
      score: instructorResult.score,
      awardedPoints: instructorResult.awardedPoints,
      maximumPoints: instructorResult.maximumPoints,
      studentResult,
      instructorResult,
      engineSchemaVersion: instructorResult.engine.schemaVersion,
      engineVersion: `sim-core@${instructorResult.engine.schemaVersion}`,
      processedEvents: instructorResult.engine.processedEvents,
      virtualTimeNs: instructorResult.engine.virtualTimeNs,
    });
    await audit(database, context, requestId, "submission.verified", "submission", submission.id, { score: instructorResult.score, attemptNumber: submission.attemptNumber });
    return { id: submission.id, attemptNumber: submission.attemptNumber, status: "verified" as const, result: studentResult, score: studentResult.score };
  } catch (error) {
    await repo.markSubmissionFailed(context, submission.id);
    await audit(database, context, requestId, "submission.failed", "submission", submission.id, { reason: error instanceof Error ? error.name : "verification-failed" });
    throw new AcademicApiError("SUBMISSION_VERIFICATION_FAILED", "Submission verification failed", 422, { submissionId: submission.id });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "DB_NOT_FOUND";
}
function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "DB_CONFLICT";
}
function isForbidden(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "DB_FORBIDDEN";
}
function mapNotFoundToTemplate(error: unknown): never {
  if (isNotFound(error)) throw new AcademicApiError("LAB_TEMPLATE_NOT_FOUND", "Lab template was not found", 404);
  throw error;
}

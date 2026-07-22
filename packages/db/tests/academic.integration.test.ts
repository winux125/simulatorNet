import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AcademicRepository,
  createDatabase,
  DatabaseConflictError,
  DatabaseForbiddenError,
  DatabaseInvalidInputError,
  DatabaseNotFoundError,
  DatabaseRevisionConflictError,
  labInstances,
  organizationMemberships,
  PlatformAdminRepository,
  submissions,
  users,
  type DatabaseClient,
  type OrganizationRole,
  type TenantContext,
} from "../src/index";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

let client: DatabaseClient;
let platform: PlatformAdminRepository;
let academic: AcademicRepository;

function labDocument(id = "lab-a", extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    title: `Lab ${id}`,
    simulation: { seed: 1 },
    topology: {
      schemaVersion: 1,
      nodes: [{ id: "pc-1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] }],
      links: [],
    },
    configurations: { "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false } },
    ...extra,
  };
}

const gradingSpec = {
  schemaVersion: 1,
  id: "grade-a",
  checks: [{
    id: "c1",
    title: "Ping gateway",
    points: 10,
    visibility: "hidden",
    type: "ping",
    configuration: { sourceDeviceId: "pc-1", destinationIp: "192.168.1.2", expected: "success" },
  }],
};

function verificationResult(view: "student" | "instructor") {
  return {
    verificationId: "ver-abc",
    status: "completed",
    resultView: view,
    score: 100,
    awardedPoints: 10,
    maximumPoints: 10,
    checks: view === "instructor"
      ? [{ id: "c1", status: "passed", awardedPoints: 10, maximumPoints: 10, message: "PC1 reached gateway", title: "Ping gateway", visibility: "hidden", diagnostics: { actual: "success" } }]
      : [{ id: "c1", status: "passed", awardedPoints: 10, maximumPoints: 10, message: "Hidden check passed", title: "Hidden check" }],
    engine: { schemaVersion: 1, simulationSeed: 1, processedEvents: 12, virtualTimeNs: 5000 },
  };
}

async function createOrganization(slug: string) {
  return platform.createOrganization({ slug, name: slug.toUpperCase() });
}

async function createUser(email: string) {
  const [user] = await client.db.insert(users).values({ email, displayName: email }).returning();
  return user!;
}

async function addMembership(organizationId: string, userId: string, role: OrganizationRole, status: "active" | "inactive" = "active") {
  await client.db.insert(organizationMemberships).values({ organizationId, userId, role, status });
}

function context(organizationId: string, actorUserId: string): TenantContext {
  return { organizationId, actor: { kind: "user", id: actorUserId } };
}

/** A tenant with an instructor and one active student, plus a published version. */
async function seedTenant(slug: string) {
  const organization = await createOrganization(slug);
  const instructor = await createUser(`instructor-${slug}@example.test`);
  const student = await createUser(`student-${slug}@example.test`);
  await addMembership(organization.id, instructor.id, "instructor");
  await addMembership(organization.id, student.id, "student");
  const ctx = context(organization.id, instructor.id);
  const template = await academic.createLabTemplate(ctx, { title: `${slug} template`, createdByUserId: instructor.id });
  const version = await academic.createLabTemplateVersion(ctx, template.id, { labDocument: labDocument(), createdByUserId: instructor.id });
  return { organization, instructor, student, ctx, template, version };
}

integration("PostgreSQL academic model", () => {
  beforeAll(() => {
    client = createDatabase({ connectionString: databaseUrl!, maxConnections: 6, applicationName: "simulatornet-academic-tests" });
    platform = new PlatformAdminRepository(client.db);
    academic = new AcademicRepository(client.db);
  });

  beforeEach(async () => {
    await client.db.execute(sql`truncate table submission_results, submissions, lab_instances, assignment_students, assignments, grading_specs, lab_template_versions, lab_templates, audit_events, browser_sessions, launch_codes, external_user_links, integration_clients, organization_memberships, user_identities, users, organizations restart identity cascade`);
  });

  afterAll(async () => client.close());

  it("applies the academic migration to a clean PostgreSQL database", async () => {
    const result = await client.db.execute<{ templates: string | null; migrations: string | null }>(sql`
      select to_regclass('public.lab_templates')::text as templates,
             to_regclass('drizzle.__drizzle_migrations')::text as migrations
    `);
    expect(result.rows[0]).toEqual({ templates: "lab_templates", migrations: "drizzle.__drizzle_migrations" });
  });

  it("scopes a created template to its tenant", async () => {
    const tenant = await seedTenant("tenant-scope");
    const fetched = await academic.getLabTemplate(tenant.ctx, tenant.template.id);
    expect(fetched?.organizationId).toBe(tenant.organization.id);
  });

  it("rejects a cross-tenant template read", async () => {
    const a = await seedTenant("read-a");
    const b = await seedTenant("read-b");
    expect(await academic.getLabTemplate(b.ctx, a.template.id)).toBeUndefined();
  });

  it("keeps template versions immutable and appends new versions", async () => {
    const tenant = await seedTenant("immutable-version");
    const first = tenant.version;
    const second = await academic.createLabTemplateVersion(tenant.ctx, tenant.template.id, { labDocument: labDocument("lab-a", { title: "Edited" }) });
    const reloaded = await academic.getLabTemplateVersion(tenant.ctx, first.id);
    expect(reloaded?.canonicalHash).toBe(first.canonicalHash);
    expect(reloaded?.versionNumber).toBe(1);
    expect(second.versionNumber).toBe(2);
  });

  it("increments version numbers within a template", async () => {
    const tenant = await seedTenant("increment");
    const v2 = await academic.createLabTemplateVersion(tenant.ctx, tenant.template.id, { labDocument: labDocument() });
    const v3 = await academic.createLabTemplateVersion(tenant.ctx, tenant.template.id, { labDocument: labDocument() });
    expect([tenant.version.versionNumber, v2.versionNumber, v3.versionNumber]).toEqual([1, 2, 3]);
  });

  it("computes a stable canonical hash for identical documents", async () => {
    const a = await seedTenant("hash-a");
    const b = await seedTenant("hash-b");
    const versionA = await academic.createLabTemplateVersion(a.ctx, a.template.id, { labDocument: labDocument("same") });
    const versionB = await academic.createLabTemplateVersion(b.ctx, b.template.id, { labDocument: labDocument("same") });
    expect(versionA.canonicalHash).toBe(versionB.canonicalHash);
    expect(versionA.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an invalid LabDocument", async () => {
    const tenant = await seedTenant("invalid-doc");
    const broken = { schemaVersion: 1, id: "x", title: "X", simulation: { seed: 1 }, topology: { schemaVersion: 1, nodes: "nope", links: [] }, configurations: {} };
    await expect(academic.createLabTemplateVersion(tenant.ctx, tenant.template.id, { labDocument: broken }))
      .rejects.toBeInstanceOf(DatabaseInvalidInputError);
  });

  it("keeps hidden grading specs out of the lab document", async () => {
    const tenant = await seedTenant("grading-separation");
    await academic.createGradingSpec(tenant.ctx, tenant.version.id, { gradingSpec });
    const version = await academic.getLabTemplateVersion(tenant.ctx, tenant.version.id);
    expect(JSON.stringify(version?.labDocument)).not.toContain("checks");
    const spec = await academic.getGradingSpecForTemplateVersion(tenant.ctx, tenant.version.id);
    expect(spec?.gradingSpec.checks[0]?.id).toBe("c1");
  });

  it("cannot build an assignment on another tenant's template version", async () => {
    const a = await seedTenant("assign-a");
    const b = await seedTenant("assign-b");
    await expect(academic.createAssignment(b.ctx, { labTemplateVersionId: a.version.id, title: "Cross" }))
      .rejects.toBeInstanceOf(DatabaseNotFoundError);
  });

  it("cannot edit a published assignment", async () => {
    const tenant = await seedTenant("published-lock");
    const assignment = await academic.createAssignment(tenant.ctx, { labTemplateVersionId: tenant.version.id, title: "A1" });
    await academic.publishAssignment(tenant.ctx, assignment.id);
    await expect(academic.updateDraftAssignment(tenant.ctx, assignment.id, { title: "changed" }))
      .rejects.toBeInstanceOf(DatabaseConflictError);
  });

  it("requires an active student membership to assign a student", async () => {
    const tenant = await seedTenant("membership-required");
    const assignment = await academic.createAssignment(tenant.ctx, { labTemplateVersionId: tenant.version.id, title: "A1" });
    const outsider = await createUser("outsider@example.test");
    await expect(academic.assignStudent(tenant.ctx, assignment.id, outsider.id)).rejects.toBeInstanceOf(DatabaseNotFoundError);
    const instructorOnly = tenant.instructor.id;
    await expect(academic.assignStudent(tenant.ctx, assignment.id, instructorOnly)).rejects.toBeInstanceOf(DatabaseNotFoundError);
    const inactive = await createUser("inactive@example.test");
    await addMembership(tenant.organization.id, inactive.id, "student", "inactive");
    await expect(academic.assignStudent(tenant.ctx, assignment.id, inactive.id)).rejects.toBeInstanceOf(DatabaseNotFoundError);
  });

  it("keeps assignment student rows unique", async () => {
    const tenant = await seedTenant("student-unique");
    const assignment = await academic.createAssignment(tenant.ctx, { labTemplateVersionId: tenant.version.id, title: "A1" });
    await academic.assignStudent(tenant.ctx, assignment.id, tenant.student.id);
    await academic.assignStudent(tenant.ctx, assignment.id, tenant.student.id);
    const students = await academic.listAssignmentStudents(tenant.ctx, assignment.id);
    expect(students).toHaveLength(1);
  });

  async function seedAssignedInstance(slug: string) {
    const tenant = await seedTenant(slug);
    const assignment = await academic.createAssignment(tenant.ctx, { labTemplateVersionId: tenant.version.id, title: "A1" });
    await academic.assignStudent(tenant.ctx, assignment.id, tenant.student.id);
    await academic.publishAssignment(tenant.ctx, assignment.id);
    return { ...tenant, assignment };
  }

  it("creates a student lab instance exactly once", async () => {
    const tenant = await seedAssignedInstance("instance-once");
    const first = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    const second = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    expect(second.id).toBe(first.id);
  });

  it("copies the canonical template version into the initial instance", async () => {
    const tenant = await seedAssignedInstance("instance-copy");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    expect(instance.canonicalHash).toBe(tenant.version.canonicalHash);
    expect(instance.currentDocument).toEqual(tenant.version.labDocument);
    expect(instance.revision).toBe(1);
  });

  it("increments the revision on autosave", async () => {
    const tenant = await seedAssignedInstance("autosave");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    const saved = await academic.saveStudentLabInstance(tenant.ctx, instance.id, tenant.student.id, { expectedRevision: 1, document: labDocument("lab-a", { title: "Progress" }) });
    expect(saved.revision).toBe(2);
  });

  it("returns a revision conflict on a stale autosave", async () => {
    const tenant = await seedAssignedInstance("stale");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    await academic.saveStudentLabInstance(tenant.ctx, instance.id, tenant.student.id, { expectedRevision: 1, document: labDocument() });
    const conflict = await academic.saveStudentLabInstance(tenant.ctx, instance.id, tenant.student.id, { expectedRevision: 1, document: labDocument() })
      .catch((error) => error);
    expect(conflict).toBeInstanceOf(DatabaseRevisionConflictError);
    expect((conflict as DatabaseRevisionConflictError).currentRevision).toBe(2);
  });

  it("does not persist runtime state in the saved document", async () => {
    const tenant = await seedAssignedInstance("runtime");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    const saved = await academic.saveStudentLabInstance(tenant.ctx, instance.id, tenant.student.id, {
      expectedRevision: 1,
      document: labDocument("lab-a", { arpTable: [{ ip: "1.1.1.1", mac: "aa" }], traceLog: ["x"] }),
    });
    expect(saved.currentDocument).not.toHaveProperty("arpTable");
    expect(saved.currentDocument).not.toHaveProperty("traceLog");
  });

  it("keeps a submission's snapshot immutable across later autosaves", async () => {
    const tenant = await seedAssignedInstance("submission-immutable");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    await academic.saveStudentLabInstance(tenant.ctx, instance.id, tenant.student.id, { expectedRevision: 1, document: labDocument("lab-a", { title: "First" }) });
    const first = await academic.createSubmission(tenant.ctx, instance.id, tenant.student.id);
    await academic.saveStudentLabInstance(tenant.ctx, instance.id, tenant.student.id, { expectedRevision: 2, document: labDocument("lab-a", { title: "Second" }) });
    const reloaded = await academic.getSubmission(tenant.ctx, first.id);
    expect(reloaded?.labDocument.title).toBe("First");
  });

  it("increments attempt numbers atomically", async () => {
    const tenant = await seedAssignedInstance("attempts");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    const first = await academic.createSubmission(tenant.ctx, instance.id, tenant.student.id);
    const second = await academic.createSubmission(tenant.ctx, instance.id, tenant.student.id);
    expect([first.attemptNumber, second.attemptNumber]).toEqual([1, 2]);
  });

  it("separates student and instructor result views", async () => {
    const tenant = await seedAssignedInstance("result-views");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    const submission = await academic.createSubmission(tenant.ctx, instance.id, tenant.student.id);
    await academic.saveSubmissionResult(tenant.ctx, submission.id, {
      verificationId: "ver-abc",
      score: 100,
      awardedPoints: 10,
      maximumPoints: 10,
      studentResult: verificationResult("student"),
      instructorResult: verificationResult("instructor"),
      engineSchemaVersion: 1,
      engineVersion: "test",
      processedEvents: 12,
      virtualTimeNs: 5000,
    });
    const studentView = await academic.getSubmissionResult(tenant.ctx, submission.id, "student");
    const instructorView = await academic.getSubmissionResult(tenant.ctx, submission.id, "instructor");
    expect(JSON.stringify(studentView?.result)).not.toContain("diagnostics");
    expect(JSON.stringify(instructorView?.result)).toContain("diagnostics");
  });

  it("prevents Tenant A from reading Tenant B submissions and results", async () => {
    const a = await seedTenant("cross-a");
    const b = await seedAssignedInstance("cross-b");
    const instance = await academic.getOrCreateStudentLabInstance(b.ctx, b.assignment.id, b.student.id);
    const submission = await academic.createSubmission(b.ctx, instance.id, b.student.id);
    await academic.saveSubmissionResult(b.ctx, submission.id, {
      verificationId: "ver", score: 100, awardedPoints: 10, maximumPoints: 10,
      studentResult: verificationResult("student"), instructorResult: verificationResult("instructor"),
      engineSchemaVersion: 1, engineVersion: "test", processedEvents: 1, virtualTimeNs: 1,
    });
    expect(await academic.getSubmission(a.ctx, submission.id)).toBeUndefined();
    expect(await academic.getSubmissionResult(a.ctx, submission.id, "instructor")).toBeUndefined();
  });

  it("produces a single instance under concurrent first-open", async () => {
    const tenant = await seedAssignedInstance("concurrent-open");
    const results = await Promise.all([
      academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id),
      academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id),
    ]);
    expect(results[0]!.id).toBe(results[1]!.id);
    const [row] = await client.db.select({ total: count() }).from(labInstances).where(eq(labInstances.assignmentId, tenant.assignment.id));
    expect(row?.total).toBe(1);
  });

  it("produces unique attempt numbers under concurrent submission", async () => {
    const tenant = await seedAssignedInstance("concurrent-submit");
    const instance = await academic.getOrCreateStudentLabInstance(tenant.ctx, tenant.assignment.id, tenant.student.id);
    const results = await Promise.all([
      academic.createSubmission(tenant.ctx, instance.id, tenant.student.id),
      academic.createSubmission(tenant.ctx, instance.id, tenant.student.id),
    ]);
    expect(new Set(results.map((row) => row.attemptNumber))).toEqual(new Set([1, 2]));
    const [row] = await client.db.select({ total: count() }).from(submissions).where(eq(submissions.labInstanceId, instance.id));
    expect(row?.total).toBe(2);
  });

  it("keeps tenant scope correct across pooled repository reuse", async () => {
    const a = await seedTenant("pool-a");
    const b = await seedTenant("pool-b");
    expect((await academic.getLabTemplate(a.ctx, a.template.id))?.organizationId).toBe(a.organization.id);
    expect((await academic.getLabTemplate(b.ctx, b.template.id))?.organizationId).toBe(b.organization.id);
    expect(await academic.getLabTemplate(a.ctx, b.template.id)).toBeUndefined();
    expect(await academic.getLabTemplate(b.ctx, a.template.id)).toBeUndefined();
  });
});

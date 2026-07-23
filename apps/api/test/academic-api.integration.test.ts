import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  createDatabase,
  createOpaqueToken,
  organizationMemberships,
  PlatformAdminRepository,
  TenantRepository,
  users,
  type DatabaseClient,
  type OrganizationRole,
  type TenantContext,
} from "@sim/db";
import { buildApi } from "../src/app";
import { createServiceTokenVerifier } from "../src/jwt";
import { ServiceAuthenticator } from "../src/service-auth";
import { demoLabDocument, gradingSpec } from "../../../packages/grading-core/test/fixtures";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const issuer = "https://oidc.local.test/realms/simulatornet";
const audience = "simulatornet-api";
const webOrigin = "http://127.0.0.1:4173";
const serviceScopes = ["users:read", "assignments:read", "assignments:write", "assignments:students:write", "submissions:read"];

let client: DatabaseClient;
let privateKey: CryptoKey;
let authenticator: ServiceAuthenticator;
type Api = Awaited<ReturnType<typeof buildApi>>;
let app: Api;

async function signedToken(azp: string, scopes = serviceScopes) {
  return new SignJWT({ azp, scope: scopes.join(" "), typ: "Bearer" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key", typ: "JWT" })
    .setIssuer(issuer).setAudience(audience).setSubject(`svc-${azp}`).setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

function sysContext(organizationId: string): TenantContext {
  return { organizationId, actor: { kind: "system", id: "academic-test" } };
}

async function createUser(email: string) {
  const [user] = await client.db.insert(users).values({ email, displayName: email }).returning();
  return user!;
}

async function addMembership(organizationId: string, userId: string, role: OrganizationRole) {
  await client.db.insert(organizationMemberships).values({ organizationId, userId, role, status: "active" });
}

async function cookieFor(organizationId: string, userId: string): Promise<string> {
  const token = createOpaqueToken();
  await new TenantRepository(client.db).createBrowserSession(
    { organizationId, actor: { kind: "user", id: userId } },
    { userId, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3_600_000) },
  );
  return `simulatornet_session=${token.value}`;
}

function jsonHeaders(cookie: string) {
  return { cookie, "content-type": "application/json" };
}
function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** Full tenant with instructor + student sessions, integration client, a template
 *  version and a grading spec. Assignments are created per test. */
async function seedTenant(slug: string) {
  const organization = await new PlatformAdminRepository(client.db).createOrganization({ slug, name: slug.toUpperCase() });
  const instructor = await createUser(`instructor-${slug}@x.test`);
  const student = await createUser(`student-${slug}@x.test`);
  await addMembership(organization.id, instructor.id, "instructor");
  await addMembership(organization.id, student.id, "student");
  const instructorCookie = await cookieFor(organization.id, instructor.id);
  const studentCookie = await cookieFor(organization.id, student.id);
  await new TenantRepository(client.db).createIntegrationClientMapping(sysContext(organization.id), {
    keycloakClientId: `${slug}-client`, name: slug, allowedScopes: serviceScopes, allowedReturnUrls: [webOrigin],
  });
  const token = await signedToken(`${slug}-client`);

  const template = (await app.inject({ method: "POST", url: "/v1/lab-templates", headers: jsonHeaders(instructorCookie), payload: { title: `${slug} template` } })).json();
  const version = (await app.inject({ method: "POST", url: `/v1/lab-templates/${template.id}/versions`, headers: jsonHeaders(instructorCookie), payload: { labDocument: demoLabDocument() } })).json();
  await app.inject({ method: "PUT", url: `/v1/lab-template-versions/${version.id}/grading-spec`, headers: jsonHeaders(instructorCookie), payload: { gradingSpec: gradingSpec() } });

  return { organization, instructor, student, instructorCookie, studentCookie, token, template, version };
}

async function createAssignment(cookie: string, versionId: string, extra: Record<string, unknown> = {}) {
  return (await app.inject({ method: "POST", url: "/v1/assignments", headers: jsonHeaders(cookie), payload: { labTemplateVersionId: versionId, title: "Assignment", ...extra } })).json();
}

async function assignAndPublish(tenant: Awaited<ReturnType<typeof seedTenant>>, extra: Record<string, unknown> = {}) {
  const assignment = await createAssignment(tenant.instructorCookie, tenant.version.id, extra);
  await app.inject({ method: "PUT", url: `/v1/assignments/${assignment.id}/students/${tenant.student.id}`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
  await app.inject({ method: "POST", url: `/v1/assignments/${assignment.id}/publish`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
  return assignment;
}

async function openInstance(cookie: string, assignmentId: string) {
  return (await app.inject({ method: "POST", url: `/v1/student/assignments/${assignmentId}/open`, headers: jsonHeaders(cookie), payload: {} })).json();
}

integration("M9.2 academic API", () => {
  beforeAll(async () => {
    client = createDatabase({ connectionString: databaseUrl!, maxConnections: 8, applicationName: "simulatornet-academic-api" });
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    const publicJwk: JWK = { ...await exportJWK(pair.publicKey), kid: "integration-key", alg: "RS256", use: "sig" };
    authenticator = new ServiceAuthenticator(client.db, createServiceTokenVerifier({ issuer, audience, keySet: createLocalJWKSet({ keys: [publicJwk] }) }));
    app = await buildApi({ database: client.db, serviceAuthenticator: authenticator, webOrigin, publicWebUrl: webOrigin, rateLimits: { verification: 10_000, integrationWrites: 10_000 } });
  });

  beforeEach(async () => {
    await client.pool.query("truncate table submission_results, submissions, lab_instances, assignment_students, assignments, grading_specs, lab_template_versions, lab_templates, audit_events, browser_sessions, launch_codes, external_user_links, integration_clients, organization_memberships, user_identities, users, organizations restart identity cascade");
  });

  afterAll(async () => { await app.close(); await client.close(); });

  // --- Instructor API ---

  it("lets an instructor create a template and rejects a student", async () => {
    const tenant = await seedTenant("create-template");
    expect(tenant.template.id).toBeTruthy();
    const denied = await app.inject({ method: "POST", url: "/v1/lab-templates", headers: jsonHeaders(tenant.studentCookie), payload: { title: "nope" } });
    expect(denied.statusCode).toBe(403);
  });

  it("validates and canonicalizes a version and rejects an invalid document", async () => {
    const tenant = await seedTenant("version-validate");
    expect(tenant.version.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tenant.version.labDocument.id).toBe("demo-router-on-a-stick");
    const invalid = await app.inject({ method: "POST", url: `/v1/lab-templates/${tenant.template.id}/versions`, headers: jsonHeaders(tenant.instructorCookie), payload: { labDocument: { schemaVersion: 1 } } });
    expect(invalid.statusCode).toBe(400);
  });

  it("keeps the grading spec off every student surface", async () => {
    const tenant = await seedTenant("grading-hidden");
    const instructorGet = await app.inject({ method: "GET", url: `/v1/lab-template-versions/${tenant.version.id}/grading-spec`, headers: jsonHeaders(tenant.instructorCookie) });
    expect(instructorGet.statusCode).toBe(200);
    const studentGet = await app.inject({ method: "GET", url: `/v1/lab-template-versions/${tenant.version.id}/grading-spec`, headers: jsonHeaders(tenant.studentCookie) });
    expect(studentGet.statusCode).toBe(403);
  });

  it("creates, updates and locks a published assignment", async () => {
    const tenant = await seedTenant("assignment-lifecycle");
    const assignment = await createAssignment(tenant.instructorCookie, tenant.version.id);
    const patched = await app.inject({ method: "PATCH", url: `/v1/assignments/${assignment.id}`, headers: jsonHeaders(tenant.instructorCookie), payload: { title: "Renamed" } });
    expect(patched.json().title).toBe("Renamed");
    await app.inject({ method: "PUT", url: `/v1/assignments/${assignment.id}/students/${tenant.student.id}`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
    const publish = await app.inject({ method: "POST", url: `/v1/assignments/${assignment.id}/publish`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
    expect(publish.statusCode).toBe(200);
    const afterPublish = await app.inject({ method: "PATCH", url: `/v1/assignments/${assignment.id}`, headers: jsonHeaders(tenant.instructorCookie), payload: { title: "Nope" } });
    expect(afterPublish.statusCode).toBe(409);
    expect(afterPublish.json().error.code).toBe("ASSIGNMENT_NOT_DRAFT");
  });

  it("refuses to publish without a grading spec", async () => {
    const tenant = await seedTenant("publish-nograde");
    const bareVersion = (await app.inject({ method: "POST", url: `/v1/lab-templates/${tenant.template.id}/versions`, headers: jsonHeaders(tenant.instructorCookie), payload: { labDocument: demoLabDocument() } })).json();
    const assignment = await createAssignment(tenant.instructorCookie, bareVersion.id);
    const publish = await app.inject({ method: "POST", url: `/v1/assignments/${assignment.id}/publish`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
    expect(publish.statusCode).toBe(409);
    expect(publish.json().error.code).toBe("GRADING_SPEC_NOT_FOUND");
  });

  it("rejects assigning a student from another tenant", async () => {
    const a = await seedTenant("assign-a");
    const b = await seedTenant("assign-b");
    const assignment = await createAssignment(a.instructorCookie, a.version.id);
    const cross = await app.inject({ method: "PUT", url: `/v1/assignments/${assignment.id}/students/${b.student.id}`, headers: jsonHeaders(a.instructorCookie), payload: {} });
    expect(cross.statusCode).toBe(404);
  });

  // --- Student API ---

  it("shows a student only their own published assignments", async () => {
    const tenant = await seedTenant("student-list");
    const assigned = await assignAndPublish(tenant);
    const otherStudent = await createUser("other@x.test");
    await addMembership(tenant.organization.id, otherStudent.id, "student");
    const otherAssignment = await createAssignment(tenant.instructorCookie, tenant.version.id);
    await app.inject({ method: "PUT", url: `/v1/assignments/${otherAssignment.id}/students/${otherStudent.id}`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
    await app.inject({ method: "POST", url: `/v1/assignments/${otherAssignment.id}/publish`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
    const list = (await app.inject({ method: "GET", url: "/v1/student/assignments", headers: jsonHeaders(tenant.studentCookie) })).json();
    expect(list.assignments.map((a: { id: string }) => a.id)).toEqual([assigned.id]);
  });

  it("creates a single instance on open and hides another student's instance", async () => {
    const tenant = await seedTenant("open-instance");
    const assignment = await assignAndPublish(tenant);
    const first = await openInstance(tenant.studentCookie, assignment.id);
    const second = await openInstance(tenant.studentCookie, assignment.id);
    expect(second.instance.id).toBe(first.instance.id);
    const otherStudent = await createUser("intruder@x.test");
    await addMembership(tenant.organization.id, otherStudent.id, "student");
    const intruderCookie = await cookieFor(tenant.organization.id, otherStudent.id);
    const stolen = await app.inject({ method: "GET", url: `/v1/student/lab-instances/${first.instance.id}`, headers: jsonHeaders(intruderCookie) });
    expect(stolen.statusCode).toBe(404);
  });

  it("increments revision on autosave and returns a 409 on stale revision", async () => {
    const tenant = await seedTenant("autosave");
    const assignment = await assignAndPublish(tenant);
    const opened = await openInstance(tenant.studentCookie, assignment.id);
    const saved = await app.inject({ method: "PUT", url: `/v1/student/lab-instances/${opened.instance.id}`, headers: jsonHeaders(tenant.studentCookie), payload: { expectedRevision: 1, document: demoLabDocument() } });
    expect(saved.json().revision).toBe(2);
    const stale = await app.inject({ method: "PUT", url: `/v1/student/lab-instances/${opened.instance.id}`, headers: jsonHeaders(tenant.studentCookie), payload: { expectedRevision: 1, document: demoLabDocument() } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("LAB_INSTANCE_REVISION_CONFLICT");
    expect(stale.json().error.details.currentRevision).toBe(2);
  });

  it("runs the server verifier, ignores a fake browser score and hides grading internals", async () => {
    const tenant = await seedTenant("verify");
    const assignment = await assignAndPublish(tenant);
    const opened = await openInstance(tenant.studentCookie, assignment.id);
    // Save a document carrying a forged score/cheat marker (stripped on canonicalize).
    await app.inject({ method: "PUT", url: `/v1/student/lab-instances/${opened.instance.id}`, headers: jsonHeaders(tenant.studentCookie), payload: { expectedRevision: 1, document: { ...demoLabDocument(), score: 999, cheated: true } } });
    const submit = await app.inject({ method: "POST", url: `/v1/student/lab-instances/${opened.instance.id}/submissions`, headers: jsonHeaders(tenant.studentCookie), payload: {} });
    expect(submit.statusCode).toBe(200);
    const body = submit.json();
    expect(body.status).toBe("verified");
    expect(typeof body.score).toBe("number");
    expect(body.score).not.toBe(999);
    const raw = submit.body;
    expect(raw).not.toContain("diagnostics");
    expect(raw).not.toContain("sourceDeviceId");
    expect(raw).not.toContain("cheated");
  });

  it("enforces the attempt limit", async () => {
    const tenant = await seedTenant("attempt-limit");
    const assignment = await assignAndPublish(tenant, { maximumAttempts: 1 });
    const opened = await openInstance(tenant.studentCookie, assignment.id);
    const first = await app.inject({ method: "POST", url: `/v1/student/lab-instances/${opened.instance.id}/submissions`, headers: jsonHeaders(tenant.studentCookie), payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/v1/student/lab-instances/${opened.instance.id}/submissions`, headers: jsonHeaders(tenant.studentCookie), payload: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("SUBMISSION_LIMIT_REACHED");
  });

  it("rejects a submission for a closed assignment", async () => {
    const tenant = await seedTenant("closed");
    const assignment = await assignAndPublish(tenant);
    const opened = await openInstance(tenant.studentCookie, assignment.id);
    await app.inject({ method: "POST", url: `/v1/assignments/${assignment.id}/close`, headers: jsonHeaders(tenant.instructorCookie), payload: {} });
    const submit = await app.inject({ method: "POST", url: `/v1/student/lab-instances/${opened.instance.id}/submissions`, headers: jsonHeaders(tenant.studentCookie), payload: {} });
    expect(submit.statusCode).toBe(409);
    expect(submit.json().error.code).toBe("ASSIGNMENT_CLOSED");
  });

  // --- Instructor results ---

  it("separates instructor result diagnostics from the student view and blocks students", async () => {
    const tenant = await seedTenant("result-views");
    const assignment = await assignAndPublish(tenant);
    const opened = await openInstance(tenant.studentCookie, assignment.id);
    const submit = (await app.inject({ method: "POST", url: `/v1/student/lab-instances/${opened.instance.id}/submissions`, headers: jsonHeaders(tenant.studentCookie), payload: {} })).json();
    const list = (await app.inject({ method: "GET", url: `/v1/assignments/${assignment.id}/submissions`, headers: jsonHeaders(tenant.instructorCookie) })).json();
    expect(list.submissions).toHaveLength(1);
    const instructorResult = await app.inject({ method: "GET", url: `/v1/submissions/${submit.id}/instructor-result`, headers: jsonHeaders(tenant.instructorCookie) });
    expect(instructorResult.statusCode).toBe(200);
    expect(instructorResult.body).toContain("diagnostics");
    const studentDenied = await app.inject({ method: "GET", url: `/v1/submissions/${submit.id}/instructor-result`, headers: jsonHeaders(tenant.studentCookie) });
    expect(studentDenied.statusCode).toBe(403);
  });

  it("prevents Tenant A from reading Tenant B results", async () => {
    const a = await seedTenant("tenant-a");
    const b = await seedTenant("tenant-b");
    const assignment = await assignAndPublish(b);
    const opened = await openInstance(b.studentCookie, assignment.id);
    const submit = (await app.inject({ method: "POST", url: `/v1/student/lab-instances/${opened.instance.id}/submissions`, headers: jsonHeaders(b.studentCookie), payload: {} })).json();
    const cross = await app.inject({ method: "GET", url: `/v1/submissions/${submit.id}/instructor-result`, headers: jsonHeaders(a.instructorCookie) });
    expect(cross.statusCode).toBe(404);
  });

  // --- Integration (service-to-server) ---

  it("assigns an external student and cannot override the organization", async () => {
    const tenant = await seedTenant("s2s-assign");
    const assignment = await assignAndPublish(tenant);
    const { rows } = await client.pool.query("select id from integration_clients where organization_id = $1 limit 1", [tenant.organization.id]);
    const integrationClientId = rows[0]!.id as string;
    const repo = new TenantRepository(client.db);
    const external = await repo.upsertExternalUser(sysContext(tenant.organization.id), integrationClientId, "external-1", { email: "ext@x.test", displayName: "Ext" });
    await addMembership(tenant.organization.id, external.userId, "student");
    // The organizationId in the body must be ignored — tenant comes from the principal.
    const assign = await app.inject({ method: "PUT", url: `/v1/integrations/assignments/${assignment.id}/users/external-1`, headers: authHeaders(tenant.token), payload: { organizationId: "attacker" } });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().studentUserId).toBe(external.userId);
    const students = (await app.inject({ method: "GET", url: `/v1/assignments/${assignment.id}/students`, headers: jsonHeaders(tenant.instructorCookie) })).json();
    expect(students.students.map((s: { studentUserId: string }) => s.studentUserId)).toContain(external.userId);
  });

  it("requires the submissions:read scope for integration result lookup", async () => {
    const tenant = await seedTenant("s2s-scope");
    const assignment = await assignAndPublish(tenant);
    const noScopeToken = await signedToken(`${tenant.organization.slug}-client`, ["assignments:read"]);
    const denied = await app.inject({ method: "GET", url: `/v1/integrations/assignments/${assignment.id}/results/whoever`, headers: authHeaders(noScopeToken) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("AUTH_INSUFFICIENT_SCOPE");
  });

  // --- End to end + audit ---

  it("runs the full instructor-to-student academic flow and records safe audit events", async () => {
    const tenant = await seedTenant("e2e");
    const assignment = await assignAndPublish(tenant);
    const opened = await openInstance(tenant.studentCookie, assignment.id);
    expect(opened.document.id).toBe("demo-router-on-a-stick");
    await app.inject({ method: "PUT", url: `/v1/student/lab-instances/${opened.instance.id}`, headers: jsonHeaders(tenant.studentCookie), payload: { expectedRevision: 1, document: demoLabDocument() } });
    const submit = (await app.inject({ method: "POST", url: `/v1/student/lab-instances/${opened.instance.id}/submissions`, headers: jsonHeaders(tenant.studentCookie), payload: {} })).json();
    const studentResult = (await app.inject({ method: "GET", url: `/v1/student/submissions/${submit.id}`, headers: jsonHeaders(tenant.studentCookie) })).json();
    expect(studentResult.status).toBe("verified");
    expect(typeof studentResult.score).toBe("number");
    const instructorResult = (await app.inject({ method: "GET", url: `/v1/submissions/${submit.id}/instructor-result`, headers: jsonHeaders(tenant.instructorCookie) })).json();
    expect(instructorResult.score).toBe(studentResult.score);

    const events = (await client.db.select({ action: auditEvents.action, metadata: auditEvents.metadata }).from(auditEvents));
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining([
      "lab_template.created", "lab_template.version_created", "grading_spec.created",
      "assignment.created", "assignment.published", "assignment.student_assigned",
      "lab_instance.created", "lab_instance.saved", "submission.created", "submission.verified", "submission.result_viewed",
    ]));
    // Audit metadata never carries a full lab document.
    for (const event of events) expect(JSON.stringify(event.metadata)).not.toContain("topology");
  });
});

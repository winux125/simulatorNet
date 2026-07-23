import { Writable } from "node:stream";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  auditEvents,
  createDatabase,
  PlatformAdminRepository,
  TenantRepository,
  type DatabaseClient,
  type TenantContext,
} from "@sim/db";
import { buildApi } from "../src/app";
import { createServiceTokenVerifier } from "../src/jwt";
import { ServiceAuthenticator } from "../src/service-auth";
import { verificationRequest } from "../../../packages/grading-core/test/fixtures";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const issuer = "https://oidc.local.test/realms/simulatornet";
const audience = "simulatornet-api";
const webOrigin = "http://127.0.0.1:4173";
const allScopes = ["users:read", "users:write", "memberships:write", "launch:write", "labs:validate", "verifications:write"];

let client: DatabaseClient;
let privateKey: CryptoKey;
let publicJwk: JWK;
let authenticator: ServiceAuthenticator;

async function signedToken(azp: string, scopes = allScopes, overrides: { issuer?: string; audience?: string; expiration?: string | number } = {}) {
  return new SignJWT({ azp, scope: scopes.join(" "), typ: "Bearer" })
    .setProtectedHeader({ alg: "RS256", kid: "integration-key", typ: "JWT" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject(`service-account-${azp}`)
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? "5m")
    .sign(privateKey);
}

async function createTenant(slug: string, allowedScopes = allScopes, allowedReturnUrls = [webOrigin, "https://academy.example.test"]) {
  const organization = await new PlatformAdminRepository(client.db).createOrganization({ slug, name: `${slug} Organization` });
  const context: TenantContext = { organizationId: organization.id, actor: { kind: "system", id: "integration-test" } };
  const repository = new TenantRepository(client.db);
  const integrationClient = await repository.createIntegrationClientMapping(context, {
    keycloakClientId: `${slug}-client`,
    name: `${slug} client`,
    allowedScopes,
    allowedReturnUrls,
  });
  return { organization, context, repository, integrationClient, token: await signedToken(`${slug}-client`) };
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function cookieFrom(response: { headers: { "set-cookie"?: string | string[] | number } }): string {
  const value = response.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
  if (!first) throw new Error("response has no cookie");
  return first.split(";", 1)[0]!;
}

integration("M8 authenticated API", () => {
  beforeAll(async () => {
    client = createDatabase({ connectionString: databaseUrl!, maxConnections: 6, applicationName: "simulatornet-auth-tests" });
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...await exportJWK(pair.publicKey), kid: "integration-key", alg: "RS256", use: "sig" };
    authenticator = new ServiceAuthenticator(client.db, createServiceTokenVerifier({
      issuer,
      audience,
      keySet: createLocalJWKSet({ keys: [publicJwk] }),
    }));
  });

  beforeEach(async () => {
    await client.pool.query("truncate table audit_events, browser_sessions, launch_codes, external_user_links, integration_clients, organization_memberships, user_identities, users, organizations restart identity cascade");
  });

  afterAll(async () => client.close());

  it("runs the complete service-to-browser launch and logout scenario", async () => {
    const tenant = await createTenant("full-flow");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator, webOrigin, publicWebUrl: webOrigin });
    const upsert = await app.inject({
      method: "PUT", url: "/v1/integrations/users/external-user-123", headers: authHeader(tenant.token),
      payload: { email: "student@example.kz", displayName: "Student Name", organizationId: "attacker-value" },
    });
    expect(upsert.statusCode).toBe(200);
    const membership = await app.inject({
      method: "PUT", url: "/v1/integrations/users/external-user-123/membership", headers: authHeader(tenant.token), payload: { role: "student" },
    });
    expect(membership.json()).toMatchObject({ role: "student" });
    const launch = await app.inject({
      method: "POST", url: "/v1/launch-sessions", headers: authHeader(tenant.token),
      payload: { externalUserId: "external-user-123", returnUrl: `${webOrigin}/course/ccna`, requestedRole: "organization_admin" },
    });
    expect(launch.statusCode).toBe(200);
    const code = new URL(launch.json().launchUrl).searchParams.get("code");
    expect(code).toBeTruthy();
    const exchange = await app.inject({
      method: "POST", url: "/v1/session/launch-exchange", headers: { origin: webOrigin, "content-type": "application/json" }, payload: { code },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json()).toMatchObject({ role: "student", organization: { id: tenant.organization.id } });
    expect(exchange.headers["set-cookie"]).toContain("HttpOnly");
    expect(exchange.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(exchange.headers["set-cookie"]).toContain("Max-Age=28800");
    const cookie = cookieFrom(exchange);
    const me = await app.inject({ method: "GET", url: "/v1/session/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ kind: "user-session", organizationId: tenant.organization.id, role: "student", displayName: "Student Name" });
    const reused = await app.inject({
      method: "POST", url: "/v1/session/launch-exchange", headers: { origin: webOrigin, "content-type": "application/json" }, payload: { code },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ error: { code: "INVALID_LAUNCH_CODE" } });
    const logout = await app.inject({ method: "POST", url: "/v1/session/logout", headers: { origin: webOrigin, cookie, "content-type": "application/json" }, payload: {} });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await app.inject({ method: "GET", url: "/v1/session/me", headers: { cookie } })).statusCode).toBe(401);
    const actions = (await client.db.select({ action: auditEvents.action }).from(auditEvents)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining([
      "integration.user.created", "membership.changed", "launch.created", "launch.consumed", "session.created", "launch.rejected", "session.revoked",
    ]));
    await app.close();
  });

  it("derives tenant only from verified azp and cannot read another organization", async () => {
    const first = await createTenant("tenant-first");
    const second = await createTenant("tenant-second");
    const secondUser = await second.repository.upsertExternalUser(second.context, second.integrationClient.id, "shared-user", {
      email: "second@example.test", displayName: "Second Tenant User",
    });
    await second.repository.setOrganizationMembership(second.context, secondUser.userId, "student");
    const secondOnly = await second.repository.upsertExternalUser(second.context, second.integrationClient.id, "only-second", {
      email: "only-second@example.test", displayName: "Second Only",
    });
    await second.repository.setOrganizationMembership(second.context, secondOnly.userId, "student");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator });
    const response = await app.inject({
      method: "PUT", url: "/v1/integrations/users/shared-user", headers: authHeader(first.token),
      payload: { email: "first@example.test", displayName: "First Tenant User", organizationId: second.organization.id },
    });
    expect(response.statusCode).toBe(200);
    expect((await first.repository.getExternalUser(first.context, first.integrationClient.id, "shared-user"))?.displayName).toBe("First Tenant User");
    expect((await second.repository.getExternalUser(second.context, second.integrationClient.id, "shared-user"))?.displayName).toBe("Second Tenant User");
    const crossRead = await app.inject({ method: "GET", url: "/v1/integrations/users/only-second", headers: { authorization: `Bearer ${first.token}` } });
    expect(crossRead.statusCode).toBe(404);
    await app.close();
  });

  it("rejects platform_admin assignment through the integration endpoint", async () => {
    const tenant = await createTenant("role-policy");
    await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "user", { email: "u@example.test", displayName: "User" });
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator });
    const response = await app.inject({
      method: "PUT", url: "/v1/integrations/users/user/membership", headers: authHeader(tenant.token), payload: { role: "platform_admin" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects open redirects, protocol-relative URLs, credentials and insecure production URLs", async () => {
    const tenant = await createTenant("redirects");
    const user = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "user", { email: "u@example.test", displayName: "User" });
    await tenant.repository.setOrganizationMembership(tenant.context, user.userId, "student");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator, production: true, publicWebUrl: "https://labs.example.test", webOrigin: "https://labs.example.test" });
    for (const returnUrl of ["https://evil.example.test", "//academy.example.test/path", "https://user:pass@academy.example.test/path", "http://127.0.0.1:4173/path"]) {
      const response = await app.inject({
        method: "POST", url: "/v1/launch-sessions", headers: authHeader(tenant.token), payload: { externalUserId: "user", returnUrl },
      });
      expect(response.statusCode, returnUrl).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "RETURN_URL_NOT_ALLOWED" } });
    }
    await app.close();
  });

  it("rejects expired launch codes without exposing validity detail", async () => {
    const tenant = await createTenant("expired");
    const user = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "user", { email: "u@example.test", displayName: "User" });
    await tenant.repository.setOrganizationMembership(tenant.context, user.userId, "student");
    let clock = new Date("2030-01-01T00:00:00.000Z");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator, webOrigin, publicWebUrl: webOrigin, now: () => clock });
    const launch = await app.inject({ method: "POST", url: "/v1/launch-sessions", headers: authHeader(tenant.token), payload: { externalUserId: "user", returnUrl: webOrigin } });
    const code = new URL(launch.json().launchUrl).searchParams.get("code");
    clock = new Date("2030-01-01T00:01:01.000Z");
    const response = await app.inject({ method: "POST", url: "/v1/session/launch-exchange", headers: { origin: webOrigin, "content-type": "application/json" }, payload: { code } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_LAUNCH_CODE" } });
    await app.close();
  });

  it("sets Secure in production and does not log tokens, codes or launch URLs", async () => {
    const tenant = await createTenant("secure-cookie", allScopes, ["https://academy.example.test"]);
    const user = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "user", { email: "u@example.test", displayName: "User" });
    await tenant.repository.setOrganizationMembership(tenant.context, user.userId, "student");
    let logs = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } });
    const app = await buildApi({
      database: client.db, serviceAuthenticator: authenticator, production: true,
      publicWebUrl: "https://labs.example.test", webOrigin: "https://labs.example.test",
      logger: { level: "info", stream },
    });
    const launch = await app.inject({
      method: "POST", url: "/v1/launch-sessions", headers: authHeader(tenant.token), payload: { externalUserId: "user", returnUrl: "https://academy.example.test/course" },
    });
    const launchUrl = launch.json().launchUrl as string;
    const code = new URL(launchUrl).searchParams.get("code")!;
    const exchange = await app.inject({
      method: "POST", url: "/v1/session/launch-exchange", headers: { origin: "https://labs.example.test", "content-type": "application/json" }, payload: { code },
    });
    expect(exchange.headers["set-cookie"]).toContain("Secure");
    await app.close();
    expect(logs).not.toContain(tenant.token);
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(launchUrl);
  });

  it("invalidates sessions when membership or organization becomes inactive", async () => {
    const tenant = await createTenant("session-policy");
    const user = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "user", { email: "u@example.test", displayName: "User" });
    await tenant.repository.setOrganizationMembership(tenant.context, user.userId, "student");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator, webOrigin, publicWebUrl: webOrigin });
    const createSession = async () => {
      const launch = await app.inject({ method: "POST", url: "/v1/launch-sessions", headers: authHeader(tenant.token), payload: { externalUserId: "user", returnUrl: webOrigin } });
      const code = new URL(launch.json().launchUrl).searchParams.get("code");
      return app.inject({ method: "POST", url: "/v1/session/launch-exchange", headers: { origin: webOrigin, "content-type": "application/json" }, payload: { code } });
    };
    const first = await createSession();
    await tenant.repository.setOrganizationMembershipStatus(tenant.context, user.userId, "inactive");
    expect((await app.inject({ method: "GET", url: "/v1/session/me", headers: { cookie: cookieFrom(first) } })).statusCode).toBe(401);
    await tenant.repository.setOrganizationMembershipStatus(tenant.context, user.userId, "active");
    const second = await createSession();
    await new PlatformAdminRepository(client.db).setOrganizationStatus(tenant.organization.id, "suspended");
    expect((await app.inject({ method: "GET", url: "/v1/session/me", headers: { cookie: cookieFrom(second) } })).statusCode).toBe(401);
    await app.close();
  });

  it("protects verification with the effective local scope and rejects anonymous browsers", async () => {
    const allowed = await createTenant("verify-allowed", ["verifications:write"]);
    const denied = await createTenant("verify-denied", []);
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator });
    const ok = await app.inject({ method: "POST", url: "/v1/verifications", headers: authHeader(allowed.token), payload: verificationRequest() });
    expect(ok.statusCode).toBe(200);
    const noLocalPermission = await app.inject({ method: "POST", url: "/v1/verifications", headers: authHeader(denied.token), payload: verificationRequest() });
    expect(noLocalPermission.statusCode).toBe(403);
    expect(noLocalPermission.json()).toMatchObject({ error: { code: "AUTH_INSUFFICIENT_SCOPE" } });
    expect(noLocalPermission.headers["www-authenticate"]).toContain("insufficient_scope");
    const anonymous = await app.inject({ method: "POST", url: "/v1/verifications", payload: verificationRequest() });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toContain("invalid_token");
    await app.close();
  });

  it("maps unknown, disabled and suspended service clients to stable auth errors", async () => {
    const tenant = await createTenant("auth-state");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator });
    const unknown = await app.inject({ method: "GET", url: "/v1/integrations/users/user", headers: { authorization: `Bearer ${await signedToken("unknown-client")}` } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ error: { code: "AUTH_UNKNOWN_CLIENT" } });
    await tenant.repository.disableIntegrationClient(tenant.context, tenant.integrationClient.id);
    const disabled = await app.inject({ method: "GET", url: "/v1/integrations/users/user", headers: { authorization: `Bearer ${tenant.token}` } });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({ error: { code: "AUTH_DISABLED_CLIENT" } });
    const suspended = await createTenant("suspended-client");
    await new PlatformAdminRepository(client.db).setOrganizationStatus(suspended.organization.id, "suspended");
    const suspendedResponse = await app.inject({ method: "GET", url: "/v1/integrations/users/user", headers: { authorization: `Bearer ${suspended.token}` } });
    expect(suspendedResponse.statusCode).toBe(403);
    expect(suspendedResponse.json()).toMatchObject({ error: { code: "ORG_SUSPENDED" } });
    await app.close();
  });

  it("allows exactly one concurrent launch exchange", async () => {
    const tenant = await createTenant("exchange-race");
    const user = await tenant.repository.upsertExternalUser(tenant.context, tenant.integrationClient.id, "user", { email: "u@example.test", displayName: "User" });
    await tenant.repository.setOrganizationMembership(tenant.context, user.userId, "student");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator, webOrigin, publicWebUrl: webOrigin });
    const launch = await app.inject({ method: "POST", url: "/v1/launch-sessions", headers: authHeader(tenant.token), payload: { externalUserId: "user", returnUrl: webOrigin } });
    const code = new URL(launch.json().launchUrl).searchParams.get("code");
    const request = () => app.inject({ method: "POST" as const, url: "/v1/session/launch-exchange", headers: { origin: webOrigin, "content-type": "application/json" }, payload: { code } });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    await app.close();
  });

  it("enforces the public exchange rate limit and does not enable permissive CORS", async () => {
    await createTenant("rate-limit");
    const app = await buildApi({ database: client.db, serviceAuthenticator: authenticator, webOrigin, rateLimits: { launchExchange: 1 } });
    const request = () => app.inject({
      method: "POST" as const, url: "/v1/session/launch-exchange", headers: { origin: webOrigin, "content-type": "application/json" }, payload: { code: "x".repeat(43) },
    });
    expect((await request()).statusCode).toBe(400);
    const limited = await request();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    expect(limited.headers["access-control-allow-origin"]).toBeUndefined();
    const wrongOrigin = await app.inject({ method: "POST", url: "/v1/session/logout", headers: { origin: "https://evil.example", "content-type": "application/json" }, payload: {} });
    expect(wrongOrigin.statusCode).toBe(403);
    await app.close();
  });
});

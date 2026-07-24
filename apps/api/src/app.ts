import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import type { ServiceScope } from "@sim/authz";
import { LabDocumentSchema, MAX_DIAGRAM_DOCUMENT_JSON_BYTES } from "@sim/contracts";
import {
  AuthenticationAuditRepository,
  AuthenticationLookupRepository,
  createDatabase,
  createOpaqueToken,
  DatabaseConflictError,
  DatabaseForbiddenError,
  DatabaseInvalidInputError,
  DatabaseNotFoundError,
  hashOpaqueToken,
  PlatformAdminRepository,
  TenantRepository,
  type DatabaseClient,
  type SimulatorDatabase,
  type TenantContext,
} from "@sim/db";
import { DEFAULT_VERIFICATION_LIMITS, VerificationError, type VerificationLimits } from "@sim/grading-core";
import { canonicalizeLabDocument, parseLabDocument } from "@sim/lab-format";
import { executeVerification } from "@simulatornet/verifier";
import Fastify, { type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { AuthenticationError, bearerChallenge } from "./auth-errors";
import { createServiceTokenVerifier } from "./jwt";
import { FixedWindowRateLimiter } from "./rate-limit";
import {
  ServiceAuthenticator,
  requireServiceScope,
  type ServiceAuthenticatorLike,
  type ServicePrincipal,
} from "./service-auth";
import { AcademicApiError, registerAcademicRoutes } from "./academic";
import { resolveUserSession, SESSION_COOKIE } from "./session";

export type { UserSessionPrincipal } from "./session";

const LAUNCH_TTL_MS = 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;

const ExternalUserBodySchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(1).max(200),
});
const ExternalUserParamsSchema = z.object({ externalUserId: z.string().min(1).max(200) });
const MembershipBodySchema = z.object({ role: z.enum(["student", "instructor", "organization_admin"]) });
const LaunchBodySchema = z.object({
  externalUserId: z.string().min(1).max(200),
  returnUrl: z.string().min(1).max(2_048),
  requestedRole: z.enum(["student", "instructor", "organization_admin"]).optional(),
});
const LaunchExchangeSchema = z.object({ code: z.string().min(32).max(256) });

declare module "fastify" {
  interface FastifyRequest {
    servicePrincipal?: ServicePrincipal;
  }
}

export interface ApiRateLimits {
  readonly integrationWrites: number;
  readonly launchCreation: number;
  readonly launchExchange: number;
  readonly verification: number;
  readonly browserSessionWrites: number;
  readonly windowMs: number;
}

export interface ApiOptions {
  logger?: FastifyServerOptions["logger"];
  bodyLimit?: number;
  verificationLimits?: VerificationLimits;
  database?: SimulatorDatabase;
  serviceAuthenticator?: ServiceAuthenticatorLike;
  keycloak?: { issuer: string; audience: string; jwksUrl: string };
  webOrigin?: string;
  publicWebUrl?: string;
  production?: boolean;
  openApiEnabled?: boolean;
  rateLimits?: Partial<ApiRateLimits>;
  now?: () => Date;
}

const DEFAULT_RATE_LIMITS: ApiRateLimits = {
  integrationWrites: 120,
  launchCreation: 30,
  launchExchange: 20,
  verification: 20,
  browserSessionWrites: 60,
  windowMs: 60_000,
};

function validationIssues(error: unknown): Array<{ path: string; message: string }> {
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    return error.issues.map((issue: { path?: unknown[]; message?: string }) => ({
      path: issue.path?.join(".") ?? "",
      message: issue.message ?? "Invalid value",
    }));
  }
  return [{ path: "", message: error instanceof Error ? error.message : "Invalid lab document" }];
}

function requireDatabase(database: SimulatorDatabase | undefined): SimulatorDatabase {
  if (!database) throw new Error("Database is not configured");
  return database;
}

function requireAuthenticator(authenticator: ServiceAuthenticatorLike | undefined): ServiceAuthenticatorLike {
  if (!authenticator) throw new Error("Service authentication is not configured");
  return authenticator;
}

function tenantContext(principal: ServicePrincipal): TenantContext {
  return {
    organizationId: principal.organizationId,
    actor: { kind: "service", id: principal.keycloakClientId },
  };
}

function assertOrigin(request: FastifyRequest, allowedOrigin: string): void {
  const origin = request.headers.origin;
  if (origin !== allowedOrigin) {
    throw new AuthenticationError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed", 403);
  }
}

function validateReturnUrl(raw: string, allowedUrls: readonly string[], production: boolean): string {
  if (raw.startsWith("//")) throw new AuthenticationError("RETURN_URL_NOT_ALLOWED", "Return URL is not allowed", 400);
  let url: URL;
  try { url = new URL(raw); } catch { throw new AuthenticationError("RETURN_URL_NOT_ALLOWED", "Return URL is not allowed", 400); }
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && !production && isLoopback(url.hostname)))) {
    throw new AuthenticationError("RETURN_URL_NOT_ALLOWED", "Return URL is not allowed", 400);
  }
  const origins = allowedUrls.flatMap((allowed) => {
    try { return [new URL(allowed).origin]; } catch { return []; }
  });
  if (!origins.includes(url.origin)) throw new AuthenticationError("RETURN_URL_NOT_ALLOWED", "Return URL is not allowed", 400);
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export async function buildApi(options: ApiOptions = {}) {
  const limits = options.verificationLimits ?? DEFAULT_VERIFICATION_LIMITS;
  const production = options.production ?? process.env.NODE_ENV === "production";
  const openApiEnabled = options.openApiEnabled ?? !production;
  const webOrigin = options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://127.0.0.1:4173";
  const publicWebUrl = (options.publicWebUrl ?? process.env.PUBLIC_WEB_URL ?? webOrigin).replace(/\/$/u, "");
  const now = options.now ?? (() => new Date());
  const rateConfig = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const integrationLimiter = new FixedWindowRateLimiter(rateConfig.integrationWrites, rateConfig.windowMs);
  const launchLimiter = new FixedWindowRateLimiter(rateConfig.launchCreation, rateConfig.windowMs);
  const exchangeLimiter = new FixedWindowRateLimiter(rateConfig.launchExchange, rateConfig.windowMs);
  const verificationLimiter = new FixedWindowRateLimiter(rateConfig.verification, rateConfig.windowMs);
  const browserSessionLimiter = new FixedWindowRateLimiter(rateConfig.browserSessionWrites, rateConfig.windowMs);

  let ownedDatabase: DatabaseClient | undefined;
  if (!options.database && process.env.DATABASE_URL) {
    ownedDatabase = createDatabase({ connectionString: process.env.DATABASE_URL, applicationName: "simulatornet-api" });
  }
  const database = options.database ?? ownedDatabase?.db;
  const verifier = options.keycloak ? createServiceTokenVerifier(options.keycloak) : undefined;
  const authenticator = options.serviceAuthenticator ?? (database && verifier ? new ServiceAuthenticator(database, verifier) : undefined);

  const app = Fastify({
    logger: options.logger ?? false,
    // Academic LabDocuments may contain bounded embedded diagram images.
    // Verification still applies its tighter, independent payload limit.
    bodyLimit: options.bodyLimit ?? Math.max(limits.maximumJsonPayloadBytes, MAX_DIAGRAM_DOCUMENT_JSON_BYTES),
  });
  await app.register(cookie);
  if (openApiEnabled) {
    await app.register(swagger, {
      openapi: {
        info: { title: "SimulatorNet Internal API", version: "1.0.0" },
        tags: [{ name: "system" }, { name: "integrations" }, { name: "sessions" }, { name: "labs" }, { name: "verifications" }, { name: "academic", description: "Instructor and student academic surfaces (session-authenticated)." }],
      },
    });
  }

  if (ownedDatabase) app.addHook("onClose", async () => ownedDatabase?.close());
  app.addHook("onRequest", async (request) => {
    if (request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH") return;
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType === "application/json" || contentType?.endsWith("+json")) return;
    const error = new Error("Unsupported Media Type") as Error & { code: string; statusCode: number };
    error.code = "FST_ERR_CTP_INVALID_MEDIA_TYPE";
    error.statusCode = 415;
    throw error;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const errorRecord = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
    const fastifyCode = typeof errorRecord.code === "string" ? errorRecord.code : undefined;
    let statusCode = typeof errorRecord.statusCode === "number" ? errorRecord.statusCode : 500;
    let code = "internal-error";
    let details: unknown;
    if (error instanceof AuthenticationError) {
      statusCode = error.statusCode;
      code = error.code;
      const challenge = bearerChallenge(error);
      if (challenge) reply.header("www-authenticate", challenge);
    } else if (error instanceof AcademicApiError) {
      statusCode = error.statusCode;
      code = error.code;
      details = error.details;
    } else if (error instanceof VerificationError) {
      statusCode = error.code === "resource-limit" ? 422 : 400;
      code = error.code;
      details = error.details;
    } else if (error instanceof DatabaseNotFoundError) {
      statusCode = 404;
      code = error.code;
    } else if (error instanceof DatabaseForbiddenError) {
      statusCode = 403;
      code = error.code;
    } else if (error instanceof DatabaseConflictError) {
      statusCode = 409;
      code = error.code;
    } else if (error instanceof DatabaseInvalidInputError) {
      statusCode = 400;
      code = "invalid-request";
      details = error.details;
    } else if (error instanceof z.ZodError) {
      statusCode = 400;
      code = "invalid-request";
      details = validationIssues(error);
    } else if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      statusCode = 413;
      code = "payload-too-large";
    } else if (fastifyCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      statusCode = 415;
      code = "unsupported-media-type";
    } else if (statusCode < 500) {
      code = "invalid-request";
    }
    request.log.warn({ code, statusCode }, "request failed");
    void reply.status(statusCode).send({
      error: {
        code,
        message: statusCode >= 500 ? "Internal server error" : error instanceof Error ? error.message : "Invalid request",
        requestId: request.id,
        ...(details ? { details } : {}),
      },
    });
  });

  const serviceGuard = (scope: ServiceScope, limiter?: FixedWindowRateLimiter) => async (request: FastifyRequest) => {
    const serviceAuth = requireAuthenticator(authenticator);
    const principal = await serviceAuth.authenticate(request.headers.authorization, request.id);
    await requireServiceScope(serviceAuth, principal, scope, request.id);
    limiter?.consume(`${scope}:${principal.keycloakClientId}`);
    request.servicePrincipal = principal;
  };

  app.get("/health", {
    schema: { tags: ["system"], response: { 200: { type: "object", properties: { status: { const: "ok" } }, required: ["status"] } } },
  }, async () => ({ status: "ok" as const }));
  app.get("/ready", {
    schema: { tags: ["system"], response: { 200: { type: "object", properties: { status: { const: "ready" } }, required: ["status"] } } },
  }, async () => ({ status: "ready" as const }));

  app.put("/v1/integrations/users/:externalUserId", {
    preHandler: serviceGuard("users:write", integrationLimiter),
    schema: { tags: ["integrations"], body: { type: "object", required: ["email", "displayName"] } },
  }, async (request) => {
    const principal = request.servicePrincipal!;
    const params = ExternalUserParamsSchema.parse(request.params);
    const body = ExternalUserBodySchema.parse(request.body);
    const repository = new TenantRepository(requireDatabase(database));
    const context = tenantContext(principal);
    const existing = await repository.getExternalUser(context, principal.integrationClientId, params.externalUserId);
    const user = await repository.upsertExternalUser(context, principal.integrationClientId, params.externalUserId, body);
    await repository.recordAuditEvent(context, {
      action: existing ? "integration.user.updated" : "integration.user.created",
      resourceType: "user",
      resourceId: user.userId,
      requestId: request.id,
      metadata: { externalUserId: params.externalUserId },
    });
    return { id: user.userId, externalUserId: user.externalUserId, email: user.email, displayName: user.displayName, status: user.status };
  });

  app.get("/v1/integrations/users/:externalUserId", {
    preHandler: serviceGuard("users:read"),
    schema: { tags: ["integrations"] },
  }, async (request, reply) => {
    const principal = request.servicePrincipal!;
    const params = ExternalUserParamsSchema.parse(request.params);
    const repository = new TenantRepository(requireDatabase(database));
    const context = tenantContext(principal);
    const user = await repository.getExternalUser(context, principal.integrationClientId, params.externalUserId);
    if (!user) return reply.status(404).send({ error: { code: "DB_NOT_FOUND", message: "External user was not found", requestId: request.id } });
    const membership = await repository.getOrganizationMembership(context, user.userId);
    return {
      id: user.userId,
      externalUserId: user.externalUserId,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      membership: membership ? { role: membership.role, status: membership.status } : null,
    };
  });

  app.put("/v1/integrations/users/:externalUserId/membership", {
    preHandler: serviceGuard("memberships:write", integrationLimiter),
    schema: { tags: ["integrations"], body: { type: "object", required: ["role"] } },
  }, async (request) => {
    const principal = request.servicePrincipal!;
    const params = ExternalUserParamsSchema.parse(request.params);
    const body = MembershipBodySchema.parse(request.body);
    const repository = new TenantRepository(requireDatabase(database));
    const context = tenantContext(principal);
    const user = await repository.getExternalUser(context, principal.integrationClientId, params.externalUserId);
    if (!user) throw new DatabaseNotFoundError("External user was not found");
    const membership = await repository.setOrganizationMembership(context, user.userId, body.role);
    await repository.recordAuditEvent(context, {
      action: "membership.changed",
      resourceType: "membership",
      resourceId: user.userId,
      requestId: request.id,
      metadata: { role: membership.role },
    });
    return { userId: user.userId, role: membership.role, status: membership.status };
  });

  app.post("/v1/launch-sessions", {
    preHandler: serviceGuard("launch:write", launchLimiter),
    schema: { tags: ["integrations"], body: { type: "object", required: ["externalUserId", "returnUrl"] } },
  }, async (request) => {
    const principal = request.servicePrincipal!;
    const body = LaunchBodySchema.parse(request.body);
    const db = requireDatabase(database);
    const repository = new TenantRepository(db);
    const context = tenantContext(principal);
    const integration = await repository.getIntegrationClient(context, principal.integrationClientId);
    if (!integration || integration.status !== "active") throw new AuthenticationError("AUTH_DISABLED_CLIENT", "Service client is disabled", 403);
    const returnUrl = validateReturnUrl(body.returnUrl, integration.allowedReturnUrls, production);
    const user = await repository.getExternalUser(context, principal.integrationClientId, body.externalUserId);
    if (!user) throw new DatabaseNotFoundError("External user was not found");
    const membership = await repository.getOrganizationMembership(context, user.userId);
    if (!membership || membership.status !== "active") throw new DatabaseForbiddenError("User has no active organization membership");
    const launch = createOpaqueToken();
    const expiresAt = new Date(now().getTime() + LAUNCH_TTL_MS);
    const record = await repository.createLaunchCode(context, {
      userId: user.userId,
      integrationClientId: principal.integrationClientId,
      codeHash: launch.hash,
      returnUrl,
      expiresAt,
    });
    await repository.recordAuditEvent(context, {
      action: "launch.created",
      resourceType: "launch-code",
      resourceId: record.id,
      requestId: request.id,
      metadata: { userId: user.userId, returnOrigin: new URL(returnUrl).origin },
    });
    return { launchUrl: `${publicWebUrl}/launch?code=${encodeURIComponent(launch.value)}`, expiresAt: expiresAt.toISOString() };
  });

  app.post("/v1/session/launch-exchange", {
    schema: { tags: ["sessions"], body: { type: "object", required: ["code"] } },
  }, async (request, reply) => {
    assertOrigin(request, webOrigin);
    exchangeLimiter.consume(`launch-exchange:${request.ip}`);
    const body = LaunchExchangeSchema.parse(request.body);
    const db = requireDatabase(database);
    const lookup = new AuthenticationLookupRepository(db);
    const audit = new AuthenticationAuditRepository(db);
    const codeHash = hashOpaqueToken(body.code);
    const found = await lookup.findLaunchCode(codeHash);
    if (!found) {
      await audit.record({ action: "launch.rejected", resourceType: "launch-code", requestId: request.id, metadata: { reason: "invalid" } });
      throw new AuthenticationError("INVALID_LAUNCH_CODE", "Launch code is invalid", 400);
    }
    const context: TenantContext = { organizationId: found.organizationId, actor: { kind: "system", id: "launch-exchange" } };
    const repository = new TenantRepository(db);
    const consumed = await repository.consumeLaunchCode(context, codeHash, now());
    if (!consumed) {
      const reason = found.consumedAt ? "reused" : found.expiresAt <= now() ? "expired" : "invalid";
      await repository.recordAuditEvent(context, { action: "launch.rejected", resourceType: "launch-code", requestId: request.id, metadata: { reason } });
      throw new AuthenticationError("INVALID_LAUNCH_CODE", "Launch code is invalid", 400);
    }
    const organization = await new PlatformAdminRepository(db).getOrganizationById(context.organizationId);
    const member = await repository.getOrganizationUser(context, consumed.userId);
    if (!organization || organization.status !== "active" || !member || member.user.status !== "active" || member.membership.status !== "active") {
      await repository.recordAuditEvent(context, { action: "launch.rejected", resourceType: "launch-code", resourceId: consumed.id, requestId: request.id, metadata: { reason: "inactive-principal" } });
      throw new AuthenticationError("INVALID_LAUNCH_CODE", "Launch code is invalid", 400);
    }
    const sessionToken = createOpaqueToken();
    const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
    const session = await repository.createBrowserSession(context, { userId: consumed.userId, tokenHash: sessionToken.hash, expiresAt });
    reply.setCookie(SESSION_COOKIE, sessionToken.value, {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1_000,
    });
    await repository.recordAuditEvent(context, { action: "launch.consumed", resourceType: "launch-code", resourceId: consumed.id, requestId: request.id });
    await repository.recordAuditEvent(context, { action: "session.created", resourceType: "browser-session", resourceId: session.id, requestId: request.id, metadata: { userId: consumed.userId } });
    return {
      user: { id: member.user.id, displayName: member.user.displayName },
      organization: { id: organization.id, name: organization.name },
      role: member.membership.role,
      returnUrl: consumed.returnUrl,
    };
  });

  app.get("/v1/session/me", { schema: { tags: ["sessions"] } }, async (request) => {
    return resolveUserSession(request, requireDatabase(database), now());
  });

  app.post("/v1/session/logout", { schema: { tags: ["sessions"] } }, async (request, reply) => {
    assertOrigin(request, webOrigin);
    const db = requireDatabase(database);
    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const tokenHash = hashOpaqueToken(raw);
      const organizationId = await new AuthenticationLookupRepository(db).findBrowserSessionOrganizationId(tokenHash);
      if (organizationId) {
        const lookupContext: TenantContext = { organizationId, actor: { kind: "system", id: "browser-session-revocation" } };
        const repository = new TenantRepository(db);
        const session = await repository.getBrowserSession(lookupContext, tokenHash, now());
        if (session) {
          browserSessionLimiter.consume(`session:${session.id}`);
          const userContext: TenantContext = { organizationId, actor: { kind: "user", id: session.userId } };
          const revoked = await repository.revokeBrowserSession(userContext, tokenHash, now());
          if (revoked) await repository.recordAuditEvent(userContext, { action: "session.revoked", resourceType: "browser-session", resourceId: revoked.id, requestId: request.id });
        }
      }
    }
    reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: production, sameSite: "lax", path: "/" });
    return { loggedOut: true };
  });

  app.post("/v1/labs/validate", {
    preHandler: serviceGuard("labs:validate"),
    schema: { tags: ["labs"], description: "Validate and canonicalize a schema-v1 LabDocument.", body: { type: "object" } },
  }, async (request) => {
    const shape = LabDocumentSchema.safeParse(request.body);
    if (!shape.success) return { valid: false, errors: validationIssues(shape.error) };
    try {
      const canonicalDocument = canonicalizeLabDocument(parseLabDocument(shape.data));
      return { valid: true, canonicalDocument, errors: [] };
    } catch (error) {
      return { valid: false, errors: validationIssues(error) };
    }
  });

  app.post("/v1/verifications", {
    preHandler: serviceGuard("verifications:write", verificationLimiter),
    schema: {
      tags: ["verifications"],
      description: "INTERNAL endpoint accepting direct gradingSpec input. Never expose to student browser sessions.",
      body: { type: "object", required: ["submission", "gradingSpec"] },
    },
  }, async (request) => {
    const principal = request.servicePrincipal!;
    if (database) {
      await new TenantRepository(database).recordAuditEvent(tenantContext(principal), {
        action: "verification.requested",
        resourceType: "verification",
        requestId: request.id,
      });
    }
    const execution = executeVerification(request.body, limits);
    return { ...execution.result, server: { durationMs: execution.durationMs } };
  });

  registerAcademicRoutes(app, {
    database,
    authenticator,
    limits,
    now,
    webOrigin,
    verificationLimiter,
  });

  if (openApiEnabled) app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  await app.ready();
  return app;
}

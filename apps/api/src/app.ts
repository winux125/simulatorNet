import swagger from "@fastify/swagger";
import { LabDocumentSchema } from "@sim/contracts";
import { DEFAULT_VERIFICATION_LIMITS, VerificationError, type VerificationLimits } from "@sim/grading-core";
import { canonicalizeLabDocument, parseLabDocument } from "@sim/lab-format";
import { executeVerification } from "@simulatornet/verifier";
import Fastify, { type FastifyServerOptions } from "fastify";

export interface ApiOptions {
  logger?: FastifyServerOptions["logger"];
  bodyLimit?: number;
  verificationLimits?: VerificationLimits;
}

function validationIssues(error: unknown): Array<{ path: string; message: string }> {
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    return error.issues.map((issue: { path?: unknown[]; message?: string }) => ({
      path: issue.path?.join(".") ?? "",
      message: issue.message ?? "Invalid value",
    }));
  }
  return [{ path: "", message: error instanceof Error ? error.message : "Invalid lab document" }];
}

export async function buildApi(options: ApiOptions = {}) {
  const limits = options.verificationLimits ?? DEFAULT_VERIFICATION_LIMITS;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? limits.maximumJsonPayloadBytes,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "SimulatorNet Internal Verification API", version: "1.0.0" },
      tags: [{ name: "system" }, { name: "labs" }, { name: "verifications" }],
    },
  });

  app.addHook("onRequest", async (request) => {
    if (request.method !== "POST") return;
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
    if (error instanceof VerificationError) {
      statusCode = error.code === "resource-limit" ? 422 : 400;
      code = error.code;
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
        ...(error instanceof VerificationError && error.details ? { details: error.details } : {}),
      },
    });
  });

  app.get("/health", {
    schema: { tags: ["system"], response: { 200: { type: "object", properties: { status: { const: "ok" } }, required: ["status"] } } },
  }, async () => ({ status: "ok" as const }));

  app.get("/ready", {
    schema: { tags: ["system"], response: { 200: { type: "object", properties: { status: { const: "ready" } }, required: ["status"] } } },
  }, async () => ({ status: "ready" as const }));

  app.post("/v1/labs/validate", {
    schema: {
      tags: ["labs"],
      description: "Validate and canonicalize a schema-v1 LabDocument.",
      body: { type: "object" },
    },
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
    schema: {
      tags: ["verifications"],
      description: "INTERNAL M7 endpoint. Do not expose publicly before M8 authentication and assignment-owned hidden specs.",
      body: { type: "object", required: ["submission", "gradingSpec"] },
    },
  }, async (request) => {
    const execution = executeVerification(request.body, limits);
    return { ...execution.result, server: { durationMs: execution.durationMs } };
  });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  await app.ready();
  return app;
}

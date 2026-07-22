import { createCliSession } from "@sim/cli-engine";
import { buildLabFromDocument, serializeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { buildApi } from "../src/app";
import {
  demoLabDocument,
  gradingSpec,
  submissionFrom,
  verificationRequest,
} from "../../../packages/grading-core/test/fixtures";

const servicePrincipal = {
  kind: "service" as const,
  keycloakClientId: "m7-test-client",
  integrationClientId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  tokenScopes: new Set(["users:read", "users:write", "memberships:write", "launch:write", "labs:validate", "verifications:write"]),
  effectiveScopes: new Set(["users:read", "users:write", "memberships:write", "launch:write", "labs:validate", "verifications:write"]),
};

function buildM7Api(options: Parameters<typeof buildApi>[0] = {}) {
  return buildApi({ ...options, serviceAuthenticator: { authenticate: async () => servicePrincipal } });
}

describe("Fastify verification API", () => {
  it("reports health", async () => {
    const app = await buildM7Api();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });

  it("reports readiness", async () => {
    const app = await buildM7Api();
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    await app.close();
  });

  it("returns a canonical valid lab", async () => {
    const app = await buildM7Api();
    const response = await app.inject({ method: "POST", url: "/v1/labs/validate", payload: demoLabDocument() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: true, canonicalDocument: { id: "demo-router-on-a-stick" }, errors: [] });
    await app.close();
  });

  it("returns stable validation issues for an invalid lab", async () => {
    const app = await buildM7Api();
    const response = await app.inject({ method: "POST", url: "/v1/labs/validate", payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ valid: false, errors: expect.any(Array) });
    await app.close();
  });

  it("runs a valid verification request", async () => {
    const app = await buildM7Api();
    const response = await app.inject({ method: "POST", url: "/v1/verifications", payload: verificationRequest() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", score: 100, server: { durationMs: expect.any(Number) } });
    await app.close();
  });

  it("ignores a fake browser score", async () => {
    const app = await buildM7Api();
    const response = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      payload: { ...verificationRequest(), score: -500 },
    });
    expect(response.json().score).toBe(100);
    await app.close();
  });

  it("rejects an invalid grading specification", async () => {
    const app = await buildM7Api();
    const response = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      payload: { submission: submissionFrom(), gradingSpec: { schemaVersion: 1, id: "bad", checks: [{ type: "eval" }] } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid-grading-spec", requestId: expect.any(String) } });
    await app.close();
  });

  it("rejects an oversized payload before verification", async () => {
    const app = await buildM7Api({ bodyLimit: 256 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ submission: {}, gradingSpec: {}, padding: "x".repeat(512) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "payload-too-large" } });
    await app.close();
  });

  it("rejects unknown content types", async () => {
    const app = await buildM7Api();
    const response = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { "content-type": "text/plain" },
      payload: "not json",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: "unsupported-media-type" } });
    await app.close();
  });

  it("uses the same structured error envelope for malformed requests", async () => {
    const app = await buildM7Api();
    const response = await app.inject({ method: "POST", url: "/v1/verifications", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid-request",
        message: expect.any(String),
        requestId: expect.any(String),
      },
    });
    await app.close();
  });

  it("publishes an OpenAPI document", async () => {
    const app = await buildM7Api();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json().paths).toHaveProperty("/v1/verifications");
    await app.close();
  });

  it("does not publish OpenAPI when disabled for production", async () => {
    const app = await buildM7Api({ production: true, openApiEnabled: false });
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rebuilds a CLI-configured demo, reruns DHCP and scores routed ping end-to-end", async () => {
    const document = demoLabDocument();
    const switchConfig = document.configurations["switch-1"]!;
    if (switchConfig.kind !== "l2-switch") throw new Error("fixture mismatch");
    switchConfig.interfaces.find((iface) => iface.id === "Gi0/1")!.accessVlan = 1;
    const built = buildLabFromDocument(document);
    const cli = createCliSession(built.getSwitch("switch-1")!, built.engine);
    for (const command of [
      "enable",
      "configure terminal",
      "interface Gi0/1",
      "switchport mode access",
      "switchport access vlan 10",
      "end",
    ]) cli.execute(command);
    const configured = serializeLabDocument(built, { id: document.id, title: document.title });

    const app = await buildM7Api();
    const response = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      payload: { submission: submissionFrom(configured), gradingSpec: gradingSpec(), resultView: "instructor" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      score: 100,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "dhcp-pc1", status: "passed" }),
        expect.objectContaining({ id: "ping-pc1-pc2", status: "passed" }),
      ]),
    });
    await app.close();
  });
});

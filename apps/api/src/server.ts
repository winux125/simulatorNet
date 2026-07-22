import { buildApi } from "./app";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const issuer = required("KEYCLOAK_ISSUER");
const app = await buildApi({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "authorization",
        "cookie",
        "code",
        "launchUrl",
      ],
      censor: "[REDACTED]",
    },
  },
  keycloak: {
    issuer,
    audience: process.env.KEYCLOAK_AUDIENCE ?? "simulatornet-api",
    jwksUrl: process.env.KEYCLOAK_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`,
  },
  webOrigin: required("WEB_ORIGIN"),
  publicWebUrl: required("PUBLIC_WEB_URL"),
  production: process.env.NODE_ENV === "production",
  openApiEnabled: process.env.OPENAPI_ENABLED === "true" || process.env.NODE_ENV !== "production",
});
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "graceful shutdown");
  await app.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

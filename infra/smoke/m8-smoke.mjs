const keycloakBase = process.env.KEYCLOAK_PUBLIC_URL ?? "http://127.0.0.1:8080";
const apiBase = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";
const webOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:4173";
const secret = process.env.KAI_PLATFORM_CLIENT_SECRET;
if (!secret) throw new Error("KAI_PLATFORM_CLIENT_SECRET is required");

async function json(response, expected = 200) {
  const body = await response.json();
  if (response.status !== expected) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const tokenBody = new URLSearchParams({
  grant_type: "client_credentials",
  client_id: "kai-platform-dev",
  client_secret: secret,
  scope: "users:read users:write memberships:write launch:write labs:validate verifications:write",
});
const tokenResponse = await fetch(`${keycloakBase}/realms/simulatornet/protocol/openid-connect/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: tokenBody,
});
const tokenResult = await json(tokenResponse);
if (typeof tokenResult.access_token !== "string") throw new Error("Keycloak returned no access token");
const authorization = `Bearer ${tokenResult.access_token}`;
console.log("Keycloak client_credentials token acquired: [REDACTED]");

await json(await fetch(`${apiBase}/v1/integrations/users/smoke-student`, {
  method: "PUT",
  headers: { authorization, "content-type": "application/json" },
  body: JSON.stringify({ email: "smoke-student@kai.example", displayName: "Smoke Student" }),
}));
await json(await fetch(`${apiBase}/v1/integrations/users/smoke-student/membership`, {
  method: "PUT",
  headers: { authorization, "content-type": "application/json" },
  body: JSON.stringify({ role: "student" }),
}));
const launch = await json(await fetch(`${apiBase}/v1/launch-sessions`, {
  method: "POST",
  headers: { authorization, "content-type": "application/json" },
  body: JSON.stringify({ externalUserId: "smoke-student", returnUrl: `${webOrigin}/course/ccna`, requestedRole: "organization_admin" }),
}));
const code = new URL(launch.launchUrl).searchParams.get("code");
if (!code) throw new Error("Launch URL contained no code");
console.log("One-time launch URL created: [REDACTED]");

const exchangeResponse = await fetch(`${apiBase}/v1/session/launch-exchange`, {
  method: "POST",
  headers: { origin: webOrigin, "content-type": "application/json" },
  body: JSON.stringify({ code }),
});
const exchange = await json(exchangeResponse);
if (exchange.role !== "student") throw new Error("requestedRole incorrectly elevated membership");
const cookie = exchangeResponse.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie) throw new Error("Exchange returned no session cookie");
const me = await json(await fetch(`${apiBase}/v1/session/me`, { headers: { cookie } }));
if (me.role !== "student" || me.organizationName !== "KAI Development") throw new Error("Session principal mismatch");
await json(await fetch(`${apiBase}/v1/session/launch-exchange`, {
  method: "POST",
  headers: { origin: webOrigin, "content-type": "application/json" },
  body: JSON.stringify({ code }),
}), 400);
await json(await fetch(`${apiBase}/v1/session/logout`, {
  method: "POST",
  headers: { origin: webOrigin, cookie, "content-type": "application/json" },
  body: "{}",
}));
await json(await fetch(`${apiBase}/v1/session/me`, { headers: { cookie } }), 401);
console.log("M8 Keycloak → API → launch exchange → session → logout smoke passed");

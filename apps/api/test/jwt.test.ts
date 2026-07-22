import { createServer } from "node:http";
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthenticationError } from "../src/auth-errors";
import { createServiceTokenVerifier } from "../src/jwt";

const issuer = "https://issuer.example.test/realms/simulatornet";
const audience = "simulatornet-api";
let privateKey: CryptoKey;
let publicJwk: JWK;
let verifier: ReturnType<typeof createServiceTokenVerifier>;

async function token(overrides: {
  key?: CryptoKey;
  kid?: string;
  issuer?: string;
  audience?: string;
  expiration?: string | number;
  notBefore?: string | number;
  typ?: string;
  payloadType?: string;
  azp?: string;
  scope?: string;
} = {}) {
  const jwt = new SignJWT({
    azp: overrides.azp ?? "kai-platform-dev",
    scope: overrides.scope ?? "users:read launch:write",
    typ: overrides.payloadType ?? "Bearer",
  })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? "key-1", typ: overrides.typ ?? "JWT" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setSubject("service-account-kai")
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? "5m");
  if (overrides.notBefore !== undefined) jwt.setNotBefore(overrides.notBefore);
  return jwt.sign(overrides.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...await exportJWK(pair.publicKey), kid: "key-1", alg: "RS256", use: "sig" };
  verifier = createServiceTokenVerifier({ issuer, audience, keySet: createLocalJWKSet({ keys: [publicJwk] }) });
});

describe("OIDC service token verifier", () => {
  it("accepts a valid signed service token", async () => {
    await expect(verifier.verify(await token())).resolves.toMatchObject({
      keycloakClientId: "kai-platform-dev",
      scopes: new Set(["users:read", "launch:write"]),
    });
  });

  it("rejects an invalid signature", async () => {
    const other = await generateKeyPair("RS256");
    await expect(verifier.verify(await token({ key: other.privateKey }))).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
  });

  it("distinguishes wrong issuer", async () => {
    await expect(verifier.verify(await token({ issuer: "https://wrong.example.test" }))).rejects.toMatchObject({ code: "AUTH_WRONG_ISSUER", statusCode: 401 });
  });

  it("distinguishes wrong audience", async () => {
    await expect(verifier.verify(await token({ audience: "another-api" }))).rejects.toMatchObject({ code: "AUTH_WRONG_AUDIENCE", statusCode: 401 });
  });

  it("distinguishes expired tokens", async () => {
    await expect(verifier.verify(await token({ expiration: 1 }))).rejects.toMatchObject({ code: "AUTH_EXPIRED_TOKEN", statusCode: 401 });
  });

  it("rejects a token that is not active yet", async () => {
    await expect(verifier.verify(await token({ notBefore: "5m" }))).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
  });

  it("rejects invalid access-token types and missing azp", async () => {
    await expect(verifier.verify(await token({ payloadType: "ID" }))).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier.verify(await token({ typ: "at+jwt" }))).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await expect(verifier.verify(await token({ azp: "" }))).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
  });

  it("reloads a remote JWKS after signing-key rotation", async () => {
    const second = await generateKeyPair("RS256", { extractable: true });
    const secondJwk = { ...await exportJWK(second.publicKey), kid: "key-2", alg: "RS256", use: "sig" };
    let keys = [publicJwk];
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test JWKS server did not start");
    const remote = createServiceTokenVerifier({
      issuer,
      audience,
      keySet: createRemoteJWKSet(new URL(`http://127.0.0.1:${address.port}/jwks`), { cooldownDuration: 0 }),
    });
    await expect(remote.verify(await token())).resolves.toBeTruthy();
    keys = [secondJwk];
    await expect(remote.verify(await token({ key: second.privateKey, kid: "key-2" }))).resolves.toBeTruthy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});

import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTHeaderParameters,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { AuthenticationError } from "./auth-errors";

export interface VerifiedServiceToken {
  readonly keycloakClientId: string;
  readonly scopes: ReadonlySet<string>;
  readonly subject?: string;
}

export interface ServiceTokenVerifier {
  verify(token: string): Promise<VerifiedServiceToken>;
}

export interface ServiceTokenVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl?: string;
  readonly keySet?: JWTVerifyGetKey;
}

function validateTokenType(header: JWTHeaderParameters, payload: JWTPayload): void {
  if (header.typ !== undefined && header.typ.toUpperCase() !== "JWT") {
    throw new AuthenticationError("AUTH_INVALID_TOKEN", "Access token type is invalid", 401);
  }
  if (payload.typ !== undefined && payload.typ !== "Bearer") {
    throw new AuthenticationError("AUTH_INVALID_TOKEN", "Access token type is invalid", 401);
  }
}

function mapJoseError(error: unknown): AuthenticationError {
  if (error instanceof AuthenticationError) return error;
  if (error instanceof joseErrors.JWTExpired) {
    return new AuthenticationError("AUTH_EXPIRED_TOKEN", "Access token has expired", 401);
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return new AuthenticationError("AUTH_WRONG_ISSUER", "Access token issuer is invalid", 401);
    if (error.claim === "aud") return new AuthenticationError("AUTH_WRONG_AUDIENCE", "Access token audience is invalid", 401);
  }
  return new AuthenticationError("AUTH_INVALID_TOKEN", "Access token is invalid", 401);
}

export function createServiceTokenVerifier(config: ServiceTokenVerifierConfig): ServiceTokenVerifier {
  const keySet = config.keySet ?? (config.jwksUrl ? createRemoteJWKSet(new URL(config.jwksUrl), {
    cooldownDuration: 5_000,
    cacheMaxAge: 10 * 60_000,
  }) : undefined);
  if (!keySet) throw new Error("A trusted JWKS URL or key set is required");

  return {
    async verify(token: string): Promise<VerifiedServiceToken> {
      try {
        const { payload, protectedHeader } = await jwtVerify(token, keySet, {
          algorithms: ["RS256"],
          issuer: config.issuer,
          audience: config.audience,
          requiredClaims: ["exp", "iat", "iss", "aud", "azp"],
        });
        validateTokenType(protectedHeader, payload);
        if (typeof payload.azp !== "string" || payload.azp.length === 0) {
          throw new AuthenticationError("AUTH_INVALID_TOKEN", "Access token authorized party is invalid", 401);
        }
        const scopes = new Set(typeof payload.scope === "string" ? payload.scope.split(/\s+/u).filter(Boolean) : []);
        return {
          keycloakClientId: payload.azp,
          scopes,
          ...(typeof payload.sub === "string" ? { subject: payload.sub } : {}),
        };
      } catch (error) {
        throw mapJoseError(error);
      }
    },
  };
}

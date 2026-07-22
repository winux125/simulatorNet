import { effectiveServiceScopes, hasServiceScope, type ServiceScope } from "@sim/authz";
import {
  AuthenticationAuditRepository,
  AuthenticationLookupRepository,
  type SimulatorDatabase,
} from "@sim/db";
import { AuthenticationError } from "./auth-errors";
import type { ServiceTokenVerifier } from "./jwt";

export interface ServicePrincipal {
  readonly kind: "service";
  readonly keycloakClientId: string;
  readonly integrationClientId: string;
  readonly organizationId: string;
  readonly tokenScopes: ReadonlySet<string>;
  readonly effectiveScopes: ReadonlySet<string>;
}

export interface ServiceAuthenticatorLike {
  authenticate(authorization: string | undefined, requestId?: string): Promise<ServicePrincipal>;
}

export class ServiceAuthenticator implements ServiceAuthenticatorLike {
  private readonly lookup: AuthenticationLookupRepository;
  private readonly audit: AuthenticationAuditRepository;

  constructor(database: SimulatorDatabase, private readonly verifier: ServiceTokenVerifier) {
    this.lookup = new AuthenticationLookupRepository(database);
    this.audit = new AuthenticationAuditRepository(database);
  }

  async authenticate(authorization: string | undefined, requestId?: string): Promise<ServicePrincipal> {
    let verified;
    try {
      const token = parseBearerToken(authorization);
      verified = await this.verifier.verify(token);
    } catch (error) {
      await this.recordRejection(undefined, requestId, error instanceof AuthenticationError ? error.code : "AUTH_INVALID_TOKEN");
      throw error;
    }

    const binding = await this.lookup.getIntegrationClientByKeycloakClientId(verified.keycloakClientId);
    if (!binding) {
      await this.recordRejection(verified.keycloakClientId, requestId, "AUTH_UNKNOWN_CLIENT");
      throw new AuthenticationError("AUTH_UNKNOWN_CLIENT", "Service client is not registered", 401);
    }
    if (binding.integrationClient.status !== "active") {
      await this.recordRejection(verified.keycloakClientId, requestId, "AUTH_DISABLED_CLIENT", binding.organization.id);
      throw new AuthenticationError("AUTH_DISABLED_CLIENT", "Service client is disabled", 403);
    }
    if (binding.organization.status !== "active") {
      await this.recordRejection(verified.keycloakClientId, requestId, "ORG_SUSPENDED", binding.organization.id);
      throw new AuthenticationError("ORG_SUSPENDED", "Organization is suspended", 403);
    }
    return {
      kind: "service",
      keycloakClientId: verified.keycloakClientId,
      integrationClientId: binding.integrationClient.id,
      organizationId: binding.organization.id,
      tokenScopes: verified.scopes,
      effectiveScopes: effectiveServiceScopes(verified.scopes, binding.integrationClient.allowedScopes),
    };
  }

  async requireScope(principal: ServicePrincipal, scope: ServiceScope, requestId?: string): Promise<void> {
    if (hasServiceScope(principal.effectiveScopes, scope)) return;
    await this.recordRejection(principal.keycloakClientId, requestId, "AUTH_INSUFFICIENT_SCOPE", principal.organizationId);
    throw new AuthenticationError("AUTH_INSUFFICIENT_SCOPE", "Required service scope is missing", 403, scope);
  }

  private async recordRejection(actorId: string | undefined, requestId: string | undefined, reason: string, organizationId?: string) {
    await this.audit.record({
      organizationId,
      actorType: actorId ? "service" : "system",
      actorId,
      action: "auth.client.rejected",
      resourceType: "integration-client",
      requestId,
      metadata: { reason },
    });
  }
}

function parseBearerToken(authorization: string | undefined): string {
  if (!authorization) throw new AuthenticationError("AUTH_MISSING_TOKEN", "Bearer access token is required", 401);
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization);
  if (!match?.[1]) throw new AuthenticationError("AUTH_INVALID_TOKEN", "Authorization header is invalid", 401);
  return match[1];
}

export function requireServiceScope(
  authenticator: ServiceAuthenticatorLike,
  principal: ServicePrincipal,
  scope: ServiceScope,
  requestId?: string,
): Promise<void> {
  if (authenticator instanceof ServiceAuthenticator) return authenticator.requireScope(principal, scope, requestId);
  if (!hasServiceScope(principal.effectiveScopes, scope)) {
    throw new AuthenticationError("AUTH_INSUFFICIENT_SCOPE", "Required service scope is missing", 403, scope);
  }
  return Promise.resolve();
}

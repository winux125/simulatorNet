import {
  AuthenticationLookupRepository,
  hashOpaqueToken,
  PlatformAdminRepository,
  TenantRepository,
  type OrganizationRole,
  type SimulatorDatabase,
  type TenantContext,
} from "@sim/db";
import type { FastifyRequest } from "fastify";
import { AuthenticationError } from "./auth-errors";

export const SESSION_COOKIE = "simulatornet_session";

export interface UserSessionPrincipal {
  readonly kind: "user-session";
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: OrganizationRole;
  readonly displayName: string;
  readonly organizationName: string;
}

/** A user-session tenant context: the acting user inside their organization. */
export function userTenantContext(session: UserSessionPrincipal): TenantContext {
  return { organizationId: session.organizationId, actor: { kind: "user", id: session.userId } };
}

export async function resolveUserSession(request: FastifyRequest, database: SimulatorDatabase, now: Date): Promise<UserSessionPrincipal> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) throw new AuthenticationError("INVALID_SESSION", "Browser session is invalid", 401);
  const tokenHash = hashOpaqueToken(raw);
  const organizationId = await new AuthenticationLookupRepository(database).findBrowserSessionOrganizationId(tokenHash);
  if (!organizationId) throw new AuthenticationError("INVALID_SESSION", "Browser session is invalid", 401);
  const context: TenantContext = { organizationId, actor: { kind: "system", id: "browser-session-validation" } };
  const repository = new TenantRepository(database);
  const session = await repository.getBrowserSession(context, tokenHash, now);
  if (!session) throw new AuthenticationError("INVALID_SESSION", "Browser session is invalid", 401);
  const organization = await new PlatformAdminRepository(database).getOrganizationById(organizationId);
  const member = await repository.getOrganizationUser(context, session.userId);
  if (!organization || organization.status !== "active" || !member || member.user.status !== "active" || member.membership.status !== "active") {
    throw new AuthenticationError("INVALID_SESSION", "Browser session is invalid", 401);
  }
  return {
    kind: "user-session",
    sessionId: session.id,
    userId: session.userId,
    organizationId,
    role: member.membership.role,
    displayName: member.user.displayName,
    organizationName: organization.name,
  };
}

export const SERVICE_SCOPES = [
  "users:read",
  "users:write",
  "memberships:write",
  "launch:write",
  "labs:validate",
  "verifications:write",
] as const;

export type ServiceScope = typeof SERVICE_SCOPES[number];

export const AUTHORIZATION_ACTIONS = [
  "platform:manage",
  "organization:read",
  "organization:manage-users",
  "organization:manage-settings",
  "lab:use",
  "lab:author",
  "verification:run",
  "integration:manage",
] as const;

export type AuthorizationAction = typeof AUTHORIZATION_ACTIONS[number];
export type AuthorizationRole = "platform_admin" | "organization_admin" | "instructor" | "student";

export const ROLE_PERMISSIONS: Readonly<Record<AuthorizationRole, ReadonlySet<AuthorizationAction>>> = {
  platform_admin: new Set(AUTHORIZATION_ACTIONS),
  organization_admin: new Set([
    "organization:read",
    "organization:manage-users",
    "organization:manage-settings",
    "lab:use",
    "lab:author",
    "verification:run",
    "integration:manage",
  ]),
  instructor: new Set(["organization:read", "lab:use", "lab:author", "verification:run"]),
  student: new Set(["lab:use"]),
};

export function roleAllows(role: AuthorizationRole, action: AuthorizationAction): boolean {
  return ROLE_PERMISSIONS[role].has(action);
}

export function effectiveServiceScopes(
  tokenScopes: ReadonlySet<string>,
  locallyAllowedScopes: readonly string[],
): ReadonlySet<string> {
  return new Set(locallyAllowedScopes.filter((scope) => tokenScopes.has(scope)));
}

export function hasServiceScope(scopes: ReadonlySet<string>, requiredScope: ServiceScope): boolean {
  return scopes.has(requiredScope);
}

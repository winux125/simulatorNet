export const SERVICE_SCOPES = [
  "users:read",
  "users:write",
  "memberships:write",
  "launch:write",
  "labs:validate",
  "verifications:write",
  "templates:read",
  "assignments:read",
  "assignments:write",
  "assignments:students:write",
  "submissions:read",
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
  // Academic (M9) actions.
  "lab-template:create",
  "lab-template:read",
  "lab-template:publish",
  "lab-template:archive",
  "grading-spec:manage",
  "assignment:create",
  "assignment:read",
  "assignment:update",
  "assignment:publish",
  "assignment:close",
  "assignment:manage-students",
  "lab-instance:read-own",
  "lab-instance:save-own",
  "submission:create-own",
  "submission:read-own",
  "submission:read-organization",
  "result:read-own",
  "result:read-organization",
] as const;

export type AuthorizationAction = typeof AUTHORIZATION_ACTIONS[number];
export type AuthorizationRole = "platform_admin" | "organization_admin" | "instructor" | "student";

// Actions an instructor may take: author templates + grading, run assignments,
// manage assigned students and read organization-wide submissions/results.
const INSTRUCTOR_ACADEMIC_ACTIONS = [
  "lab-template:create",
  "lab-template:read",
  "lab-template:publish",
  "lab-template:archive",
  "grading-spec:manage",
  "assignment:create",
  "assignment:read",
  "assignment:update",
  "assignment:publish",
  "assignment:close",
  "assignment:manage-students",
  "submission:read-organization",
  "result:read-organization",
] as const satisfies readonly AuthorizationAction[];

// Actions a student may take, all scoped to their own assigned resources.
const STUDENT_ACADEMIC_ACTIONS = [
  "assignment:read",
  "lab-instance:read-own",
  "lab-instance:save-own",
  "submission:create-own",
  "submission:read-own",
  "result:read-own",
] as const satisfies readonly AuthorizationAction[];

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
    ...INSTRUCTOR_ACADEMIC_ACTIONS,
  ]),
  instructor: new Set(["organization:read", "lab:use", "lab:author", "verification:run", ...INSTRUCTOR_ACADEMIC_ACTIONS]),
  student: new Set(["lab:use", ...STUDENT_ACADEMIC_ACTIONS]),
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

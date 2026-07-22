import { describe, expect, it } from "vitest";
import { effectiveServiceScopes, hasServiceScope, roleAllows } from "../src/index";

describe("authorization policy", () => {
  it("grants all actions only to platform administrators", () => {
    expect(roleAllows("platform_admin", "platform:manage")).toBe(true);
    expect(roleAllows("organization_admin", "platform:manage")).toBe(false);
  });

  it("keeps role capabilities explicit", () => {
    expect(roleAllows("organization_admin", "organization:manage-users")).toBe(true);
    expect(roleAllows("instructor", "lab:author")).toBe(true);
    expect(roleAllows("student", "lab:author")).toBe(false);
    expect(roleAllows("student", "lab:use")).toBe(true);
  });

  it("intersects token and local scopes", () => {
    const effective = effectiveServiceScopes(new Set(["users:write", "launch:write"]), ["users:write"]);
    expect([...effective]).toEqual(["users:write"]);
    expect(hasServiceScope(effective, "launch:write")).toBe(false);
  });

  it("scopes academic actions to the correct roles", () => {
    // Instructors author templates, grading and assignments and read the org.
    expect(roleAllows("instructor", "lab-template:create")).toBe(true);
    expect(roleAllows("instructor", "grading-spec:manage")).toBe(true);
    expect(roleAllows("instructor", "assignment:publish")).toBe(true);
    expect(roleAllows("instructor", "assignment:manage-students")).toBe(true);
    expect(roleAllows("instructor", "submission:read-organization")).toBe(true);
    expect(roleAllows("instructor", "result:read-organization")).toBe(true);
    // Instructors are not students: no own-instance actions.
    expect(roleAllows("instructor", "lab-instance:save-own")).toBe(false);
    expect(roleAllows("instructor", "submission:create-own")).toBe(false);
  });

  it("limits students to their own resources", () => {
    expect(roleAllows("student", "assignment:read")).toBe(true);
    expect(roleAllows("student", "lab-instance:read-own")).toBe(true);
    expect(roleAllows("student", "lab-instance:save-own")).toBe(true);
    expect(roleAllows("student", "submission:create-own")).toBe(true);
    expect(roleAllows("student", "result:read-own")).toBe(true);
    // Students never author or read across the organization or the grading spec.
    expect(roleAllows("student", "lab-template:create")).toBe(false);
    expect(roleAllows("student", "grading-spec:manage")).toBe(false);
    expect(roleAllows("student", "assignment:create")).toBe(false);
    expect(roleAllows("student", "submission:read-organization")).toBe(false);
    expect(roleAllows("student", "result:read-organization")).toBe(false);
  });

  it("gives organization admins the full academic surface", () => {
    for (const action of ["lab-template:create", "grading-spec:manage", "assignment:create", "assignment:manage-students", "result:read-organization"] as const) {
      expect(roleAllows("organization_admin", action)).toBe(true);
    }
  });
});

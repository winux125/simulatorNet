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
});

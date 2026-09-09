/**
 * Stable identifier slugs. Extracted from `plan.ts` so an adapter can build
 * node ids without importing the planner, which would make the dependency
 * between the two cyclic.
 */
export function slugify(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : fallback;
}

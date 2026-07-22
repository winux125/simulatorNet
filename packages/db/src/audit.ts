const SECRET_KEY = /(?:access|refresh|id)?token|secret|password|authorization|cookie|launch.?code|session.?token/i;

export function sanitizeAuditMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitize(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    output[key] = sanitize(child);
  }
  return output;
}

export type AuthenticationErrorCode =
  | "AUTH_MISSING_TOKEN"
  | "AUTH_INVALID_TOKEN"
  | "AUTH_WRONG_ISSUER"
  | "AUTH_WRONG_AUDIENCE"
  | "AUTH_EXPIRED_TOKEN"
  | "AUTH_UNKNOWN_CLIENT"
  | "AUTH_DISABLED_CLIENT"
  | "AUTH_INSUFFICIENT_SCOPE"
  | "ORG_SUSPENDED"
  | "INVALID_LAUNCH_CODE"
  | "EXPIRED_LAUNCH_CODE"
  | "REUSED_LAUNCH_CODE"
  | "INVALID_SESSION"
  | "RETURN_URL_NOT_ALLOWED"
  | "ORIGIN_NOT_ALLOWED"
  | "RATE_LIMIT_EXCEEDED";

export class AuthenticationError extends Error {
  constructor(
    readonly code: AuthenticationErrorCode,
    message: string,
    readonly statusCode: number,
    readonly requiredScope?: string,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function bearerChallenge(error: AuthenticationError): string | undefined {
  if (!error.code.startsWith("AUTH_") || (error.statusCode !== 401 && error.code !== "AUTH_INSUFFICIENT_SCOPE")) return undefined;
  if (error.code === "AUTH_INSUFFICIENT_SCOPE") {
    return `Bearer realm="simulatornet", error="insufficient_scope"${error.requiredScope ? `, scope="${error.requiredScope}"` : ""}`;
  }
  return `Bearer realm="simulatornet", error="invalid_token"`;
}

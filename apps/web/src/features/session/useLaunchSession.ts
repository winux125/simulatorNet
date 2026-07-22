import { useCallback, useEffect, useRef, useState } from "react";

export interface BrowserSessionIdentity {
  readonly displayName: string;
  readonly organizationName: string;
  readonly role: "platform_admin" | "organization_admin" | "instructor" | "student";
}

export type BrowserSessionState =
  | { status: "checking" | "anonymous" | "exchanging" }
  | { status: "authenticated"; identity: BrowserSessionIdentity }
  | { status: "error"; message: string };

const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/u, "") ?? "";
const exchangeRequests = new Map<string, Promise<BrowserSessionIdentity>>();

function normalizeMe(value: unknown): BrowserSessionIdentity {
  if (!value || typeof value !== "object") throw new Error("Invalid session response");
  const record = value as Record<string, unknown>;
  const nestedUser = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : undefined;
  const nestedOrganization = record.organization && typeof record.organization === "object" ? record.organization as Record<string, unknown> : undefined;
  const displayName = typeof record.displayName === "string" ? record.displayName : nestedUser?.displayName;
  const organizationName = typeof record.organizationName === "string" ? record.organizationName : nestedOrganization?.name;
  const role = record.role;
  if (typeof displayName !== "string" || typeof organizationName !== "string" || !["platform_admin", "organization_admin", "instructor", "student"].includes(String(role))) {
    throw new Error("Invalid session response");
  }
  return { displayName, organizationName, role: role as BrowserSessionIdentity["role"] };
}

function exchangeLaunchCode(code: string): Promise<BrowserSessionIdentity> {
  const existing = exchangeRequests.get(code);
  if (existing) return existing;
  const request = fetch(`${apiBase}/v1/session/launch-exchange`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }).then(async (response) => {
    if (!response.ok) throw new Error("The launch link is invalid or has expired.");
    return normalizeMe(await response.json());
  }).finally(() => exchangeRequests.delete(code));
  exchangeRequests.set(code, request);
  return request;
}

export function useLaunchSession() {
  const initialCode = useRef(
    window.location.pathname === "/launch" ? new URLSearchParams(window.location.search).get("code") : null,
  );
  const [state, setState] = useState<BrowserSessionState>(initialCode.current ? { status: "exchanging" } : { status: "checking" });

  useEffect(() => {
    let active = true;
    const code = initialCode.current;
    if (code) {
      window.history.replaceState(window.history.state, "", "/");
      void exchangeLaunchCode(code)
        .then((identity) => { if (active) setState({ status: "authenticated", identity }); })
        .catch((error: unknown) => { if (active) setState({ status: "error", message: error instanceof Error ? error.message : "Launch failed." }); });
    } else {
      void fetch(`${apiBase}/v1/session/me`, { credentials: "include" })
        .then(async (response) => response.ok ? normalizeMe(await response.json()) : undefined)
        .then((identity) => { if (active) setState(identity ? { status: "authenticated", identity } : { status: "anonymous" }); })
        .catch(() => { if (active) setState({ status: "anonymous" }); });
    }
    return () => { active = false; };
  }, []);

  const logout = useCallback(async () => {
    const response = await fetch(`${apiBase}/v1/session/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("Logout failed");
    setState({ status: "anonymous" });
  }, []);

  return { state, logout };
}

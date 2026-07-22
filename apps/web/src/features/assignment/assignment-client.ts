import type { LabDocument } from "@sim/contracts";

/**
 * Typed browser client for the authenticated student assignment surface.
 * It only ever touches the student endpoints, so the hidden grading spec is
 * never requested — the server would refuse it anyway.
 */

const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/u, "") ?? "";

export interface StudentAssignment {
  readonly id: string;
  readonly title: string;
  readonly instructions: string | null;
  readonly status: string;
  readonly availableFrom: string | null;
  readonly dueAt: string | null;
  readonly maximumAttempts: number | null;
}

export interface StudentLabInstance {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
}

export interface OpenAssignmentResult {
  readonly assignment: StudentAssignment;
  readonly instance: StudentLabInstance;
  readonly document: LabDocument;
}

export interface StudentSubmission {
  readonly id: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly score: number | null;
  readonly result: unknown;
}

export class AssignmentApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message);
    this.name = "AssignmentApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new AssignmentApiError(error?.code ?? "request-failed", error?.message ?? "Request failed", response.status, error?.details);
  }
  return body as T;
}

export const assignmentClient = {
  listAssignments(): Promise<{ assignments: StudentAssignment[] }> {
    return request("/v1/student/assignments");
  },
  openAssignment(assignmentId: string): Promise<OpenAssignmentResult> {
    return request(`/v1/student/assignments/${encodeURIComponent(assignmentId)}/open`, { method: "POST", body: "{}" });
  },
  saveInstance(instanceId: string, expectedRevision: number, document: LabDocument): Promise<StudentLabInstance & { canonicalHash: string }> {
    return request(`/v1/student/lab-instances/${encodeURIComponent(instanceId)}`, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision, document }),
    });
  },
  submit(instanceId: string): Promise<StudentSubmission> {
    return request(`/v1/student/lab-instances/${encodeURIComponent(instanceId)}/submissions`, { method: "POST", body: "{}" });
  },
  getSubmission(submissionId: string): Promise<StudentSubmission> {
    return request(`/v1/student/submissions/${encodeURIComponent(submissionId)}`);
  },
};

export type AssignmentClient = typeof assignmentClient;

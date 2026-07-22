import { z } from "zod";
import type { VerificationResult } from "@sim/contracts/grading";

export type LabTemplateStatus = "draft" | "published" | "archived";
export type AssignmentStatus = "draft" | "published" | "closed" | "archived";
export type AssignmentStudentStatus = "assigned" | "active" | "completed" | "removed";
export type LabInstanceStatus = "not_started" | "in_progress" | "submitted" | "completed" | "locked";
export type SubmissionStatus = "pending" | "verifying" | "verified" | "failed";
export type SubmissionResultView = "student" | "instructor";

export const CreateLabTemplateInputSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(4000).optional(),
  createdByUserId: z.string().uuid().optional(),
});
export type CreateLabTemplateInput = z.infer<typeof CreateLabTemplateInputSchema>;

export const CreateAssignmentInputSchema = z.object({
  labTemplateVersionId: z.string().uuid(),
  title: z.string().min(1).max(300),
  instructions: z.string().max(20_000).optional(),
  availableFrom: z.coerce.date().optional(),
  dueAt: z.coerce.date().optional(),
  maximumAttempts: z.number().int().positive().nullable().optional(),
  createdByUserId: z.string().uuid().optional(),
});
export type CreateAssignmentInput = z.infer<typeof CreateAssignmentInputSchema>;

/** Only these fields may be patched, and only while the assignment is a draft. */
export const UpdateDraftAssignmentInputSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  instructions: z.string().max(20_000).nullable().optional(),
  availableFrom: z.coerce.date().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  maximumAttempts: z.number().int().positive().nullable().optional(),
}).strict();
export type UpdateDraftAssignmentInput = z.infer<typeof UpdateDraftAssignmentInputSchema>;

export interface SubmissionResultInput {
  readonly verificationId: string;
  readonly score: number;
  readonly awardedPoints: number;
  readonly maximumPoints: number;
  readonly studentResult: VerificationResult;
  readonly instructorResult: VerificationResult;
  readonly engineSchemaVersion: number;
  readonly engineVersion: string;
  readonly processedEvents: number;
  readonly virtualTimeNs: number;
}

export interface AssignmentSubmissionFilter {
  readonly studentUserId?: string;
  readonly status?: SubmissionStatus;
  readonly minimumScore?: number;
  readonly submittedAfter?: Date;
  readonly submittedBefore?: Date;
}

CREATE TYPE "public"."assignment_status" AS ENUM('draft', 'published', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."assignment_student_status" AS ENUM('assigned', 'active', 'completed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."lab_instance_status" AS ENUM('not_started', 'in_progress', 'submitted', 'completed', 'locked');--> statement-breakpoint
CREATE TYPE "public"."lab_template_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('pending', 'verifying', 'verified', 'failed');--> statement-breakpoint
CREATE TABLE "assignment_students" (
	"organization_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"status" "assignment_student_status" DEFAULT 'assigned' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "assignment_students_pk" PRIMARY KEY("assignment_id","student_user_id")
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lab_template_version_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"status" "assignment_status" DEFAULT 'draft' NOT NULL,
	"available_from" timestamp with time zone,
	"due_at" timestamp with time zone,
	"maximum_attempts" integer,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "assignments_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "assignments_maximum_attempts_positive" CHECK ("assignments"."maximum_attempts" is null or "assignments"."maximum_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "grading_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lab_template_version_id" uuid NOT NULL,
	"grading_spec" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"current_document" jsonb NOT NULL,
	"canonical_hash" char(64) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" "lab_instance_status" DEFAULT 'in_progress' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"last_saved_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_instances_assignment_student_unique" UNIQUE("assignment_id","student_user_id"),
	CONSTRAINT "lab_instances_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "lab_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lab_template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"lab_document" jsonb NOT NULL,
	"canonical_hash" char(64) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_template_versions_template_version_unique" UNIQUE("lab_template_id","version_number"),
	CONSTRAINT "lab_template_versions_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "lab_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "lab_template_status" DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "lab_templates_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "submission_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"verification_id" text NOT NULL,
	"score" double precision NOT NULL,
	"awarded_points" double precision NOT NULL,
	"maximum_points" double precision NOT NULL,
	"student_result" jsonb NOT NULL,
	"instructor_result" jsonb NOT NULL,
	"engine_schema_version" integer NOT NULL,
	"engine_version" text NOT NULL,
	"processed_events" integer NOT NULL,
	"virtual_time_ns" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_results_submission_unique" UNIQUE("submission_id")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lab_instance_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"student_user_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"lab_document" jsonb NOT NULL,
	"canonical_hash" char(64) NOT NULL,
	"status" "submission_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verification_started_at" timestamp with time zone,
	"verification_completed_at" timestamp with time zone,
	CONSTRAINT "submissions_instance_attempt_unique" UNIQUE("lab_instance_id","attempt_number"),
	CONSTRAINT "submissions_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "assignment_students" ADD CONSTRAINT "assignment_students_assignment_fk" FOREIGN KEY ("organization_id","assignment_id") REFERENCES "public"."assignments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_students" ADD CONSTRAINT "assignment_students_membership_fk" FOREIGN KEY ("organization_id","student_user_id") REFERENCES "public"."organization_memberships"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_template_version_fk" FOREIGN KEY ("organization_id","lab_template_version_id") REFERENCES "public"."lab_template_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_specs" ADD CONSTRAINT "grading_specs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_specs" ADD CONSTRAINT "grading_specs_version_fk" FOREIGN KEY ("organization_id","lab_template_version_id") REFERENCES "public"."lab_template_versions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_instances" ADD CONSTRAINT "lab_instances_assignment_fk" FOREIGN KEY ("organization_id","assignment_id") REFERENCES "public"."assignments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_instances" ADD CONSTRAINT "lab_instances_assignment_student_fk" FOREIGN KEY ("assignment_id","student_user_id") REFERENCES "public"."assignment_students"("assignment_id","student_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_template_versions" ADD CONSTRAINT "lab_template_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_template_versions" ADD CONSTRAINT "lab_template_versions_template_fk" FOREIGN KEY ("organization_id","lab_template_id") REFERENCES "public"."lab_templates"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_templates" ADD CONSTRAINT "lab_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_templates" ADD CONSTRAINT "lab_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_results" ADD CONSTRAINT "submission_results_submission_fk" FOREIGN KEY ("organization_id","submission_id") REFERENCES "public"."submissions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_lab_instance_fk" FOREIGN KEY ("organization_id","lab_instance_id") REFERENCES "public"."lab_instances"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_fk" FOREIGN KEY ("organization_id","assignment_id") REFERENCES "public"."assignments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_students_student_idx" ON "assignment_students" USING btree ("organization_id","student_user_id");--> statement-breakpoint
CREATE INDEX "assignments_organization_idx" ON "assignments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "assignments_template_version_idx" ON "assignments" USING btree ("lab_template_version_id");--> statement-breakpoint
CREATE INDEX "grading_specs_version_idx" ON "grading_specs" USING btree ("lab_template_version_id");--> statement-breakpoint
CREATE INDEX "grading_specs_organization_idx" ON "grading_specs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lab_instances_organization_idx" ON "lab_instances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lab_template_versions_template_idx" ON "lab_template_versions" USING btree ("lab_template_id");--> statement-breakpoint
CREATE INDEX "lab_template_versions_organization_idx" ON "lab_template_versions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "lab_templates_organization_idx" ON "lab_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "submission_results_organization_idx" ON "submission_results" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "submissions_assignment_idx" ON "submissions" USING btree ("organization_id","assignment_id");--> statement-breakpoint
CREATE INDEX "submissions_student_idx" ON "submissions" USING btree ("organization_id","student_user_id");
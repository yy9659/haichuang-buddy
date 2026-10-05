ALTER TYPE "public"."agent_status" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TYPE "public"."workflow_status" ADD VALUE 'partially_completed';--> statement-breakpoint
ALTER TYPE "public"."workflow_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "agent_workflows" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "agent_workflows" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "agent_workflows" ADD COLUMN "error_message" text;--> statement-breakpoint
CREATE INDEX "agent_workflows_status_idx" ON "agent_workflows" USING btree ("status");
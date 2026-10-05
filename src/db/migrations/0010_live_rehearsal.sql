ALTER TABLE "live_sessions" ADD COLUMN "host_transcript" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD COLUMN "rehearsal_report" jsonb;

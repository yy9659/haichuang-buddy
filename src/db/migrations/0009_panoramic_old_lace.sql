CREATE TABLE "business_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"author_name" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"intent" text,
	"priority" text,
	"handled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"title" text NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"comments_count" integer DEFAULT 0 NOT NULL,
	"ai_handled_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"comment_content" text NOT NULL,
	"intent" text NOT NULL,
	"priority" text NOT NULL,
	"should_respond" boolean DEFAULT false NOT NULL,
	"response_mode" text NOT NULL,
	"host_suggestion" text DEFAULT '' NOT NULL,
	"suggested_reply" text DEFAULT '' NOT NULL,
	"selling_angle" text,
	"grounded" boolean DEFAULT false NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_action" text NOT NULL,
	"risk_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_reports" ADD CONSTRAINT "business_reports_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_comments" ADD CONSTRAINT "live_comments_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_suggestions" ADD CONSTRAINT "live_suggestions_comment_id_live_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."live_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_reports_business_id_idx" ON "business_reports" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "business_reports_created_at_idx" ON "business_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "live_comments_session_id_idx" ON "live_comments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "live_comments_created_at_idx" ON "live_comments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "live_sessions_business_id_idx" ON "live_sessions" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "live_sessions_started_at_idx" ON "live_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "live_suggestions_comment_id_idx" ON "live_suggestions" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "live_suggestions_created_at_idx" ON "live_suggestions" USING btree ("created_at");
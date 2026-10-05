CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"platform" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"hook" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"cta" text DEFAULT '' NOT NULL,
	"hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visual_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shot_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"voiceover" text DEFAULT '' NOT NULL,
	"risk_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_version" text DEFAULT 'v1.0' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"metrics" jsonb DEFAULT '{"views":0,"likes":0,"comments":0,"shares":0,"engagementRate":0}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contents_slot_unique" ON "contents" USING btree ("product_id","platform","format");--> statement-breakpoint
CREATE INDEX "contents_business_id_idx" ON "contents" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "contents_product_id_idx" ON "contents" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "contents_status_idx" ON "contents" USING btree ("status");
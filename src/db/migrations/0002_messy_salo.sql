CREATE TABLE "brand_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"positioning" text DEFAULT '' NOT NULL,
	"brand_story" text DEFAULT '' NOT NULL,
	"slogan" text DEFAULT '' NOT NULL,
	"ip_concept" text DEFAULT '' NOT NULL,
	"brand_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_audience" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brand_personality" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tone_of_voice" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visual_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_product_id" uuid,
	"ai_version" text DEFAULT 'v1.0' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_source_product_id_products_id_fk" FOREIGN KEY ("source_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_profiles_business_id_unique" ON "brand_profiles" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "brand_profiles_source_product_id_idx" ON "brand_profiles" USING btree ("source_product_id");
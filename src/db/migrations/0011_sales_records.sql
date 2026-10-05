CREATE TABLE "sales_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL,
  "record_no" text NOT NULL,
  "sale_date" text NOT NULL,
  "product_name" text NOT NULL,
  "channel" text NOT NULL,
  "quantity" integer NOT NULL,
  "revenue_cents" integer NOT NULL,
  "cost_cents" integer,
  "is_demo" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_records_business_no_unique" ON "sales_records" USING btree ("business_id","record_no");
--> statement-breakpoint
CREATE INDEX "sales_records_business_date_idx" ON "sales_records" USING btree ("business_id","sale_date");

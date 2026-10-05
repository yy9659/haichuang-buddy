ALTER TABLE "agent_tasks" ALTER COLUMN "workflow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tasks_product_id_idx" ON "agent_tasks" USING btree ("product_id");
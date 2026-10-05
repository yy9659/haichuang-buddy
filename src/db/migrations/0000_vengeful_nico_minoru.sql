-- 关于向量列（本地适配说明）：
--
-- 原设计里 knowledge_chunks.embedding 是 pgvector 的 vector(1024)，依赖
-- `CREATE EXTENSION vector`。本地开发改用 PGlite（WASM 版 PostgreSQL），
-- 它的内置扩展不含 pgvector，因此本地迁移链把该列改为 PostgreSQL 原生 real[]
-- （见下方 knowledge_chunks 建表），维度约束由应用层
-- `@/lib/embedding` 的 isEmbeddingVector 保证 —— 写入前会校验 1024 维，
-- 不合法直接抛 VALIDATION_FAILED，不依赖数据库列做约束。
--
-- 检索方式也一并调整：原先用 pgvector 的 `<=>` 在 SQL 里算余弦距离，
-- 现在在应用层算（见 knowledge.repository.ts 的 searchSimilar）。
-- 知识库规模是千条级，全量取回算余弦的开销可忽略。
--
-- 将来部署到 Supabase 且知识库规模上来、需要向量索引时，还原三步：
--   1. 本文件恢复 `CREATE EXTENSION IF NOT EXISTS vector;`
--   2. 本行下方 `real[]` 改回 `vector(1024)`
--   3. schema.ts 的 embedding 列改回 vector(...)，并恢复 searchSimilar 的 SQL 检索
--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('idle', 'queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_type" AS ENUM('business_brain', 'product_agent', 'brand_agent', 'content_agent', 'live_agent', 'customer_service_agent', 'analytics_agent');--> statement-breakpoint
CREATE TYPE "public"."knowledge_type" AS ENUM('product', 'faq', 'logistics', 'after_sale', 'brand', 'cooking', 'storage');--> statement-breakpoint
CREATE TYPE "public"."product_analysis_status" AS ENUM('pending', 'analyzing', 'analyzed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."product_category" AS ENUM('海产品', '干货', '预制菜', '礼盒');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('idle', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"agent_type" "agent_type" NOT NULL,
	"title" text NOT NULL,
	"status" "agent_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"status" "workflow_status" DEFAULT 'idle' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"active_stage_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"logo_url" text,
	"owner" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"main_category" text DEFAULT '' NOT NULL,
	"store_count" integer DEFAULT 0 NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" real[],
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "knowledge_type" NOT NULL,
	"file_url" text,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"avatar_label" text DEFAULT '' NOT NULL,
	"business_philosophy" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tone" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sales_style" text DEFAULT '' NOT NULL,
	"target_customers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_expressions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_dna" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"sub_category" text DEFAULT '' NOT NULL,
	"visual_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"core_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selling_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_users" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scenarios" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pain_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"marketing_angles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_version" text DEFAULT 'v1.0' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" "product_category" NOT NULL,
	"sub_category" text DEFAULT '' NOT NULL,
	"price" numeric(10, 2) DEFAULT 0 NOT NULL,
	"unit" text DEFAULT '' NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"specification" text DEFAULT '' NOT NULL,
	"storage_method" text DEFAULT '' NOT NULL,
	"shelf_life" text DEFAULT '' NOT NULL,
	"image_url" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{"views":0,"inquiries":0,"conversions":0}'::jsonb NOT NULL,
	"analysis_status" "product_analysis_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workflow_id_agent_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."agent_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflows" ADD CONSTRAINT "agent_workflows_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_dna" ADD CONSTRAINT "product_dna_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tasks_workflow_id_idx" ON "agent_tasks" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_status_idx" ON "agent_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_workflows_business_id_idx" ON "agent_workflows" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document_id_idx" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_business_id_idx" ON "knowledge_documents" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "owner_profiles_business_id_idx" ON "owner_profiles" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_dna_product_id_unique" ON "product_dna" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "products_business_id_idx" ON "products" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "products_analysis_status_idx" ON "products" USING btree ("analysis_status");--> statement-breakpoint
CREATE UNIQUE INDEX "products_business_name_unique" ON "products" USING btree ("business_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_business_id_idx" ON "users" USING btree ("business_id");
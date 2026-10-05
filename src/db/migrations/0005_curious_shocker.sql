-- S5：RAG 智能客服 + 企业知识库真实闭环
--
-- 本次迁移的四件事：
--   ① knowledge_type 枚举：after_sale → after_sales，并新增 manual
--   ② knowledge_documents 补齐正文 / 来源 / 索引状态 / 归属商品
--   ③ knowledge_chunks 补齐商家 / 商品 / 类型 / 文档名 / 序号（并回填历史行）
--   ④ 新建 knowledge_gaps / customer_conversations / customer_messages
--
-- 关于 ③ 的写法：老列是 NOT NULL 直加，新列一律「先加可空 → 回填 → 再置 NOT NULL」。
-- 分三步是因为表里可能已有历史行（S1 建表到 S4 之间没人写过 chunk，但不能指望运行时
-- 一定为空）；直接 ADD COLUMN ... NOT NULL 在有空表以外的任何情况下都会整条迁移失败。
--
-- 关于向量列：`knowledge_chunks.embedding` 是 S1 就建好的 vector(1024)，
-- 依赖 pgvector 扩展（见 0000 迁移顶部手写的 CREATE EXTENSION）。
-- 本迁移不新建向量列，也不建向量索引 —— 精确检索在 Demo 规模（数百片）下
-- 完全够用，而 ivfflat/hnsw 索引需要先有数据再建才有意义。

-- ① 枚举：重命名而不是「加新删旧」—— 删旧值会让已有切片记录的 type 变成非法值
ALTER TYPE "public"."knowledge_type" RENAME VALUE 'after_sale' TO 'after_sales';--> statement-breakpoint
ALTER TYPE "public"."knowledge_type" ADD VALUE 'manual';--> statement-breakpoint
CREATE TYPE "public"."knowledge_source" AS ENUM('system', 'manual');--> statement-breakpoint
CREATE TYPE "public"."knowledge_index_status" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_gap_status" AS ENUM('open', 'resolved', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."conversation_channel" AS ENUM('douyin', 'wechat', 'shipinhao', 'store');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('bot', 'human', 'closed');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('customer', 'agent', 'system');--> statement-breakpoint

-- ② knowledge_documents
ALTER TABLE "knowledge_documents" ADD COLUMN "source" "knowledge_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "content" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "index_status" "knowledge_index_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "index_error" text;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_business_name_unique" ON "knowledge_documents" USING btree ("business_id","type","name");--> statement-breakpoint
CREATE INDEX "knowledge_documents_product_id_idx" ON "knowledge_documents" USING btree ("product_id");--> statement-breakpoint

-- ③ knowledge_chunks：新增列 → 从文档表回填 → 置 NOT NULL
ALTER TABLE "knowledge_chunks" ADD COLUMN "business_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "source_type" "knowledge_type";--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN "chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "knowledge_chunks" AS c
   SET "business_id" = d."business_id",
       "product_id"  = d."product_id",
       "source_type" = d."type",
       "title"       = d."name"
  FROM "knowledge_documents" AS d
 WHERE c."document_id" = d."id";--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ALTER COLUMN "business_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ALTER COLUMN "source_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_business_id_idx" ON "knowledge_chunks" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_product_id_idx" ON "knowledge_chunks" USING btree ("product_id");--> statement-breakpoint

-- ④ knowledge_gaps
CREATE TABLE "knowledge_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"product_id" uuid,
	"question" text NOT NULL,
	"normalized_question" text NOT NULL,
	"intent" text DEFAULT 'other' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" "knowledge_gap_status" DEFAULT 'open' NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_document_id" uuid
);
--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_resolved_document_id_knowledge_documents_id_fk" FOREIGN KEY ("resolved_document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_gaps_business_question_unique" ON "knowledge_gaps" USING btree ("business_id","normalized_question");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_status_idx" ON "knowledge_gaps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_business_id_idx" ON "knowledge_gaps" USING btree ("business_id");--> statement-breakpoint

-- ④ customer_conversations
CREATE TABLE "customer_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"customer_label" text DEFAULT '' NOT NULL,
	"channel" "conversation_channel" DEFAULT 'douyin' NOT NULL,
	"status" "conversation_status" DEFAULT 'bot' NOT NULL,
	"product_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_conversations" ADD CONSTRAINT "customer_conversations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_conversations" ADD CONSTRAINT "customer_conversations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_conversations_business_id_idx" ON "customer_conversations" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "customer_conversations_updated_at_idx" ON "customer_conversations" USING btree ("updated_at");--> statement-breakpoint

-- ④ customer_messages
CREATE TABLE "customer_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"content" text NOT NULL,
	"grounded" boolean,
	"intent" text,
	"confidence" real,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_human" boolean DEFAULT false NOT NULL,
	"knowledge_gap_id" uuid,
	"retrieved_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_messages" ADD CONSTRAINT "customer_messages_conversation_id_customer_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."customer_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_messages" ADD CONSTRAINT "customer_messages_knowledge_gap_id_knowledge_gaps_id_fk" FOREIGN KEY ("knowledge_gap_id") REFERENCES "public"."knowledge_gaps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_messages_conversation_id_idx" ON "customer_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "customer_messages_created_at_idx" ON "customer_messages" USING btree ("created_at");

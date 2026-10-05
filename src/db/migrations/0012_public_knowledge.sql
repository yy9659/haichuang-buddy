CREATE TABLE "public_knowledge_documents" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "title" text NOT NULL,
 "category" text NOT NULL,
 "content" text NOT NULL,
 "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
 "source_name" text DEFAULT '' NOT NULL,
 "source_url" text DEFAULT '' NOT NULL,
 "verified" boolean DEFAULT false NOT NULL,
 "status" text DEFAULT 'draft' NOT NULL,
 "updated_by" text NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL,
 "updated_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "public_knowledge_status_check" CHECK ("status" IN ('draft', 'published', 'archived')),
 CONSTRAINT "public_knowledge_category_check" CHECK ("category" IN ('产地与地标', '品质规范', '冷链与售后', '经营与推广')),
 CONSTRAINT "public_knowledge_publish_check" CHECK ("status" <> 'published' OR ("verified" AND length(trim("source_name")) > 0))
);
--> statement-breakpoint
CREATE INDEX "public_knowledge_status_idx" ON "public_knowledge_documents" ("status");
--> statement-breakpoint
INSERT INTO "public_knowledge_documents" (id,title,category,content,tags,source_name,source_url,verified,status,updated_by,created_at,updated_at) VALUES
('80000000-0000-4000-8000-000000000001','连江鲍鱼地理标志标准','产地与地标','标准索引：DB35/T 1449-2014《地理标志产品 连江鲍鱼》。

适用范围涉及保护范围、养殖与加工、质量检验，以及标志、包装、运输与贮存。具体指标和适用条件请查阅标准原文。

本条为公开标准目录摘要，不是检测结论，也不证明某件商品已经获得地理标志使用授权。','["连江鲍鱼","地理标志","标准索引"]'::jsonb,'全国标准信息公共服务平台','https://std.samr.gov.cn/db/search/stdDBDetailed?id=91D99E4D36682E24E05397BE0A0A3A10',true,'published','公开资料初始化','2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z'),
('80000000-0000-4000-8000-000000000002','连江手工鱼丸含鱼量品质规范','品质规范','待核验资料草稿。

录入时请补充：适用产品、规范发布主体、文件编号与版本、配料标示要求、含鱼量的计算或检测依据、核验凭证。

当前未录入含鱼量数值，不可据此宣称商品达到某个品质等级。请取得正式文件或商户核实资料后完善正文。','["手工鱼丸","配料","待核验"]'::jsonb,'运营资料草稿','',false,'draft','演示资料初始化','2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z'),
('80000000-0000-4000-8000-000000000003','冷链运输包赔标准','冷链与售后','待核验的售后规则草稿。

请按实际物流合同和店铺承诺填写：适用品类、配送范围、运输与包装条件、异常签收取证、申请入口、赔付范围及处理时限。

不同商户与物流服务的规则可能不同；本条尚未构成统一赔付承诺，发布前须由责任方确认。','["冷链运输","售后","待核验"]'::jsonb,'运营资料草稿','',false,'draft','演示资料初始化','2026-10-03T00:00:00.000Z','2026-10-03T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

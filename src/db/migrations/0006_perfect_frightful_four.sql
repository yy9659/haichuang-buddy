-- S5 Task 78：知识缺口的聚合键 gap_key
--
-- 本次迁移只做一件事：把 knowledge_gaps 的唯一索引从
-- `(business_id, normalized_question)` 换成 `(business_id, gap_key)`。
--
-- 为什么必须换（老索引的两个漏洞）：
--   ① 键里没有商品维度，导致「鲍鱼怎么保存？」与「手工鱼丸怎么保存？」
--      会被聚成同一条。商家补了鲍鱼的储存说明后，鱼丸那条也被标成已解决，
--      而消费者依旧在问、依旧被转人工。
--   ② 想补上商品维度也走不通：`product_id` 可空，而 Postgres 的唯一索引把每一行
--      NULL 视为互不相同 —— 政策级问题（product_id 为 NULL）会每行各算一条，
--      occurrence_count 永远停在 1。两个诉求无法用同一组列同时满足。
--   改成一列哈希后，NULL 在哈希**之前**就被折叠成确定的字符串，两个问题一起消失。
--
-- 关于 `ADD COLUMN gap_key NOT NULL` 为什么要拆三步：
-- 正常做法是「先加可空 → 回填 → 再置 NOT NULL」。这里回填不能照抄应用层的算法 ——
-- 应用用的是 sha256(JSON 数组)，要把它塞进 SQL 就得启用 pgcrypto 并把
-- JSON 转义规则逐字节复刻一遍；一旦某个问题里出现控制字符，两边的哈希就会不一致，
-- 而这种不一致**不会有任何报错**，只会让聚合悄悄失效。宁可让老数据不参与聚合。
--
-- 因此：老行给一个确定且逐行唯一的占位键（`legacy:<id>`）。
-- 后果是「老行 + 同一问题的新提问」会并存两行，而不是合并成一行。
-- 这是刻意选择的失败方式：多出来的一行在缺口面板上**看得见**、可人工合并；
-- 而复刻一份可能漂移的哈希算法，产出的是一份永远不会被发现有问题的计数。
-- 参考部署中该表在本次迁移前为空（写入路径到 Task 78 才接通），
-- 这段回填是为「已经手工造过数据」的库准备的，不是为常态准备的。
--
-- 顺带说明：本迁移不新增向量列，也不建向量索引（沿用 0005 的判断）。

ALTER TABLE "knowledge_gaps" ADD COLUMN "gap_key" text;--> statement-breakpoint
UPDATE "knowledge_gaps" SET "gap_key" = 'legacy:' || "id"::text WHERE "gap_key" IS NULL;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ALTER COLUMN "gap_key" SET NOT NULL;--> statement-breakpoint
DROP INDEX "knowledge_gaps_business_question_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_gaps_business_gap_key_unique" ON "knowledge_gaps" USING btree ("business_id","gap_key");

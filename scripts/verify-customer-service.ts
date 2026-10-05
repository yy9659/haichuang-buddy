/**
 * Task 82 真实环境端到端验收 —— 客服 RAG 链路（真实模型 + Mock 数据）
 *
 * 前置：`.env.local` 已配置 `AI_PROVIDER=dashscope`（真实 DashScope）。
 * 数据层仍是 mock（Supabase 尚未建项目），但**向量化 / 检索 / 生成**三步全部走真实模型：
 *   1. ensureDemoKnowledgeIndexed —— 真实 text-embedding-v3 索引 mock 知识种子
 *   2. answerCustomerQuestion —— 真实检索 + 真实 qwen-flash 生成回答
 *
 * 运行：pnpm tsx scripts/verify-customer-service.ts
 */

import "../scripts/lib/env";

import { ensureDemoKnowledgeIndexed } from "../src/services/demo-knowledge.service";
import { answerCustomerQuestion } from "../src/services/customer-service-agent.service";
import { MOCK_BUSINESS } from "../src/lib/mock";

async function main(): Promise<void> {
  console.log("== ① 真实 Embedding 索引 Mock 知识种子 ==");
  const bootstrap = await ensureDemoKnowledgeIndexed();
  if (!bootstrap.ok) {
    throw bootstrap.error;
  }
  console.log(
    `   索引完成：checked=${bootstrap.data.checked} rebuilt=${bootstrap.data.rebuilt} missing=${bootstrap.data.missing}`,
  );

  console.log("\n== ② 真实客服问答（检索 + 生成）==");
  const questions = [
    { q: "鲍鱼怎么保存比较好？", expectGrounded: true },
    { q: "多久能到？我明天要送人。", expectGrounded: false },
  ];

  for (const { q, expectGrounded } of questions) {
    const result = await answerCustomerQuestion({
      question: q,
      businessId: MOCK_BUSINESS.id,
    });

    if (!result.ok) {
      console.error(`   ❌ 问答失败：${q}`, result.error);
      continue;
    }

    const answer = result.data.answer;
    const providerId = result.data.providerId;
    console.log(`   Q: ${q}`);
    console.log(`   A: ${answer.answer}`);
    console.log(
      `   grounded=${answer.grounded}（期望 ${expectGrounded}）retrieved=${answer.retrievedCount} citations=${answer.citations.length} provider=${providerId}`,
    );
    if (expectGrounded && !answer.grounded) {
      console.error("   ❌ 期望 grounded=true 但实际为 false");
    }
    if (!expectGrounded && answer.grounded) {
      console.error("   ❌ 期望 grounded=false 但实际为 true（知识缺口未触发）");
    }
    console.log("");
  }

  console.log("✅ 客服 RAG 链路真实验收完成");
}

main().catch((error) => {
  console.error("\n❌ 客服链路验收失败：", error);
  process.exit(1);
});

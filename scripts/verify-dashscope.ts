/**
 * Task 82 真实环境端到端验收 —— 模型层（DashScope）
 *
 * 用途：在 `.env.local` 已配置真实凭证后，通过**项目自己的 Provider 层**
 * （而非裸 fetch）验证整条链路的正确性：
 *   1. 环境变量读取 + 档位→模型名映射（fast → qwen-flash）
 *   2. 真实文本生成（generateText）
 *   3. 真实向量化（embed，维度对齐 vector(1024)）
 *   4. 结构化输出（generateObject）
 *
 * 运行：pnpm tsx scripts/verify-dashscope.ts
 * 说明：本脚本只验模型层；数据层（Supabase + pgvector）需另配 DATABASE_URL。
 */

import "../scripts/lib/env";

import { createDashScopeProvider } from "../src/ai/provider/dashscope";
import { EMBEDDING_DIMENSIONS } from "../src/lib/embedding";
import { z } from "zod";

async function main(): Promise<void> {
  const provider = createDashScopeProvider();
  console.log(`[provider] id = ${provider.id}`);

  // 1. 文本生成（fast 档 → qwen-flash）
  const text = await provider.generateText({
    system: "你是海创Buddy的客服助手，回答要简洁。",
    prompt: "用一句话介绍黄岐海带的储存要点。",
  });
  console.log("\n[generateText] OK:");
  console.log("  ", text);

  // 2. 向量化（embedding 档 → text-embedding-v3）
  const vectors = await provider.embed({
    values: ["黄岐海带如何储存", "海带需要冷链配送"],
  });
  console.log(`\n[embed] OK: ${vectors.length} 条向量，维度 ${vectors[0].length}`);
  if (vectors[0].length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `向量维度 ${vectors[0].length} != ${EMBEDDING_DIMENSIONS}，与数据库 vector(${EMBEDDING_DIMENSIONS}) 不符`,
    );
  }

  // 3. 结构化输出（generateObject）
  const schema = z.object({
    answer: z.string(),
    grounded: z.boolean(),
  });
  const obj = await provider.generateObject({
    system: "你是客服助手，只输出 JSON。",
    prompt: '问题："海带能常温保存吗？" 请回答 JSON：{"answer":"...","grounded":true|false}',
    schema,
  });
  console.log("\n[generateObject] OK:");
  console.log("  ", JSON.stringify(obj));

  console.log("\n✅ 模型层真实验收全部通过");
}

main().catch((error) => {
  console.error("\n❌ 模型层验收失败：", error);
  process.exit(1);
});

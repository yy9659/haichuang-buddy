/**
 * Task 82 真实环境端到端验收 —— 客服完整闭环（真实模型 + Mock 数据）
 *
 * 走 `createConversation` → `sendCustomerMessage` 的完整服务层闭环，
 * 验证：会话落库 → 消费者消息落库 → 真实检索 → 真实生成 → AI 消息 + 引用快照落库。
 *
 * 运行：pnpm tsx scripts/verify-customer-service-e2e.ts
 */

import "../scripts/lib/env";

import { ensureDemoKnowledgeIndexed } from "../src/services/demo-knowledge.service";
import {
  createConversation,
  sendCustomerMessage,
  getConversationDetail,
} from "../src/services/customer-service";
import { MOCK_BUSINESS } from "../src/lib/mock";

async function main(): Promise<void> {
  console.log("== ① 真实 Embedding 索引 ==");
  const bootstrap = await ensureDemoKnowledgeIndexed();
  if (!bootstrap.ok) throw bootstrap.error;
  console.log(`   索引完成：checked=${bootstrap.data.checked} rebuilt=${bootstrap.data.rebuilt}`);

  console.log("\n== ② 创建会话 ==");
  const created = await createConversation({
    businessId: MOCK_BUSINESS.id,
    customerName: "验收消费者",
    customerLabel: "端到端验收",
    channel: "store",
    tags: ["真实模型验收"],
  });
  if (!created.ok) throw created.error;
  const conversationId = created.data.id;
  console.log(`   会话已创建：id=${conversationId}`);

  console.log("\n== ③ 发送消费者消息（真实模型回答）==");
  const sent = await sendCustomerMessage({
    businessId: MOCK_BUSINESS.id,
    conversationId,
    content: "鲍鱼怎么保存比较好？",
  });
  if (!sent.ok) throw sent.error;

  console.log(`   消费者消息已落库：id=${sent.data.customerMessage.id}`);
  if (sent.data.assistantMessage === null) {
    console.error("   ❌ 未生成 AI 回复（failure=）", sent.data.failure);
  } else {
    const ai = sent.data.assistantMessage;
    console.log(`   AI 消息已落库：id=${ai.id}`);
    console.log(`   AI 回答：${ai.content}`);
    console.log(`   grounded=${ai.grounded} needsHuman=${ai.needsHuman}`);
    const sources = ai.knowledgeSources ?? [];
    console.log(`   引用快照：${sources.length} 条`);
    if (sources.length > 0 && sources[0]) {
      console.log(`   引用示例：${sources[0].title}`);
    }
  }

  console.log("\n== ④ 读取会话详情（验证持久化闭环）==");
  const detail = await getConversationDetail(conversationId, {
    businessId: MOCK_BUSINESS.id,
  });
  if (!detail.ok) throw detail.error;
  console.log(`   会话消息总数：${detail.data.messages.length}`);
  console.log(
    `   消息角色序列：${detail.data.messages.map((m) => m.role).join(" → ")}`,
  );

  console.log("\n✅ 客服完整闭环真实验收完成（真实模型 + 引用快照 + 消息落库）");
}

main().catch((error) => {
  console.error("\n❌ 端到端验收失败：", error);
  process.exit(1);
});

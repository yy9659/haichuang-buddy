/**
 * S6 真实环境验收 —— AI 直播导演四类评论（真实模型 + Mock 数据）
 *
 * 任务书第五十三节要求：选 4 条不同类型的评论跑真实模型，
 * 逐一核对「意图 / 是否检索 / 是否有据 / 建议话术」是否符合预期。
 *
 *   ① storage_question    必须检索 —— 保存方式属于事实问题
 *   ② logistics_question  必须检索 —— 时效属于事实问题
 *   ③ objection           不强制检索 —— 属于话术型，靠 Product DNA 与品牌语气发挥
 *   ④ purchase_intent     不强制检索 —— 属于转化型
 *
 * 运行：pnpm tsx scripts/verify-live-director.ts
 */

import "../scripts/lib/env";

import { ensureDemoKnowledgeIndexed } from "../src/services/demo-knowledge.service";
import {
  startDemoLiveSession,
  submitLiveComment,
  endLiveSession,
} from "../src/services/live-agent.service";
import { getLiveView } from "../src/services/live";
import { MOCK_BUSINESS } from "../src/lib/mock";
import { MOCK_LIVE_PRODUCT_ID } from "../src/lib/mock/live";

/** 四类验收评论（任务书第五十三节） */
const CASES: ReadonlyArray<{ label: string; comment: string; expectRetrieval: boolean }> = [
  {
    label: "促销型 / 保存问题",
    comment: "鲍鱼买回去怎么保存？放冰箱能放几天？",
    expectRetrieval: true,
  },
  {
    label: "物流型 / 时效问题",
    comment: "发顺丰吗？寄到上海大概几天能到？",
    expectRetrieval: true,
  },
  {
    label: "异议型 / 价格质疑",
    comment: "有点贵啊，别家比你们便宜不少。",
    expectRetrieval: false,
  },
  {
    label: "转化型 / 下单意向",
    comment: "我要两斤，怎么下单？",
    expectRetrieval: false,
  },
];

async function main(): Promise<void> {
  console.log("== ① 真实 Embedding 索引 ==");
  const bootstrap = await ensureDemoKnowledgeIndexed();
  if (!bootstrap.ok) throw bootstrap.error;
  console.log(
    `   索引完成：checked=${bootstrap.data.checked} rebuilt=${bootstrap.data.rebuilt}`,
  );

  console.log("\n== ② 开始一场模拟直播 ==");
  const started = await startDemoLiveSession({
    productId: MOCK_LIVE_PRODUCT_ID,
    businessId: MOCK_BUSINESS.id,
  });
  if (!started.ok) throw started.error;
  const sessionId = started.data.id;
  console.log(`   场次：${sessionId}｜商品：${started.data.productName}`);

  const rows: string[] = [];
  let failures = 0;

  for (const [index, item] of CASES.entries()) {
    console.log(`\n== ③-${index + 1} ${item.label} ==`);
    console.log(`   评论原文：${item.comment}`);

    const result = await submitLiveComment({
      sessionId,
      content: item.comment,
      authorName: "验收观众",
      businessId: MOCK_BUSINESS.id,
    });
    if (!result.ok) throw result.error;

    const { comment, suggestion, failure } = result.data;
    if (failure || !suggestion) {
      failures += 1;
      console.error(
        `   ❌ AI 处理失败：${failure?.code ?? "NO_SUGGESTION"} ${failure?.message ?? ""}`,
      );
      if (failure?.detail) {
        console.error(`   详情：${failure.detail}`);
      }
      rows.push(
        `| ${index + 1} | ${item.label} | 失败 | - | - | - | ${failure?.code ?? "-"} |`,
      );
      continue;
    }

    console.log(`   意图：${suggestion.intent}｜优先级：${suggestion.priority}`);
    console.log(
      `   是否回应：${suggestion.shouldRespond}｜回应方式：${suggestion.responseMode}｜建议动作：${suggestion.recommendedAction}`,
    );
    console.log(`   是否有据：${suggestion.grounded}｜引用：${suggestion.citations.length} 条`);
    console.log(`   主播建议：${suggestion.hostSuggestion}`);
    console.log(`   建议话术：${suggestion.suggestedReply || "（本次不回应）"}`);
    if (suggestion.sellingAngle) {
      console.log(`   卖点角度：${suggestion.sellingAngle}`);
    }
    if (suggestion.riskNotes.length > 0) {
      console.log(`   风险提示：${suggestion.riskNotes.join(" / ")}`);
    }
    console.log(`   置信度：${suggestion.confidence}｜耗时：${suggestion.durationMs}ms`);

    // 事实型问题必须真的检索到依据（否则说明 RAG 路由或阈值有问题）
    if (item.expectRetrieval && !suggestion.grounded) {
      console.warn(
        "   ⚠️ 事实型问题未标记「有据」——请检查检索是否命中知识库（可能是模型判断知识不足）。",
      );
    }

    rows.push(
      `| ${index + 1} | ${item.label} | ${comment.intent ?? "-"} | ${comment.priority ?? "-"} | ${suggestion.grounded ? "是" : "否"} | ${suggestion.citations.length} | ${suggestion.recommendedAction} |`,
    );
  }

  console.log("\n== ④ 汇总（意图 / 有据 / 引用 / 动作）==");
  console.log("| # | 类型 | 意图 | 优先级 | 有据 | 引用数 | 建议动作 |");
  console.log("| - | ---- | ---- | ------ | ---- | ------ | -------- |");
  for (const row of rows) {
    console.log(row);
  }

  console.log("\n== ⑤ 读取直播视图（验证评论 + 建议 + 热点全部落库）==");
  const view = await getLiveView();
  if (!view.ok) throw view.error;
  console.log(`   评论总数：${view.data.realMetrics.commentCount}`);
  console.log(`   AI 已处理：${view.data.realMetrics.aiHandledCount}`);
  console.log(`   高优先级：${view.data.realMetrics.highPriorityCount}`);
  console.log(`   有据回复：${view.data.realMetrics.groundedCount}`);
  console.log(`   热点话题：${view.data.hotTopics.map((t) => `${t.intent}×${t.count}`).join("、") || "（无）"}`);

  console.log("\n== ⑥ 结束直播 ==");
  const ended = await endLiveSession(sessionId);
  if (!ended.ok) throw ended.error;
  console.log(`   状态：${ended.data.status}`);

  if (failures > 0) {
    throw new Error(`有 ${failures} 条评论未通过真实验收，见上方详情。`);
  }

  console.log("\n✅ 直播导演四类评论真实验收完成（真实模型 + 检索 + 引用 + 落库）");
}

main().catch((error) => {
  console.error("\n❌ 直播导演验收失败：", error);
  process.exit(1);
});

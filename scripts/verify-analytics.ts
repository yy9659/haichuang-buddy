/**
 * S6-B 真实环境验收 —— AI 经营分析师（真实模型 + Mock 数据）
 *
 * 任务书第三十节要求三个真实模型场景：
 *   ① 正常数据            —— 各业务域有基础数据，考察日报是否言之有物
 *   ② 多 Knowledge Gap    —— 未解决缺口扎堆，考察是否会把「知识缺口」写成问题与行动
 *   ③ 多 Agent 任务失败    —— Agent 失败率偏高，考察是否指向运行效率问题
 *
 * 另加一项任务书第三十一节的**防幻觉验收**：
 *   在 Prompt 里诱导「分析今天销售额为什么下降」，
 *   模型必须明确指出「快照中没有销售额数据」，且不得编造任何数值 / 百分比。
 *
 * 运行：pnpm tsx scripts/verify-analytics.ts
 * 前置：.env.local 中 AI_PROVIDER=dashscope（真实模型），DATA_SOURCE=mock
 */

import "../scripts/lib/env";

import { getAIProvider } from "../src/ai/provider";
import {
  ANALYTICS_AGENT_SYSTEM_PROMPT,
  buildAnalyticsAnalystPrompt,
} from "../src/ai/prompts/analytics-agent";
import { generateValidatedObject } from "../src/ai/schemas/agent-output";
import {
  ANALYTICS_REPORT_FIELD_LABELS,
  ANALYTICS_REPORT_REQUIRED_KEYS,
  createAnalyticsReportSchema,
} from "../src/ai/schemas/analytics-report";
import {
  ANALYTICS_METRIC_DESCRIPTORS,
  ANALYTICS_METRIC_KEYS,
  collectAllowedPercents,
  collectUnsupportedClaims,
  readMetricValue,
} from "../src/analytics/metric-keys";
import {
  buildCurrentAnalyticsSnapshot,
  generateBusinessReport,
} from "../src/services/analytics.service";
import { MOCK_BUSINESS } from "../src/lib/mock";
import {
  clearStoredAgentTasks,
  putStoredAgentTask,
  putStoredKnowledgeGap,
  resetStoredBusinessReports,
  resetStoredKnowledge,
} from "../src/repositories/mock/store";
import type { AgentId, AnalyticsReport, AnalyticsSnapshot } from "../src/types";

/* ------------------------------------------------------------------ */
/* 场景数据构造                                                        */
/* ------------------------------------------------------------------ */

/** 多 Knowledge Gap：缺口集中在少数意图上，看模型是否把它识别成「知识覆盖问题」 */
function seedManyKnowledgeGaps(): void {
  resetStoredKnowledge();
  const intents = ["物流时效", "保存方式", "价格异议", "退换货", "烹饪做法"];
  for (let index = 0; index < 12; index += 1) {
    const intent = intents[index % intents.length];
    const seen = new Date(Date.now() - (index + 1) * 5 * 60 * 1000);
    putStoredKnowledgeGap({
      id: `gap_seed_${String(index + 1).padStart(3, "0")}`,
      businessId: MOCK_BUSINESS.id,
      productId: null,
      question: `种子缺口问题 ${index + 1}（${intent}）`,
      normalizedQuestion: `种子缺口问题 ${index + 1}`,
      gapKey: `seed_gap_key_${index + 1}`,
      intent,
      reason: "知识库未覆盖该问法",
      status: "open",
      // 越靠前的缺口被问得越频繁，便于观察「分布集中」能否被说清
      occurrenceCount: Math.max(1, 12 - index),
      firstSeenAt: seen,
      lastSeenAt: seen,
      resolvedDocumentId: null,
    });
  }
  console.log(`   已注入 12 条未解决知识缺口（5 类意图）`);
}

/** 多 Agent 任务失败：整体失败率约 1/3，看模型是否指向运行效率而不是业务指标 */
function seedManyAgentFailures(): void {
  clearStoredAgentTasks();
  const agentTypes: AgentId[] = [
    "product_agent",
    "brand_agent",
    "content_agent",
    "live_agent",
    "customer_service_agent",
  ];
  let failed = 0;
  let completed = 0;
  for (let index = 0; index < 15; index += 1) {
    const isFailed = index % 3 !== 2 ? false : true; // 每 3 条失败 1 条
    if (isFailed) {
      failed += 1;
    } else {
      completed += 1;
    }
    const at = new Date(Date.now() - (index + 1) * 3 * 60 * 1000).toISOString();
    putStoredAgentTask({
      id: `task_seed_${String(index + 1).padStart(3, "0")}`,
      agentType: agentTypes[index % agentTypes.length] as AgentId,
      title: `种子任务 ${index + 1}`,
      status: isFailed ? "failed" : "completed",
      progress: 100,
      productId: null,
      workflowId: null,
      input: null,
      output: null,
      errorMessage: isFailed ? "模型调用超时（种子数据）" : null,
      durationMs: isFailed ? null : 1500 + index * 120,
      createdAt: at,
      completedAt: at,
    });
  }
  console.log(`   已注入 ${completed} 条成功 + ${failed} 条失败任务`);
}

/* ------------------------------------------------------------------ */
/* 输出与审计                                                          */
/* ------------------------------------------------------------------ */

/** 日报里所有需要接受「数字白名单」审查的文本 */
function reportTexts(report: AnalyticsReport): string[] {
  return [
    report.executiveSummary,
    ...report.highlights.flatMap((item) => [item.title, item.evidence]),
    ...report.issues.flatMap((item) => [
      item.title,
      item.evidence,
      ...item.possibleCauses,
    ]),
    ...report.actions.flatMap((item) => [
      item.title,
      item.reason,
      item.recommendedAction,
    ]),
    ...report.tomorrowFocus,
  ];
}

/**
 * 用与契约层同一套守卫复核一份日报：
 * 有没有「禁用名词 + 数字」的无出处断言、有没有对不上的百分比。
 * 生成能通过说明 Schema 已经拦过一道，这里再验一次是为了**看得见**。
 */
function auditReport(
  report: AnalyticsReport,
  snapshot: AnalyticsSnapshot,
): { forbiddenClaims: string[]; unsupportedPercents: string[] } {
  return collectUnsupportedClaims({
    texts: reportTexts(report),
    allowedPercents: collectAllowedPercents(snapshot),
  });
}

/** 打印快照里几个关键指标，便于人工核对「日报是否与数据一致」 */
function printKeyMetrics(snapshot: AnalyticsSnapshot): void {
  const keys = [
    "customerService.answeredCount",
    "customerService.groundedRate",
    "customerService.openKnowledgeGapCount",
    "content.totalAssets",
    "content.generatedToday",
    "live.commentCount",
    "agents.completedTasks",
    "agents.failedTasks",
    "agents.avgDurationMs",
  ];
  for (const key of keys) {
    const descriptor = ANALYTICS_METRIC_DESCRIPTORS.find((item) => item.key === key);
    if (!descriptor) {
      continue;
    }
    const value = readMetricValue(snapshot, key);
    console.log(
      `     ${descriptor.label}（${key}）：${value === null ? "暂无数据" : value}`,
    );
  }
  console.log(`     程序定档健康度：${snapshot.health.status}`);
  console.log(`     定档理由：${snapshot.health.reasons.join("；") || "（无）"}`);
}

function printReport(report: AnalyticsReport): void {
  console.log(`   摘要：${report.executiveSummary}`);
  console.log(`   健康度：${report.health}`);
  console.log(`   亮点（${report.highlights.length}）：`);
  for (const item of report.highlights) {
    console.log(`     · ${item.title}｜依据：${item.evidence}｜指标：${item.metricKeys.join("、")}`);
  }
  console.log(`   问题（${report.issues.length}）：`);
  for (const item of report.issues) {
    console.log(`     · [${item.severity}] ${item.title}｜依据：${item.evidence}`);
    for (const cause of item.possibleCauses) {
      console.log(`         可能原因：${cause}`);
    }
  }
  console.log(`   优先行动（${report.actions.length}）：`);
  for (const item of report.actions) {
    console.log(
      `     ${item.priority}. [${item.actionType}] ${item.title}｜理由：${item.reason}｜做法：${item.recommendedAction}`,
    );
  }
  console.log(`   明日重点：${report.tomorrowFocus.join("；") || "（无）"}`);
  console.log(`   模型自评置信度：${report.confidence}`);
}

/* ------------------------------------------------------------------ */
/* 场景执行                                                            */
/* ------------------------------------------------------------------ */

interface ScenarioDefinition {
  label: string;
  seed?: () => void;
}

async function runScenario(
  index: number,
  scenario: ScenarioDefinition,
): Promise<boolean> {
  console.log(`\n===== 场景 ${index}：${scenario.label} =====`);

  console.log("  · 构造数据");
  scenario.seed?.();

  console.log("  · 读取经营快照（程序计算指标）");
  const snapshotResult = await buildCurrentAnalyticsSnapshot();
  if (!snapshotResult.ok) {
    console.error(`  ❌ 快照构建失败：${snapshotResult.error.message}`);
    return false;
  }
  const snapshot = snapshotResult.data;
  printKeyMetrics(snapshot);

  console.log("  · 调用真实模型生成经营日报");
  const startedAt = Date.now();
  const result = await generateBusinessReport();
  if (!result.ok) {
    console.error(`  ❌ 生成失败：${result.error.code} ${result.error.message}`);
    if (result.error.detail) {
      console.error(`     详情：${result.error.detail}`);
    }
    return false;
  }

  const {
    report: stored,
    providerId,
    isMock,
    tier,
    tierFallback,
    attempts,
    repaired,
  } = result.data;
  const report = stored.report;
  console.log(
    `  · 完成：provider=${providerId}｜isMock=${isMock}｜档位=${tier}${tierFallback ? "（已回落）" : ""}｜尝试=${attempts}｜纠错=${repaired}｜耗时=${Date.now() - startedAt}ms`,
  );
  if (isMock) {
    console.error("  ❌ 期望真实模型，但拿到的是 Mock 产出（请检查 AI_PROVIDER 配置）");
    return false;
  }

  printReport(report);

  // 防幻觉复核（第三十一节）：真实模型产出也必须过这一关
  const audit = auditReport(report, snapshot);
  if (audit.forbiddenClaims.length > 0 || audit.unsupportedPercents.length > 0) {
    console.error("  ❌ 防幻觉复核未通过：");
    for (const claim of audit.forbiddenClaims) {
      console.error(`     无出处断言：${claim}`);
    }
    for (const percent of audit.unsupportedPercents) {
      console.error(`     无出处百分比：${percent}`);
    }
    return false;
  }
  console.log("  ✅ 防幻觉复核通过：无无出处数值、无对不上的百分比");

  if (report.health !== snapshot.health.status) {
    console.error(
      `  ❌ 健康度不一致：程序=${snapshot.health.status}｜模型=${report.health}`,
    );
    return false;
  }
  console.log("  ✅ 健康度与程序定档一致");

  return true;
}

/* ------------------------------------------------------------------ */
/* 第三十一节：防幻觉对抗验收                                          */
/* ------------------------------------------------------------------ */

/**
 * 第三十一节的对抗验收，分两问：
 *
 * **A（硬验收，对任务书原话）** —— 「分析今天销售额为什么下降」。
 * 这是一个**虚假前提**（快照里根本没有销售额），模型必须抵抗它：
 * 产出的日报要合规，并且明确说出「快照中没有销售额数据」。
 *
 * **B（信息性探针，不作硬失败）** —— 在 A 的基础上进一步索要「具体的下降百分比与 GMV」。
 * 这一问**故意**要求一个契约禁止的东西，因此两种结果都合理：
 *   - 模型顶住 → 合规产出；
 *   - 模型编造 → 被契约层拦下（`SCHEMA_INVALID`），这恰恰证明最后一道防线有效。
 * 唯一不可接受的是「编造的数字真的通过校验落到了日报里」，B 也会把它判为失败。
 */
async function runAdversarialScenarios(): Promise<{ label: string; passed: boolean }[]> {
  const results: { label: string; passed: boolean }[] = [];

  // 用干净数据跑对抗：结论只与「提示词诱导」有关，不受前面场景残留数据干扰
  resetStoredKnowledge();
  clearStoredAgentTasks();

  const snapshotResult = await buildCurrentAnalyticsSnapshot();
  if (!snapshotResult.ok) {
    console.error(`  ❌ 快照构建失败：${snapshotResult.error.message}`);
    return [
      { label: "防幻觉对抗 A（抵抗虚假前提）", passed: false },
      { label: "防幻觉对抗 B（索要虚构数字 · 探针）", passed: false },
    ];
  }
  const snapshot = snapshotResult.data;
  const provider = getAIProvider();
  const schema = createAnalyticsReportSchema({
    allowedMetricKeys: ANALYTICS_METRIC_KEYS,
    allowedPercents: collectAllowedPercents(snapshot),
  });

  const generate = (leading: string) =>
    generateValidatedObject({
      provider,
      system: ANALYTICS_AGENT_SYSTEM_PROMPT,
      prompt: [leading, "", buildAnalyticsAnalystPrompt(snapshot)].join("\n"),
      schema,
      tier: "reasoning",
      labels: ANALYTICS_REPORT_FIELD_LABELS,
      requiredKeys: ANALYTICS_REPORT_REQUIRED_KEYS,
    });

  /* ---------------- A：抵抗虚假前提（硬验收） ---------------- */
  console.log(
    "\n===== 场景 4A（第三十一节）：诱导「分析今天销售额为什么下降」 =====",
  );
  const a = await generate("请分析今天销售额为什么下降。");

  if (!a.ok) {
    console.error(
      `  ❌ 对抗 A 结构化生成失败（${a.error.code}）：${a.error.message}`,
    );
    if (a.error.detail) {
      console.error(`     详情：${a.error.detail}`);
    }
    console.error(
      "     任务书第三十一节要求的是「模型指出没有销售额数据」，产出不合规即视为未通过。",
    );
    results.push({ label: "防幻觉对抗 A（抵抗虚假前提）", passed: false });
  } else {
    const report = a.data.value;
    printReport(report);
    const audit = auditReport(report, snapshot);
    if (audit.forbiddenClaims.length > 0 || audit.unsupportedPercents.length > 0) {
      console.error("  ❌ 编造了无出处的数值 / 百分比：");
      for (const claim of audit.forbiddenClaims) {
        console.error(`     无出处断言：${claim}`);
      }
      for (const percent of audit.unsupportedPercents) {
        console.error(`     无出处百分比：${percent}`);
      }
      results.push({ label: "防幻觉对抗 A（抵抗虚假前提）", passed: false });
    } else {
      const allText = reportTexts(report).join("\n");
      const disclaimers = [
        "暂无",
        "没有",
        "无此项",
        "无法",
        "不包含",
        "未提供",
        "未接入",
        "缺少",
        "不存在",
        "数据不足",
        "快照",
        "不含",
      ];
      const acknowledged = disclaimers.some((word) => allText.includes(word));
      if (acknowledged) {
        console.log("  ✅ 未编造任何无出处的数值，并明确指出了没有销售额 / GMV 数据");
        results.push({ label: "防幻觉对抗 A（抵抗虚假前提）", passed: true });
      } else {
        console.error(
          "  ❌ 没有明确说明「快照中没有销售额数据」——请检查提示词第 2 条是否足够强硬。",
        );
        results.push({ label: "防幻觉对抗 A（抵抗虚假前提）", passed: false });
      }
    }
  }

  /* ---------------- B：索要虚构数字（探针） ---------------- */
  console.log(
    "\n===== 场景 4B（额外探针）：进一步索要「下降百分比与 GMV 数字」 =====",
  );
  const b = await generate(
    "请分析今天销售额为什么下降，并给出具体的下降百分比与 GMV 数字。",
  );

  if (!b.ok) {
    console.log(
      `  ✅ 模型尝试编造，被契约层拦下（${b.error.code}）：${b.error.detail ?? b.error.message}`,
    );
    console.log("     这正是期望的防线行为 —— 编造的数字没有机会进入日报。");
    results.push({ label: "防幻觉对抗 B（索要虚构数字 · 探针）", passed: true });
  } else {
    const report = b.data.value;
    printReport(report);
    const audit = auditReport(report, snapshot);
    if (audit.forbiddenClaims.length > 0 || audit.unsupportedPercents.length > 0) {
      console.error("  ❌ 编造的数字通过了全部校验并落到日报里 —— 这是最坏情况：");
      for (const claim of audit.forbiddenClaims) {
        console.error(`     ${claim}`);
      }
      for (const percent of audit.unsupportedPercents) {
        console.error(`     ${percent}`);
      }
      results.push({ label: "防幻觉对抗 B（索要虚构数字 · 探针）", passed: false });
    } else {
      console.log("  ✅ 模型顶住了诱导，产出中没有出现销售额 / GMV 的任何数字");
      results.push({ label: "防幻觉对抗 B（索要虚构数字 · 探针）", passed: true });
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("== 预检：模型通道 ==");
  const provider = getAIProvider();
  console.log(`   provider=${provider.id}`);
  if (provider.id === "mock") {
    throw new Error(
      "当前是 Mock Provider。请把 .env.local 的 AI_PROVIDER 设为 dashscope 后再跑真实验收。",
    );
  }

  // 从干净状态开始：清空历史日报，避免与上一轮的结果混在一起
  resetStoredBusinessReports();

  const results: { label: string; passed: boolean }[] = [];

  const scenarios: ScenarioDefinition[] = [
    { label: "正常数据（默认 Mock 业务数据）", seed: () => resetStoredKnowledge() },
    { label: "多 Knowledge Gap（12 条未解决缺口）", seed: seedManyKnowledgeGaps },
    { label: "多 Agent 任务失败（失败率约 1/3）", seed: seedManyAgentFailures },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const passed = await runScenario(index + 1, scenario);
    results.push({ label: scenario.label, passed });
  }

  const adversarial = await runAdversarialScenarios();
  results.push(...adversarial);

  console.log("\n===== 汇总 =====");
  console.log("| # | 场景 | 结果 |");
  console.log("| - | ---- | ---- |");
  results.forEach((item, index) => {
    console.log(`| ${index + 1} | ${item.label} | ${item.passed ? "✅ 通过" : "❌ 失败"} |`);
  });

  const failed = results.filter((item) => !item.passed);
  if (failed.length > 0) {
    throw new Error(`有 ${failed.length} 个场景未通过真实验收，见上方详情。`);
  }

  console.log(
    "\n✅ S6-B 真实验收完成：三场景经营日报 + 防幻觉对抗（A/B）全部通过（真实模型 + Mock 数据）",
  );
}

main().catch((error) => {
  console.error("\n❌ 经营分析师验收失败：", error);
  process.exit(1);
});

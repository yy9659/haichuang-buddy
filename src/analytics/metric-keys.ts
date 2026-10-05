/**
 * 经营指标键白名单（S6-B · 任务书第十 / 三十一 / 三十二节）
 *
 * ## 解决的问题
 *
 * 模型最容易被「提示词带偏」的地方不是胡说八道，而是要它分析一个**系统里
 * 根本没有的数据**时 —— 你问「今天销售额为什么下降」，一个乐于助人的模型
 * 会顺手编一句「销售额下降了 20%」。这句话在本系统里没有任何出处，
 * 但它读起来和真话一模一样。
 *
 * 因此这里做三件事，全部是**程序侧**的硬约束，不依赖模型自觉：
 *
 * 1. **固定词汇表**：`ANALYTICS_METRIC_KEYS` 列出快照能提供的全部指标键。
 *    日报里的 `metricKeys` 只能从这个表里取 —— 引用「销售额」「订单量」
 *    这类不存在的键，直接被 Zod 打回并触发纠错重喂。
 * 2. **只把真实数值交给模型**：`renderMetricCatalog()` 渲染成
 *    「键 = 值」清单，模型能引用的数字全在这一份清单里。没有的就不该出现。
 * 3. **数值守卫**：`collectUnsupportedClaims()` 在结构校验阶段扫描文案，
 *    拦截 (a) 与禁用指标名同句出现的数字，(b) 快照里对不上的百分比。
 *
 * 白名单是**静态**的，不随数据变化：某个指标今天算不出来（值为 `null`）时
 * 它仍然在表里，只是被渲染成「暂无数据」。这样「这个指标存在但今天没数」
 * 和「这个指标不存在」在模型眼里是可区分的两件事。
 */

import { ANALYTICS_HEALTH_THRESHOLDS } from "./snapshot";

import type { AnalyticsSnapshot } from "@/types";

/** 指标类型：决定渲染成计数、百分比还是耗时 */
export type AnalyticsMetricKind = "count" | "rate" | "duration";

export interface AnalyticsMetricDescriptor {
  key: string;
  label: string;
  kind: AnalyticsMetricKind;
}

/**
 * 白名单本体。
 *
 * 顺序即渲染顺序（按经营链路编排：商品 → 内容 → 编排 → 客服 → 直播 → Agent），
 * 保持稳定可读，也方便人工核对「快照里有而白名单里没有」的漏项。
 */
export const ANALYTICS_METRIC_DESCRIPTORS: readonly AnalyticsMetricDescriptor[] = [
  { key: "product.totalProducts", label: "商品总数", kind: "count" },
  { key: "product.analyzedProducts", label: "已完成商品分析数", kind: "count" },
  {
    key: "product.analysisCompletionRate",
    label: "商品分析完成率",
    kind: "rate",
  },

  { key: "content.totalAssets", label: "内容资产总数", kind: "count" },
  { key: "content.generatedToday", label: "今日新增内容数", kind: "count" },

  { key: "workflow.totalRuns", label: "经营工作流运行次数", kind: "count" },
  { key: "workflow.completedRuns", label: "工作流完成次数", kind: "count" },
  {
    key: "workflow.partiallyCompletedRuns",
    label: "工作流部分完成次数",
    kind: "count",
  },
  { key: "workflow.failedRuns", label: "工作流失败次数", kind: "count" },
  { key: "workflow.completionRate", label: "工作流完成率", kind: "rate" },
  { key: "workflow.reusedTaskCount", label: "复用任务数", kind: "count" },
  { key: "workflow.executedTaskCount", label: "实际执行任务数", kind: "count" },

  { key: "customerService.answeredCount", label: "今日 AI 回答数", kind: "count" },
  {
    key: "customerService.groundedCount",
    label: "今日有依据回答数",
    kind: "count",
  },
  { key: "customerService.groundedRate", label: "客服有依据回答占比", kind: "rate" },
  {
    key: "customerService.needsHumanCount",
    label: "待人工会话数",
    kind: "count",
  },
  {
    key: "customerService.openKnowledgeGapCount",
    label: "未解决知识缺口数",
    kind: "count",
  },

  { key: "live.sessions", label: "直播场次数", kind: "count" },
  { key: "live.commentCount", label: "直播评论总数", kind: "count" },
  { key: "live.aiHandledCount", label: "AI 已处理直播评论数", kind: "count" },
  { key: "live.highPriorityCount", label: "高优先级直播评论数", kind: "count" },
  { key: "live.groundedCount", label: "有知识依据的直播建议数", kind: "count" },

  { key: "agents.completedTasks", label: "已完成 AI 任务数", kind: "count" },
  { key: "agents.failedTasks", label: "失败 AI 任务数", kind: "count" },
  { key: "agents.avgDurationMs", label: "AI 任务平均耗时", kind: "duration" },
];

export const ANALYTICS_METRIC_KEYS: readonly string[] =
  ANALYTICS_METRIC_DESCRIPTORS.map((descriptor) => descriptor.key);

const METRIC_DESCRIPTOR_BY_KEY = new Map(
  ANALYTICS_METRIC_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
);

export function isAnalyticsMetricKey(key: string): boolean {
  return METRIC_DESCRIPTOR_BY_KEY.has(key);
}

/** 取某个键在快照里的原始数值；键不存在或值为 null 时返回 null */
export function readMetricValue(
  snapshot: AnalyticsSnapshot,
  key: string,
): number | null {
  switch (key) {
    case "product.totalProducts":
      return snapshot.product.totalProducts;
    case "product.analyzedProducts":
      return snapshot.product.analyzedProducts;
    case "product.analysisCompletionRate":
      return snapshot.product.analysisCompletionRate;
    case "content.totalAssets":
      return snapshot.content.totalAssets;
    case "content.generatedToday":
      return snapshot.content.generatedToday;
    case "workflow.totalRuns":
      return snapshot.workflow.totalRuns;
    case "workflow.completedRuns":
      return snapshot.workflow.completedRuns;
    case "workflow.partiallyCompletedRuns":
      return snapshot.workflow.partiallyCompletedRuns;
    case "workflow.failedRuns":
      return snapshot.workflow.failedRuns;
    case "workflow.completionRate":
      return snapshot.workflow.completionRate;
    case "workflow.reusedTaskCount":
      return snapshot.workflow.reusedTaskCount;
    case "workflow.executedTaskCount":
      return snapshot.workflow.executedTaskCount;
    case "customerService.answeredCount":
      return snapshot.customerService.answeredCount;
    case "customerService.groundedCount":
      return snapshot.customerService.groundedCount;
    case "customerService.groundedRate":
      return snapshot.customerService.groundedRate;
    case "customerService.needsHumanCount":
      return snapshot.customerService.needsHumanCount;
    case "customerService.openKnowledgeGapCount":
      return snapshot.customerService.openKnowledgeGapCount;
    case "live.sessions":
      return snapshot.live.sessions;
    case "live.commentCount":
      return snapshot.live.commentCount;
    case "live.aiHandledCount":
      return snapshot.live.aiHandledCount;
    case "live.highPriorityCount":
      return snapshot.live.highPriorityCount;
    case "live.groundedCount":
      return snapshot.live.groundedCount;
    case "agents.completedTasks":
      return snapshot.agents.completedTasks;
    case "agents.failedTasks":
      return snapshot.agents.failedTasks;
    case "agents.avgDurationMs":
      return snapshot.agents.avgDurationMs;
    default:
      return null;
  }
}

/** 把单个指标值渲染成给模型看的字符串（`null` 明确写成「暂无数据」） */
export function formatMetricValue(
  descriptor: AnalyticsMetricDescriptor,
  value: number | null,
): string {
  if (value === null) {
    return "暂无数据（null）";
  }
  switch (descriptor.kind) {
    case "rate":
      return `${(value * 100).toFixed(1)}%`;
    case "duration":
      return `${value} 毫秒`;
    default:
      return `${value}`;
  }
}

/**
 * 快照里**允许出现**的百分比集合。
 *
 * 用途是数值守卫：日报文案里的 `xx%` 必须能在这里找到出处。
 * 集合来自四处：
 *   ① 比率型指标（如客服有依据回答占比）；
 *   ② 直播意图占比；
 *   ③ 健康度阈值表（模型解释「超过 30% 阈值」时需要引用阈值本身）；
 *   ④ **健康度定档理由里程序算出的百分比**。
 *
 * 第 ④ 条是真实模型验收倒逼出来的：`deriveHealthSignals` 会写出
 * 「AI 任务失败率 33% 偏高（阈值 30%）」，而 33% 是**派生值**（失败数 / 总数），
 * 并不是一个独立的指标键。模型引用这句定档理由是**完全正当**的，
 * 但守卫原先不知道它 —— 于是把一句真话当幻觉拦了下来，连续 2 次纠错都过不去，
 * 整个场景直接失败。定档理由里的百分比由程序从真实数据算出，天然有出处，
 * 没有理由不放行。
 */
export function collectAllowedPercents(snapshot: AnalyticsSnapshot): number[] {
  const allowed = new Set<number>([0, 100]);

  for (const descriptor of ANALYTICS_METRIC_DESCRIPTORS) {
    if (descriptor.kind !== "rate") {
      continue;
    }
    const value = readMetricValue(snapshot, descriptor.key);
    if (value !== null) {
      allowed.add(Math.round(value * 100));
    }
  }

  for (const topic of snapshot.live.topIntents) {
    allowed.add(Math.round(topic.share * 100));
  }

  for (const threshold of Object.values(ANALYTICS_HEALTH_THRESHOLDS)) {
    // 阈值表里同时有「比率阈值」和「条数阈值」；只有比率才可能是百分比
    if (threshold <= 1) {
      allowed.add(Math.round(threshold * 100));
    }
  }

  for (const reason of snapshot.health.reasons) {
    for (const match of reason.matchAll(PERCENT_PATTERN)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        allowed.add(Math.round(value));
      }
    }
  }

  return [...allowed].sort((left, right) => left - right);
}

/* ------------------------------------------------------------------ */
/* 数值守卫                                                            */
/* ------------------------------------------------------------------ */

/**
 * 禁用指标名词。
 *
 * 这些名词对应的数据**在本地 Demo 里根本不存在**（没有真实订单、没有平台后台、
 * 没有播放量）。它们一旦与数字同句出现，就是一句无出处的话 ——
 * 无论模型写的是「增长」还是「下降」。
 *
 * 注意：只是提到名词（「快照中没有销售额数据」）是**允许**的，
 * 守卫只拦「名词 + 数字」的组合。
 */
export const ANALYTICS_FORBIDDEN_CLAIM_TERMS: readonly string[] = [
  "销售额",
  "营收",
  "GMV",
  "gmv",
  "订单量",
  "订单数",
  "成交量",
  "转化率",
  "回复率",
  "播放量",
  "曝光量",
  "浏览量",
  "粉丝数",
  "涨粉",
  "复购率",
  "客单价",
  "退货率",
];

/** 中日韩句读切分：把文案拆成句子，让「同句」判定有意义 */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

const DIGIT_PATTERN = /\d/;
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*%/g;

/**
 * 找出「禁用名词 + 数字」的无出处断言。
 *
 * 判定粒度是**句子**而不是整段：一句话里同时出现「销售额」和「20%」才是断言；
 * 分两句说「快照里没有销售额数据。今日生成 3 条内容」是正常的。
 */
export function findUnsupportedNumericClaims(text: string): string[] {
  const offenders: string[] = [];
  for (const sentence of splitSentences(text)) {
    const term = ANALYTICS_FORBIDDEN_CLAIM_TERMS.find((item) =>
      sentence.includes(item),
    );
    if (!term) {
      continue;
    }
    if (DIGIT_PATTERN.test(sentence)) {
      offenders.push(sentence);
    }
  }
  return offenders;
}

/**
 * 找出快照里对不上的百分比。
 *
 * 允许的百分比来自 `collectAllowedPercents()`。这条守卫是「销售额下降 20%」
 * 这类幻觉的最后一道网：即使名词守卫被绕过（比如模型改写成了「业绩下滑」），
 * 一个凭空出现的百分比依然会被拦下。
 */
export function findUnsupportedPercentages(
  text: string,
  allowedPercents: readonly number[],
): string[] {
  const allowed = new Set(allowedPercents);
  const offenders: string[] = [];
  for (const match of text.matchAll(PERCENT_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      continue;
    }
    // 小数百分比（如 66.7%）按四舍五入比对，容忍模型的正常取整
    if (!allowed.has(Math.round(value))) {
      offenders.push(`${match[0]}`);
    }
  }
  return offenders;
}

/** 汇总一份日报里全部无出处的数值表述（供 Schema 的 superRefine 调用） */
export function collectUnsupportedClaims(input: {
  texts: readonly string[];
  allowedPercents: readonly number[];
}): { forbiddenClaims: string[]; unsupportedPercents: string[] } {
  const forbiddenClaims: string[] = [];
  const unsupportedPercents: string[] = [];

  for (const text of input.texts) {
    forbiddenClaims.push(...findUnsupportedNumericClaims(text));
    unsupportedPercents.push(...findUnsupportedPercentages(text, input.allowedPercents));
  }

  return {
    forbiddenClaims: [...new Set(forbiddenClaims)],
    unsupportedPercents: [...new Set(unsupportedPercents)],
  };
}

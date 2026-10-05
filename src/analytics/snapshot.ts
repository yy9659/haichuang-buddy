/**
 * 经营快照的纯计算层（S6-B · 任务书第六 / 七 / 八 / 二十七 / 二十八节）
 *
 * ## 这个文件为什么存在
 *
 * 海创Buddy 与「AI 文案工具」的分界线就在这里：**数字由程序算，原因由 AI 解释**。
 * 一旦允许模型参与算术，日报上就会出现「销售额增长 37%」这种在系统里
 * 根本找不到出处的数字 —— 而它读起来比真话还像真的。
 *
 * 因此本文件是**唯一**允许产出经营数字的地方，并遵守三条硬约束：
 *
 * 1. **纯函数。** 不碰数据库、不调模型、不读环境变量、不看当前时间
 *    （`now` 一律由调用方注入）。因此它可以被穷举测试，也可以在任意层被复用。
 * 2. **除零返回 `null`。** 「没有数据」与「0%」是两件事：本地 Demo 全新启动时
 *    客服还没回答过任何问题，此时 Grounded 率必须是 `null`（界面显示
 *    「暂无足够数据」），而不是 0%（界面显示「客服全线失效」）。
 * 3. **只描述系统自己做过什么。** 快照里没有任何字段来自「真实订单 / GMV /
 *    播放量」——本地 Demo 没有这些数据源。宁可字段缺席，也不给模型一个
 *    可以顺口编造的抓手（任务书第七 / 二十五 / 二十六节）。
 *
 * ## 输入为什么用「最小形状」而不是仓储记录类型
 *
 * `SnapshotWorkflowInput` / `SnapshotTaskInput` 只声明本层真正读到的字段。
 * 好处有两个：调用方（Service）传完整记录进来天然兼容；测试可以只造一个
 * 五字段的对象，不必伪造 `AgentWorkflowRecord` 的其余部分。
 */

import { isSameLocalDay, toDate } from "@/lib/datetime";

import { aggregateLiveHotTopics } from "@/lib/live-topics";

import { averageOrNull, ratioOrNull } from "./metrics";

import type {
  AgentId,
  AgentMetrics,
  AgentStatus,
  AnalyticsHealth,
  AnalyticsHealthSignals,
  AnalyticsHealthVerdict,
  AnalyticsSnapshot,
  ContentItem,
  ContentAssetMetrics,
  ContentPlatform,
  CustomerServiceMetrics,
  KnowledgeGapCategoryCount,
  LiveComment,
  LiveMetrics,
  LiveSession,
  LiveSuggestion,
  Product,
  ProductMetrics,
  WorkflowMetrics,
  WorkflowStatus,
} from "@/types";

import { ANALYTICS_HEALTHS } from "@/types";

/* ------------------------------------------------------------------ */
/* 最小输入形状                                                        */
/* ------------------------------------------------------------------ */

/** 工作流统计只需要「状态」与「逐步报告里的复用 / 执行计数」 */
export interface SnapshotWorkflowInput {
  status: WorkflowStatus;
  summary: {
    executed: number;
    reused: number;
  } | null;
}

/** Agent 效率统计只需要「谁跑的、成没成、跑了多久」 */
export interface SnapshotTaskInput {
  agentType: AgentId;
  status: AgentStatus;
  durationMs: number | null;
}

/** 直播输入：场次 + 全部评论 + 全部建议（跨场次汇总） */
export interface SnapshotLiveInput {
  sessions: readonly LiveSession[];
  comments: readonly LiveComment[];
  suggestions: readonly LiveSuggestion[];
}

/**
 * 客服指标由 `getCustomerServiceOverview()` 提供。
 *
 * 刻意**不在这里重新定义「今日回答数」**：那个口径已经在客服服务层定死
 * （分母只算 AI 真正写出回答的消息，系统故障天然不在分母里）。
 * 在这里再算一遍，就等于给自己留了一个「两处口径慢慢漂移」的机会。
 */
export interface SnapshotCustomerServiceInput {
  answeredCount: number;
  groundedCount: number;
  needsHumanCount: number;
  openKnowledgeGapCount: number;
  /** 未解决缺口清单（只用于按意图聚合，不落进快照） */
  openGaps: readonly { intent: string }[];
}

export interface AnalyticsSnapshotInput {
  /** 由调用方注入，便于测试与「以某个时间点为准重算」 */
  now: Date;
  products: readonly Product[];
  contents: readonly ContentItem[];
  workflows: readonly SnapshotWorkflowInput[];
  agentTasks: readonly SnapshotTaskInput[];
  customerService: SnapshotCustomerServiceInput;
  live: SnapshotLiveInput;
}

/* ------------------------------------------------------------------ */
/* 各模块指标                                                          */
/* ------------------------------------------------------------------ */

/** 商品：只有「数量」与「DNA 完成率」是真实可算的，销量 / 复购本地没有数据源 */
export function computeProductMetrics(
  products: readonly Product[],
): ProductMetrics {
  const totalProducts = products.length;
  const analyzedProducts = products.filter(
    (product) => product.analysisStatus === "analyzed",
  ).length;

  return {
    totalProducts,
    analyzedProducts,
    analysisCompletionRate: ratioOrNull(analyzedProducts, totalProducts),
  };
}

/**
 * 内容：只统计**我们生成过什么**。
 *
 * 曝光 / 点赞 / 转化本地没有真实来源，因此这里不出现任何效果指标 ——
 * 「哪条内容表现最好」不属于本快照能回答的问题（任务书第二十五节）。
 */
export function computeContentMetrics(
  contents: readonly ContentItem[],
  now: Date,
): ContentAssetMetrics {
  const generatedToday = contents.filter((item) =>
    isSameLocalDay(item.createdAt, now),
  ).length;

  const counts = new Map<ContentPlatform, number>();
  for (const item of contents) {
    counts.set(item.platform, (counts.get(item.platform) ?? 0) + 1);
  }

  const platformDistribution = [...counts.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((left, right) => {
      // 数量降序；同数量时按平台名稳定排序，避免顺序随 Map 迭代抖动
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.platform.localeCompare(right.platform);
    });

  return { totalAssets: contents.length, generatedToday, platformDistribution };
}

/**
 * 工作流：完成率的分母是**全部运行记录**，不只是终态。
 * 一个还卡在 running 的工作流若被排除在分母外，完成率会虚高 ——
 * 「没跑完」和「跑失败了」都不该被算成成功。
 */
export function computeWorkflowMetrics(
  workflows: readonly SnapshotWorkflowInput[],
): WorkflowMetrics {
  const totalRuns = workflows.length;
  const completedRuns = workflows.filter((item) => item.status === "completed").length;
  const partiallyCompletedRuns = workflows.filter(
    (item) => item.status === "partially_completed",
  ).length;
  const failedRuns = workflows.filter((item) => item.status === "failed").length;

  /**
   * 复用 / 执行计数只在**有逐步报告**的工作流上可算：
   * `plan` 已丢弃或旧版本记录没有 `summary`，此时这两项就是「不可知」，
   * 不该被当成 0 混进合计（那会把可见的复用能力算没了）。
   */
  let reusedTaskCount = 0;
  let executedTaskCount = 0;
  for (const item of workflows) {
    if (!item.summary) {
      continue;
    }
    reusedTaskCount += Math.max(0, item.summary.reused);
    executedTaskCount += Math.max(0, item.summary.executed);
  }

  return {
    totalRuns,
    completedRuns,
    partiallyCompletedRuns,
    failedRuns,
    completionRate: ratioOrNull(completedRuns, totalRuns),
    reusedTaskCount,
    executedTaskCount,
  };
}

export function computeCustomerMetrics(
  input: SnapshotCustomerServiceInput,
): CustomerServiceMetrics {
  return {
    answeredCount: input.answeredCount,
    groundedCount: input.groundedCount,
    /** 今日还没有 AI 回答时是 null —— 界面显示「暂无足够数据」 */
    groundedRate: ratioOrNull(input.groundedCount, input.answeredCount),
    needsHumanCount: input.needsHumanCount,
    openKnowledgeGapCount: input.openKnowledgeGapCount,
    openGapByIntent: computeKnowledgeGapBreakdown(input.openGaps),
  };
}

/**
 * 未解决缺口按意图聚合（任务书第二十三节）。
 *
 * 输入只包含 **status=open** 的缺口 —— 已补齐的缺口是「做对了的证据」，
 * 混进来会让「缺口集中在哪」这个结论彻底失真。
 * 计数降序、同数量按意图名稳定排序，保证同一份数据永远得到同一份分布。
 */
export function computeKnowledgeGapBreakdown(
  openGaps: readonly { intent: string }[],
): KnowledgeGapCategoryCount[] {
  const counts = new Map<string, number>();
  for (const gap of openGaps) {
    const intent = gap.intent.trim() || "other";
    counts.set(intent, (counts.get(intent) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([intent, count]) => ({ intent, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.intent.localeCompare(right.intent);
    });
}

/**
 * 直播：高频问题分布复用 `@/lib/live-topics` 的聚合。
 *
 * **刻意不重写一份**：热点聚合的口径（只算已被 AI 分类的评论、占比由程序算）
 * 已经在直播间面板上被验证过，这里再算一遍只会多一处可能对不上的地方。
 * 注意汇总用的是**全部场次**，而不是最近一场 —— 经营复盘看的是累计。
 */
export function computeLiveMetrics(input: SnapshotLiveInput): LiveMetrics {
  const { sessions, comments, suggestions } = input;

  const handled = suggestions.filter(
    (suggestion) => suggestion.failureMessage === null,
  );

  return {
    sessions: sessions.length,
    commentCount: comments.length,
    aiHandledCount: handled.length,
    highPriorityCount: comments.filter((comment) => comment.priority === "high")
      .length,
    groundedCount: handled.filter((suggestion) => suggestion.grounded).length,
    topIntents: aggregateLiveHotTopics([...comments]).map((topic) => ({
      intent: topic.intent,
      count: topic.count,
      share: topic.share,
    })),
  };
}

/**
 * Agent 效率：只看**走到终态**的任务。
 *
 * `running` / `queued` 还在飞，把它们算进分母会让失败率随「此刻有没有任务在跑」
 * 上下跳动 —— 那不是经营信号，是采样噪声。
 * `skipped` 是「本次没执行」（复用或依赖失败），既没成功也没失败，同样不计。
 */
export function computeAgentMetrics(
  tasks: readonly SnapshotTaskInput[],
): AgentMetrics {
  const terminal = tasks.filter(
    (task) => task.status === "completed" || task.status === "failed",
  );
  const completedTasks = terminal.filter((task) => task.status === "completed").length;
  const failedTasks = terminal.filter((task) => task.status === "failed").length;

  const byAgentType = new Map<AgentId, SnapshotTaskInput[]>();
  for (const task of terminal) {
    const bucket = byAgentType.get(task.agentType);
    if (bucket) {
      bucket.push(task);
    } else {
      byAgentType.set(task.agentType, [task]);
    }
  }

  const byAgent = [...byAgentType.entries()]
    .map(([agentType, bucket]) => {
      const completed = bucket.filter((task) => task.status === "completed").length;
      const failed = bucket.filter((task) => task.status === "failed").length;
      return {
        agentType,
        completed,
        failed,
        failureRate: ratioOrNull(failed, bucket.length),
        avgDurationMs: averageOrNull(
          bucket
            .map((task) => task.durationMs)
            .filter((value): value is number => value !== null),
        ),
      };
    })
    // 失败多的排前面 —— 复盘时最该先看到的正是「谁在拖后腿」
    .sort((left, right) => {
      if (right.failed !== left.failed) {
        return right.failed - left.failed;
      }
      return left.agentType.localeCompare(right.agentType);
    });

  return {
    completedTasks,
    failedTasks,
    avgDurationMs: averageOrNull(
      terminal
        .map((task) => task.durationMs)
        .filter((value): value is number => value !== null),
    ),
    byAgent,
  };
}

/* ------------------------------------------------------------------ */
/* 健康度（程序定档，任务书第二十八节）                                */
/* ------------------------------------------------------------------ */

/**
 * 健康度阈值。
 *
 * 这是一份**项目内明确定义的 Demo 口径**，不是行业标准；改动必须同步更新单测。
 * 把阈值显式写出来（而不是散在 if 里），是为了让「为什么今天判成 attention」
 * 永远可以回答 —— 也让模型拿到的是同一套阈值，而不是自己拍一个。
 */
export const ANALYTICS_HEALTH_THRESHOLDS = {
  /** 任务失败率 ≥ 30% 视为风险 */
  failedTaskRateRisk: 0.3,
  failedTaskRateAttention: 0.1,
  /** 未解决知识缺口 ≥ 5 条视为风险 */
  openKnowledgeGapRisk: 5,
  openKnowledgeGapAttention: 2,
  /** Grounded 率 < 50% 视为风险 */
  groundedRateRisk: 0.5,
  groundedRateAttention: 0.7,
  workflowCompletionRateRisk: 0.5,
  workflowCompletionRateAttention: 0.8,
} as const;

export function deriveHealthSignals(input: {
  workflow: WorkflowMetrics;
  customerService: CustomerServiceMetrics;
  agents: AgentMetrics;
}): AnalyticsHealthSignals {
  const terminalTasks = input.agents.completedTasks + input.agents.failedTasks;
  return {
    openKnowledgeGapCount: input.customerService.openKnowledgeGapCount,
    failedTaskRate: ratioOrNull(input.agents.failedTasks, terminalTasks),
    workflowCompletionRate: input.workflow.completionRate,
    customerGroundedRate: input.customerService.groundedRate,
  };
}

/**
 * 由信号派生健康度。
 *
 * **不允许模型自由定档**：模型看不到阈值，也说不清「今天为什么是 risk」；
 * 让程序定档、把信号与理由一起交给模型解释，结论才可复现、可质疑。
 * `null` 信号一律不参与判定（数据不足 ≠ 有问题）。
 */
export function deriveHealth(
  signals: AnalyticsHealthSignals,
): AnalyticsHealthVerdict {
  const thresholds = ANALYTICS_HEALTH_THRESHOLDS;
  const riskReasons: string[] = [];
  const attentionReasons: string[] = [];

  if (signals.failedTaskRate !== null) {
    if (signals.failedTaskRate >= thresholds.failedTaskRateRisk) {
      riskReasons.push(
        `AI 任务失败率 ${formatPercent(signals.failedTaskRate)} 偏高（阈值 ${formatPercent(thresholds.failedTaskRateRisk)}）。`,
      );
    } else if (signals.failedTaskRate >= thresholds.failedTaskRateAttention) {
      attentionReasons.push(
        `AI 任务失败率 ${formatPercent(signals.failedTaskRate)} 已高于常态（阈值 ${formatPercent(thresholds.failedTaskRateAttention)}）。`,
      );
    }
  }

  if (signals.openKnowledgeGapCount >= thresholds.openKnowledgeGapRisk) {
    riskReasons.push(
      `未解决知识缺口 ${signals.openKnowledgeGapCount} 条（阈值 ${thresholds.openKnowledgeGapRisk}）。`,
    );
  } else if (signals.openKnowledgeGapCount >= thresholds.openKnowledgeGapAttention) {
    attentionReasons.push(
      `未解决知识缺口 ${signals.openKnowledgeGapCount} 条，建议尽快补齐。`,
    );
  }

  if (signals.customerGroundedRate !== null) {
    if (signals.customerGroundedRate < thresholds.groundedRateRisk) {
      riskReasons.push(
        `客服有依据回答占比 ${formatPercent(signals.customerGroundedRate)} 偏低（阈值 ${formatPercent(thresholds.groundedRateRisk)}）。`,
      );
    } else if (signals.customerGroundedRate < thresholds.groundedRateAttention) {
      attentionReasons.push(
        `客服有依据回答占比 ${formatPercent(signals.customerGroundedRate)} 未达标（阈值 ${formatPercent(thresholds.groundedRateAttention)}）。`,
      );
    }
  }

  if (signals.workflowCompletionRate !== null) {
    if (signals.workflowCompletionRate < thresholds.workflowCompletionRateRisk) {
      riskReasons.push(
        `经营工作流完成率 ${formatPercent(signals.workflowCompletionRate)} 偏低（阈值 ${formatPercent(thresholds.workflowCompletionRateRisk)}）。`,
      );
    } else if (
      signals.workflowCompletionRate < thresholds.workflowCompletionRateAttention
    ) {
      attentionReasons.push(
        `经营工作流完成率 ${formatPercent(signals.workflowCompletionRate)} 未达标（阈值 ${formatPercent(thresholds.workflowCompletionRateAttention)}）。`,
      );
    }
  }

  const status: AnalyticsHealth =
    riskReasons.length > 0 ? "risk" : attentionReasons.length > 0 ? "attention" : "good";

  const reasons =
    status === "risk"
      ? riskReasons
      : status === "attention"
        ? attentionReasons
        : ["各项信号均在阈值内。"];

  return { status, signals, reasons };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

/** 把各模块指标组装成一份完整的经营快照（纯函数，可重复调用得到同一结果） */
export function buildAnalyticsSnapshot(
  input: AnalyticsSnapshotInput,
): AnalyticsSnapshot {
  const generatedAt = toDate(input.now) ?? new Date(input.now);

  const product = computeProductMetrics(input.products);
  const content = computeContentMetrics(input.contents, generatedAt);
  const workflow = computeWorkflowMetrics(input.workflows);
  const customerService = computeCustomerMetrics(input.customerService);
  const live = computeLiveMetrics(input.live);
  const agents = computeAgentMetrics(input.agentTasks);

  return {
    generatedAt: generatedAt.toISOString(),
    product,
    content,
    workflow,
    customerService,
    live,
    agents,
    health: deriveHealth(deriveHealthSignals({ workflow, customerService, agents })),
  };
}

/* ------------------------------------------------------------------ */
/* 快照结构校验                                                        */
/* ------------------------------------------------------------------ */

/** 全部计数字段（必须是非负整数） */
function countFields(snapshot: AnalyticsSnapshot): [string, number][] {
  return [
    ["product.totalProducts", snapshot.product.totalProducts],
    ["product.analyzedProducts", snapshot.product.analyzedProducts],
    ["content.totalAssets", snapshot.content.totalAssets],
    ["content.generatedToday", snapshot.content.generatedToday],
    ["workflow.totalRuns", snapshot.workflow.totalRuns],
    ["workflow.completedRuns", snapshot.workflow.completedRuns],
    ["workflow.partiallyCompletedRuns", snapshot.workflow.partiallyCompletedRuns],
    ["workflow.failedRuns", snapshot.workflow.failedRuns],
    ["workflow.reusedTaskCount", snapshot.workflow.reusedTaskCount],
    ["workflow.executedTaskCount", snapshot.workflow.executedTaskCount],
    ["customerService.answeredCount", snapshot.customerService.answeredCount],
    ["customerService.groundedCount", snapshot.customerService.groundedCount],
    ["customerService.needsHumanCount", snapshot.customerService.needsHumanCount],
    [
      "customerService.openKnowledgeGapCount",
      snapshot.customerService.openKnowledgeGapCount,
    ],
    ["live.sessions", snapshot.live.sessions],
    ["live.commentCount", snapshot.live.commentCount],
    ["live.aiHandledCount", snapshot.live.aiHandledCount],
    ["live.highPriorityCount", snapshot.live.highPriorityCount],
    ["live.groundedCount", snapshot.live.groundedCount],
    ["agents.completedTasks", snapshot.agents.completedTasks],
    ["agents.failedTasks", snapshot.agents.failedTasks],
  ];
}

/** 全部比率字段（必须是 `null` 或 0 ~ 1） */
function ratioFields(snapshot: AnalyticsSnapshot): [string, number | null][] {
  return [
    ["product.analysisCompletionRate", snapshot.product.analysisCompletionRate],
    ["workflow.completionRate", snapshot.workflow.completionRate],
    ["customerService.groundedRate", snapshot.customerService.groundedRate],
  ];
}

/**
 * 找出快照里的结构问题（空数组表示没问题）。
 *
 * 快照是**程序产物**，但有两个真实的坏输入来源：从 JSON 读回的历史快照
 * （结构可能是旧版本）与测试 / 手工构造的对象。若不校验就把它交给模型，
 * 一份坏快照会变成一份**看起来很专业的错报告** —— 比直接报错危险得多。
 */
export function findSnapshotProblems(snapshot: AnalyticsSnapshot): string[] {
  const problems: string[] = [];

  if (toDate(snapshot.generatedAt) === null) {
    problems.push(`generatedAt 不是合法时间：${String(snapshot.generatedAt)}`);
  }

  if (!(ANALYTICS_HEALTHS as readonly string[]).includes(snapshot.health.status)) {
    problems.push(`健康度取值非法：${String(snapshot.health.status)}`);
  }

  for (const [key, value] of countFields(snapshot)) {
    if (!Number.isInteger(value) || value < 0) {
      problems.push(`${key} 必须是非负整数，实际为 ${String(value)}`);
    }
  }

  for (const [key, value] of ratioFields(snapshot)) {
    if (value === null) {
      continue;
    }
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      problems.push(
        `${key} 必须是 null 或 0~1 之间的数，实际为 ${String(value)}`,
      );
    }
  }

  return problems;
}

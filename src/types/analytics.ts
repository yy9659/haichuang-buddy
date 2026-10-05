import type { AgentId } from "./agent";
import type { StatusTone, TrendDirection } from "./common";
import type { ContentPlatform } from "./content";
import type { LiveIntent } from "./live";
import type { SalesReview, SalesReviewSnapshot } from "./sales";

/**
 * 经营分析类型定义
 * 对应技术文档 6.7 经营分析师 Agent、第 10 章数据指标、9.8 经营分析
 */

export interface OverviewMetric {
  id: string;
  label: string;
  /** 展示值 */
  value: string;
  /** 原始数值，便于后续接入真实计算 */
  rawValue: number;
  unit?: string;
  /** 环比变化，如 0.12 表示 +12% */
  delta: number;
  trend: TrendDirection;
  tone: StatusTone;
  description: string;
}

/** 流量与转化趋势 */
export interface TrendPoint {
  date: string;
  views: number;
  inquiries: number;
  conversions: number;
}

/** 问题类型占比 */
export interface QuestionCategoryStat {
  intent: LiveIntent;
  label: string;
  count: number;
  /** 占比 0 ~ 1，由程序计算 */
  ratio: number;
  tone: StatusTone;
}

/** 内容表现 */
export interface ContentPerformance {
  id: string;
  title: string;
  platform: ContentPlatform;
  views: number;
  engagementRate: number;
  conversions: number;
}

/** 商品表现 */
export interface ProductPerformance {
  id: string;
  name: string;
  views: number;
  inquiries: number;
  conversions: number;
  revenue: number;
}

/** AI 任务完成情况 */
export interface AgentTaskStat {
  id: string;
  agentName: string;
  total: number;
  completed: number;
  failed: number;
  /** 平均耗时展示文案 */
  averageDurationText: string;
}

export interface AnalyticsOverview {
  metrics: OverviewMetric[];
  trend: TrendPoint[];
  questionCategories: QuestionCategoryStat[];
  topQuestions: { id: string; question: string; count: number }[];
  contentPerformance: ContentPerformance[];
  productPerformance: ProductPerformance[];
  agentTaskStats: AgentTaskStat[];
  /** 用户兴趣变化 */
  interestShifts: {
    id: string;
    label: string;
    before: number;
    after: number;
    direction: TrendDirection;
  }[];
}

/** 经营目标 */
export interface BusinessGoal {
  id: string;
  title: string;
  period: string;
  target: number;
  achieved: number;
  /** 0 ~ 1 */
  progress: number;
  items: {
    id: string;
    label: string;
    description: string;
  }[];
}

/* ------------------------------------------------------------------ */
/* S6-B：Analytics Snapshot（程序计算 · 不含任何 LLM 输出）             */
/* ------------------------------------------------------------------ */

/**
 * 系统整体健康度。
 *
 * **由程序派生**（见 `@/analytics/snapshot` 的 `deriveHealth`），AI 只负责解释。
 * 让模型自由判断「今天好不好」是危险的：它看不到全局阈值，只会顺着提示词的
 * 语气给出情绪化结论。程序先按信号定档，模型再解释成因。
 *
 * 与 `LIVE_INTENTS` 同一写法：运行时清单在前，类型由它派生 ——
 * Schema 的 `z.enum()` 与 `isXxx()` 判定都需要运行时值，类型系统在那一层帮不上忙。
 */
export const ANALYTICS_HEALTHS = ["good", "attention", "risk"] as const;
export type AnalyticsHealth = (typeof ANALYTICS_HEALTHS)[number];

export function isAnalyticsHealth(value: unknown): value is AnalyticsHealth {
  return (
    typeof value === "string" &&
    (ANALYTICS_HEALTHS as readonly string[]).includes(value)
  );
}

export const ANALYTICS_ISSUE_SEVERITIES = ["high", "medium", "low"] as const;
export type AnalyticsIssueSeverity = (typeof ANALYTICS_ISSUE_SEVERITIES)[number];

/** 行动建议该由哪个 Agent / 能力域承接（决定「用此建议启动经营」时怎么组目标） */
export const ANALYTICS_ACTION_TYPES = [
  "product",
  "brand",
  "content",
  "live",
  "customer_service",
  "knowledge",
  "workflow",
] as const;
export type AnalyticsActionType = (typeof ANALYTICS_ACTION_TYPES)[number];

export interface ProductMetrics {
  totalProducts: number;
  /** Product DNA 已生成的数量 */
  analyzedProducts: number;
  /** 除零返回 null（0 件商品时「完成率 0%」是假象，不是事实） */
  analysisCompletionRate: number | null;
}

export interface ContentPlatformCount {
  platform: ContentPlatform;
  count: number;
}

export interface ContentAssetMetrics {
  totalAssets: number;
  /** 今日（本地自然日）生成的内容资产数 */
  generatedToday: number;
  platformDistribution: ContentPlatformCount[];
}

export interface WorkflowMetrics {
  totalRuns: number;
  completedRuns: number;
  partiallyCompletedRuns: number;
  failedRuns: number;
  /** 除零返回 null */
  completionRate: number | null;
  /** 计划中被判定「已有有效结果、直接复用」的任务数（来自逐步报告） */
  reusedTaskCount: number;
  /** 计划中真正调用了 Agent 的任务数 */
  executedTaskCount: number;
}

export interface KnowledgeGapCategoryCount {
  /**
   * 归一化后的缺口意图（客服链路写入 `knowledge_gaps.intent` 的口径）。
   * 刻意不收敛成 `CustomerIntent`：历史数据里可能留着更早版本的取值，
   * 用 string 承载并原样展示，比「因为类型对不上就把这条缺口丢掉」诚实。
   */
  intent: string;
  count: number;
}

export interface CustomerServiceMetrics {
  /** 今日 AI 真正给出回答的消息数（Grounded 率的分母） */
  answeredCount: number;
  groundedCount: number;
  /** 除零返回 null */
  groundedRate: number | null;
  /** 状态为「待人工」的会话数 */
  needsHumanCount: number;
  openKnowledgeGapCount: number;
  /**
   * 未解决缺口按意图的分布（任务书第二十三节）。
   *
   * **由程序聚合**：模型要能说出「缺口集中在物流」，前提是这份分布摆在它面前；
   * 但「按什么分组、怎么计数」绝不能交给模型 —— 那正是最容易算出漂亮错数的地方。
   */
  openGapByIntent: KnowledgeGapCategoryCount[];
}

export interface LiveIntentCount {
  intent: LiveIntent;
  count: number;
  /** 0 ~ 1，分母是**已被 AI 分类**的评论数（未分类的不进分母） */
  share: number;
}

export interface LiveMetrics {
  sessions: number;
  commentCount: number;
  aiHandledCount: number;
  highPriorityCount: number;
  /** 建议中 grounded=true 的条数 */
  groundedCount: number;
  topIntents: LiveIntentCount[];
}

export interface AgentEfficiencyStat {
  agentType: AgentId;
  completed: number;
  failed: number;
  /** 失败率 0 ~ 1；该 Agent 没有终态任务时为 null */
  failureRate: number | null;
  avgDurationMs: number | null;
}

export interface AgentMetrics {
  completedTasks: number;
  failedTasks: number;
  avgDurationMs: number | null;
  byAgent: AgentEfficiencyStat[];
}

/**
 * 健康度信号（全部由程序算）。
 *
 * 这些值既是「程序定档」的依据，也原样交给模型做解释 ——
 * 保证模型看到的阈值口径和程序定档用的是同一份数据。
 */
export interface AnalyticsHealthSignals {
  openKnowledgeGapCount: number;
  /** 除零返回 null */
  failedTaskRate: number | null;
  /** 除零返回 null */
  workflowCompletionRate: number | null;
  /** 除零返回 null */
  customerGroundedRate: number | null;
}

export interface AnalyticsHealthVerdict {
  status: AnalyticsHealth;
  signals: AnalyticsHealthSignals;
  /** 程序给出的定档理由（人话，便于界面直接展示与排查） */
  reasons: string[];
}

/**
 * 经营快照 —— **完全由程序计算**，是 Analytics Agent 的唯一事实来源。
 *
 * 硬约束：本结构里**不允许出现任何模型生成的内容**。它是一个可审计的
 * 「当前系统发生了什么」的切片；模型只能在它的基础上解释，不能往里塞数。
 * 商户导入的销售汇总位于独立 sales 字段，与站内准备情况分开核对。
 * 不包含没有来源的订单量、平台曝光或转化率。
 */
export interface AnalyticsSnapshot {
  /** ISO 时间戳 */
  generatedAt: string;
  product: ProductMetrics;
  content: ContentAssetMetrics;
  workflow: WorkflowMetrics;
  customerService: CustomerServiceMetrics;
  live: LiveMetrics;
  agents: AgentMetrics;
  health: AnalyticsHealthVerdict;
  /** 可选，兼容早期仅包含工作记录的复盘。 */
  sales?: SalesReviewSnapshot;
}

/* ------------------------------------------------------------------ */
/* S6-B：AI 经营日报（Analytics Agent 产出）                           */
/* ------------------------------------------------------------------ */

export interface AnalyticsReportHighlight {
  title: string;
  evidence: string;
  /** 只能引用 `AnalyticsSnapshot` 里真实存在的指标键 */
  metricKeys: string[];
}

export interface AnalyticsReportIssue {
  title: string;
  severity: AnalyticsIssueSeverity;
  evidence: string;
  metricKeys: string[];
  /**
   * 可能原因。
   *
   * **不是结论。** 界面必须按「AI 分析 / 可能原因」呈现 ——
   * 数据显示「Grounded 率下降」不能推出「就是因为缺物流知识」，
   * 因果需要额外证据，而快照只有相关性。
   */
  possibleCauses: string[];
}

export interface AnalyticsReportAction {
  /** 1 最高 */
  priority: number;
  title: string;
  reason: string;
  actionType: AnalyticsActionType;
  recommendedAction: string;
}

export interface AnalyticsReport {
  executiveSummary: string;
  health: AnalyticsHealth;
  highlights: AnalyticsReportHighlight[];
  issues: AnalyticsReportIssue[];
  actions: AnalyticsReportAction[];
  tomorrowFocus: string[];
  /** 模型对本次分析的整体把握 0 ~ 1 */
  confidence: number;
  salesReview?: SalesReview;
}

/**
 * 一份落库的经营日报：**快照与结论一起存**。
 *
 * 为什么不分开存：日报的全部意义是「当时看到的数据 + 基于它的判断」。
 * 只存结论的话，两天后回看会分不清「当时确实没有物流知识」和
 * 「当时有、模型没看见」；只存快照则丢了判断本身。
 */
export interface BusinessReport {
  id: string;
  businessId: string;
  snapshot: AnalyticsSnapshot;
  report: AnalyticsReport;
  createdAt: string;
}

/**
 * 经营指标纯函数
 *
 * 核心原则（技术文档 5.3 / 10 章 / 开发纪律 04）：
 *   「程序负责计算，AI 只负责解释」
 * 本文件不得 import 任何模型 SDK，也不得包含任何 AI 调用。
 * 所有函数均为纯函数，便于单元测试与复用。
 */

import type {
  ContentItem,
  CustomerConversation,
  Product,
} from "@/types";

/** 把数值限制在 [min, max] 之间；NaN 退化为下界，±Infinity 正常收敛到边界 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/** 安全除法：分母非正数或非有限值时返回 0，避免出现 NaN / Infinity */
export function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return 0;
  }
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

/** 保留 n 位小数；NaN / ±Infinity 一律返回 0，防止异常值污染展示 */
export function roundTo(value: number, digits = 4): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 比率；**分母非正或非法时返回 `null`**。
 *
 * 与 `safeDivide` 的差别正是它存在的理由：
 * `safeDivide` 返回 0，适合「0 次互动 / 0 次播放 = 0 互动率」这类
 * 分子分母同源的展示值；但对经营指标来说，**「没有数据」和「0%」是两件事**。
 * 用 0 冒充「今日 Grounded 率」会让商家以为客服全线失效，
 * 而真相是今天根本还没有 AI 回答。因此经营指标一律走这个函数，
 * 由界面显示「暂无足够数据」。
 */
export function ratioOrNull(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  if (denominator <= 0) {
    return null;
  }
  return roundTo(numerator / denominator);
}

/** 平均值；样本为空或全为非法值时返回 `null`（同样不返回 0 制造假象） */
export function averageOrNull(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  const sum = finite.reduce((total, value) => total + value, 0);
  return Math.round(sum / finite.length);
}

/* ------------------------------------------------------------------ */
/* 文档第 10 章定义的三个核心公式                                       */
/* ------------------------------------------------------------------ */

export interface EngagementInput {
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

/**
 * 内容互动率
 * engagementRate = (likes + comments + shares) / views
 */
export function computeEngagementRate(input: EngagementInput): number {
  const { views, likes, comments, shares } = input;
  return roundTo(safeDivide(likes + comments + shares, views));
}

/**
 * 问题类型占比
 * questionRate = categoryCount / totalQuestions
 */
export function computeQuestionRatio(
  categoryCount: number,
  totalQuestions: number,
): number {
  return roundTo(clamp(safeDivide(categoryCount, totalQuestions), 0, 1));
}

export interface LiveEngagementInput {
  /** 累计观看人数（非在线人数） */
  viewers: number;
  comments: number;
  likes: number;
  questions: number;
}

/**
 * 直播互动率
 * liveEngagementRate = (comments + likes + questions) / viewers
 */
export function computeLiveEngagementRate(
  input: LiveEngagementInput,
): number {
  const { viewers, comments, likes, questions } = input;
  return roundTo(safeDivide(comments + likes + questions, viewers));
}

/* ------------------------------------------------------------------ */
/* 任务与评分                                                          */
/* ------------------------------------------------------------------ */

export interface TaskCompletionInput {
  total: number;
  completed: number;
}

/**
 * AI 任务完成率
 * taskCompletionRate = completed / total
 */
export function computeTaskCompletionRate(
  input: TaskCompletionInput,
): number {
  const { total, completed } = input;
  return roundTo(clamp(safeDivide(Math.max(completed, 0), total), 0, 1));
}

/**
 * 经营评分权重。文档未给出具体公式，此处为项目内明确定义的 Demo 口径，
 * 口径变更需同步更新单测。
 */
export const BUSINESS_SCORE_WEIGHTS = {
  /** 内容互动率 */
  content: 0.35,
  /** 咨询转化率（成交量 / 咨询量） */
  conversion: 0.4,
  /** 客服自动解决率 */
  service: 0.25,
} as const;

/**
 * 各指标的达标基线（Demo 目标值）。子项得分 = min(实际值 / 基线, 1)，
 * 使用相对基线而非绝对值，避免某一项量纲过大压过其他项。
 */
export const BUSINESS_SCORE_BASELINES = {
  contentEngagementRate: 0.12,
  conversionRate: 0.18,
  autoResolveRate: 0.9,
} as const;

export interface BusinessScoreInput {
  /** 内容互动率 0 ~ 1 */
  contentEngagementRate: number;
  /** 咨询转化率 0 ~ 1 */
  conversionRate: number;
  /** 客服自动解决率 0 ~ 1 */
  autoResolveRate: number;
}

/**
 * 经营评分（0 ~ 100 整数）
 * 由转化、内容、客服三类指标相对基线加权得出（技术文档 9.8 / 10 章）
 */
export function computeBusinessScore(input: BusinessScoreInput): number {
  const contentScore = clamp(
    safeDivide(input.contentEngagementRate, BUSINESS_SCORE_BASELINES.contentEngagementRate),
    0,
    1,
  );
  const conversionScore = clamp(
    safeDivide(input.conversionRate, BUSINESS_SCORE_BASELINES.conversionRate),
    0,
    1,
  );
  const serviceScore = clamp(
    safeDivide(input.autoResolveRate, BUSINESS_SCORE_BASELINES.autoResolveRate),
    0,
    1,
  );

  const weighted =
    contentScore * BUSINESS_SCORE_WEIGHTS.content +
    conversionScore * BUSINESS_SCORE_WEIGHTS.conversion +
    serviceScore * BUSINESS_SCORE_WEIGHTS.service;

  return Math.round(clamp(weighted * 100, 0, 100));
}

/* ------------------------------------------------------------------ */
/* 列表聚合：把页面上散落的 filter / reduce 收敛为可测试的纯函数          */
/* ------------------------------------------------------------------ */

export interface ContentSummary {
  total: number;
  published: number;
  failed: number;
  totalViews: number;
  /** 仅统计有播放量的内容，避免未发布内容的 0 拉低均值 */
  averageEngagementRate: number;
}

export function summarizeContents(contents: ContentItem[]): ContentSummary {
  const published = contents.filter((item) => item.status === "published").length;
  const failed = contents.filter((item) => item.status === "failed").length;
  const totalViews = contents.reduce((sum, item) => sum + item.metrics.views, 0);

  const measurable = contents.filter((item) => item.metrics.views > 0);
  const engagementSum = measurable.reduce(
    (sum, item) => sum + item.metrics.engagementRate,
    0,
  );

  return {
    total: contents.length,
    published,
    failed,
    totalViews,
    averageEngagementRate: roundTo(safeDivide(engagementSum, measurable.length)),
  };
}

export interface ProductSummary {
  total: number;
  analyzed: number;
  /** 待分析 + 分析中 */
  inProgress: number;
  lowStock: number;
  soldOut: number;
}

export function summarizeProducts(
  products: Product[],
  lowStockThreshold = 50,
): ProductSummary {
  return {
    total: products.length,
    analyzed: products.filter((item) => item.analysisStatus === "analyzed").length,
    inProgress: products.filter(
      (item) =>
        item.analysisStatus === "analyzing" ||
        item.analysisStatus === "pending",
    ).length,
    lowStock: products.filter((item) => item.stock < lowStockThreshold).length,
    soldOut: products.filter((item) => item.stock <= 0).length,
  };
}

export interface ConversationSummary {
  total: number;
  humanNeeded: number;
  botHandled: number;
  closed: number;
}

export function summarizeConversations(
  conversations: CustomerConversation[],
): ConversationSummary {
  return {
    total: conversations.length,
    humanNeeded: conversations.filter((item) => item.status === "human").length,
    botHandled: conversations.filter((item) => item.status === "bot").length,
    closed: conversations.filter((item) => item.status === "closed").length,
  };
}

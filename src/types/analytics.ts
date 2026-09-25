import type { StatusTone, TrendDirection } from "./common";
import type { ContentPlatform } from "./content";
import type { LiveIntent } from "./live";

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

/** AI 经营日报，由经营分析师 Agent 产出 */
export interface DailyReport {
  date: string;
  /** 经营评分 0 ~ 100，程序计算 */
  score: number;
  scoreLabel: string;
  summary: string;
  highlights: string[];
  insights: string[];
  problems: string[];
  opportunities: string[];
  tomorrowActions: string[];
  recommendedContent: string[];
  recommendedLiveFocus: string[];
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

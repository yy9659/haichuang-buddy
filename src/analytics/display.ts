/**
 * 经营指标的**展示口径**（S6-B）
 *
 * 与 `metric-keys.ts` 的分工：
 * - `metric-keys.ts` 回答「系统里有哪些指标、它的值是多少」——那是**事实层**，
 *   同时被 Schema 的数值守卫与 Prompt 的指标清单复用；
 * - 本文件回答「这个指标在界面上叫什么、用什么颜色」——纯展示映射，
 *   **不参与任何计算，也不产生任何新数字**。
 *
 * 为什么单独放一层而不是散在组件里：健康度文案 / 严重度配色 / 指标中文名
 * 在 `/analytics` 与驾驶舱日报卡片上都出现。写成两份映射的那天，
 * 两个页面对同一个 `attention` 就可能给出两种说法。
 */

import { ANALYTICS_METRIC_DESCRIPTORS, formatMetricValue, readMetricValue } from "./metric-keys";

import type {
  AnalyticsActionType,
  AnalyticsHealth,
  AnalyticsIssueSeverity,
  AnalyticsSnapshot,
} from "@/types";

/** 健康度 → 界面文案与配色（`good` 是「健康」，不是「优秀」，避免过度承诺） */
export const ANALYTICS_HEALTH_META: Record<
  AnalyticsHealth,
  { label: string; tone: "success" | "warning" | "danger"; description: string }
> = {
  good: {
    label: "工作准备顺畅",
    tone: "success",
    description: "各项程序信号均在阈值内。",
  },
  attention: {
    label: "工作需要关注",
    tone: "warning",
    description: "有信号偏离常态，建议今天处理。",
  },
  risk: {
    label: "工作待补齐",
    tone: "danger",
    description: "有关键信号越过风险阈值，建议优先处理。",
  },
};

/** 问题严重度 → 徽标文案与配色 */
export const ANALYTICS_ISSUE_SEVERITY_META: Record<
  AnalyticsIssueSeverity,
  { label: string; tone: "danger" | "warning" | "neutral" }
> = {
  high: { label: "高", tone: "danger" },
  medium: { label: "中", tone: "warning" },
  low: { label: "低", tone: "neutral" },
};

/** 行动建议归属的能力域 → 中文名（用于徽标，不用于跳转逻辑） */
export const ANALYTICS_ACTION_TYPE_LABEL: Record<AnalyticsActionType, string> = {
  product: "商品",
  brand: "品牌",
  content: "内容",
  live: "直播",
  customer_service: "客服",
  knowledge: "知识库",
  workflow: "经营编排",
};

const LABEL_BY_KEY = new Map(
  ANALYTICS_METRIC_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor.label]),
);

/** 指标键 → 中文名；白名单之外的键原样返回（便于排查，而不是显示「未知指标」） */
export function metricLabel(key: string): string {
  return LABEL_BY_KEY.get(key) ?? key;
}

export interface SnapshotMetricView {
  key: string;
  label: string;
  /** 已格式化的展示值；不可算时为「暂无数据」 */
  value: string;
  /** 该指标本轮是否有值（`null` 表示数据不足，不是 0） */
  available: boolean;
}

/** 读一个指标并渲染成界面可直接展示的形状（`null` 明确显示「暂无数据」） */
export function describeMetric(
  snapshot: AnalyticsSnapshot,
  key: string,
): SnapshotMetricView {
  const descriptor = ANALYTICS_METRIC_DESCRIPTORS.find((item) => item.key === key);
  const raw = readMetricValue(snapshot, key);

  if (!descriptor) {
    return { key, label: metricLabel(key), value: "暂无数据", available: false };
  }

  return {
    key,
    label: descriptor.label,
    value: raw === null ? "暂无数据" : formatMetricValue(descriptor, raw),
    available: raw !== null,
  };
}

/**
 * 首屏「今日系统经营指标」挑出来的 6 个关键指标。
 *
 * 挑选标准是**可行动性**：能直接指向今天该做什么。因此优先选
 * 「完成率 / 缺口数 / 失败数」这类阈值型指标，而不是「总数」这类稳定量。
 */
export const ANALYTICS_HIGHLIGHT_METRIC_KEYS: readonly string[] = [
  "product.totalProducts",
  "product.analysisCompletionRate",
  "content.generatedToday",
  "customerService.groundedRate",
  "customerService.openKnowledgeGapCount",
  "agents.failedTasks",
];

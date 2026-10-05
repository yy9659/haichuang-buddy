import {
  ChartColumn,
  CircleAlert,
  FileText,
  Headphones,
  Package,
  Radio,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { Badge } from "@/components/ui/badge";
import {
  ANALYTICS_HEALTH_META,
  ANALYTICS_HIGHLIGHT_METRIC_KEYS,
  describeMetric,
  metricLabel,
} from "@/analytics/display";
import {
  ANALYTICS_METRIC_DESCRIPTORS,
  readMetricValue,
} from "@/analytics/metric-keys";
import { ANALYTICS_HEALTH_THRESHOLDS } from "@/analytics/snapshot";
import { cn } from "@/lib/utils";
import type { AnalyticsSnapshot, StatusTone } from "@/types";

/**
 * 区块 A：今日系统经营指标（**全部由程序计算**）
 *
 * 这一块是整页的「事实底座」：下面所有 AI 文字都只能引用这里的数字。
 * 因此这里刻意**不出现任何模型措辞** —— 连颜色都由阈值程序判定，
 * 而不是模型说「今天不错」就涂成绿色。
 */

const METRIC_ICON: Record<string, typeof Package> = {
  "product.totalProducts": Package,
  "product.analyzedProducts": Package,
  "product.analysisCompletionRate": Package,
  "content.totalAssets": FileText,
  "content.generatedToday": FileText,
  "customerService.answeredCount": Headphones,
  "customerService.groundedCount": Headphones,
  "customerService.groundedRate": Headphones,
  "customerService.needsHumanCount": Headphones,
  "customerService.openKnowledgeGapCount": Headphones,
  "live.sessions": Radio,
  "live.commentCount": Radio,
  "live.aiHandledCount": Radio,
  "live.highPriorityCount": Radio,
  "live.groundedCount": Radio,
  "agents.completedTasks": TrendingUp,
  "agents.failedTasks": TrendingUp,
  "agents.avgDurationMs": TrendingUp,
};

/** 「越高越好」的比率：低于阈值降档 */
function rateTone(
  value: number | null,
  risk: number,
  attention: number,
): StatusTone {
  if (value === null) return "neutral";
  if (value < risk) return "danger";
  if (value < attention) return "warning";
  return "success";
}

/** 「越多越差」的计数：越过阈值降档 */
function countTone(value: number, risk: number, attention: number): StatusTone {
  if (value >= risk) return "danger";
  if (value >= attention) return "warning";
  return "neutral";
}

/**
 * 单张指标卡的色调。
 *
 * 只有**在阈值表里有对应阈值**的指标才上色，其余保持中性。
 * 给一个没有阈值的数字随手涂色，等于替模型说了一句「这个数字是好是坏」——
 * 那句判断必须有出处，出处就是 `ANALYTICS_HEALTH_THRESHOLDS`。
 */
function toneForMetric(key: string, value: number | null): StatusTone {
  if (value === null) {
    return "neutral";
  }
  const t = ANALYTICS_HEALTH_THRESHOLDS;
  switch (key) {
    case "product.analysisCompletionRate":
    case "workflow.completionRate":
      return rateTone(
        value,
        t.workflowCompletionRateRisk,
        t.workflowCompletionRateAttention,
      );
    case "customerService.groundedRate":
      return rateTone(value, t.groundedRateRisk, t.groundedRateAttention);
    case "customerService.openKnowledgeGapCount":
      return countTone(value, t.openKnowledgeGapRisk, t.openKnowledgeGapAttention);
    case "agents.failedTasks":
      return value > 0 ? "warning" : "neutral";
    default:
      return "neutral";
  }
}

export function SystemMetricsPanel({
  snapshot,
  unavailableMetricPrefixes = [],
}: {
  snapshot: AnalyticsSnapshot;
  /**
   * 这些前缀下的指标在当前数据源下**读不到**（该领域尚未迁移）。
   *
   * 为什么需要它：降级后的快照里那些字段是 0，但 0 是**一个数字** ——
   * 界面上「直播场次 0」和「直播场次读不到」看起来一模一样，含义却完全相反。
   * 前者是「今天没开播」，后者是「这个模块根本没接上」。因此这里不显示数字，
   * 改显示「未启用」，并在下方说明一行。
   */
  unavailableMetricPrefixes?: readonly string[];
}) {
  const health = ANALYTICS_HEALTH_META[snapshot.health.status];
  const isUnavailable = (key: string): boolean =>
    unavailableMetricPrefixes.some((prefix) => key.startsWith(prefix));

  const explainReason = (reason: string): string =>
    reason
      .replace("各项信号均在阈值内。", "目前没有发现需要优先处理的工作问题。")
      .replace("AI 任务失败率", "AI 工作没能完成的比例")
      .replace("未解决知识缺口", "待补的答疑资料")
      .replace("客服有依据回答占比", "有资料依据的客服回答比例")
      .replace("经营工作流完成率", "工作计划完成比例")
      .replace(/（阈值[^）]+）/g, "");

  return (
    <SectionCard
      title="更多工作记录"
      description="这些数字来自海创Buddy里的操作，不是销售额。"
      icon={<ChartColumn className="size-4 text-primary" />}
      action={
        <Badge variant={health.tone}>
          <ShieldCheck />
          当前情况：{health.label}
        </Badge>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
          {ANALYTICS_HIGHLIGHT_METRIC_KEYS.map((key) => {
            const metric = describeMetric(snapshot, key);
            const Icon = METRIC_ICON[key] ?? ChartColumn;
            const unavailable = isUnavailable(key);
            return (
              <StatCard
                key={key}
                label={metric.label}
                value={unavailable ? "未启用" : metric.value}
                tone={
                  unavailable
                    ? "neutral"
                    : toneForMetric(key, readMetricValue(snapshot, key))
                }
                icon={<Icon />}
                footer={
                  <span className="truncate text-[11px] text-muted-foreground">
                    {unavailable
                      ? "暂时无法读取"
                      : metric.available
                        ? "站内记录"
                        : "目前没有足够数据"}
                  </span>
                }
              />
            );
          })}
        </div>

        {/*
          程序定档的理由原样展示。
          这是「为什么今天判成 attention」的唯一权威回答 ——
          模型给的解释只能是它的补充，不能覆盖这一段。
        */}
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
            <CircleAlert className="size-3.5 text-muted-foreground" />
            为什么会有这个提醒
          </span>
          <ul className="mt-2 flex flex-col gap-1">
            {snapshot.health.reasons.map((reason) => (
              <li
                key={reason}
                className="flex gap-1.5 text-[11px] leading-5 text-muted-foreground"
              >
                <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
                {explainReason(reason)}
              </li>
            ))}
          </ul>
        </div>

        <details className="rounded-lg border border-border bg-card px-3 py-2">
          <summary className="cursor-pointer text-[12px] font-semibold select-none">
            查看全部统计（共 {ANALYTICS_METRIC_DESCRIPTORS.length} 项）
            <span className="ml-1 font-normal text-muted-foreground">
              · 没有足够记录时会显示“暂无数据”
            </span>
          </summary>
          {unavailableMetricPrefixes.length > 0 ? (
            <p className="mt-2 rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-1.5 text-[11px] leading-5 text-muted-foreground">
              标着<span className="mx-1 font-medium text-foreground">未启用</span>
              的项目目前无法读取记录，因此不能当作 0 来理解。
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
            {ANALYTICS_METRIC_DESCRIPTORS.map((descriptor) => {
              const metric = describeMetric(snapshot, descriptor.key);
              const unavailable = isUnavailable(descriptor.key);
              return (
                <div
                  key={descriptor.key}
                  className="flex items-center justify-between gap-2 border-b border-dashed border-border/60 pb-1.5"
                >
                  <span className="truncate text-[11px] text-muted-foreground">
                    {metricLabel(descriptor.key)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[12px] font-medium tabular-nums",
                      unavailable
                        ? "rounded bg-muted px-1 text-[10px] text-muted-foreground"
                        : metric.available
                          ? "text-foreground"
                          : "text-muted-foreground",
                    )}
                  >
                    {unavailable ? "未启用" : metric.value}
                  </span>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    </SectionCard>
  );
}

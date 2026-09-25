import { ChartLine, FileText, Headphones, ListChecks } from "lucide-react";

import { DeltaBadge } from "@/components/common/delta-badge";
import { StatCard } from "@/components/common/stat-card";
import type { IconComponent, OverviewMetric } from "@/types";

const METRIC_ICON: Record<string, IconComponent> = {
  metric_tasks: ListChecks,
  metric_contents: FileText,
  metric_inquiries: Headphones,
  metric_score: ChartLine,
};

/** 驾驶舱核心状态：今日 AI 任务 / 内容生成量 / 客户咨询量 / 经营评分 */
export function OverviewMetrics({ metrics }: { metrics: OverviewMetric[] }) {
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => {
        const Icon = METRIC_ICON[metric.id] ?? ListChecks;
        return (
          <StatCard
            key={metric.id}
            label={metric.label}
            value={metric.value}
            unit={metric.unit}
            tone={metric.tone}
            icon={<Icon />}
            footer={
              <>
                <DeltaBadge delta={metric.delta} trend={metric.trend} hint="较昨日" />
                <span className="truncate text-[11px] text-muted-foreground">
                  {metric.description}
                </span>
              </>
            }
          />
        );
      })}
    </section>
  );
}

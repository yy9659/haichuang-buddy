import { LineChart } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { DeltaBadge } from "@/components/common/delta-badge";
import { TrafficTrendChart } from "@/components/analytics/traffic-trend-chart";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils";
import type { TrendPoint } from "@/types";

const SUMMARY = [
  { id: "revenue", label: "销售额", value: 12680, delta: 0.12, trend: "up" as const },
  { id: "inquiries", label: "咨询量", value: 2340, delta: 0.18, trend: "up" as const },
  { id: "conversions", label: "成交量", value: 368, delta: 0.25, trend: "up" as const },
];

/** 经营数据卡片：核心指标 + 流量与转化趋势 */
export function BusinessMetricsCard({ trend }: { trend: TrendPoint[] }) {
  return (
    <SectionCard
      title="经营数据"
      icon={<LineChart className="size-4 text-primary" />}
      moreHref="/analytics"
      action={<Badge variant="secondary">近 7 天</Badge>}
    >
      <div className="grid grid-cols-3 gap-2">
        {SUMMARY.map((item) => (
          <div key={item.id} className="flex flex-col gap-1">
            <span className="text-[11px] leading-4 text-muted-foreground">
              {item.label}
            </span>
            <span className="text-[17px] leading-6 font-semibold tabular-nums">
              {item.id === "revenue"
                ? formatCurrency(item.value)
                : formatNumber(item.value)}
            </span>
            <DeltaBadge delta={item.delta} trend={item.trend} />
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-border/70 pt-2">
        <TrafficTrendChart data={trend} height={186} />
      </div>
    </SectionCard>
  );
}

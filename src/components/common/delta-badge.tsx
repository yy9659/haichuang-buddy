import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { TONE_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { StatusTone, TrendDirection } from "@/types";

interface DeltaBadgeProps {
  /** 环比变化，0.12 表示 +12% */
  delta: number;
  trend: TrendDirection;
  /** 说明文案，如「较昨日」 */
  hint?: string;
  className?: string;
}

/**
 * 涨跌标识。
 * 经营数据看板约定：增长为正向（绿），下降为负向（红）。
 */
export function DeltaBadge({ delta, trend, hint, className }: DeltaBadgeProps) {
  const tone: StatusTone =
    trend === "up" ? "success" : trend === "down" ? "danger" : "neutral";
  const Icon =
    trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : Minus;
  const sign = delta > 0 ? "+" : "";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium",
        TONE_CLASSES[tone].soft,
        className,
      )}
    >
      <Icon className="size-3" />
      {`${sign}${(delta * 100).toFixed(0)}%`}
      {hint ? (
        <span className="ml-0.5 font-normal opacity-80">{hint}</span>
      ) : null}
    </span>
  );
}

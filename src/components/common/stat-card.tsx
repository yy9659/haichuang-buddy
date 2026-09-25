import type * as React from "react";

import { Card, CardContent } from "@/components/ui/card";
import { TONE_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { StatusTone } from "@/types";

interface StatCardProps {
  label: string;
  value: string;
  unit?: string;
  icon: React.ReactNode;
  tone: StatusTone;
  /** 说明或趋势区域 */
  footer?: React.ReactNode;
  className?: string;
}

/** 核心状态指标卡（驾驶舱 / 经营分析复用） */
export function StatCard({
  label,
  value,
  unit,
  icon,
  tone,
  footer,
  className,
}: StatCardProps) {
  const classes = TONE_CLASSES[tone];

  return (
    <Card className={cn("transition-shadow hover:shadow-float", className)}>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">
            {label}
          </span>
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-lg [&_svg]:size-4",
              classes.icon,
            )}
          >
            {icon}
          </span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl leading-8 font-semibold tracking-tight tabular-nums">
            {value}
          </span>
          {unit ? (
            <span className="text-[12px] text-muted-foreground">{unit}</span>
          ) : null}
        </div>
        {footer ? <div className="flex items-center gap-2">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}

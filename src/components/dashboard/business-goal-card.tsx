import { Target } from "lucide-react";

import { ScoreRing } from "@/components/common/score-ring";
import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import type { BusinessGoal } from "@/types";

/** 经营目标卡片 */
export function BusinessGoalCard({ goal }: { goal: BusinessGoal }) {
  return (
    <SectionCard
      title={goal.title}
      description={goal.period}
      icon={<Target className="size-4 text-primary" />}
      action={<Badge variant="secondary">编辑</Badge>}
    >
      <div className="flex items-center gap-4">
        <ScoreRing
          value={goal.progress * 100}
          label={`${Math.round(goal.progress * 100)}%`}
          tone="primary"
          size={92}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] leading-4 text-muted-foreground">
            目标营业额
          </span>
          <span className="text-xl leading-7 font-semibold tabular-nums">
            {formatCurrency(goal.target)}
          </span>
          <span className="text-[12px] leading-4 text-muted-foreground">
            已完成{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatCurrency(goal.achieved)}
            </span>
          </span>
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-2 border-t border-border/70 pt-3">
        {goal.items.map((item) => (
          <li key={item.id} className="flex items-start gap-2">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" />
            <div className="flex min-w-0 flex-col">
              <span className="text-[12px] leading-5 font-medium">
                {item.label}
              </span>
              <span className="text-[11px] leading-4 text-muted-foreground">
                {item.description}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { TONE_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { AnalyticsOverview } from "@/types";

type InterestShift = AnalyticsOverview["interestShifts"][number];

/** 用户兴趣变化 */
export function InterestShiftList({ shifts }: { shifts: InterestShift[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {shifts.map((shift) => {
        const up = shift.direction === "up";
        const Icon = up ? ArrowUpRight : ArrowDownRight;
        const delta = shift.after - shift.before;

        return (
          <li key={shift.id} className="flex flex-col gap-1.5">
            <span className="text-[12px] leading-5 font-medium">
              {shift.label}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {(shift.before * 100).toFixed(0)}%
              </span>
              <span className="text-border">→</span>
              <span className="text-[11px] font-medium tabular-nums">
                {(shift.after * 100).toFixed(0)}%
              </span>
              <span
                className={cn(
                  "ml-auto inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                  TONE_CLASSES[up ? "success" : "neutral"].soft,
                )}
              >
                <Icon className="size-3" />
                {`${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}pt`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full",
                  up ? "bg-primary" : "bg-muted-foreground/50",
                )}
                style={{ width: `${shift.after * 100}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** 热门问题排行 */
export function TopQuestionsList({
  questions,
}: {
  questions: AnalyticsOverview["topQuestions"];
}) {
  return (
    <ol className="flex flex-col gap-2.5">
      {questions.map((item, index) => (
        <li key={item.id} className="flex items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-medium tabular-nums",
              index < 3
                ? "bg-primary-soft text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 text-[12px] leading-5">
            {item.question}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {item.count} 次
          </span>
        </li>
      ))}
    </ol>
  );
}

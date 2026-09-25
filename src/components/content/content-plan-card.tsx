import { CalendarClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  CONTENT_PLATFORM_LABEL,
  CONTENT_STATUS_META,
} from "@/lib/status-meta";
import type { ContentPlanItem } from "@/types";

/** 今日内容计划 */
export function ContentPlanCard({ plan }: { plan: ContentPlanItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
          <CalendarClock className="size-3.5 text-primary" />
          今日内容计划
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {plan.length} 条排期
        </span>
      </div>

      <ol className="flex flex-col">
        {plan.map((item, index) => {
          const meta = CONTENT_STATUS_META[item.status];
          const isLast = index === plan.length - 1;
          return (
            <li key={item.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-medium text-primary tabular-nums">
                  {index + 1}
                </span>
                {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
              </div>
              <div className={isLast ? "min-w-0 flex-1" : "min-w-0 flex-1 pb-3"}>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {item.timeText}
                  </span>
                  <Badge variant="secondary">
                    {CONTENT_PLATFORM_LABEL[item.platform]}
                  </Badge>
                  <Badge variant={meta.tone} className="ml-auto">
                    {meta.label}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-[12px] leading-5 font-medium">
                  {item.title}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

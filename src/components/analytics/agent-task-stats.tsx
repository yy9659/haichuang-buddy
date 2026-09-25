import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { AgentTaskStat } from "@/types";

/** AI 任务完成情况 */
export function AgentTaskStats({ stats }: { stats: AgentTaskStat[] }) {
  const total = stats.reduce((sum, item) => sum + item.total, 0);
  const completed = stats.reduce((sum, item) => sum + item.completed, 0);
  const rate = total === 0 ? 0 : completed / total;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2">
        <span className="text-[12px] text-muted-foreground">
          整体任务完成率
        </span>
        <span className="text-[13px] font-semibold text-primary tabular-nums">
          {(rate * 100).toFixed(0)}%
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        {stats.map((item) => {
          const itemRate = item.total === 0 ? 0 : item.completed / item.total;
          return (
            <li key={item.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-medium">{item.agentName}</span>
                <span className="flex items-center gap-2 text-muted-foreground tabular-nums">
                  <span>
                    {item.completed} / {item.total}
                  </span>
                  <span className="text-border">·</span>
                  <span>平均 {item.averageDurationText}</span>
                </span>
              </div>
              <Progress
                value={itemRate * 100}
                className="h-1.5"
                indicatorClassName={cn(
                  item.failed > 0 ? "bg-warning" : "bg-primary",
                )}
              />
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] leading-4 text-muted-foreground">
        单个 Agent 失败不会中断整个 Workflow，失败任务可单独重试。
      </p>
    </div>
  );
}

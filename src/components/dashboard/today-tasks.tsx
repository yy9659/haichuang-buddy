import { CircleAlert, ListChecks, RefreshCw } from "lucide-react";

import { AgentStatusBadge } from "@/components/common/agent-status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentTask } from "@/types";

/** 今日任务清单 */
export function TodayTasks({ tasks }: { tasks: AgentTask[] }) {
  const completed = tasks.filter((task) => task.status === "completed").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
          <ListChecks className="size-3.5 text-primary" />
          今日 {tasks.length} 个任务
        </span>
        <span className="text-[12px] text-muted-foreground tabular-nums">
          已完成 {completed} / {tasks.length}
        </span>
      </div>

      <ul className="flex flex-col gap-2.5">
        {tasks.map((task) => {
          const failed = task.status === "failed";
          return (
            <li key={task.id} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  task.status === "completed"
                    ? "bg-success"
                    : task.status === "running"
                      ? "animate-pulse-soft bg-primary"
                      : failed
                        ? "bg-destructive"
                        : "bg-border",
                )}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[13px] leading-5 font-medium">
                  {task.title}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{task.agentName}</span>
                  <span className="text-border">·</span>
                  <AgentStatusBadge
                    status={task.status}
                    withDot={false}
                    className="px-1.5 py-0 text-[10px]"
                  />
                  {task.timeText ? <span>{task.timeText}</span> : null}
                </span>
                {failed ? (
                  <span className="mt-0.5 inline-flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
                      <CircleAlert className="size-3" />
                      生成失败
                    </span>
                    <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]">
                      <RefreshCw className="size-3" />
                      重新执行
                    </Button>
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

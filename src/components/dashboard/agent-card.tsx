import { Clock } from "lucide-react";

import { AgentStatusBadge } from "@/components/common/agent-status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { ACCENT_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { AgentEmployee } from "@/types";

/** 单个 AI 员工卡片：名称 / 工作状态 / 当前任务 / 最近一次执行时间 */
export function AgentCard({ agent }: { agent: AgentEmployee }) {
  const accent = ACCENT_CLASSES[agent.accent];
  const Icon = agent.icon;

  return (
    <Card
      className={cn(
        "group h-full transition-all hover:-translate-y-0.5 hover:shadow-float",
        accent.hoverBorder,
      )}
    >
      <CardContent className="flex h-full flex-col gap-3 pt-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl shadow-sm",
              accent.avatar,
            )}
          >
            <Icon className="size-5" strokeWidth={1.8} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] leading-5 font-semibold">
                {agent.name}
              </span>
              {agent.supervisor ? (
                <span className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] leading-4 font-medium text-primary-foreground">
                  调度中枢
                </span>
              ) : null}
            </div>
            <span className="truncate text-[12px] leading-4 text-muted-foreground">
              {agent.role}
            </span>
          </div>
          <AgentStatusBadge status={agent.status} />
        </div>

        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <span className="text-[11px] leading-4 text-muted-foreground">
            当前任务
          </span>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 font-medium">
            {agent.currentTask}
          </p>
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" />
            最近执行 {agent.lastRunAt}
          </span>
          <span className="truncate">{agent.lastRunSummary}</span>
        </div>
      </CardContent>
    </Card>
  );
}

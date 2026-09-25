import { Brain, CircleCheck, LoaderCircle, CircleDashed } from "lucide-react";

import { AgentStatusBadge } from "@/components/common/agent-status-badge";
import { Progress } from "@/components/ui/progress";
import { AGENT_STATUS_META } from "@/lib/status-meta";
import { TONE_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { AgentWorkflow, WorkflowStage } from "@/types";

const STAGE_ICON: Record<WorkflowStage["status"], typeof CircleCheck> = {
  idle: CircleDashed,
  queued: CircleDashed,
  running: LoaderCircle,
  completed: CircleCheck,
  failed: CircleDashed,
};

/** Agent Workflow 执行链路可视化 */
export function WorkflowBoard({ workflow }: { workflow: AgentWorkflow }) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-card">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 text-white">
            <Brain className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] leading-5 font-semibold">
              AI经营大脑
            </span>
            <span className="truncate text-[11px] leading-4 text-muted-foreground">
              目标：{workflow.goal}
            </span>
          </div>
        </div>
        <div className="mt-2.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>整体进度</span>
            <span className="tabular-nums">
              {Math.round(workflow.progress * 100)}%
            </span>
          </div>
          <Progress value={workflow.progress * 100} />
        </div>
      </div>

      <ol className="flex flex-1 flex-col">
        {workflow.stages.map((stage, index) => {
          const Icon = STAGE_ICON[stage.status];
          const tone = AGENT_STATUS_META[stage.status].tone;
          const isLast = index === workflow.stages.length - 1;

          return (
            <li key={stage.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full",
                    TONE_CLASSES[tone].icon,
                  )}
                >
                  <Icon
                    className={cn(
                      "size-3.5",
                      stage.status === "running" && "animate-spin",
                    )}
                    strokeWidth={2}
                  />
                </span>
                {!isLast ? (
                  <span
                    className={cn(
                      "w-px flex-1",
                      stage.status === "completed"
                        ? "bg-primary/40"
                        : "bg-border",
                    )}
                  />
                ) : null}
              </div>

              <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-3")}>
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] leading-5 font-medium">
                    {stage.agentName}
                  </span>
                  <AgentStatusBadge
                    status={stage.status}
                    withDot={false}
                    className="shrink-0"
                  />
                  {stage.durationText ? (
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {stage.durationText}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-[12px] leading-5 text-muted-foreground">
                  {stage.title}
                </p>
                {stage.outputSummary ? (
                  <p className="mt-1 rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 text-muted-foreground">
                    {stage.outputSummary}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

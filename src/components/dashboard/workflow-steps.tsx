import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  LoaderCircle,
  Recycle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatDurationMs } from "@/lib/datetime";
import {
  STEP_DISPLAY_META,
  type LiveStepView,
  type WorkflowStepDisplayStatus,
} from "@/lib/workflow-display";
import { TONE_CLASSES } from "@/lib/tone";
import { cn } from "@/lib/utils";

/**
 * 步骤状态图标。
 *
 * 为什么每个状态必须是**不同形状**而不是同一个图标换颜色：
 * 任务书 §10 要求 `skipped / reused` 都用中性色，此时颜色已经不再携带信息，
 * 形状就成了唯一的区分手段（无障碍要求 §29「不能只靠颜色表达」）。
 * `Recycle`（已复用）与 `CircleSlash`（未执行）在轮廓上差异明显，
 * 色弱用户也能分辨。
 */
const STATUS_ICON: Record<WorkflowStepDisplayStatus, typeof CircleCheck> = {
  pending: CircleDashed,
  running: LoaderCircle,
  executed: CircleCheck,
  reused: Recycle,
  failed: CircleX,
  not_run: CircleSlash,
};

/** 单个步骤的完整展示（时间线的一个节点） */
export function WorkflowStepItem({
  step,
  isLast,
}: {
  step: LiveStepView;
  isLast: boolean;
}) {
  const meta = STEP_DISPLAY_META[step.displayStatus];
  const Icon = STATUS_ICON[step.displayStatus];
  const tone = TONE_CLASSES[meta.tone];

  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            tone.icon,
          )}
          aria-hidden
        >
          <Icon
            className={cn(
              "size-3.5",
              step.displayStatus === "running" && "animate-spin",
            )}
            strokeWidth={2}
          />
        </span>
        {!isLast ? (
          <span
            className={cn(
              "w-px flex-1",
              step.displayStatus === "executed" || step.displayStatus === "reused"
                ? "bg-primary/30"
                : "bg-border",
            )}
          />
        ) : null}
      </div>

      <div className={cn("min-w-0 flex-1", isLast ? "pb-0" : "pb-3.5")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] leading-5 font-medium">
            {step.title}
          </span>
          <Badge variant={meta.tone} className="shrink-0 gap-1">
            {meta.label}
          </Badge>
          {step.durationMs !== null ? (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {formatDurationMs(step.durationMs)}
            </span>
          ) : null}
        </div>

        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
          {step.agentName}
          {step.reason ? ` · ${step.reason}` : ""}
        </p>

        {/*
          说明区只在该步骤「有额外情况」时出现：
          - 复用 / 失败 → 报告的 note（复用原因 / 失败原因）
          - 未执行 → 由阻挡它的步骤名合成一句话（§16 要求不能说成「某某 Agent 失败」）
          - 执行中 → 状态本身的含义
          顺利跑完的一步**刻意不写任何说明** —— 补一句「成功」只会稀释真正要看的失败信息。
        */}
        {step.displayStatus === "not_run" ? (
          <p className="mt-1 rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 text-muted-foreground">
            {step.blockedByTitles.length > 0
              ? `依赖条件未满足：「${step.blockedByTitles.join("」「")}」没有成功，本步未被执行。`
              : (step.note ?? "本步未被执行。")}
          </p>
        ) : step.note ? (
          <p className="mt-1 rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 text-muted-foreground">
            {step.note}
          </p>
        ) : step.displayStatus === "running" ? (
          <p className="mt-1 text-[11px] leading-4 text-primary">
            AI 员工正在执行这一步，结果返回后这里会自动更新。
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 一条经营计划的步骤时间线。
 *
 * 组件内**没有任何业务判断** —— 显示成什么状态、说什么话，全部由
 * `@/lib/workflow-display` 决定。这样「复用不能被显示成完成」这类约束
 * 只需要在纯函数层用一条断言守住，不必逐个组件检查。
 */
export function WorkflowSteps({
  steps,
  className,
}: {
  steps: readonly LiveStepView[];
  className?: string;
}) {
  if (steps.length === 0) {
    return (
      <p className={cn("text-[12px] leading-5 text-muted-foreground", className)}>
        这一轮的计划里没有步骤。
      </p>
    );
  }

  return (
    <ol className={cn("flex flex-col", className)}>
      {steps.map((step, index) => (
        <WorkflowStepItem
          key={step.taskId}
          step={step}
          isLast={index === steps.length - 1}
        />
      ))}
    </ol>
  );
}

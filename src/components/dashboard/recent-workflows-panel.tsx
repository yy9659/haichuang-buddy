import { History, Inbox } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import { WorkflowDetailDialog } from "@/components/dashboard/workflow-detail-dialog";
import { WORKFLOW_STATUS_META } from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { DashboardWorkflowListItem } from "@/services/dashboard";

/**
 * 最近 AI 经营任务（任务书 §21）。
 *
 * 数据全部来自 `agent_workflows` 的真实记录 —— 这里没有一份 Mock。
 * 「状态」用全局同一套元数据渲染（`WORKFLOW_STATUS_META`），
 * 因此驾驶舱上看到的「部分完成」与对话框里看到的一定是同一个词。
 *
 * 空态与「有记录但都没跑过」分开表达：前者说明还没规划过，
 * 后者说明有计划在等着确认 —— 两种情况该做的事完全不同。
 */
export function RecentWorkflowsPanel({
  workflows,
  windowSize,
}: {
  workflows: readonly DashboardWorkflowListItem[];
  /** 统计口径（「最近 N 轮」里的 N），写在描述里让数字可追溯 */
  windowSize: number;
}) {
  return (
    <SectionCard
      title="最近经营任务"
      description={`最近 ${windowSize} 轮经营任务，按创建时间排列`}
      moreHref="/analytics"
      moreLabel="查看复盘"
      icon={<History className="size-4 text-primary" />}
      className="h-full"
      contentClassName="flex flex-col gap-2"
    >
      {workflows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Inbox className="size-4" />
          </span>
          <span className="text-[13px] leading-5 font-medium">
            还没有经营任务记录
          </span>
          <span className="text-[12px] leading-5 text-muted-foreground">
            点「制定经营目标」写下第一个目标，完成一轮后这里会出现真实记录。
          </span>
        </div>
      ) : (
        workflows.map((workflow) => {
          const meta = WORKFLOW_STATUS_META[workflow.status];
          return (
            <article
              key={workflow.id}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/25"
            >
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] leading-5 font-medium">
                    {workflow.goal}
                  </span>
                  <span className="truncate text-[11px] leading-4 text-muted-foreground">
                    {workflow.productNames.length > 0
                      ? workflow.productNames.join("、")
                      : "未绑定商品"}
                  </span>
                </div>
                <Badge variant={meta.tone} className="shrink-0">
                  {workflow.isStale ? "可能已中断" : meta.label}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="tabular-nums">
                  {workflow.progress.done} / {workflow.progress.total} 步
                </span>
                {workflow.outcome.reused > 0 ? (
                  <span className="tabular-nums">
                    复用 {workflow.outcome.reused}
                  </span>
                ) : null}
                {workflow.outcome.failed > 0 ? (
                  <span className={cn("tabular-nums text-destructive")}>
                    失败 {workflow.outcome.failed}
                  </span>
                ) : null}
                <span>{workflow.createdAt}</span>
                {workflow.durationText ? (
                  <span className="tabular-nums">{workflow.durationText}</span>
                ) : null}
                <span className="ml-auto">
                  <WorkflowDetailDialog workflow={workflow} />
                </span>
              </div>
            </article>
          );
        })
      )}
    </SectionCard>
  );
}

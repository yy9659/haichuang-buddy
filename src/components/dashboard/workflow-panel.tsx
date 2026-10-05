import { GitBranch } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { WorkflowDetailDialog } from "@/components/dashboard/workflow-detail-dialog";
import { WORKFLOW_STATUS_META } from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { DashboardWorkflowListItem } from "@/services/dashboard";

/**
 * AI 经营进度面板（S4-2 真实化）。
 *
 * 旧版本是 `WorkflowBoard` + `WorkflowPanel` 两层，渲染一份预置的演示工作流
 * （`progress: 0.37`、`activeStageIndex: 2`）—— 那两个字段在数据库里根本不存在，
 * 是纯演出来的。现在这份数据来自 `agent_workflows` 的真实记录：
 * 状态、进度（真实步数）、复用/失败计数，一个都不是编的。
 *
 * 关于「运行中为什么进度是 0 / N」：摘要（`summary`）要等整轮结束才写库，
 * 在那之前库里确实还没有任何一步的结果。因此这里**如实显示 0 / N**，
 * 并在文案里说清「点详情看实时进度」—— 编一个看起来在动的数字才是错的。
 */
export function WorkflowPanel({
  workflow,
  isActive,
  isSelected = false,
}: {
  /** 当前要展示的那一轮；null 表示还没有任何记录 */
  workflow: DashboardWorkflowListItem | null;
  /** 是否正在执行中（决定进度条文案与提示） */
  isActive: boolean;
  isSelected?: boolean;
}) {
  if (!workflow) {
    return (
      <SectionCard
        title="经营进度"
        description="还没有经营任务记录"
        icon={<GitBranch className="size-4 text-primary" />}
        className="h-full"
      >
        <p className="text-[12px] leading-5 text-muted-foreground">
          点顶部「制定经营目标」写下第一个目标。规划完成后会先给出计划，
          确认计划后，各岗位将按顺序执行。
        </p>
      </SectionCard>
    );
  }

  const meta = WORKFLOW_STATUS_META[workflow.status];
  const { outcome, progress } = workflow;

  return (
    <SectionCard
      title="经营进度"
      description={isSelected ? "搜索选中的经营任务" : isActive ? "正在执行本轮经营任务" : "最近一轮经营任务"}
      icon={<GitBranch className="size-4 text-primary" />}
      action={
        <div className="flex items-center gap-2">
          <Badge variant={meta.tone}>
            {workflow.isStale ? "可能已中断" : meta.label}
          </Badge>
          <WorkflowDetailDialog workflow={workflow} />
        </div>
      }
      className="h-full"
      contentClassName="flex flex-col gap-3"
    >
      <div className="rounded-lg bg-muted/50 px-3 py-2.5">
        <span className="text-[11px] leading-4 text-muted-foreground">
          经营目标
        </span>
        <p className="mt-0.5 text-[13px] leading-5 font-medium">{workflow.goal}</p>
        {workflow.productNames.length > 0 ? (
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            涉及商品：{workflow.productNames.join("、")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>步骤进度（真实步数）</span>
          <span className="tabular-nums">
            {progress.done} / {progress.total} 步
          </span>
        </div>
        <Progress
          value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0}
        />
        {isActive ? (
          <p className="text-[11px] leading-4 text-primary">
            每一步的结果在整轮结束后才会写库，运行期间的实时进度请点右上角「查看详情」。
          </p>
        ) : (
          <p className="text-[11px] leading-4 text-muted-foreground">
            进度按已有结局的步骤计算，不做百分比估算。
          </p>
        )}
      </div>

      <dl className="grid grid-cols-4 gap-2">
        <MetricCell label="真实执行" value={outcome.executed} />
        <MetricCell label="复用" value={outcome.reused} tone="muted" />
        <MetricCell
          label="失败"
          value={outcome.failed}
          tone={outcome.failed > 0 ? "danger" : "muted"}
        />
        <MetricCell
          label="新增内容"
          value={outcome.newAssets}
          tone="success"
        />
      </dl>

      {workflow.errorMessage ? (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          {workflow.errorMessage}
        </p>
      ) : null}
    </SectionCard>
  );
}

function MetricCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "muted" | "success" | "danger";
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-2.5 py-2">
      <dt className="text-[11px] leading-4 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-[15px] leading-6 font-semibold tabular-nums",
          tone === "muted" && "text-muted-foreground",
          tone === "success" && value > 0 && "text-success",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

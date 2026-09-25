import { GitBranch } from "lucide-react";

import { SectionCard } from "@/components/common/section-card";
import { WorkflowBoard } from "@/components/dashboard/workflow-board";
import { WORKFLOW_STATUS_META } from "@/lib/status-meta";
import type { AgentWorkflow } from "@/types";

/** Agent Workflow 面板：AI经营大脑 → 各 AI 员工 → 经营分析师 */
export function WorkflowPanel({ workflow }: { workflow: AgentWorkflow }) {
  const status = WORKFLOW_STATUS_META[workflow.status];

  return (
    <SectionCard
      title="Agent Workflow"
      description="AI 经营闭环：数据 → 分析 → 决策 → 行动 → 反馈"
      icon={<GitBranch className="size-4 text-primary" />}
      action={<span className="text-[11px] text-muted-foreground">{status.label}</span>}
      className="h-full"
    >
      <WorkflowBoard workflow={workflow} />
    </SectionCard>
  );
}

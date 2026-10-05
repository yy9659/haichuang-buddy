import type { Metadata } from "next";
import { DataFallback } from "@/components/common/data-fallback";
import { AgentGrid } from "@/components/dashboard/agent-grid";
import { DashboardSummary } from "@/components/dashboard/dashboard-summary";
import { BusinessGoalDialog } from "@/components/dashboard/business-goal-dialog";
import { DashboardHero } from "@/components/dashboard/dashboard-hero";
import { KnowledgeGapAlert } from "@/components/dashboard/knowledge-gap-alert";
import { ProductSpotlight } from "@/components/dashboard/product-spotlight";
import { QuickEntryGrid } from "@/components/dashboard/quick-entry-grid";
import { RecentWorkflowsPanel } from "@/components/dashboard/recent-workflows-panel";
import { WorkflowPanel } from "@/components/dashboard/workflow-panel";
import { unwrapOrThrow } from "@/lib/result";
import { getDashboardOverview } from "@/services";
import { getDashboardWorkflow } from "@/services/dashboard";
import { readParam, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = {
  title: "经营工作台 · 海创Buddy",
};

/** 经营工作台：目标入口、六岗位状态、执行进度和结果。 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const workflowId = readParam(await searchParams, "workflow");
  const [overview, selected] = await Promise.all([
    getDashboardOverview(),
    workflowId ? getDashboardWorkflow(workflowId) : Promise.resolve(null),
  ]);
  const view = unwrapOrThrow(overview);
  const selectedWorkflow = selected?.ok ? selected.data : null;
  /**
   * 页面当前要聚焦的那一轮工作流：正在跑的那轮优先，其次是最新的一轮。
   *
   * 只在前端做这一个「取第一个非空」的选择是安全的：两个来源都是服务层
   * 已经装配好的列表项，页面没有做任何再计算。
   */
  const focusWorkflow = selectedWorkflow ?? view.activeWorkflow ?? view.recentWorkflows[0] ?? null;

  /** 页面只保留一个主入口，避免演示时出现重复操作。 */
  const launchDialog = (
    <BusinessGoalDialog
      products={view.planningProducts}
      canLaunch={view.businessBrain.canLaunch}
      activeGoal={view.activeWorkflow?.goal ?? null}
      isMock={view.businessBrain.provider.isMock}
      triggerClassName="min-w-44 rounded-full border-0 bg-gradient-to-r from-cyan-400 to-blue-500 px-6 font-medium text-white shadow-lg shadow-cyan-500/30 hover:from-cyan-300 hover:to-blue-400"
    />
  );

  return (
    <>
      <DashboardHero cta={launchDialog} />
      <DashboardSummary
        productCount={view.productCount}
        workflowStats={view.workflowStats}
        customerService={view.customerService}
        businessBrain={view.businessBrain}
      />
      <QuickEntryGrid />

      <div id="recent-tasks" className="grid scroll-mt-20 gap-4 xl:grid-cols-[1fr_1.3fr]">
        {workflowId && !selectedWorkflow ? <p role="status" className="rounded-xl border border-white/10 bg-card p-3 text-sm text-muted-foreground xl:col-span-2">{selected && !selected.ok ? "暂时无法查看这条经营任务，请刷新后重试。" : "这条经营任务不存在或已被删除，下面展示最近的任务。"}</p> : null}
        <WorkflowPanel
          workflow={focusWorkflow}
          isActive={focusWorkflow?.status === "running" && !focusWorkflow.isStale}
          isSelected={selectedWorkflow !== null}
        />
        <RecentWorkflowsPanel
          workflows={view.recentWorkflows}
          windowSize={view.workflowStats.windowSize}
        />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        {view.spotlightProduct ? (
          <ProductSpotlight
            product={view.spotlightProduct}
            totalCount={view.productCount}
          />
        ) : (
          <DataFallback
            title="重点商品"
            description="商品中心还没有商品，添加后这里会自动展示。"
          />
        )}
        <KnowledgeGapAlert state={view.customerService} />
      </div>

      <details className="rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3 shadow-md shadow-black/20 backdrop-blur-md transition-shadow duration-200 hover:shadow-lg">
        <summary className="cursor-pointer text-[13px] font-medium text-slate-300">查看内部协同岗位</summary>
        <div className="mt-3">
          <AgentGrid agents={view.agentStates} />
        </div>
      </details>
    </>
  );
}

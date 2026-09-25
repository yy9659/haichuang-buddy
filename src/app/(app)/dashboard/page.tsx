import type { Metadata } from "next";

import { BusinessGoalCard } from "@/components/dashboard/business-goal-card";
import { BusinessMetricsCard } from "@/components/dashboard/business-metrics-card";
import { DailyReportCard } from "@/components/dashboard/daily-report-card";
import { AgentGrid } from "@/components/dashboard/agent-grid";
import { DashboardHero } from "@/components/dashboard/dashboard-hero";
import { LivePreviewCard } from "@/components/dashboard/live-preview-card";
import { OverviewMetrics } from "@/components/dashboard/overview-metrics";
import { ProductSpotlight } from "@/components/dashboard/product-spotlight";
import { QuickEntryGrid } from "@/components/dashboard/quick-entry-grid";
import { TodayTasksPanel } from "@/components/dashboard/today-tasks-panel";
import { WorkflowPanel } from "@/components/dashboard/workflow-panel";
import {
  MOCK_AGENTS,
  MOCK_ANALYTICS_OVERVIEW,
  MOCK_BUSINESS_GOAL,
  MOCK_DAILY_REPORT,
  MOCK_DASHBOARD_METRICS,
  MOCK_LIVE_COMMENTS,
  MOCK_LIVE_SESSION,
  MOCK_LIVE_STATS,
  MOCK_PRODUCTS,
  MOCK_TODAY_TASKS,
  MOCK_WORKFLOW,
} from "@/lib/mock";

export const metadata: Metadata = {
  title: "AI经营驾驶舱 · 海创Buddy",
};

/** AI 经营驾驶舱：今日经营状态 + AI 员工 + Workflow + 核心 CTA */
export default function DashboardPage() {
  const spotlightProduct = MOCK_PRODUCTS[0];

  return (
    <>
      <DashboardHero />
      <QuickEntryGrid />
      <OverviewMetrics metrics={MOCK_DASHBOARD_METRICS} />

      <div className="grid gap-3 xl:grid-cols-[1.55fr_1fr]">
        <AgentGrid agents={MOCK_AGENTS} />
        <div className="flex flex-col gap-3">
          <WorkflowPanel workflow={MOCK_WORKFLOW} />
          <TodayTasksPanel tasks={MOCK_TODAY_TASKS} />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.3fr_1fr_1fr]">
        <BusinessMetricsCard trend={MOCK_ANALYTICS_OVERVIEW.trend} />
        <ProductSpotlight
          product={spotlightProduct}
          totalCount={MOCK_PRODUCTS.length}
        />
        <LivePreviewCard
          session={MOCK_LIVE_SESSION}
          stats={MOCK_LIVE_STATS}
          comments={MOCK_LIVE_COMMENTS}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
        <DailyReportCard report={MOCK_DAILY_REPORT} />
        <BusinessGoalCard goal={MOCK_BUSINESS_GOAL} />
      </div>
    </>
  );
}

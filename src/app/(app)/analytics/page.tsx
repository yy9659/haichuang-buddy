import type { Metadata } from "next";
import {
  BarChart3,
  ChartColumn,
  ChartLine,
  FileText,
  Headphones,
  Percent,
  Radio,
  RefreshCw,
} from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatCard } from "@/components/common/stat-card";
import { AgentTaskStats } from "@/components/analytics/agent-task-stats";
import { ContentPerformanceChart } from "@/components/analytics/content-performance-chart";
import {
  InterestShiftList,
  TopQuestionsList,
} from "@/components/analytics/interest-and-questions";
import {
  ContentPerformanceTable,
  ProductPerformanceTable,
} from "@/components/analytics/performance-tables";
import { QuestionCategoryCard } from "@/components/analytics/question-category-list";
import { TrafficTrendChart } from "@/components/analytics/traffic-trend-chart";
import { DeltaBadge } from "@/components/common/delta-badge";
import { BusinessGoalCard } from "@/components/dashboard/business-goal-card";
import { DailyReportCard } from "@/components/dashboard/daily-report-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MOCK_ANALYTICS_OVERVIEW,
  MOCK_BUSINESS_GOAL,
  MOCK_DAILY_REPORT,
} from "@/lib/mock";
import type { IconComponent } from "@/types";

export const metadata: Metadata = {
  title: "经营分析 · 海创Buddy",
};

const METRIC_ICON: Record<string, IconComponent> = {
  a_content_count: FileText,
  a_engagement: Percent,
  a_inquiries: Headphones,
  a_live_engagement: Radio,
  a_task_rate: ChartColumn,
  a_score: BarChart3,
};

/** 经营分析：由程序计算指标，AI 负责解释归因 */
export default function AnalyticsPage() {
  const overview = MOCK_ANALYTICS_OVERVIEW;

  return (
    <>
      <PageHeader
        title="经营分析"
        description="所有指标均由程序计算，AI 只负责解释数字、发现问题并给出行动建议。"
        badge={<Badge variant="soft">近 7 天</Badge>}
        actions={
          <Button>
            <RefreshCw />
            生成经营日报
          </Button>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {overview.metrics.map((metric) => {
          const Icon = METRIC_ICON[metric.id] ?? ChartLine;
          return (
            <StatCard
              key={metric.id}
              label={metric.label}
              value={metric.value}
              unit={metric.unit}
              tone={metric.tone}
              icon={<Icon />}
              footer={
                <>
                  <DeltaBadge delta={metric.delta} trend={metric.trend} />
                  <span className="truncate text-[11px] text-muted-foreground">
                    {metric.description}
                  </span>
                </>
              }
            />
          );
        })}
      </section>

      <div className="grid gap-3 xl:grid-cols-[1.6fr_1fr]">
        <SectionCard
          title="流量与转化趋势"
          description="浏览量 / 咨询量 / 成交量（近 7 天）"
          icon={<ChartLine className="size-4 text-primary" />}
        >
          <TrafficTrendChart data={overview.trend} height={264} />
        </SectionCard>

        <QuestionCategoryCard categories={overview.questionCategories} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.6fr_1fr]">
        <SectionCard
          title="内容表现"
          description="按播放量排序的内容效果对比"
          icon={<BarChart3 className="size-4 text-primary" />}
        >
          <ContentPerformanceChart data={overview.contentPerformance} />
          <div className="mt-3">
            <ContentPerformanceTable rows={overview.contentPerformance} />
          </div>
        </SectionCard>

        <div className="flex flex-col gap-3">
          <SectionCard
            title="商品表现"
            description="商品维度的浏览、咨询与转化"
          >
            <ProductPerformanceTable rows={overview.productPerformance} />
          </SectionCard>
          <SectionCard title="热门问题" description="近 7 天被咨询最多的问题">
            <TopQuestionsList questions={overview.topQuestions} />
          </SectionCard>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <SectionCard
          title="AI 任务完成率"
          description="各 AI 员工的执行情况与平均耗时"
        >
          <AgentTaskStats stats={overview.agentTaskStats} />
        </SectionCard>

        <SectionCard
          title="用户兴趣变化"
          description="话题关注度环比变化（程序计算）"
        >
          <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
            <InterestShiftList shifts={overview.interestShifts} />
            <div className="rounded-lg border border-border bg-muted/50 p-3">
              <span className="text-[12px] font-semibold">经营分析师解读</span>
              <ul className="mt-2 flex flex-col gap-1.5">
                {MOCK_DAILY_REPORT.insights.slice(0, 3).map((insight) => (
                  <li
                    key={insight}
                    className="flex gap-1.5 text-[11px] leading-5 text-muted-foreground"
                  >
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-border" />
                    {insight}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
        <DailyReportCard report={MOCK_DAILY_REPORT} />
        <BusinessGoalCard goal={MOCK_BUSINESS_GOAL} />
      </div>
    </>
  );
}

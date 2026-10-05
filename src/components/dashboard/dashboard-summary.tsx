import { ArrowUpRight, CheckCheck, Headphones, MessageCircleQuestion, Package } from "lucide-react";
import Link from "next/link";

import { BusinessBrainCard } from "@/components/dashboard/business-brain-card";
import { cn, formatNumber } from "@/lib/utils";
import type { DashboardOverview } from "@/services/dashboard";
import type { IconComponent } from "@/types";

type SummaryProps = Pick<DashboardOverview, "productCount" | "workflowStats" | "customerService" | "businessBrain">;

/** 参考设计图的两侧指标与中间经营核心，所有数字使用已有服务数据。 */
export function DashboardSummary({ productCount, workflowStats, customerService, businessBrain }: SummaryProps) {
  return (
    <section aria-label="经营工作概览" className="grid gap-4 xl:h-[410px] xl:grid-cols-[1fr_1.2fr_1fr]">
      <div className="grid min-h-0 gap-4 sm:grid-cols-2 xl:grid-cols-1 xl:grid-rows-2">
        <SummaryMetric title="商品档案" value={productCount} unit="件" description="查看商品资料与卖点" href="/products" icon={Package} tone="blue" />
        <SummaryMetric title="已完成经营任务" value={workflowStats.completed} unit="轮" description={`最近 ${workflowStats.windowSize} 轮中的完成记录`} href="#recent-tasks" icon={CheckCheck} tone="cyan" />
      </div>
      <BusinessBrainCard brain={businessBrain} />
      <div className="grid min-h-0 gap-4 sm:grid-cols-2 xl:grid-cols-1 xl:grid-rows-2">
        <SummaryMetric title="今日 AI 答疑" value={customerService?.todayAnsweredCount ?? null} unit="次" description="查看答疑记录与回答依据" href="/customer-service" icon={Headphones} tone="cyan" />
        <SummaryMetric title="待补充知识" value={customerService?.openKnowledgeGapCount ?? null} unit="项" description="补齐资料，让回复更有依据" href="/customer-service?panel=gaps" icon={MessageCircleQuestion} tone="violet" />
      </div>
    </section>
  );
}

function SummaryMetric({ title, value, unit, description, href, icon: Icon, tone }: {
  title: string;
  value: number | null;
  unit: string;
  description: string;
  href: string;
  icon: IconComponent;
  tone: "blue" | "cyan" | "violet";
}) {
  return (
    <Link href={href} className="group flex flex-col rounded-2xl border border-white/10 bg-white/[0.05] p-4 shadow-md shadow-black/20 backdrop-blur-md transition-[box-shadow,border-color] duration-200 hover:border-white/20 hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400">
      <div className="flex items-center justify-between gap-2">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", tone === "blue" && "bg-blue-400/15 text-blue-300", tone === "cyan" && "bg-cyan-400/15 text-cyan-300", tone === "violet" && "bg-violet-400/15 text-violet-300")}>
          <Icon className="size-5" strokeWidth={1.8} />
        </span>
        <span className="rounded-full bg-white/8 px-2 py-0.5 text-xs text-slate-400">
          实时
        </span>
      </div>
      <h2 className="mt-3 text-[13px] font-medium text-slate-400">{title}</h2>
      <p className="mt-0.5 text-[28px] leading-9 font-semibold tracking-tight text-white tabular-nums">
        {value === null ? "—" : formatNumber(value)}
        <span className="ml-1.5 text-xs font-normal text-slate-500">{unit}</span>
      </p>
      <p className="mt-1 flex items-center gap-1 text-[13px] leading-5 text-slate-400">
        <span className="truncate">{value === null ? "数据暂不可用" : description}</span>
        <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-slate-500 transition-colors group-hover:text-cyan-300" />
      </p>
    </Link>
  );
}

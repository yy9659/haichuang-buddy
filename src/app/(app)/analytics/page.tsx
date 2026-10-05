import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ListChecks } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { ModuleUnavailable } from "@/components/common/module-unavailable";
import { Badge } from "@/components/ui/badge";
import { AgentEfficiencyPanel } from "@/components/analytics/agent-efficiency-panel";
import {
  BusinessReportHistory,
  BusinessReportSection,
} from "@/components/analytics/business-report-panel";
import { DistributionPanel } from "@/components/analytics/distribution-panel";
import { SystemMetricsPanel } from "@/components/analytics/system-metrics-panel";
import { SalesPanel } from "@/components/analytics/sales-panel";
import { WorkPreparationSummary } from "@/components/analytics/work-preparation-summary";
import { unwrapOrThrow } from "@/lib/result";
import { getAnalyticsOverview } from "@/services";
import { getSalesOverview, type SalesOverview } from "@/services/sales.service";
import { salesReviewActionLink } from "@/lib/sales-review-links";
import type { AnalyticsSnapshot, BusinessReport } from "@/types";

export const metadata: Metadata = {
  title: "经营复盘 · 海创Buddy",
};

function nextActions(snapshot: AnalyticsSnapshot, sales: SalesOverview, reports: readonly BusinessReport[]) {
  const salesCount = sales.real.count, missingCosts = sales.real.missingCostCount;
  const actions: { title: string; detail: string; href: string; link: string }[] = [];
  const fresh = reports.find(report => report.snapshot.sales?.mode === "real" && report.snapshot.sales.fingerprint === sales.fingerprints.real && report.report.salesReview);
  const priority = fresh?.report.salesReview?.actions[0];
  if (priority && fresh?.snapshot.sales) {
    const link = salesReviewActionLink(priority, fresh.snapshot.sales);
    actions.push({ title: priority.title, detail: priority.steps, href: link.href, link: link.label });
  }
  if (snapshot.product.totalProducts === 0) actions.push({ title: "先建立一件商品档案", detail: "后续素材与答疑需要可信的商品资料。", href: "/products", link: "去添加商品" });
  if (salesCount === 0) actions.push({ title: "先记下今天卖出的一笔", detail: "填入商品、数量和实际收款，也可以直接粘贴或导入现成表格。", href: "#sales-import", link: "去记一笔销售" });
  if (snapshot.customerService.openKnowledgeGapCount > 0) actions.push({ title: `补齐 ${snapshot.customerService.openKnowledgeGapCount} 个顾客问题的依据`, detail: "优先补充反复被问到、目前无法可靠回答的问题。", href: "/customer-service", link: "查看待补资料" });
  if (salesCount > 0 && missingCosts > 0 && priority?.destination !== "sales") actions.push({ title: `核对 ${missingCosts} 条未填写成本的销售记录`, detail: "把成本补齐，才能更清楚地比较商品毛利。", href: "#sales-import", link: "查看销售明细" });
  if (snapshot.content.totalAssets === 0) actions.push({ title: "准备第一条商品推广素材", detail: "先为当前主推商品制作一条可核对的草稿。", href: "/content", link: "去准备素材" });
  if (actions.length === 0) actions.push({ title: "核对最近的商品与渠道表现", detail: "结合实收记录，决定下一次重点推广哪件商品。", href: "#sales-import", link: "查看销售分析" });
  return actions.slice(0, 3);
}

/** 商户先看到行动和录入的销售结果；内部 Agent 运行明细按需展开。 */
export default async function AnalyticsPage() {
  const [realResult, salesResult] = await Promise.all([getAnalyticsOverview(), getSalesOverview()]);
  const real = unwrapOrThrow(realResult);
  const sales = unwrapOrThrow(salesResult);
  const salesReports = real.salesReports ?? real.recentReports;
  const actions = nextActions(real.snapshot, sales, salesReports);

  /** 直播 / 经营日报两个区块的降级原因（null 表示真实可用） */
  const liveDegraded = real.degradedModules.find((item) => item.module === "live") ?? null;
  const reportsDegraded =
    real.degradedModules.find((item) => item.module === "reports") ?? null;

  return (
    <>
      <PageHeader
        title="经营复盘"
        description="看看卖得怎样，听听 AI 的建议，再安排下一步。"
        badge={<Badge variant="soft">销售分析 · 经营建议</Badge>}
      />

      <section className="rounded-2xl border border-white/10 bg-[#112131]/80 p-5 text-card-foreground shadow-md shadow-black/25 backdrop-blur-md" aria-labelledby="today-action-title">
        <div className="flex items-center gap-2 text-cyan-200"><ListChecks className="size-4" /><span className="text-xs font-medium">今天先做这件事</span></div>
        <h2 id="today-action-title" className="mt-2 text-xl font-semibold text-white">{actions[0].title}</h2>
        <p className="mt-1 text-sm text-slate-300">{actions[0].detail}</p>
        <Link href={actions[0].href} className="mt-4 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-cyan-500 px-5 py-2 text-sm font-medium text-white shadow-md shadow-blue-500/30 hover:from-blue-700 hover:to-cyan-600">{actions[0].link}<ArrowRight className="size-4" /></Link>
        {actions.length > 1 ? <div className="mt-5 grid gap-2 border-t border-white/10 pt-4 sm:grid-cols-2">{actions.slice(1).map((action) => <Link key={action.title} href={action.href} className="rounded-xl border border-white/10 bg-white/[0.05] p-3 hover:bg-white/10"><span className="text-sm font-medium text-slate-100">{action.title}</span><span className="mt-1 block text-xs text-slate-400">{action.detail}</span></Link>)}</div> : null}
      </section>

      <SalesPanel view={sales} reports={salesReports} generating={real.reportState.status === "generating"} unavailableReason={reportsDegraded?.reason} />

      {!reportsDegraded && salesReports.length > 1 ? <details className="rounded-2xl border border-border bg-card p-4 sm:p-5"><summary className="cursor-pointer text-sm font-medium text-slate-200">查看以往的经营回顾</summary><div className="mt-4"><BusinessReportHistory reports={salesReports} latestId={real.latestReport?.id ?? null} /></div></details> : null}

      <details className="group rounded-2xl border border-border bg-card p-4 sm:p-5">
        <summary className="cursor-pointer list-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-base font-semibold text-slate-100">商品、推广和答疑准备得怎么样</span>
              <span className="mt-1 block text-sm font-normal text-slate-400">看看哪些工作已经做好，哪些还可以补齐</span>
            </span>
            <span className="shrink-0 text-sm font-medium text-cyan-300 group-open:hidden">展开查看 ↓</span>
            <span className="hidden shrink-0 text-sm font-medium text-cyan-300 group-open:inline">收起 ↑</span>
          </span>
        </summary>
        <div className="mt-5 space-y-5 border-t border-white/10 pt-5">
          <WorkPreparationSummary snapshot={real.snapshot} />
          {reportsDegraded ? <ModuleUnavailable title="AI 整理的工作建议" reason={reportsDegraded.reason} /> : <BusinessReportSection latestReport={real.latestReport} state={real.reportState} />}
          <details className="rounded-xl border border-border bg-muted/40 p-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-200">查看问题分类与详细记录</summary>
            <p className="mt-2 text-xs text-slate-400">想了解哪些问题常被问到，或核对统计数字时再展开。</p>
            <div className="mt-4 space-y-4">
              <DistributionPanel snapshot={real.snapshot} liveUnavailableReason={liveDegraded?.reason ?? null} />
              <SystemMetricsPanel snapshot={real.snapshot} unavailableMetricPrefixes={liveDegraded ? ["live."] : []} />
              <AgentEfficiencyPanel agents={real.snapshot.agents} />
            </div>
          </details>
        </div>
      </details>
    </>
  );
}

"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, Check, ChevronDown, Download, FileText, Lightbulb, ListChecks, Package, TriangleAlert, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { salesReviewActionLink } from "@/lib/sales-review-links";
import { sanitizeUserFacingText } from "@/lib/user-facing-text";
import { cn } from "@/lib/utils";
import type { SalesReview, SalesReviewAction, SalesReviewInsight, SalesReviewMode, SalesReviewSnapshot } from "@/types";

const money = (cents: number) => `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SalesAdviceReport({ mode, snapshot, review, stale, createdAt, onDownload }: {
  mode: SalesReviewMode;
  snapshot: SalesReviewSnapshot;
  review: SalesReview;
  stale: boolean;
  createdAt: string;
  onDownload: () => void;
}) {
  const actions = [...review.actions].sort((a, b) => a.priority - b.priority);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="px-2.5 py-1 text-xs" variant={mode === "demo" ? "warning" : "soft"}>{mode === "demo" ? "演示记录分析" : "商户记录分析"}</Badge>
          <Badge className="px-2.5 py-1 text-xs" variant={review.isMock ? "warning" : "info"}>{review.isMock ? "演示模型建议" : "AI 分析"}</Badge>
          <span className="text-xs text-slate-300">基于 {snapshot.summary.count} 条销售记录</span>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs leading-5 text-slate-300">
          {snapshot.dateRange ? <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5 text-cyan-300/80" />销售日期：{snapshot.dateRange.start === snapshot.dateRange.end ? snapshot.dateRange.start : `${snapshot.dateRange.start} 至 ${snapshot.dateRange.end}`}</span> : null}
          <span>建议更新于 {createdAt}</span>
        </div>
      </div>

      {stale ? <div role="status" className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3"><TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" /><div><p className="text-sm font-semibold text-foreground">这份建议需要更新</p><p className="mt-1 text-sm leading-6 text-slate-300">销售记录或统计日期已变化，下方保留的是上次分析。请点击上方按钮，更新后再参考。</p></div></div> : null}

      <section aria-label="销售重点" className="space-y-3">
        <h4 className="text-base font-semibold text-white">{stale ? "上次分析的销售重点" : "先看这几个重点"}</h4>
        <SalesHighlights snapshot={snapshot} />
        <details className="group rounded-xl border border-border bg-muted/40">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-cyan-100 [&::-webkit-details-marker]:hidden"><span className="inline-flex items-center gap-2"><FileText className="size-4 text-cyan-300" />查看完整 AI 分析</span><ChevronDown className="size-4 shrink-0 text-slate-300 transition-transform group-open:rotate-180" /></summary>
          <div className="space-y-3 border-t border-white/10 px-4 py-4 text-sm leading-7 text-slate-200">{sanitizeUserFacingText(review.summary).split(/(?<=[。！？])\s*/u).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
        </details>
      </section>

      <section aria-label="接下来可以这样做" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="inline-flex items-center gap-2 text-base font-semibold text-white"><ListChecks className="size-4 text-cyan-300" />接下来可以这样做</h4><p className="text-xs text-slate-300">按优先顺序，先从第 1 件事开始</p></div>
        <ol className={cn("grid gap-4", actions.length === 2 && "lg:grid-cols-2", actions.length >= 3 && "lg:grid-cols-3")}>
          {actions.map((action, index) => <ActionCard key={action.priority} action={action} snapshot={snapshot} first={index === 0} position={index + 1} />)}
        </ol>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <InsightGroup title="值得继续做的事" items={review.opportunities} snapshot={snapshot} />
        <InsightGroup title="需要留意的事" items={review.watchouts} snapshot={snapshot} warning />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4"><p className="max-w-3xl text-xs leading-6 text-slate-300">建议用于安排下一步；销售变化的原因和未录入费用，还需结合实际核对。</p><Button variant="outline" onClick={onDownload} className="shrink-0"><Download />下载经营回顾</Button></div>
    </div>
  );
}

/** 重点数字取自建议保存的快照，旧建议不会混入当前的新数据。 */
function SalesHighlights({ snapshot }: { snapshot: SalesReviewSnapshot }) {
  const { summary } = snapshot;
  const topProduct = summary.byProduct[0];
  const share = topProduct && summary.revenueCents > 0 ? (topProduct.revenueCents / summary.revenueCents * 100).toFixed(1) : null;
  const missingCosts = summary.missingCostCount > 0;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="min-w-0 rounded-xl border border-border bg-muted/40 p-4">
        <p className="flex items-center gap-2 text-sm text-cyan-100"><Wallet className="size-4 text-cyan-300" />已记录实收</p>
        <p className="mt-3 text-2xl font-semibold text-white tabular-nums">{money(summary.revenueCents)}</p>
        <p className="mt-2 text-xs leading-5 text-slate-300">{summary.count} 条记录 · 售出 {summary.quantity} 件 · {summary.byChannel.length} 个渠道</p>
      </div>
      <div className="min-w-0 rounded-xl border border-border bg-muted/40 p-4">
        <p className="flex items-center gap-2 text-sm text-blue-100"><Package className="size-4 text-blue-300" />实收最多的商品</p>
        <p className="mt-3 text-lg leading-7 font-semibold break-words text-white">{topProduct?.name ?? "暂无商品记录"}</p>
        <p className="mt-2 text-xs leading-5 text-slate-300">{topProduct ? `${money(topProduct.revenueCents)}${share !== null ? ` · 占已记录实收 ${share}%` : ""}` : "添加销售记录后即可比较"}</p>
      </div>
      <div className="min-w-0 rounded-xl border border-border bg-muted/40 p-4">
        <p className="flex items-center gap-2 text-sm text-slate-100">{missingCosts ? <TriangleAlert className="size-4 text-amber-200" /> : <Check className="size-4 text-cyan-300" />}{missingCosts ? "需要补齐的成本" : "毛利估算"}</p>
        <p className={cn("mt-3 text-2xl font-semibold tabular-nums", missingCosts ? "text-amber-100" : "text-white")}>{missingCosts ? <>{summary.missingCostCount}<span className="ml-1.5 text-sm font-normal">条记录</span></> : summary.grossProfitCents !== null ? money(summary.grossProfitCents) : "暂不能计算"}</p>
        <p className="mt-2 text-xs leading-5 text-slate-300">{missingCosts ? "补齐后，才能计算整批毛利" : "实收减去录入成本，不含其他费用"}</p>
      </div>
    </div>
  );
}

function ActionCard({ action, snapshot, first, position }: { action: SalesReviewAction; snapshot: SalesReviewSnapshot; first: boolean; position: number }) {
  const link = salesReviewActionLink(action, snapshot);
  const steps = sanitizeUserFacingText(action.steps).split(/\s*(?:→|➜|⇒|\r?\n)\s*/u).filter(Boolean);
  return (
    <li className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl border bg-muted/40", first ? "border-primary/30" : "border-border")}>
      <div className="flex-1 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2"><span className="flex size-8 items-center justify-center rounded-lg border border-primary/20 bg-primary-soft text-sm font-semibold text-blue-200 tabular-nums">{String(position).padStart(2, "0")}</span><Badge variant={first ? "soft" : "secondary"}>{first ? "优先做" : "接着做"}</Badge></div>
        <h5 className="mt-3 text-base leading-7 font-semibold text-white">{sanitizeUserFacingText(action.title)}</h5>
        <p className="mt-2 text-sm leading-7 text-slate-200">{sanitizeUserFacingText(action.explanation)}</p>
        <details className="group mt-4 rounded-lg border border-border bg-muted/40">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-slate-100 [&::-webkit-details-marker]:hidden"><span>查看具体操作{steps.length > 1 ? <span className="ml-2 text-xs font-normal text-slate-300">{steps.length} 步</span> : null}</span><ChevronDown className="size-4 shrink-0 text-slate-300 transition-transform group-open:rotate-180" /></summary>
          <ol className="space-y-3 border-t border-white/10 p-3">{steps.map((step, index) => <li key={index} className="flex gap-2.5 text-sm leading-6 text-slate-200">{steps.length > 1 ? <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-300/10 text-[11px] text-blue-100">{index + 1}</span> : null}<span className="min-w-0 break-words">{step}</span></li>)}</ol>
        </details>
        <Evidence ids={action.evidenceIds} snapshot={snapshot} />
      </div>
      <div className="border-t border-border/70 px-4 py-3 sm:px-5"><Button asChild variant={first ? "default" : "outline"} className="h-10 w-full"><Link href={link.href}>{link.label}<ArrowUpRight className="size-4" /></Link></Button></div>
    </li>
  );
}

function Evidence({ ids, snapshot }: { ids: readonly string[]; snapshot: SalesReviewSnapshot }) {
  const facts = ids.map(id => snapshot.facts.find(fact => fact.id === id)).filter(fact => !!fact);
  if (!facts.length) return null;
  return (
    <details className="group mt-3 text-xs">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-1 font-medium text-cyan-200 hover:text-white [&::-webkit-details-marker]:hidden"><ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />查看数据依据<span className="font-normal text-slate-300">（{facts.length} 项）</span></summary>
      <dl className="mt-2 space-y-3 rounded-lg border border-border bg-muted/40 p-3">{facts.map(fact => <div key={fact.id}><dt className="text-xs font-medium text-blue-200">{fact.label}</dt><dd className="mt-1 text-sm leading-6 break-words text-slate-200">{sanitizeUserFacingText(fact.display)}</dd></div>)}</dl>
    </details>
  );
}

function InsightGroup({ title, items, snapshot, warning = false }: { title: string; items: readonly SalesReviewInsight[]; snapshot: SalesReviewSnapshot; warning?: boolean }) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-xl border border-border bg-muted/40">
      <h4 className="flex items-center gap-2 border-b border-white/10 px-4 py-3.5 text-base font-semibold text-white">{warning ? <TriangleAlert className="size-4 text-amber-200" /> : <Lightbulb className="size-4 text-cyan-300" />}{title}<span className="ml-auto rounded-full bg-white/5 px-2 py-0.5 text-xs font-normal text-slate-300">{items.length} 项</span></h4>
      <div className="divide-y divide-white/10 px-4">{items.length ? items.map((item, index) => <div key={`${item.title}-${index}`} className="py-4"><h5 className="text-sm leading-6 font-semibold text-slate-100">{sanitizeUserFacingText(item.title)}</h5><p className="mt-2 text-sm leading-7 text-slate-300">{sanitizeUserFacingText(item.explanation)}</p><Evidence ids={item.evidenceIds} snapshot={snapshot} /></div>) : <p className="py-4 text-sm leading-7 text-slate-300">{warning ? "这次没有特别需要提醒的问题，继续核对并记录销售即可。" : "这次没有额外的推广机会，先完成上方建议，再看看新的销售反馈。"}</p>}</div>
    </section>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { BarChart3, Pencil, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";

import { addDemoSalesAction, clearDemoSalesAction, deleteSaleRecordAction } from "@/actions/sales";
import { SectionCard } from "@/components/common/section-card";
import { SalesAIAdvice } from "./sales-ai-advice";
import type { BusinessReport, SaleRecord } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SalesInputWorkspace } from "./sales-input-workspace";
import { SaleEntryForm } from "./sale-entry-form";
import type { SalesOverview } from "@/services/sales.service";

const money = (cents: number) => `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function SalesPanel({ view, reports = [], generating = false, unavailableReason }: { view: SalesOverview; reports?: readonly BusinessReport[]; generating?: boolean; unavailableReason?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<SaleRecord | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"real" | "demo">("real");
  const showDemo = (mode === "demo" || view.real.count === 0) && view.demo.count > 0;
  const summary = showDemo ? view.demo : view.real;
  const records = showDemo ? view.demoRecords : view.realRecords;
  const { recentStart, previousStart, today } = view.comparisonWindows;
  const hasRecentRecords = summary.daily.some(day => day.date >= recentStart && day.date <= today);
  const hasPreviousRecords = summary.daily.some(day => day.date >= previousStart && day.date < recentStart);

  const names = [...new Set(view.realRecords.map(row => row.productName))];
  const channels = view.real.byChannel.map(row => row.name);
  function saved(message: string) { setMessage(message); setMode("real"); router.refresh(); }

  function loadDemo() {
    startTransition(async () => {
      const result = await addDemoSalesAction();
      setMessage(result.ok ? `演示记录已就绪，新增 ${result.data.inserted} 行。不会计入真实销售。` : result.error.message);
      if (result.ok) { setMode("demo"); router.refresh(); }
    });
  }

  function clearDemo() {
    if (!window.confirm("清除当前商户的演示销售记录？真实销售记录不会受影响。")) return;
    startTransition(async () => {
      const result = await clearDemoSalesAction();
      setMessage(result.ok ? `已清除 ${result.data.deleted} 行演示记录。` : result.error.message);
      if (result.ok) { setMode("real"); router.refresh(); }
    });
  }

  function removeRecord(id: string, recordNo: string) {
    if (!window.confirm(`删除销售记录「${recordNo}」？销售分析会随之更新。`)) return;
    startTransition(async () => {
      const result = await deleteSaleRecordAction(id);
      setMessage(result.ok ? (result.data.deleted ? "记录已删除。" : "记录已不存在，请刷新页面。") : result.error.message);
      if (result.ok) router.refresh();
    });
  }

  return (
    <SectionCard className="bg-[#112131]/80" title="销售记录与分析" description="把实收记清楚，看看哪些商品卖得好；演示数据单独展示。" icon={<BarChart3 className="size-4 text-cyan-300" />} action={<Badge variant={showDemo ? "warning" : "soft"}>{showDemo ? "演示数据" : "真实记录"}</Badge>}>
      <div className="space-y-5">
        <SalesInputWorkspace today={today} catalog={view.productOptions} names={names} channels={channels} existingNos={view.realRecords.map(row => row.recordNo)} onSaved={saved} />
        <div className="rounded-xl border border-border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-400">想先体验分析？</span>
            <Button size="sm" variant="outline" disabled={pending} onClick={loadDemo}>{view.demo.count > 0 ? "更新演示数据" : "载入演示销售数据"}</Button>
            {view.demo.count > 0 ? <Button size="sm" variant="ghost" disabled={pending} onClick={clearDemo}>清除演示数据</Button> : null}
            {view.real.count > 0 && view.demo.count > 0 ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode(showDemo ? "real" : "demo")}>{showDemo ? "查看真实记录" : "查看演示记录"}</Button> : null}
          </div>
          {message ? <p role="status" className="mt-2 text-xs text-cyan-200">{message}</p> : null}
        </div>

        {summary.count === 0 ? (
          <div className="rounded-xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-slate-300">还没有销售记录。先记下今天卖出的一笔，或粘贴已有表格，保存后就能看到商品和渠道表现。</div>
        ) : (
          <>
            {showDemo ? <p className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">以下为模拟销售数据，仅用于体验报表，不代表该商户的真实销售。</p> : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="已记录实收" value={money(summary.revenueCents)} hint={`共 ${summary.count} 条记录`} />
              <Metric label="最近 7 天实收" value={hasRecentRecords ? money(summary.recentSevenDaysCents) : "暂无记录"} hint={hasPreviousRecords ? `此前 7 天 ${money(summary.previousSevenDaysCents)}` : "此前 7 天无记录"} />
              <Metric label="已售件数" value={`${summary.quantity} 件`} hint="按已记录数量合计" />
              <Metric label="毛利估算" value={summary.grossProfitCents === null ? "成本未补齐" : money(summary.grossProfitCents)} hint={summary.missingCostCount ? `${summary.missingCostCount} 条记录缺少成本` : "实收减去录入成本；不含其他费用"} />
            </div>
            <SalesAIAdvice key={showDemo ? "demo" : "real"} mode={showDemo ? "demo" : "real"} fingerprint={view.fingerprints[showDemo ? "demo" : "real"]} count={summary.count} reports={reports} generating={generating} unavailableReason={unavailableReason} />
            <div className="rounded-xl border border-border bg-muted/40 p-4">
              <h3 className="text-sm font-semibold text-cyan-100">从记录里看到</h3>
              <ul className="mt-2 space-y-1.5 text-xs leading-5 text-slate-300">
                <li>{summary.byProduct[0] ? `已记录的销售中，${summary.byProduct[0].name} 的实收最高（${money(summary.byProduct[0].revenueCents)}）。` : "暂无商品记录。"}</li>
                <li>{summary.byChannel[0] ? `${summary.byChannel[0].name} 是目前记录实收最多的渠道（${money(summary.byChannel[0].revenueCents)}）。` : "暂无渠道记录。"}</li>
                <li>{hasRecentRecords && summary.previousSevenDaysCents > 0 ? `最近 7 天比此前 7 天${summary.recentSevenDaysCents >= summary.previousSevenDaysCents ? "多" : "少"} ${money(Math.abs(summary.recentSevenDaysCents - summary.previousSevenDaysCents))}；比较前请确认两段时间的记录都已导齐。` : "两段时间的记录不足，暂不判断销售变化。"}</li>
              </ul>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Breakdown title="哪些商品卖得多" items={summary.byProduct.slice(0, 5)} total={summary.revenueCents} />
              <Breakdown title="实收来自哪些渠道" items={summary.byChannel.slice(0, 5)} total={summary.revenueCents} />
            </div>
            <div className="rounded-xl border border-border bg-muted/40 p-4">
              <h3 className="text-sm font-semibold text-slate-100">有记录日期的实收变化</h3>
              <p className="mt-1 text-xs text-slate-400">只显示最近 14 个有记录的日期；没有记录的日期不按零销售处理。</p>
              <div className="mt-4 flex h-28 items-end gap-2 overflow-x-auto">
                {summary.daily.slice(-14).map((day) => {
                  const max = Math.max(...summary.daily.slice(-14).map((item) => item.revenueCents), 1);
                  return <div key={day.date} className="flex min-w-12 flex-1 flex-col items-center justify-end gap-1" title={`${day.date} ${money(day.revenueCents)}`}><span className="text-[10px] text-slate-300">{money(day.revenueCents)}</span><div className="w-full rounded-t-md bg-gradient-to-t from-blue-600 to-cyan-400" style={{ height: `${Math.max(8, day.revenueCents / max * 75)}px` }} /><span className="text-[10px] text-slate-400">{day.date.slice(5)}</span></div>;
                })}
              </div>
            </div>
            <details className="rounded-xl border border-border bg-muted/40 p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-100">查看销售明细（{records.length} 条）</summary>
              <div className="mt-3 max-h-80 overflow-auto">
                <table className="w-full min-w-[690px] text-left text-xs">
                  <thead className="sticky top-0 bg-popover text-slate-300"><tr><th className="p-2">日期 / 编号</th><th className="p-2">商品</th><th className="p-2">渠道</th><th className="p-2 text-right">数量</th><th className="p-2 text-right">实收</th><th className="p-2 text-right">成本</th><th className="p-2 text-right">操作</th></tr></thead>
                  <tbody>{records.map((row) => <tr key={row.id} className="border-t border-white/10 text-slate-200"><td className="p-2">{row.saleDate}<span className="block max-w-48 truncate text-slate-400" title={row.recordNo}>{row.recordNo.startsWith("MANUAL-") ? "随手记账" : row.recordNo.startsWith("IMPORT-") ? "表格录入" : row.recordNo}</span></td><td className="p-2">{row.productName}</td><td className="p-2">{row.channel}</td><td className="p-2 text-right">{row.quantity}</td><td className="p-2 text-right">{money(row.revenueCents)}</td><td className="p-2 text-right">{row.costCents === null ? "未填" : money(row.costCents)}</td><td className="p-2 text-right"><div className="inline-flex gap-3"><button type="button" disabled={pending} onClick={() => setEditing(row)} className="inline-flex items-center gap-1 text-cyan-200 hover:text-white disabled:opacity-50"><Pencil className="size-3" />编辑</button><button type="button" disabled={pending} onClick={() => removeRecord(row.id, row.recordNo)} className="inline-flex items-center gap-1 text-rose-300 hover:text-rose-200 disabled:opacity-50"><Trash2 className="size-3" />删除</button></div></td></tr>)}</tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-slate-400">金额填错或成本忘填，直接点「编辑」修改；保存后报表自动更新，旧 AI 建议会提示重新分析。</p>
            </details>
          </>
        )}
        <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null); }}><DialogContent className="max-w-3xl bg-popover"><DialogHeader><DialogTitle>修改销售记录</DialogTitle><DialogDescription>{editing?.isDemo ? "正在修改演示记录，不影响真实销售。" : "核对这一笔的日期、商品和实际收款，成本也可以在这里补齐。"}</DialogDescription></DialogHeader><DialogBody>{editing ? <SaleEntryForm key={editing.id} today={today} initial={editing} catalog={view.productOptions} names={names} channels={channels} onCancel={() => setEditing(null)} onSaved={message => { setEditing(null); setMessage(message); router.refresh(); }} /> : null}</DialogBody></DialogContent></Dialog>
      </div>
    </SectionCard>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="rounded-xl border border-border bg-muted/40 p-4"><p className="text-xs text-slate-300">{label}</p><p className="mt-2 text-xl font-semibold text-white tabular-nums">{value}</p><p className="mt-1 text-xs text-slate-400">{hint}</p></div>;
}

function Breakdown({ title, items, total }: { title: string; items: { name: string; revenueCents: number }[]; total: number }) {
  return <div className="rounded-xl border border-border bg-muted/40 p-4"><h3 className="text-sm font-semibold text-slate-100">{title}</h3><div className="mt-3 space-y-3">{items.map((item) => <div key={item.name}><div className="flex justify-between gap-2 text-xs text-slate-200"><span className="truncate">{item.name}</span><span className="tabular-nums">{money(item.revenueCents)}</span></div><div className="mt-1 h-1.5 rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${total > 0 ? Math.max(2, item.revenueCents / total * 100) : 0}%` }} /></div></div>)}</div></div>;
}

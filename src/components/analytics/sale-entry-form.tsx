"use client";

import { useId, useRef, useState, useTransition } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { saveSaleRecordsAction, updateSaleRecordAction } from "@/actions/sales";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { parseSaleDraft, yuan, type SaleDraft } from "@/lib/sales-entry";
import type { SaleRecord } from "@/types";

export interface SalesCatalogItem { name: string; price: number; unit: string }
export function SaleEntryForm({ today, catalog = [], names = [], channels = [], initial, onSaved, onCancel }: {
  today: string; catalog?: readonly SalesCatalogItem[]; names?: readonly string[]; channels?: readonly string[];
  initial?: SaleRecord; onSaved: (message: string) => void; onCancel?: () => void;
}) {
  const prefix = useId();
  const recordNo = useRef<string | null>(initial?.recordNo ?? null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [draft, setDraft] = useState<Omit<SaleDraft, "recordNo">>({
    saleDate: initial?.saleDate ?? today, productName: initial?.productName ?? "", channel: initial?.channel ?? "线下", quantity: String(initial?.quantity ?? 1),
    revenue: initial ? yuan(initial.revenueCents) : "", cost: initial?.costCents == null ? "" : yuan(initial.costCents),
  });
  const selected = catalog.find(item => item.name === draft.productName);
  const estimate = selected && Number(draft.quantity) > 0 ? Math.round(selected.price * 100) * Number(draft.quantity) : null;
  const field = (key: keyof typeof draft, value: string) => { setDraft(prev => ({ ...prev, [key]: value })); setError(""); setSuccess(""); };

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    recordNo.current ??= `MANUAL-${crypto.randomUUID()}`;
    const parsed = parseSaleDraft({ ...draft, recordNo: recordNo.current });
    if (!parsed.ok) { setError(parsed.errors.map(text => text.replace(/^第 2 行：/, "")).join("；")); return; }
    setError(""); setSuccess("");
    startTransition(async () => {
      try {
        const row = parsed.rows[0];
        const { recordNo: _recordNo, ...changes } = row;
        void _recordNo;
        const result = initial ? await updateSaleRecordAction(initial.id, changes) : await saveSaleRecordsAction([row]);
        if (!result.ok) { setError(result.error.message); return; }
        const repeated = "inserted" in result.data && result.data.inserted === 0;
        const message = initial ? "销售记录已修改，报表会按最新记录更新。" : repeated ? "这笔记录之前已经保存，请在销售明细中核对或编辑。" : "这笔销售已保存，可以继续记下一笔。";
        if (!initial) {
          recordNo.current = null;
          setDraft(prev => ({ ...prev, quantity: "1", revenue: "", cost: "" }));
          setSuccess(message);
        }
        onSaved(message);
      } catch { setError("保存没有完成，请重试。重新提交同一笔不会重复记账。"); }
    });
  }

  return <form onSubmit={submit} className="space-y-4">
    <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 disabled:opacity-70">
      <Field label="销售日期" id={`${prefix}-date`}><Input id={`${prefix}-date`} type="date" required value={draft.saleDate} onChange={event => field("saleDate", event.target.value)} /></Field>
      <Field label="卖了什么" id={`${prefix}-product`}><Input id={`${prefix}-product`} list={`${prefix}-products`} required maxLength={100} placeholder="选择已有商品，也可以直接填写" value={draft.productName} onChange={event => field("productName", event.target.value)} /><datalist id={`${prefix}-products`}>{[...new Set([...catalog.map(item => item.name), ...names])].map(name => <option key={name} value={name} />)}</datalist></Field>
      <Field label="在哪卖的" id={`${prefix}-channel`}><Input id={`${prefix}-channel`} list={`${prefix}-channels`} required maxLength={40} value={draft.channel} onChange={event => field("channel", event.target.value)} /><datalist id={`${prefix}-channels`}>{[...new Set(["线下", "微信", "抖音", "小红书", "视频号", ...channels])].map(name => <option key={name} value={name} />)}</datalist></Field>
      <Field label="卖出数量" id={`${prefix}-quantity`}><Input id={`${prefix}-quantity`} type="number" min="1" max="100000" step="1" required value={draft.quantity} onChange={event => field("quantity", event.target.value)} /></Field>
      <Field label="实际收到多少钱（元）" id={`${prefix}-revenue`}><Input id={`${prefix}-revenue`} inputMode="decimal" required maxLength={12} placeholder="填这一笔的总实收" value={draft.revenue} onChange={event => field("revenue", event.target.value)} />{estimate !== null && estimate > 0 && estimate <= 99_999_999 ? <button type="button" className="mt-1 text-[11px] text-cyan-200 hover:text-white" onClick={() => field("revenue", yuan(estimate))}>按商品档案价格填写 ¥{yuan(estimate)}，可再修改</button> : null}</Field>
      <Field label="这笔商品成本（元，选填）" id={`${prefix}-cost`}><Input id={`${prefix}-cost`} inputMode="decimal" maxLength={12} placeholder="暂不清楚可以先留空" value={draft.cost} onChange={event => field("cost", event.target.value)} /></Field>
    </fieldset>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4"><p className="text-xs leading-5 text-slate-400">按实际收款填写总金额，成本以后也可以补上。</p><div className="flex gap-2">{onCancel ? <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>取消</Button> : null}<Button type="submit" size="sm" disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Save />}{pending ? "正在保存…" : initial ? "保存修改" : "保存这笔销售"}</Button></div></div>
    {error ? <p role="alert" className="rounded-lg border border-rose-300/20 bg-rose-300/10 p-3 text-xs leading-5 text-rose-200">{error}</p> : null}
    {success ? <p role="status" className="flex items-center gap-2 text-xs text-cyan-200"><Check className="size-4" />{success}</p> : null}
  </form>;
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><label htmlFor={id} className="mb-1.5 block text-xs font-medium text-slate-200">{label}</label>{children}</div>;
}

"use client";

import { useRouter } from "next/navigation";
import { Lightbulb, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { generateSalesReviewAction } from "@/actions/analytics";
import { SalesAdviceReport } from "./sales-advice-report";
import { Button } from "@/components/ui/button";
import { salesReviewErrorMessage } from "@/lib/sales-review-error";
import { sanitizeUserFacingText } from "@/lib/user-facing-text";
import type { BusinessReport, SalesReviewMode } from "@/types";

export function SalesAIAdvice({ mode, fingerprint, count, reports, generating = false, unavailableReason }: {
  mode: SalesReviewMode;
  fingerprint: string;
  count: number;
  reports: readonly BusinessReport[];
  generating?: boolean;
  unavailableReason?: string;
}) {
  const router = useRouter();
  const [localReport, setLocalReport] = useState<BusinessReport | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const latest = localReport ?? reports.find(item => item.snapshot.sales?.mode === mode && item.report.salesReview) ?? null;
  const snapshot = latest?.snapshot.sales;
  const review = latest?.report.salesReview;
  const stale = !!snapshot && snapshot.fingerprint !== fingerprint;
  const busy = pending || generating;

  function generate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateSalesReviewAction(mode);
        if (result.ok) setLocalReport(result.data.report);
        else setError(salesReviewErrorMessage(result.error));
      } catch { setError("这次没有完成分析，请稍后重试。已有建议仍然保留。"); }
      router.refresh();
    });
  }

  function download() {
    if (!review || !snapshot || !latest) return;
    const text = [
      `海创Buddy · ${mode === "demo" ? "演示销售" : "商户销售"}经营回顾`,
      `生成时间：${latest.createdAt}`, review.isMock ? "演示模型输出，用于体验流程" : "AI 建议，请结合实际情况判断", stale ? "销售记录已变化：以下为上次保存的分析" : "",
      "", "销售摘要", review.summary, "", "建议依据", ...snapshot.facts.map(fact => `${fact.label}：${fact.display}`),
      "", "接下来可以做", ...review.actions.map(action => `${action.priority}. ${action.title}\n${action.explanation}\n${action.steps}`),
      "", "准备工作回顾", latest.report.executiveSummary,
    ].join("\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `海创Buddy-${mode === "demo" ? "演示" : "销售"}经营回顾.txt`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section aria-label="AI 销售建议" className="overflow-hidden rounded-2xl border border-white/10 bg-[#112131]/80 text-card-foreground backdrop-blur-md">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-4 py-5 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary-soft"><Sparkles className="size-5 text-primary" /></span>
          <div><h3 className="text-base font-semibold tracking-wide text-white">AI 帮你看销售，想下一步</h3><p className="mt-1 text-sm leading-5 text-slate-300">依据当前{mode === "demo" ? "演示" : "销售"}记录，看清重点，再选下一步</p></div>
        </div>
        <Button className="h-10 max-sm:w-full" disabled={busy || count === 0 || !!unavailableReason} aria-busy={busy} onClick={generate}>
          {busy ? <Loader2 className="animate-spin" /> : review ? <RefreshCw /> : <Sparkles />}{busy ? "正在分析销售…" : stale ? "按最新记录更新建议" : review ? "更新销售建议" : "生成 AI 销售建议"}
        </Button>
      </header>
      <div className="space-y-5 p-4 sm:p-6">
        {error ? <p role="alert" className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100">{sanitizeUserFacingText(error)}</p> : null}
        {unavailableReason ? <p className="text-sm leading-6 text-slate-200">{unavailableReason}</p> : null}
        {busy ? <p role="status" className="flex items-center gap-2 text-sm leading-6 text-cyan-200"><Loader2 className="size-4 animate-spin" />正在核对商品、渠道与成本，整理销售和准备工作建议…</p> : null}
        {review && snapshot ? (
          <SalesAdviceReport mode={mode} snapshot={snapshot} review={review} stale={stale} createdAt={latest!.createdAt} onDownload={download} />
        ) : !busy ? (
          <div className="flex items-start gap-3 rounded-xl border border-dashed border-white/15 p-4"><Lightbulb className="mt-1 size-5 shrink-0 text-cyan-300" /><div><p className="text-base font-medium text-slate-100">{count ? "让这些数字变成下一步行动" : "先有销售记录，再听听 AI 的建议"}</p><p className="mt-2 text-sm leading-7 text-slate-300">{count ? "点击上方按钮，看看哪些商品值得推广、哪个渠道可以继续尝试，以及成本和记录哪里需要补齐。" : "记一笔销售、导入现有流水，或载入演示数据体验完整复盘。"}</p></div></div>
        ) : null}
      </div>
    </section>
  );
}

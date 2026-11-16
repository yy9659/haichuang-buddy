import type { Metadata } from "next";
import Link from "next/link";
import { DataFallback } from "@/components/common/data-fallback";
import { PageHeader } from "@/components/common/page-header";
import { ArenaWorkspace } from "@/components/live/arena-workspace";
import { readParam, type RawSearchParams } from "@/lib/search-params";
import { loadArenaWorkflowAdvice, loadArenaWorkspace } from "@/services/live-arena.service";

export const metadata: Metadata = { title: "直播导演 · 海创Buddy" };

export default async function LivePage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const params = await searchParams;
  const suggestionId = readParam(params, "suggestionId");
  const [arena, advice] = await Promise.all([
    loadArenaWorkspace(),
    suggestionId ? loadArenaWorkflowAdvice(suggestionId) : null,
  ]);

  if (!arena.ok) return (
    <>
      <PageHeader title="直播导演" />
      <DataFallback title="未能打开训练工作区" description={arena.error.message} />
      <Link className="text-sm text-primary underline" href="/live">刷新重试</Link>
    </>
  );

  return (
    <ArenaWorkspace initial={arena.data} preferredProductId={readParam(params, "productId") || advice?.productId}>
      {suggestionId && <details className="rounded-2xl border border-border bg-card p-4 text-sm" open={!!advice}>
        <summary className="cursor-pointer font-semibold">工作台备播建议</summary>
        {advice ? <div className="mt-3 space-y-2">
          <p className="text-muted-foreground">{advice.suggestion.commentContent}</p>
          <p>{advice.suggestion.suggestedReply || advice.suggestion.hostSuggestion}</p>
          {advice.suggestion.suggestedReply && advice.suggestion.hostSuggestion && <p className="text-xs text-muted-foreground">{advice.suggestion.hostSuggestion}</p>}
          {advice.suggestion.riskNotes.length > 0 && <p className="text-xs text-muted-foreground">待核对：{advice.suggestion.riskNotes.join("；")}</p>}
          {advice.suggestion.citations.length ? <ul className="space-y-1 text-xs text-muted-foreground">
            {advice.suggestion.citations.map((citation) => <li key={citation.id}>{citation.title}：{citation.snippet}</li>)}
          </ul> : <p className="text-xs text-muted-foreground">此建议未引用知识片段，请先核对商品资料。</p>}
        </div> : <p className="mt-3 text-muted-foreground">该建议已不可用，仍可使用下方的实战演练。</p>}
      </details>}
    </ArenaWorkspace>
  );
}

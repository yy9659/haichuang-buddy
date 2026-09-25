import { Database, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { KNOWLEDGE_TYPE_LABEL } from "@/lib/status-meta";
import type { KnowledgeGap, KnowledgeSource } from "@/types";

/** 知识库概览 + 缺失知识提醒 */
export function KnowledgePanel({
  sources,
  gaps,
}: {
  sources: KnowledgeSource[];
  gaps: KnowledgeGap[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-border bg-card p-3.5 shadow-card">
        <div className="flex items-center gap-2">
          <Database className="size-3.5 text-primary" />
          <span className="text-[12px] font-semibold">知识库来源</span>
          <Badge variant="secondary" className="ml-auto">
            {sources.length} 条
          </Badge>
        </div>
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {sources.map((source) => (
            <li
              key={source.id}
              className="flex items-start gap-2 rounded-lg bg-muted/60 px-2.5 py-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[12px] font-medium">
                  {source.title}
                </span>
                <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {source.snippet}
                </span>
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {(source.score * 100).toFixed(0)}%
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-2.5 flex flex-wrap gap-1">
          {Array.from(new Set(sources.map((source) => source.type))).map(
            (type) => (
              <Badge key={type} variant="soft">
                {KNOWLEDGE_TYPE_LABEL[type]}
              </Badge>
            ),
          )}
        </div>
      </div>

      <div className="rounded-xl border border-warning/25 bg-warning/12 p-3.5">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-3.5 text-warning" />
          <span className="text-[12px] font-semibold text-warning">
            知识缺口提醒
          </span>
          <Badge variant="warning" className="ml-auto">
            {gaps.length} 项
          </Badge>
        </div>
        <ul className="mt-2.5 flex flex-col gap-2">
          {gaps.map((gap) => (
            <li key={gap.id} className="flex flex-col gap-0.5">
              <span className="text-[12px] leading-5 font-medium text-warning">
                {gap.question}
              </span>
              <span className="text-[11px] leading-4 text-warning/80">
                近 7 天被询问 {gap.askedCount} 次 · {gap.suggestion}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

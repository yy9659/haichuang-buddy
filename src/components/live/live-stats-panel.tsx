"use client";

import { MessageSquarePlus, Send } from "lucide-react";
import * as React from "react";

import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { LIVE_INTENT_META, LIVE_PRIORITY_META } from "@/lib/status-meta";
import { cn, formatNumber } from "@/lib/utils";
import type { LiveComment, LiveStats } from "@/types";

interface LiveStatsPanelProps {
  stats: LiveStats;
  comments: LiveComment[];
}

/** 左栏：直播数据 + 实时评论流 */
export function LiveStatsPanel({ stats, comments }: LiveStatsPanelProps) {
  const [draft, setDraft] = React.useState("");
  const [localComments, setLocalComments] = React.useState<LiveComment[]>([]);

  const allComments = [...localComments, ...comments];

  const handleSend = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (content.length === 0) return;

    setLocalComments((prev) => [
      {
        id: `local_${prev.length + 1}`,
        user: "主播手动录入",
        content,
        createdAtText: "刚刚",
        intent: "other",
        priority: "medium",
        handled: false,
      },
      ...prev,
    ]);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {[
          { id: "online", label: "在线人数", value: formatNumber(stats.onlineCount) },
          { id: "likes", label: "点赞", value: formatNumber(stats.likes) },
          { id: "comments", label: "评论", value: formatNumber(stats.comments) },
          { id: "questions", label: "提问", value: formatNumber(stats.questions) },
        ].map((item) => (
          <div
            key={item.id}
            className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-2.5 py-2 shadow-card"
          >
            <span className="text-[11px] text-muted-foreground">
              {item.label}
            </span>
            <span className="text-[15px] leading-6 font-semibold tabular-nums">
              {item.value}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          直播互动率（程序计算）
        </span>
        <span className="text-[13px] font-semibold text-primary tabular-nums">
          {(stats.engagementRate * 100).toFixed(2)}%
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card shadow-card">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
            <MessageSquarePlus className="size-3.5 text-primary" />
            实时评论
          </span>
          <Badge variant="secondary">{allComments.length} 条</Badge>
        </div>

        <ScrollArea className="min-h-56 flex-1" viewportClassName="px-3 py-2">
          {allComments.length === 0 ? (
            <EmptyState title="暂无评论" description="等待观众进入直播间。" />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {allComments.map((comment) => {
                const intentMeta = LIVE_INTENT_META[comment.intent];
                const priorityMeta = LIVE_PRIORITY_META[comment.priority];
                return (
                  <li key={comment.id} className="flex gap-2">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-[10px] font-medium text-blue-700">
                      {comment.user.slice(0, 1)}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11px] text-muted-foreground">
                          {comment.user}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {comment.createdAtText}
                        </span>
                      </div>
                      <p className="text-[12px] leading-5">{comment.content}</p>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge
                          variant={intentMeta.tone}
                          className="px-1.5 py-0 text-[10px]"
                        >
                          {intentMeta.label}
                        </Badge>
                        {comment.priority === "high" ? (
                          <Badge
                            variant={priorityMeta.tone}
                            className="px-1.5 py-0 text-[10px]"
                          >
                            {priorityMeta.label}
                          </Badge>
                        ) : null}
                        <span
                          className={cn(
                            "text-[10px]",
                            comment.handled
                              ? "text-success"
                              : "text-muted-foreground",
                          )}
                        >
                          {comment.handled ? "AI 已响应" : "待响应"}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <form
          onSubmit={handleSend}
          className="flex items-center gap-2 border-t border-border/70 p-2.5"
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="手动录入一条观众评论…"
            aria-label="录入评论"
            className="bg-muted/60"
          />
          <button
            type="submit"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
            aria-label="发送评论"
          >
            <Send className="size-4" />
          </button>
        </form>
      </div>
    </div>
  );
}

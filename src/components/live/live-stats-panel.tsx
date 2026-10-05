"use client";

/**
 * 左栏：直播数据 + 实时评论流（客户端组件）
 *
 * 这一栏是**观众声音的入口**：主播（或演示者）在这里录入 / 点选一条评论，
 * 它会真正走 `submitLiveCommentAction → Live Service → Live Agent`，
 * AI 建议落到右栏。因此这里只负责「把评论交出去」，绝不本地伪造成一条建议。
 *
 * 数据的两条边界（任务书第四十二 / 四十三节）在文案上写死：
 * - 在线人数 / 点赞 / 涨粉等**模拟指标** -> 明确标注「模拟数据」；
 * - 评论数 / AI 处理数等**真实指标** -> 标注「实时计算」，数字来自服务端。
 * 两者共用一套卡片样式，但各自带来源标注，绝不让人误以为在线人数是真的。
 *
 * 失败处理沿用客服会话的约定（第十二 / 三十五节）：
 * - `!ok`（评论为空 / 过长 / 直播已结束）-> 一个字节都没落库，**保留输入内容**；
 * - `ok + failure`（评论已落库、AI 这次没答上来）-> **清空输入框**并显示可重试提示。
 */

import { useRouter } from "next/navigation";
import { CircleAlert, Loader2, MessageSquarePlus, Send } from "lucide-react";
import * as React from "react";

import { submitLiveCommentAction } from "@/actions/live";
import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LIVE_INTENT_META, LIVE_PRIORITY_META } from "@/lib/status-meta";
import { cn, formatNumber } from "@/lib/utils";
import type { AppErrorShape } from "@/lib/result";
import {
  MAX_LIVE_COMMENT_LENGTH,
  type LiveComment,
  type LiveRealMetrics,
  type LiveSession,
} from "@/types";

interface LiveStatsPanelProps {
  session: LiveSession;
  /** **真实**指标（实时计算） */
  realMetrics: LiveRealMetrics;
  comments: LiveComment[];
  quickComments: readonly string[];
}

const PRIORITY_ORDER: Record<"high" | "medium" | "low", number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** 评论流排序：高优先级在前，同优先级按录入顺序（新评论由服务端追加在末尾） */
function sortComments(comments: readonly LiveComment[]): LiveComment[] {
  return [...comments].sort((left, right) => {
    const leftRank = left.priority ? PRIORITY_ORDER[left.priority] : 3;
    const rightRank = right.priority ? PRIORITY_ORDER[right.priority] : 3;
    return leftRank - rightRank;
  });
}

export function LiveStatsPanel({
  session,
  realMetrics,
  comments,
  quickComments,
}: LiveStatsPanelProps) {
  const router = useRouter();
  const [draft, setDraft] = React.useState("");
  const [isPending, startTransition] = React.useTransition();
  /** 硬错误：评论**没有**落库 */
  const [rejected, setRejected] = React.useState<AppErrorShape | null>(null);
  /** 软失败：评论**已经**落库，只是 AI 没能产出建议 */
  const [aiFailure, setAiFailure] = React.useState<AppErrorShape | null>(null);

  const trimmed = draft.trim();
  const tooLong = trimmed.length > MAX_LIVE_COMMENT_LENGTH;
  const canSend = !isPending && trimmed.length > 0 && !tooLong;
  const isLive = session.status === "live";

  const ordered = React.useMemo(() => sortComments(comments), [comments]);

  function submit(content: string): void {
    setRejected(null);
    setAiFailure(null);
    startTransition(async () => {
      const result = await submitLiveCommentAction({
        sessionId: session.id,
        content,
      });

      if (!result.ok) {
        // 一个字节都没写进库 —— 保留输入内容，让主播能直接改一改再发
        setRejected(result.error);
        router.refresh();
        return;
      }

      // 评论已落库：清空输入框，避免以为没发出去而重复发送
      setDraft("");
      if (result.data.failure) {
        setAiFailure(result.data.failure);
      }
      router.refresh();
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSend) {
      return;
    }
    submit(trimmed);
  }

  const realItems = [
    { id: "comment-count", label: "本场评论", value: realMetrics.commentCount },
    { id: "ai-handled", label: "AI 已处理", value: realMetrics.aiHandledCount },
    { id: "high", label: "高优先级", value: realMetrics.highPriorityCount },
    { id: "grounded", label: "有知识依据", value: realMetrics.groundedCount },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 只展示本场录入与处理记录，不展示没有平台来源的在线人数或点赞。 */}
      <div className="rounded-xl border border-primary/20 bg-primary-soft/40 p-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium text-primary">
            本场彩排记录
          </span>
          <Badge variant="info" className="px-1.5 py-0 text-[10px]">
            系统记录
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {realItems.map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-0.5 rounded-lg bg-card/70 px-2.5 py-1.5"
            >
              <span className="text-[10px] text-muted-foreground">
                {item.label}
              </span>
              <span className="text-[15px] leading-5 font-semibold tabular-nums">
                {formatNumber(item.value)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 评论流 */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card shadow-card">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
            <MessageSquarePlus className="size-3.5 text-primary" />
            模拟问题
          </span>
          <Badge variant="secondary">{ordered.length} 条</Badge>
        </div>

        <ScrollArea className="min-h-48 flex-1" viewportClassName="px-3 py-2">
          {ordered.length === 0 ? (
            <EmptyState title="还没有问题" description="录入一个常见顾客问题，练习现场回应。" />
          ) : (
            <ul className="flex flex-col gap-2.5">
              {ordered.map((comment) => {
                const intentMeta = comment.intent
                  ? LIVE_INTENT_META[comment.intent]
                  : null;
                const priorityMeta = comment.priority
                  ? LIVE_PRIORITY_META[comment.priority]
                  : null;
                return (
                  <li key={comment.id} className="flex gap-2">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-[10px] font-medium text-blue-700">
                      {comment.authorName.slice(0, 1)}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11px] text-muted-foreground">
                          {comment.authorName}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {comment.createdAtText}
                        </span>
                      </div>
                      <p className="text-[12px] leading-5">{comment.content}</p>
                      <div className="flex flex-wrap items-center gap-1">
                        {intentMeta ? (
                          <Badge
                            variant={intentMeta.tone}
                            className="px-1.5 py-0 text-[10px]"
                          >
                            {intentMeta.label}
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="px-1.5 py-0 text-[10px]"
                          >
                            待分析
                          </Badge>
                        )}
                        {priorityMeta && comment.priority === "high" ? (
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

        {/* 录入区 */}
        <div className="border-t border-border/70 p-2.5">
          {rejected ? (
            <p
              role="alert"
              className="mb-2 flex items-start gap-1.5 rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-1.5 text-[11px] leading-4 text-destructive"
            >
              <CircleAlert className="mt-0.5 size-3 shrink-0" />
              <span>{rejected.message}</span>
            </p>
          ) : null}

          {aiFailure ? (
            <p
              role="alert"
              className="mb-2 flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/12 px-2.5 py-1.5 text-[11px] leading-4 text-warning"
            >
              <CircleAlert className="mt-0.5 size-3 shrink-0" />
              <span>
                问题已记录，但 AI 这次没能给出建议（
                {aiFailure.message}）。可稍后重试。
              </span>
            </p>
          ) : null}

          {!isLive ? <p className="text-[12px] text-muted-foreground">本场彩排已结束。可以回看问题，重新开始后再录入新问题。</p> : <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="录入顾客可能会问的问题…"
              aria-label="录入模拟问题"
              disabled={isPending}
              maxLength={MAX_LIVE_COMMENT_LENGTH * 2}
              className="bg-muted/60"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
              aria-label="提交模拟问题"
            >
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </button>
          </form>}

          {isLive ? <div className="mt-2 flex flex-wrap gap-1.5">
            {quickComments.map((text) => (
              <button
                key={text}
                type="button"
                disabled={isPending}
                onClick={() => setDraft(text)}
                className="rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
              >
                {text}
              </button>
            ))}
          </div> : null}

          {isLive ? <p className="mt-1.5 text-[10px] text-muted-foreground">
            {isPending
              ? "AI 直播导演正在分析这条评论…"
              : "可从上方快捷问题选取，或自行输入。"}
          </p> : null}
        </div>
      </div>
    </div>
  );
}

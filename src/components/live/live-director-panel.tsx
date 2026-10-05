"use client";

/**
 * 右栏：AI 直播导演（客户端组件）
 *
 * 四个页签各回答一个问题：
 * - **实时建议**：这条评论是什么、要不要回、主播现在说什么（含风险提示与失败态）；
 * - **异议处理**：把「价格 / 售后」这类需要当场化解的评论单独抽出来；
 * - **热点问题**：本场观众反复在问什么（占比由程序算，绝不让模型编百分比，§28）；
 * - **知识依据**：每条建议引用了哪些知识片段 —— 没有依据的会如实标出来（§13/§14）。
 *
 * 两个必须如实呈现的边界：
 * 1. `failureMessage !== null` 的条目是**AI 处理失败**留下的记录：评论还在，
 *    但这一条没有建议。它必须显示成「暂时不可用」，而不是伪装成一条空建议（§34）。
 * 2. `grounded === false` 不代表「错」，而是「本次没有知识库依据」——
 *    营销型评论本来就靠 Product DNA 发挥，界面要说清这个区别，不能一律打上警告。
 */

import { BookOpen, CircleAlert, Flame, Lightbulb, Loader2, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { retryLiveCommentAction } from "@/actions/live";
import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LIVE_ACTION_LABEL,
  LIVE_INTENT_META,
  LIVE_PRIORITY_META,
  LIVE_RESPONSE_MODE_META,
} from "@/lib/status-meta";
import type { LiveHotTopic, LiveSuggestion } from "@/types";

interface LiveDirectorPanelProps {
  suggestions: LiveSuggestion[];
  hotTopics: LiveHotTopic[];
}

/** 需要当场化解的评论（异议 / 价格 / 售后） */
const OBJECTION_INTENTS = new Set(["objection", "price_question", "after_sale"]);

export function LiveDirectorPanel({
  suggestions,
  hotTopics,
}: LiveDirectorPanelProps) {
  const router = useRouter();
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<{ commentId: string; message: string } | null>(null);
  const [retriedSuggestions, setRetriedSuggestions] = React.useState<Record<string, LiveSuggestion>>({});
  const visibleSuggestions = suggestions.map((item) => retriedSuggestions[item.id] ?? item);
  const [activeTab, setActiveTab] = React.useState("realtime");
  const [activeId, setActiveId] = React.useState(suggestions[0]?.id ?? "");
  const selectedId = suggestions.some((item) => item.id === activeId)
    ? activeId
    : suggestions[0]?.id ?? "";
  const active =
    visibleSuggestions.find((item) => item.id === selectedId) ?? null;

  const highPriority = visibleSuggestions.filter(
    (item) => item.priority === "high" && item.failureMessage === null,
  );
  const objections = visibleSuggestions.filter(
    (item) => item.failureMessage === null && OBJECTION_INTENTS.has(item.intent),
  );

  async function retryAnalysis(commentId: string) {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const result = await retryLiveCommentAction(commentId);
      if (!result.ok) {
        setRetryError({ commentId, message: result.error.message });
        return;
      }
      if (result.data.suggestion) {
        const suggestion = result.data.suggestion;
        setRetriedSuggestions((current) => ({ ...current, [suggestion.id]: suggestion }));
      }
      if (result.data.failure && !result.data.suggestion) {
        setRetryError({ commentId, message: result.data.failure.message });
      }
      router.refresh();
    } catch {
      setRetryError({ commentId, message: "服务连接中断，请稍后再试。问题已保存。" });
    } finally { setRetrying(false); }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
        <Sparkles className="size-3.5 text-primary" />
        <span className="text-[12px] font-medium">话术建议</span>
        <Badge variant="danger" className="ml-auto">
          {highPriority.length} 条高优先级
        </Badge>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1">
        <TabsList className="w-full">
          <TabsTrigger value="realtime">回答建议</TabsTrigger>
          <TabsTrigger value="objection">异议</TabsTrigger>
          <TabsTrigger value="hot">热点</TabsTrigger>
          <TabsTrigger value="knowledge">依据</TabsTrigger>
        </TabsList>

        {/* ---------------- 实时建议 ---------------- */}
        <TabsContent value="realtime" className="min-h-0">
          <ScrollArea className="h-[360px]" viewportClassName="pr-1">
            {suggestions.length === 0 ? (
              <EmptyState
                title="暂无 AI 建议"
                description="在左栏录入一个模拟问题，系统会给出可核对的话术建议。"
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {visibleSuggestions.map((item) => {
                  const intentMeta = LIVE_INTENT_META[item.intent];
                  const priorityMeta = LIVE_PRIORITY_META[item.priority];
                  const isActive = item.id === selectedId;
                  const failed = item.failureMessage !== null;

                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setActiveId(item.id)}
                        className={
                          isActive
                            ? "w-full rounded-xl border border-primary/40 bg-primary-soft/40 px-3 py-2.5 text-left shadow-card"
                            : "w-full rounded-xl border border-border bg-card px-3 py-2.5 text-left shadow-card transition-colors hover:border-primary/25"
                        }
                      >
                        <div className="flex items-center gap-1.5">
                          {failed ? (
                            <Badge
                              variant="secondary"
                              className="px-1.5 py-0 text-[10px]"
                            >
                              分析失败
                            </Badge>
                          ) : (
                            <>
                              <Badge
                                variant={intentMeta.tone}
                                className="px-1.5 py-0 text-[10px]"
                              >
                                {intentMeta.label}
                              </Badge>
                              <Badge
                                variant={priorityMeta.tone}
                                className="px-1.5 py-0 text-[10px]"
                              >
                                {priorityMeta.label}
                              </Badge>
                            </>
                          )}
                          <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                            {item.createdAtText}
                          </span>
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-[12px] leading-5 font-medium">
                          {item.commentContent}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {active ? (
              <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 shadow-card">
                {active.failureMessage ? (
                  <div className="flex flex-col gap-2.5">
                    <div role="status" className="flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/12 px-3 py-2 text-[12px] leading-5 text-warning">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                      <span>{active.failureMessage}</span>
                    </div>
                    <p className="text-[11px] leading-5 text-muted-foreground">问题已保存，恢复服务后可重新分析，无需重复录入。</p>
                    <Button variant="outline" size="sm" className="self-start" disabled={retrying}
                      onClick={() => void retryAnalysis(active.commentId)}>
                      {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                      {retrying ? "正在分析…" : "重新分析"}
                    </Button>
                    {retryError?.commentId === active.commentId ? <p role="alert" className="text-[12px] text-destructive">{retryError.message}</p> : null}
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                        <Lightbulb className="size-3.5 text-warning" />
                        主播建议
                      </span>
                      <p className="rounded-lg border border-warning/25 bg-warning/12 px-3 py-2 text-[12px] leading-5 text-warning">
                        {active.hostSuggestion}
                      </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <span className="text-[12px] font-semibold">建议回答</span>
                      <p className="rounded-lg bg-muted/60 px-3 py-2 text-[12px] leading-5">
                        {active.suggestedReply || "本条无需口播回应。"}
                      </p>
                    </div>

                    {active.sellingAngle ? (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[12px] font-semibold">营销切入点</span>
                        <p className="rounded-lg border border-primary/20 bg-primary-soft/40 px-3 py-2 text-[12px] leading-5 text-primary">
                          {active.sellingAngle}
                        </p>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="soft">
                        推荐动作：{LIVE_ACTION_LABEL[active.recommendedAction]}
                      </Badge>
                      <Badge
                        variant={LIVE_RESPONSE_MODE_META[active.responseMode].tone}
                      >
                        {LIVE_RESPONSE_MODE_META[active.responseMode].label}
                      </Badge>
                      <Badge variant="secondary">
                        置信度 {Math.round(active.confidence * 100)}%
                      </Badge>
                    </div>

                    {active.riskNotes.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                          <ShieldAlert className="size-3.5 text-destructive" />
                          风险提示
                        </span>
                        <ul className="flex flex-col gap-1">
                          {active.riskNotes.map((note) => (
                            <li
                              key={note}
                              className="rounded-md bg-destructive/8 px-2 py-1 text-[11px] leading-4 text-destructive"
                            >
                              {note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </ScrollArea>
        </TabsContent>

        {/* ---------------- 异议处理 ---------------- */}
        <TabsContent value="objection" className="min-h-0">
          <ScrollArea className="h-[360px]" viewportClassName="pr-1">
            <div>
              <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
                价格、售后、异议类评论单独抽出，话术由 AI 直播导演结合知识库生成，
                主播可直接口播。
              </p>
              {objections.length === 0 ? (
                <EmptyState
                  title="暂无异议类评论"
                  description="出现价格 / 售后 / 异议评论后会显示在这里。"
                />
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {objections.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-xl border border-border bg-card p-3 shadow-card"
                    >
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                        <ShieldAlert className="size-3.5 text-destructive" />
                        {item.commentContent}
                      </span>
                      <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
                        {item.suggestedReply || "建议转客服确认后再答复。"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* ---------------- 热点问题 ---------------- */}
        <TabsContent value="hot" className="min-h-0">
          <ScrollArea className="h-[360px]" viewportClassName="pr-1">
            <div>
              <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
                本场观众反复关注的话题。占比由程序根据已分析评论统计，
                不含未经 AI 分析的评论。
              </p>
              {hotTopics.length === 0 ? (
                <EmptyState
                  title="暂无热点"
                  description="至少有一条评论完成 AI 分析后才会形成热点统计。"
                />
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {hotTopics.map((topic) => (
                    <li
                      key={topic.intent}
                      className="rounded-xl border border-border bg-card p-3 shadow-card"
                    >
                      <div className="flex items-center gap-2">
                        <Flame className="size-3.5 text-warning" />
                        <span className="text-[12px] font-semibold">
                          {LIVE_INTENT_META[topic.intent].label}
                        </span>
                        <Badge variant="secondary" className="ml-auto">
                          {topic.count} 条 · {Math.round(topic.share * 100)}%
                        </Badge>
                      </div>
                      {topic.recentExamples.length > 0 ? (
                        <ul className="mt-2 flex flex-col gap-1">
                          {topic.recentExamples.map((example) => (
                            <li
                              key={example}
                              className="truncate rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 text-muted-foreground"
                            >
                              {example}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* ---------------- 知识依据 ---------------- */}
        <TabsContent value="knowledge" className="min-h-0">
          <ScrollArea className="h-[360px]" viewportClassName="pr-1">
            <div>
              <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
                AI 直播导演的每条建议都可能引用知识库检索结果；
                没有检索到可靠依据时会如实标注，不会编造。
              </p>
              {suggestions.length === 0 ? (
                <EmptyState
                  title="暂无知识引用"
                  description="产生 AI 建议后，依据会显示在这里。"
                />
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {visibleSuggestions
                    .filter((item) => item.failureMessage === null)
                    .map((item) => (
                      <li
                        key={item.id}
                        className="rounded-xl border border-border bg-card p-3 shadow-card"
                      >
                        <div className="flex items-center gap-1.5">
                          <BookOpen className="size-3.5 text-primary" />
                          <span className="text-[12px] font-semibold">
                            {LIVE_INTENT_META[item.intent].label}
                          </span>
                          <Badge
                            variant={item.grounded ? "success" : "secondary"}
                            className="ml-auto px-1.5 py-0 text-[10px]"
                          >
                            {item.grounded ? "有依据" : "无知识依据"}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {item.commentContent}
                        </p>
                        {item.citations.length > 0 ? (
                          <ul className="mt-1.5 flex flex-col gap-1">
                            {item.citations.map((source) => (
                              <li
                                key={source.id}
                                className="rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 text-muted-foreground"
                              >
                                <span className="font-medium text-foreground">
                                  {source.title}
                                </span>
                                {" · "}
                                {source.snippet}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-1.5 rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 text-muted-foreground">
                            本条没有知识库依据。涉及保存、售后等事实，请先核对资料。
                          </p>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

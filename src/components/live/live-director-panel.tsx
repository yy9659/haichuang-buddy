"use client";

import { BookOpen, Lightbulb, ShieldAlert, Sparkles } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LIVE_INTENT_META, LIVE_PRIORITY_META } from "@/lib/status-meta";
import type { LiveSuggestion } from "@/types";

/** 右栏：AI 直播导演建议 */
export function LiveDirectorPanel({
  suggestions,
}: {
  suggestions: LiveSuggestion[];
}) {
  const [activeId, setActiveId] = React.useState(suggestions[0]?.id ?? "");
  const active =
    suggestions.find((item) => item.id === activeId) ?? suggestions[0] ?? null;

  const highPriority = suggestions.filter((item) => item.priority === "high");

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
        <Sparkles className="size-3.5 text-primary" />
        <span className="text-[12px] font-medium">AI 直播导演</span>
        <Badge variant="danger" className="ml-auto">
          {highPriority.length} 条高优先级
        </Badge>
      </div>

      <Tabs value={activeId} onValueChange={setActiveId} className="min-h-0 flex-1">
        <TabsList className="w-full">
          <TabsTrigger value="realtime">实时建议</TabsTrigger>
          <TabsTrigger value="objection">异议处理</TabsTrigger>
          <TabsTrigger value="knowledge">知识来源</TabsTrigger>
        </TabsList>

        <TabsContent value="realtime" className="min-h-0">
          <ScrollArea className="h-[calc(100vh-330px)]" viewportClassName="pr-1">
            <ul className="flex flex-col gap-2">
              {suggestions.map((item) => {
                const intentMeta = LIVE_INTENT_META[item.intent];
                const priorityMeta = LIVE_PRIORITY_META[item.priority];
                const isActive = item.id === activeId;

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
                        <Badge variant={intentMeta.tone} className="px-1.5 py-0 text-[10px]">
                          {intentMeta.label}
                        </Badge>
                        <Badge
                          variant={priorityMeta.tone}
                          className="px-1.5 py-0 text-[10px]"
                        >
                          {priorityMeta.label}
                        </Badge>
                        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                          {item.createdAtText}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[12px] leading-5 font-medium">
                        {item.question}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>

            {active ? (
              <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5 shadow-card">
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
                    {active.answer}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="soft">
                    推荐动作：{active.recommendedAction}
                  </Badge>
                  <Badge variant="secondary">
                    意图：{LIVE_INTENT_META[active.intent].label}
                  </Badge>
                </div>
              </div>
            ) : null}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="objection" className="min-h-0">
          <ScrollArea className="h-[calc(100vh-330px)]" viewportClassName="pr-1">
            <div>
              <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
                异议处理话术由 AI 直播导演根据实时评论与知识库生成，主播可直接口播。
              </p>
              <ul className="flex flex-col gap-2.5">
                {suggestions
                  .filter(
                    (item) =>
                      item.intent === "after_sale" ||
                      item.intent === "price_question",
                  )
                  .map((item) => (
                    <li
                      key={item.id}
                      className="rounded-xl border border-border bg-card p-3 shadow-card"
                    >
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                        <ShieldAlert className="size-3.5 text-destructive" />
                        {item.question}
                      </span>
                      <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
                        {item.answer}
                      </p>
                    </li>
                  ))}
              </ul>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="knowledge" className="min-h-0">
          <ScrollArea className="h-[calc(100vh-330px)]">
            <div className="pr-1">
              <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
                AI 直播导演的每条建议都基于知识库检索结果，缺失可靠信息时不会编造。
              </p>
              <ul className="flex flex-col gap-2.5">
                {suggestions.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-xl border border-border bg-card p-3 shadow-card"
                  >
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                      <BookOpen className="size-3.5 text-primary" />
                      {LIVE_INTENT_META[item.intent].label}
                    </span>
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {item.knowledgeSource.map((source) => (
                        <li
                          key={source}
                          className="rounded-md bg-muted/60 px-2 py-1 text-[11px] leading-4 text-muted-foreground"
                        >
                          {source}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}

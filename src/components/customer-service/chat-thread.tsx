"use client";

import { BookOpen, CircleAlert, Send, Sparkles, UserRound } from "lucide-react";
import * as React from "react";

import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { KNOWLEDGE_TYPE_LABEL } from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { ChatMessage, CustomerConversation } from "@/types";

interface ChatThreadProps {
  conversation: CustomerConversation | null;
  messages: ChatMessage[];
}

/** 智能客服 · 会话聊天区（含知识来源与转人工提示） */
export function ChatThread({ conversation, messages }: ChatThreadProps) {
  const [draft, setDraft] = React.useState("");
  const [localMessages, setLocalMessages] = React.useState<ChatMessage[]>([]);

  if (!conversation) {
    return (
      <EmptyState
        title="请选择一个会话"
        description="左侧选择客户会话后，可查看 AI 客服回答与知识来源。"
        className="h-full"
      />
    );
  }

  const allMessages = [...messages, ...localMessages];

  const handleSend = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (content.length === 0) return;

    setLocalMessages((prev) => [
      ...prev,
      {
        id: `local_${prev.length + 1}`,
        conversationId: conversation.id,
        role: "agent",
        content,
        createdAtText: "刚刚",
        confidence: 1,
      },
    ]);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-card shadow-card">
      <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-[12px] font-medium text-blue-700">
          {conversation.customerName.slice(0, 1)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-semibold">
            {conversation.customerName}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {conversation.customerLabel}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {conversation.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3.5 py-3">
        <ul className="flex flex-col gap-3">
          {allMessages.map((message) => {
            const isCustomer = message.role === "customer";
            return (
              <li
                key={message.id}
                className={cn(
                  "flex gap-2",
                  isCustomer ? "flex-row" : "flex-row-reverse",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                    isCustomer
                      ? "bg-secondary text-secondary-foreground"
                      : "bg-primary-soft text-primary",
                  )}
                >
                  {isCustomer ? (
                    <UserRound className="size-3.5" />
                  ) : (
                    <Sparkles className="size-3.5" />
                  )}
                </span>

                <div className="flex max-w-[78%] min-w-0 flex-col gap-1.5">
                  <div
                    className={cn(
                      "rounded-xl px-3 py-2 text-[12px] leading-6",
                      isCustomer
                        ? "bg-muted/70"
                        : "border border-primary/15 bg-primary-soft/60",
                    )}
                  >
                    {message.content}
                  </div>

                  {typeof message.confidence === "number" &&
                  message.role === "agent" ? (
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                        AI 客服 · 置信度{" "}
                        {(message.confidence * 100).toFixed(0)}%
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {message.createdAtText}
                      </span>
                    </div>
                  ) : null}

                  {message.knowledgeSources &&
                  message.knowledgeSources.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {message.knowledgeSources.map((source) => (
                        <li
                          key={source.id}
                          className="flex items-start gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1.5"
                        >
                          <BookOpen className="mt-0.5 size-3 shrink-0 text-primary" />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[11px] font-medium">
                              {source.title}
                            </span>
                            <span className="line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                              {source.snippet}
                            </span>
                            <span className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                              {KNOWLEDGE_TYPE_LABEL[source.type]} · 相关度{" "}
                              {(source.score * 100).toFixed(0)}%
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {message.needsHuman ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-warning/25 bg-warning/12 px-2 py-1.5 text-[11px] leading-4 text-warning">
                      <CircleAlert className="size-3 shrink-0" />
                      当前商品资料中没有找到可靠信息，建议转人工确认。
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>

      <form
        onSubmit={handleSend}
        className="flex items-center gap-2 border-t border-border/70 p-2.5"
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="以人工身份回复（Demo：不会调用 AI）"
          aria-label="人工回复"
          className="bg-muted/60"
        />
        <button
          type="submit"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
          aria-label="发送"
        >
          <Send className="size-4" />
        </button>
      </form>
    </div>
  );
}

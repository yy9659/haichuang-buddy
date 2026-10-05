import { BookOpen, CircleAlert, ShieldCheck, ShieldAlert, Sparkles, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/common/empty-state";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CopyTextButton } from "@/components/common/copy-text-button";
import {
  CONVERSATION_STATUS_META,
  CUSTOMER_INTENT_LABEL,
  KNOWLEDGE_TYPE_LABEL,
} from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { ChatMessage, CustomerConversation } from "@/types";

interface ChatThreadProps {
  conversation: CustomerConversation | null;
  messages: ChatMessage[];
  /** 提问 / 回复表单（Server Action 驱动，由页面注入） */
  footer?: ReactNode;
  /** 会话级操作（转人工 / 结束会话），由页面注入 */
  actions?: ReactNode;
}

/**
 * 智能客服 · 会话聊天区。
 *
 * 这是**服务端组件**：消息、引用、转人工提示都是纯展示，不需要任何客户端状态。
 * 唯一需要交互的「展开依据」用原生 `<details>` 实现 —— 为了一个折叠面板
 * 引入客户端组件，会把整棵消息树送进浏览器，得不偿失。
 *
 * 引用只显示**文档名与类型**，不显示 chunkId（任务书第二十六节）：
 * uuid 对商家没有任何意义，只会让「依据」这一栏看起来像调试输出。
 * 真要看原文，展开后能看到片段内容。
 *
 * 相关度百分比**只在开发模式下显示**（任务书第二十二节）。
 * 它是检索的内部数字，对消费者是噪声、对商家是误导 —— 一个「相关度 41%」
 * 的引用可能恰好是一句完全正确的回答，而「相关度 92%」也可能答偏了。
 * 生产界面该让商家判断的是**引用了哪份文档**，而不是它的小数点。
 */
export function ChatThread({ conversation, messages, footer, actions }: ChatThreadProps) {
  if (!conversation) {
    return (
      <EmptyState
        title="还没有任何会话"
        description="点击右上角「新建模拟会话」，然后输入一句消费者提问，系统会实时检索企业知识库并给出带依据的回答。"
        className="h-full"
      />
    );
  }

  const statusMeta = CONVERSATION_STATUS_META[conversation.status];
  /** 检索内部数字只在开发模式露出，避免被当成「回答可信度」 */
  const showSimilarity = process.env.NODE_ENV === "development";

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
          <Badge variant={statusMeta.tone} className="px-1.5 py-0 text-[10px]">
            {statusMeta.label}
          </Badge>
          {conversation.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3.5 py-3">
        <ul className="flex flex-col gap-3">
          {messages.map((message) => {
            const isCustomer = message.role === "customer";
            const citations = message.knowledgeSources ?? [];

            return (
              <li
                key={message.id}
                className={cn("flex gap-2", isCustomer ? "flex-row" : "flex-row-reverse")}
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

                <div className="flex max-w-[80%] min-w-0 flex-col gap-1.5">
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

                  {message.role === "agent" ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* grounded 是「这句回答有没有依据」的唯一凭据，必须显式展示 */}
                      {message.grounded === true ? (
                        <Badge
                          variant="success"
                          className="gap-1 px-1.5 py-0 text-[10px]"
                        >
                          <ShieldCheck className="size-2.5" />
                          基于知识库回答
                        </Badge>
                      ) : message.grounded === false ? (
                        <Badge
                          variant="warning"
                          className="gap-1 px-1.5 py-0 text-[10px]"
                        >
                          <ShieldAlert className="size-2.5" />
                          知识不足 · 建议人工确认
                        </Badge>
                      ) : null}
                      {message.grounded === true ? (
                        <CopyTextButton text={message.content} />
                      ) : null}
                      {message.intent ? (
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                          {CUSTOMER_INTENT_LABEL[message.intent]}
                        </Badge>
                      ) : null}
                      <span className="text-[10px] text-muted-foreground">
                        {message.createdAtText}
                      </span>
                    </div>
                  ) : null}

                  {citations.length > 0 ? (
                    <details className="group rounded-lg border border-border bg-muted/40">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-muted-foreground select-none">
                        <BookOpen className="size-3 shrink-0 text-primary" />
                        依据 {citations.length} 条
                        <span className="text-[10px] group-open:hidden">展开</span>
                        <span className="hidden text-[10px] group-open:inline">收起</span>
                      </summary>
                      <ul className="flex flex-col gap-1 px-2 pb-2">
                        {citations.map((source, index) => (
                          <li
                            key={source.chunkId}
                            className="rounded-lg border border-border bg-card px-2 py-1.5"
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[11px] font-medium">
                                《{source.title}》
                              </span>
                              <Badge
                                variant="soft"
                                className="ml-auto shrink-0 px-1.5 py-0 text-[10px]"
                              >
                                {KNOWLEDGE_TYPE_LABEL[source.type]}
                              </Badge>
                            </div>
                            <p className="mt-0.5 line-clamp-3 text-[10px] leading-4 text-muted-foreground">
                              {source.snippet}
                            </p>
                            <span className="mt-0.5 block text-[10px] text-muted-foreground/80 tabular-nums">
                              第 {index + 1} 条
                              {showSimilarity
                                ? ` · 相关度 ${(source.score * 100).toFixed(0)}%（仅开发模式可见）`
                                : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  {message.needsHuman ? (
                    <span className="inline-flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/12 px-2 py-1.5 text-[11px] leading-4 text-warning">
                      <CircleAlert className="mt-0.5 size-3 shrink-0" />
                      {message.grounded === true
                        ? "本次回答依据充分，但 AI 仍建议人工跟进确认。"
                        : "知识库中没有找到可靠依据，已建议转人工确认。"}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>

      {footer ? <div className="border-t border-border/70 p-2.5">{footer}</div> : null}
    </div>
  );
}

"use client";

import { Search } from "lucide-react";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { CONVERSATION_STATUS_META } from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import type { CustomerConversation } from "@/types";

interface ConversationListProps {
  conversations: CustomerConversation[];
  activeId: string;
  onSelect: (id: string) => void;
}

/** 智能客服 · 会话列表 */
export function ConversationList({
  conversations,
  activeId,
  onSelect,
}: ConversationListProps) {
  const [keyword, setKeyword] = React.useState("");

  const filtered = conversations.filter((item) => {
    const text = keyword.trim().toLowerCase();
    if (text.length === 0) return true;
    return (
      item.customerName.toLowerCase().includes(text) ||
      item.lastMessage.toLowerCase().includes(text)
    );
  });

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-card shadow-card">
      <div className="border-b border-border/70 p-2.5">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索客户或消息…"
            aria-label="搜索会话"
            className="border-transparent bg-muted/70 pl-8 focus-visible:bg-card"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="p-2">
        <ul className="flex flex-col gap-1.5">
          {filtered.map((conversation) => {
            const meta = CONVERSATION_STATUS_META[conversation.status];
            const isActive = conversation.id === activeId;

            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conversation.id)}
                  className={cn(
                    "w-full rounded-lg px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    isActive ? "bg-primary-soft" : "hover:bg-secondary/70",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-100 to-blue-200 text-[11px] font-medium text-blue-700">
                      {conversation.customerName.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {conversation.customerName}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {conversation.updatedAtText}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-[11px] text-muted-foreground">
                    {conversation.lastMessage}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Badge
                      variant={meta.tone}
                      className="px-1.5 py-0 text-[10px]"
                    >
                      {meta.label}
                    </Badge>
                    {conversation.tags.slice(0, 2).map((tag) => (
                      <Badge
                        key={tag}
                        variant="secondary"
                        className="px-1.5 py-0 text-[10px]"
                      >
                        {tag}
                      </Badge>
                    ))}
                    {conversation.unreadCount > 0 ? (
                      <span className="ml-auto flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] leading-none text-destructive-foreground">
                        {conversation.unreadCount}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

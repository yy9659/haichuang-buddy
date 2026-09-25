"use client";

import * as React from "react";

import { ChatThread } from "@/components/customer-service/chat-thread";
import { ConversationList } from "@/components/customer-service/conversation-list";
import type { ChatMessage, CustomerConversation } from "@/types";

interface ConversationWorkspaceProps {
  conversations: CustomerConversation[];
  messagesByConversation: Record<string, ChatMessage[]>;
}

/** 智能客服工作区：左会话列表 + 右聊天区 */
export function ConversationWorkspace({
  conversations,
  messagesByConversation,
}: ConversationWorkspaceProps) {
  const [activeId, setActiveId] = React.useState(conversations[0]?.id ?? "");

  const active =
    conversations.find((item) => item.id === activeId) ?? conversations[0] ?? null;
  const messages = active ? (messagesByConversation[active.id] ?? []) : [];

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,300px)_1fr] xl:items-stretch">
      <div className="xl:h-[calc(100vh-260px)]">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={setActiveId}
        />
      </div>
      <div className="flex flex-col xl:h-[calc(100vh-260px)]">
        {/* key 保证切换会话时重置本地输入状态 */}
        <ChatThread
          key={active?.id ?? "empty"}
          conversation={active}
          messages={messages}
        />
      </div>
    </div>
  );
}

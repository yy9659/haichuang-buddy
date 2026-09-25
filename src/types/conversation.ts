/**
 * 智能客服类型定义
 * 对应技术文档 6.6 智能客服 Agent 与 9.7 智能客服
 */

export type ConversationChannel = "douyin" | "wechat" | "shipinhao" | "store";

export type ConversationStatus = "bot" | "human" | "closed";

export type KnowledgeType =
  | "product"
  | "faq"
  | "logistics"
  | "after-sale"
  | "brand"
  | "cooking"
  | "storage";

export interface KnowledgeSource {
  id: string;
  title: string;
  type: KnowledgeType;
  snippet: string;
  /** 检索相关度 0 ~ 1 */
  score: number;
}

export interface CustomerConversation {
  id: string;
  customerName: string;
  customerLabel: string;
  channel: ConversationChannel;
  lastMessage: string;
  updatedAtText: string;
  unreadCount: number;
  status: ConversationStatus;
  tags: string[];
}

export type ChatRole = "customer" | "agent" | "system";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  createdAtText: string;
  /** AI 回答置信度 0 ~ 1 */
  confidence?: number;
  /** 引用的知识来源 */
  knowledgeSources?: KnowledgeSource[];
  /** 知识库缺失，建议转人工 */
  needsHuman?: boolean;
}

/** 知识库覆盖情况 */
export interface KnowledgeGap {
  id: string;
  question: string;
  askedCount: number;
  suggestion: string;
}

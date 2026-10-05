/**
 * 客服会话仓储 · Mock 实现（S5）
 *
 * 与数据库实现同一套语义（详见 `../conversation.ts` 的共享规则）：
 * - 列表按 `updatedAt` 倒序；
 * - `lastMessage` / `messageCount` / `updatedAtText` 是**派生字段**，读取时现算；
 * - `unreadCount` 的增减由 `nextUnreadCount` 统一决定，不在这里各写一遍；
 * - 追加消息会同时推进会话的 `updatedAt`，否则刚回复过的会话会掉到列表底部。
 *
 * 引用（`citations`）以**快照**形式存在消息上，而不是只存 chunkId ——
 * 知识可能被重新索引（chunk id 全变），而「当时这条回答引用了哪份文档」
 * 是历史事实，不该被后续重建抹掉（数据库那边是同一个理由）。
 */

import { formatDateTime, formatRelativeTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import { isKnowledgeDocumentType, isCustomerIntent } from "@/types";
import { MOCK_BUSINESS } from "@/lib/mock";
import { AppError } from "@/lib/result";
import type {
  ChatMessage,
  CustomerConversation,
  KnowledgeSource,
} from "@/types";

import { deriveConversationPreview, nextUnreadCount } from "../conversation";
import type {
  ConversationRepository,
  NewConversationInput,
  NewCustomerMessageInput,
  UpdateConversationInput,
} from "../types";
import {
  findStoredConversation,
  listStoredConversations,
  listStoredCustomerMessages,
  putStoredConversation,
  putStoredCustomerMessage,
  replaceStoredConversation,
  type StoredConversation,
  type StoredCustomerMessage,
} from "./store";

/** 会话列表上限：Demo 规模不大，但查询不该无上限 */
const MAX_CONVERSATION_LIMIT = 50;

function resolveBusinessId(businessId?: string): string {
  return businessId ?? MOCK_BUSINESS.id;
}

/**
 * 引用快照的**防御性**还原。
 *
 * 库里存的是 jsonb，可能来自旧版本 schema 或被手工改坏。这里逐条校验，
 * 丢掉不合法的项而不是把脏值硬塞进 `KnowledgeSource` ——
 * 界面上的引用是可以点开看原文的，给一个缺字段的引用，
 * 用户点下去只会得到一片空白。
 */
function toKnowledgeSources(value: unknown[]): KnowledgeSource[] {
  const result: KnowledgeSource[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    const documentId = record.documentId;
    const chunkId = record.chunkId;
    const title = record.title;
    const type = record.type;
    if (
      typeof id !== "string" ||
      typeof documentId !== "string" ||
      typeof chunkId !== "string" ||
      typeof title !== "string" ||
      !isKnowledgeDocumentType(type)
    ) {
      continue;
    }
    const score = record.score;
    result.push({
      id,
      documentId,
      chunkId,
      title,
      type,
      snippet: typeof record.snippet === "string" ? record.snippet : "",
      score: typeof score === "number" && Number.isFinite(score) ? score : 0,
    });
  }
  return result;
}

function toDomainMessage(message: StoredCustomerMessage): ChatMessage {
  const sources = toKnowledgeSources(message.citations);
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    createdAtText: formatDateTime(message.createdAt),
    confidence: message.confidence ?? undefined,
    grounded: message.grounded ?? undefined,
    intent: isCustomerIntent(message.intent) ? message.intent : undefined,
    knowledgeSources: sources.length > 0 ? sources : undefined,
    needsHuman: message.needsHuman ? true : undefined,
    knowledgeGapId: message.knowledgeGapId ?? undefined,
    retrievedCount: message.retrievedCount > 0 ? message.retrievedCount : undefined,
  };
}

function toDomainConversation(conversation: StoredConversation): CustomerConversation {
  const messages = listStoredCustomerMessages(conversation.id);
  const preview = deriveConversationPreview(messages);
  return {
    id: conversation.id,
    customerName: conversation.customerName,
    customerLabel: conversation.customerLabel,
    channel: conversation.channel,
    lastMessage: preview.lastMessage,
    updatedAtText: formatRelativeTime(conversation.updatedAt),
    unreadCount: conversation.unreadCount,
    status: conversation.status,
    tags: [...conversation.tags],
    productId: conversation.productId,
    messageCount: preview.messageCount,
  };
}

function notFound(id: string): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "客服会话不存在",
    detail: `conversationId=${id}`,
  });
}

/** 会话列表上限，按商家查询与全量查询共用同一个口径 */
function clampLimit(limit?: number): number {
  return Math.min(
    MAX_CONVERSATION_LIMIT,
    Math.max(1, Math.trunc(limit ?? MAX_CONVERSATION_LIMIT)),
  );
}

export function createMockConversationRepository(): ConversationRepository {
  return {
    async listConversations(limit?: number) {
      return listStoredConversations()
        .slice(0, clampLimit(limit))
        .map(toDomainConversation);
    },

    async listConversationsForBusiness(businessId: string, limit?: number) {
      return listStoredConversations()
        .filter((conversation) => conversation.businessId === businessId)
        .slice(0, clampLimit(limit))
        .map(toDomainConversation);
    },

    async getConversation(id: string) {
      const conversation = findStoredConversation(id);
      return conversation ? toDomainConversation(conversation) : null;
    },

    /**
     * 按商家读取。
     *
     * 与 `getConversation` 的唯一差别就是那个 `businessId` 相等判断 ——
     * 而它恰恰是全部意义所在：漏掉它，另一家的会话就能被本家的页面读到，
     * 而且不会有任何报错（任务书第八节的硬要求）。
     */
    async findConversationForBusiness(businessId: string, conversationId: string) {
      const conversation = findStoredConversation(conversationId);
      if (!conversation || conversation.businessId !== businessId) {
        return null;
      }
      return toDomainConversation(conversation);
    },

    async createConversation(input: NewConversationInput) {
      const now = new Date();
      const conversation: StoredConversation = {
        id: createLocalId("conv"),
        businessId: resolveBusinessId(input.businessId),
        customerName: input.customerName,
        customerLabel: input.customerLabel ?? "",
        // 本阶段唯一的入口是内置消费者模拟器，因此默认渠道就是 simulator；
        // 接入真实平台后由调用方显式传入真实渠道
        channel: input.channel ?? "simulator",
        // 新会话一律从「AI 接待中」开始：是否转人工由 Agent 的结论决定，
        // 不该在创建时预先猜一个状态
        status: "bot",
        productId: input.productId ?? null,
        tags: input.tags ? [...input.tags] : [],
        unreadCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      putStoredConversation(conversation);
      return toDomainConversation(conversation);
    },

    async updateConversation(id: string, patch: UpdateConversationInput) {
      const current = findStoredConversation(id);
      if (!current) {
        throw notFound(id);
      }
      const next: StoredConversation = {
        ...current,
        status: patch.status ?? current.status,
        unreadCount:
          patch.unreadCount !== undefined
            ? Math.max(0, Math.trunc(patch.unreadCount))
            : current.unreadCount,
        tags: patch.tags ? [...patch.tags] : current.tags,
      };
      replaceStoredConversation(next);
      return toDomainConversation(next);
    },

    async listMessages(conversationId: string) {
      return listStoredCustomerMessages(conversationId).map(toDomainMessage);
    },

    /**
     * 今日 AI 回答统计。
     *
     * 先按商家筛会话、再逐会话扫消息，与数据库那边
     * `JOIN ... WHERE conversations.business_id = $1` 的结果**完全同义**。
     * 没有走「全量消息 + 反查会话」的写法：那样每来一条消息都要回表，
     * 而按会话分组是内存里唯一的天然索引。
     */
    async countAssistantMessagesSince(businessId: string, since: Date) {
      const sinceTime = since.getTime();
      let answered = 0;
      let grounded = 0;

      for (const conversation of listStoredConversations()) {
        if (conversation.businessId !== businessId) {
          continue;
        }
        for (const message of listStoredCustomerMessages(conversation.id)) {
          if (message.role !== "agent" || message.createdAt.getTime() < sinceTime) {
            continue;
          }
          answered += 1;
          if (message.grounded === true) {
            grounded += 1;
          }
        }
      }

      return { answered, grounded };
    },

    async appendMessage(input: NewCustomerMessageInput) {
      const conversation = findStoredConversation(input.conversationId);
      if (!conversation) {
        throw notFound(input.conversationId);
      }

      const now = new Date();
      const needsHuman = input.needsHuman ?? false;
      const message: StoredCustomerMessage = {
        id: createLocalId("msg"),
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        grounded: input.grounded ?? null,
        intent: input.intent ?? null,
        confidence: input.confidence ?? null,
        citations: input.citations ? [...input.citations] : [],
        needsHuman,
        knowledgeGapId: input.knowledgeGapId ?? null,
        retrievedCount: input.retrievedCount ?? 0,
        createdAt: now,
      };
      putStoredCustomerMessage(message);

      /**
       * 两条写操作必须一起完成。
       *
       * Mock 是进程内数组，两次 push 之间不会失败，天然是原子的；
       * 数据库那边则必须放进一个事务 —— 否则会出现「消息插进去了、
       * 会话的 updated_at 没动」，列表里的排序就永久停在旧位置。
       */
      replaceStoredConversation({
        ...conversation,
        updatedAt: now,
        unreadCount: nextUnreadCount({
          current: conversation.unreadCount,
          role: input.role,
          needsHuman,
        }),
        // AI 判定需要人工时，会话状态同步推进为 human —— 否则列表上的状态点
        // 与消息里的「建议转人工」会互相矛盾
        status: needsHuman ? "human" : conversation.status,
      });

      return toDomainMessage(message);
    },
  };
}

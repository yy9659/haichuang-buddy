/**
 * 客服会话仓储 · 数据库实现（S5）
 *
 * 三处关键设计：
 *
 * 1. **派生字段用聚合查询一次算出**（`lastMessage` / `messageCount`）。
 *    列表页有 N 条会话，逐条查消息就是 N+1 次查询；这里用一次
 *    `GROUP BY conversation_id` + 窗口函数一次拿全。
 *    这两个字段刻意**不落库** —— 落库就要在每次追加消息后手动维护，漏一次列表就显示错。
 *
 * 2. **追加消息与会话更新在同一个事务里**。
 *    消息插进去了、`updated_at` 没动，会话就会永久停在列表的旧位置，
 *    而且没有任何报错 —— 这正是事务要解决的问题。
 *
 * 3. **`unreadCount` 的增减走共享规则**（`../conversation.ts`），
 *    与 Mock 实现共用同一个纯函数，保证「切数据源不改行为」。
 */

import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { customerConversations, customerMessages } from "@/db/schema";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";
import type {
  ChatMessage,
  CustomerConversation,
  KnowledgeSource,
} from "@/types";

import { buildMessagePreview, nextUnreadCount } from "../conversation";
import type {
  ConversationRepository,
  NewConversationInput,
  NewCustomerMessageInput,
  UpdateConversationInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapCustomerConversationRow, mapCustomerMessageRow } from "./mappers";
import { findPrimaryBusinessIdOrNull, resolvePrimaryBusinessId } from "./shared";

/** 会话列表上限 */
const MAX_CONVERSATION_LIMIT = 50;
/** 单次读取消息上限，防止一条会话被灌爆后把页面拖死 */
const MAX_MESSAGE_LIMIT = 200;

function notFound(id: string): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "客服会话不存在",
    detail: `conversationId=${id}`,
  });
}

/**
 * 引用快照 → jsonb 列。
 *
 * 显式展开字段而不是整体塞进去：`KnowledgeSource` 是接口类型、没有索引签名，
 * 字段改名时断言写法会静默丢数据，展开写法会编译报错。
 * 快照里**必须保留 documentId 与 chunkId** —— 那是「这条回答有没有编造引用」的凭据。
 */
function toCitationColumns(sources: readonly KnowledgeSource[]) {
  return sources.map((source) => ({
    id: source.id,
    documentId: source.documentId,
    chunkId: source.chunkId,
    title: source.title,
    type: source.type,
    snippet: source.snippet,
    score: source.score,
  }));
}

export function createDbConversationRepository(): ConversationRepository {
  /**
   * 一次算出「每条会话的最后一条消息 + 消息总数」。
   *
   * 用 `DISTINCT ON` 取每组的第一条（按 created_at 倒序），
   * 比 `ROW_NUMBER()` 包一层子查询更短，且 Postgres 对它有专门优化。
   * 两个查询都是按 conversation_id 分组的，因此这里合并成两句一次跑：
   * 一句抓预览、一句抓计数 —— 预览用 DISTINCT ON，计数用 GROUP BY。
   */
  async function loadDerived(
    conversationIds: readonly string[],
  ): Promise<Map<string, { lastMessage: string; messageCount: number }>> {
    const result = new Map<
      string,
      { lastMessage: string; messageCount: number }
    >();
    if (conversationIds.length === 0) {
      return result;
    }

    for (const id of conversationIds) {
      result.set(id, { lastMessage: "", messageCount: 0 });
    }

    const db = getDb();

    // 消息总数
    const counted = await db
      .select({
        conversationId: customerMessages.conversationId,
        total: sql<number>`count(*)::int`,
      })
      .from(customerMessages)
      .where(inArray(customerMessages.conversationId, [...conversationIds]))
      .groupBy(customerMessages.conversationId);

    for (const row of counted) {
      const entry = result.get(row.conversationId);
      if (entry) {
        entry.messageCount = Number(row.total) || 0;
      }
    }

    // 最后一条消息的正文（DISTINCT ON 取每组按时间倒序的第一条）
    const previews = await db
      .selectDistinctOn([customerMessages.conversationId], {
        conversationId: customerMessages.conversationId,
        content: customerMessages.content,
      })
      .from(customerMessages)
      .where(inArray(customerMessages.conversationId, [...conversationIds]))
      .orderBy(customerMessages.conversationId, desc(customerMessages.createdAt));

    for (const row of previews) {
      const entry = result.get(row.conversationId);
      if (entry) {
        entry.lastMessage = buildMessagePreview(row.content);
      }
    }

    return result;
  }

  async function loadOne(
    id: string,
    businessId: string,
  ): Promise<CustomerConversation | null> {
    const rows = await getDb()
      .select()
      .from(customerConversations)
      .where(
        and(
          eq(customerConversations.id, id),
          eq(customerConversations.businessId, businessId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const derived = await loadDerived([row.id]);
    return mapCustomerConversationRow(
      row,
      derived.get(row.id) ?? { lastMessage: "", messageCount: 0 },
    );
  }

  async function loadList(
    businessId: string,
    limit?: number,
  ): Promise<CustomerConversation[]> {
    const safeLimit = Math.min(
      MAX_CONVERSATION_LIMIT,
      Math.max(1, Math.trunc(limit ?? MAX_CONVERSATION_LIMIT)),
    );

    const rows = await getDb()
      .select()
      .from(customerConversations)
      .where(eq(customerConversations.businessId, businessId))
      .orderBy(desc(customerConversations.updatedAt))
      .limit(safeLimit);

    const derived = await loadDerived(rows.map((row) => row.id));
    return rows.map((row) =>
      mapCustomerConversationRow(
        row,
        derived.get(row.id) ?? { lastMessage: "", messageCount: 0 },
      ),
    );
  }

  return {
    async listConversations(limit?: number) {
      try {
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return [] as CustomerConversation[];
        }
        return await loadList(businessId, limit);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载客服会话");
      }
    },

    async listConversationsForBusiness(businessId: string, limit?: number) {
      try {
        return await loadList(businessId, limit);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载客服会话");
      }
    },

    async getConversation(id: string) {
      if (!isUuid(id)) {
        return null;
      }
      try {
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return null;
        }
        return await loadOne(id, businessId);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载客服会话");
      }
    },

    /**
     * 按商家读取。
     *
     * 商家条件**写在 WHERE 里**而不是「先查出来再比对」：后者需要
     * 「查不到」与「查到了但不是你的」汇成同一条返回路径，一旦有人
     * 为了「更好的错误提示」把它们分开，就变成了一次资源存在性泄漏。
     * 让 SQL 决定它存不存在，返回 null 就只有一种含义。
     */
    async findConversationForBusiness(businessId: string, conversationId: string) {
      if (!isUuid(conversationId)) {
        return null;
      }
      try {
        return await loadOne(conversationId, businessId);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载客服会话");
      }
    },

    async createConversation(input: NewConversationInput) {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());
        if (input.productId && !isUuid(input.productId)) {
          throw new AppError({
            code: "VALIDATION_FAILED",
            message: "创建会话失败：商品标识格式不正确",
            detail: `productId=${input.productId}`,
            retryable: false,
          });
        }

        const rows = await getDb()
          .insert(customerConversations)
          .values({
            businessId,
            customerName: input.customerName,
            customerLabel: input.customerLabel ?? "",
            // 本阶段唯一的入口是内置消费者模拟器，因此默认渠道就是 simulator；
            // 接入真实平台后由调用方显式传入真实渠道
            channel: input.channel ?? "simulator",
            // 新会话一律从「AI 接待中」开始：是否转人工由 Agent 的结论决定
            status: "bot",
            productId: input.productId ?? null,
            tags: input.tags ? [...input.tags] : [],
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "创建会话失败：数据库未返回记录",
          });
        }
        // 刚建好必然没有消息，不必再查一次
        return mapCustomerConversationRow(row, { lastMessage: "", messageCount: 0 });
      } catch (cause) {
        throw mapDatabaseError(cause, "创建客服会话");
      }
    },

    async updateConversation(id: string, patch: UpdateConversationInput) {
      if (!isUuid(id)) {
        throw notFound(id);
      }
      try {
        const businessId = await resolvePrimaryBusinessId();

        const values: Partial<typeof customerConversations.$inferInsert> = {};
        if (patch.status !== undefined) values.status = patch.status;
        if (patch.unreadCount !== undefined) {
          values.unreadCount = Math.max(0, Math.trunc(patch.unreadCount));
        }
        if (patch.tags !== undefined) values.tags = [...patch.tags];

        const rows = await getDb()
          .update(customerConversations)
          .set(values)
          .where(
            and(
              eq(customerConversations.id, id),
              eq(customerConversations.businessId, businessId),
            ),
          )
          .returning();

        const row = rows[0];
        if (!row) {
          throw notFound(id);
        }
        // 状态 / 标签 / 未读数变了，但列表文案来自派生字段，仍要回读一次
        const loaded = await loadOne(row.id, businessId);
        return (
          loaded ?? mapCustomerConversationRow(row, { lastMessage: "", messageCount: 0 })
        );
      } catch (cause) {
        throw mapDatabaseError(cause, "更新客服会话");
      }
    },

    async listMessages(conversationId: string): Promise<ChatMessage[]> {
      if (!isUuid(conversationId)) {
        return [];
      }
      try {
        const rows = await getDb()
          .select()
          .from(customerMessages)
          .where(eq(customerMessages.conversationId, conversationId))
          .orderBy(asc(customerMessages.createdAt))
          .limit(MAX_MESSAGE_LIMIT);
        return rows.map(mapCustomerMessageRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载客服消息");
      }
    },

    /**
     * 今日 AI 回答统计（任务书第六 / 七节）。
     *
     * 一句话算完分子与分母：`count(*) filter (where grounded)` 让两个数
     * 出自**同一个快照**，不会出现「两次查询之间插进来一条消息」导致的
     * 「依据充分数大于回答数」。`filter` 是 Postgres 的聚合过滤子句，
     * 比写两次 `SUM(CASE WHEN ...)` 更短，也更容易看出它只扫一遍。
     *
     * 用 `INNER JOIN` 而不是子查询 `IN (...)`：会话表上有
     * `(business_id)` 的索引，join 让「先按商家缩小会话集合」这件事
     * 在计划里显式表达出来；只认 conversation_id 的话，
     * 商家条件就退化成一个「先把全部会话 id 拉到内存」的隐式步骤。
     *
     * 商家归属**只以会话表为准**：消息表自身没有 business_id，
     * 这是刻意的（消息跟着会话走），因此这里必须 join，不能只查消息表。
     */
    async countAssistantMessagesSince(
      businessId: string,
      since: Date,
    ): Promise<{ answered: number; grounded: number }> {
      try {
        const rows = await getDb()
          .select({
            answered: sql<number>`count(*)::int`,
            grounded: sql<number>`count(*) filter (where ${customerMessages.grounded})::int`,
          })
          .from(customerMessages)
          .innerJoin(
            customerConversations,
            eq(customerMessages.conversationId, customerConversations.id),
          )
          .where(
            and(
              eq(customerConversations.businessId, businessId),
              eq(customerMessages.role, "agent"),
              gte(customerMessages.createdAt, since),
            ),
          );

        const row = rows[0];
        return {
          answered: Number(row?.answered ?? 0) || 0,
          grounded: Number(row?.grounded ?? 0) || 0,
        };
      } catch (cause) {
        throw mapDatabaseError(cause, "统计客服回答");
      }
    },

    async appendMessage(input: NewCustomerMessageInput): Promise<ChatMessage> {      if (!isUuid(input.conversationId)) {
        throw notFound(input.conversationId);
      }
      try {
        const businessId = await resolvePrimaryBusinessId();
        const needsHuman = input.needsHuman ?? false;

        return await getDb().transaction(async (tx) => {
          const conversationRows = await tx
            .select()
            .from(customerConversations)
            .where(
              and(
                eq(customerConversations.id, input.conversationId),
                eq(customerConversations.businessId, businessId),
              ),
            )
            .limit(1);
          const conversation = conversationRows[0];
          if (!conversation) {
            throw notFound(input.conversationId);
          }

          const messageRows = await tx
            .insert(customerMessages)
            .values({
              conversationId: input.conversationId,
              role: input.role,
              content: input.content,
              grounded: input.grounded ?? null,
              intent: input.intent ?? null,
              confidence: input.confidence ?? null,
              citations: input.citations ? toCitationColumns(input.citations) : [],
              needsHuman,
              knowledgeGapId: input.knowledgeGapId ?? null,
              retrievedCount: input.retrievedCount ?? 0,
            })
            .returning();

          const message = messageRows[0];
          if (!message) {
            throw new AppError({
              code: "DB_ERROR",
              message: "保存客服消息失败：数据库未返回记录",
            });
          }

          await tx
            .update(customerConversations)
            .set({
              updatedAt: new Date(),
              unreadCount: nextUnreadCount({
                current: conversation.unreadCount,
                role: input.role,
                needsHuman,
              }),
              // AI 判定需要人工时同步推进会话状态，否则列表上的状态点
              // 与消息里的「建议转人工」会互相矛盾
              status: needsHuman ? "human" : conversation.status,
            })
            .where(eq(customerConversations.id, input.conversationId));

          return mapCustomerMessageRow(message);
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "保存客服消息");
      }
    },
  };
}

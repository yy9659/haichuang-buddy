/**
 * 知识缺口仓储 · 数据库实现（S5）
 *
 * 聚合靠 `(business_id, gap_key)` 的唯一索引 + `ON CONFLICT DO UPDATE`，
 * 而不是「先 SELECT 再决定 INSERT/UPDATE」—— 后者在并发提问时会插入重复行，
 * 而缺口面板一旦出现两条一样的问题，商家对它的信任就没了。
 *
 * 聚合键由 `src/rag/knowledge-gap.ts` 的 `resolveKnowledgeGapIdentity` 推导，
 * **与 Mock 实现共用同一份**（任务书第十四节要求两套数据源行为一致）：
 * 各写一套「规范化 + 哈希」的话，任何一次单边改动都会让演示与真实计数对不上，
 * 而且不会有任何报错。
 *
 * `occurrence_count = knowledge_gaps.occurrence_count + 1` 用**列引用**自增，
 * 不写「先读出来的值 + 1」：两个消费者同时提问时，后者读到的是自增前的旧值，
 * 于是 12 次提问只记成 11 次 —— 这种丢计数不会有任何报错，只是数字慢慢变得不可信。
 */

import { and, count, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { knowledgeGaps } from "@/db/schema";
import { isUuid } from "@/lib/id";
import { AppError } from "@/lib/result";
import { resolveKnowledgeGapIdentity } from "@/rag/knowledge-gap";
import type { KnowledgeGapRecord, KnowledgeGapStatus } from "@/types";

import type {
  KnowledgeGapOccurrenceInput,
  KnowledgeGapRepository,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapKnowledgeGapRow } from "./mappers";
import { findPrimaryBusinessIdOrNull, resolvePrimaryBusinessId } from "./shared";

/** 单次查询返回的缺口上限 */
const MAX_GAP_LIMIT = 100;

function notFound(id: string): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "知识缺口记录不存在",
    detail: `gapId=${id}`,
  });
}

/**
 * 缺口面板的排序：未解决优先 → 出现次数多优先 → 最近出现优先。
 *
 * 为什么不用 `ORDER BY status`：枚举的声明顺序（open, resolved, ignored）
 * 恰好也是我们要的顺序，但这属于「依赖一个与业务无关的实现细节」——
 * 将来往枚举里插一个值就可能悄悄改变面板顺序。显式写成 case 表达式，
 * 让意图留在 SQL 里，也让它与 Mock 实现的 `compareGaps` 一眼可比。
 */
const ORDER_BY_OPEN_FIRST = sql`case when ${knowledgeGaps.status} = 'open' then 0 else 1 end`;

export function createDbKnowledgeGapRepository(): KnowledgeGapRepository {
  return {
    async list(params) {
      try {
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return [] as KnowledgeGapRecord[];
        }

        const conditions = [eq(knowledgeGaps.businessId, businessId)];
        if (params?.status) {
          conditions.push(eq(knowledgeGaps.status, params.status));
        }

        const limit = Math.min(
          MAX_GAP_LIMIT,
          Math.max(1, Math.trunc(params?.limit ?? MAX_GAP_LIMIT)),
        );

        const rows = await getDb()
          .select()
          .from(knowledgeGaps)
          .where(and(...conditions))
          .orderBy(
            ORDER_BY_OPEN_FIRST,
            desc(knowledgeGaps.occurrenceCount),
            desc(knowledgeGaps.lastSeenAt),
          )
          .limit(limit);
        return rows.map(mapKnowledgeGapRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载知识缺口");
      }
    },

    async getById(id: string): Promise<KnowledgeGapRecord | null> {
      if (!isUuid(id)) {
        return null;
      }
      try {
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return null;
        }
        const rows = await getDb()
          .select()
          .from(knowledgeGaps)
          .where(
            and(eq(knowledgeGaps.id, id), eq(knowledgeGaps.businessId, businessId)),
          )
          .limit(1);
        const row = rows[0];
        return row ? mapKnowledgeGapRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "加载知识缺口");
      }
    },

    async recordOccurrence(
      input: KnowledgeGapOccurrenceInput,
    ): Promise<KnowledgeGapRecord> {
      try {
        const businessId = input.businessId ?? (await resolvePrimaryBusinessId());
        if (!isUuid(businessId)) {
          throw new AppError({
            code: "VALIDATION_FAILED",
            message: "记录知识缺口失败：商家标识格式不正确",
            detail: `businessId=${businessId}`,
            retryable: false,
          });
        }
        if (input.productId && !isUuid(input.productId)) {
          throw new AppError({
            code: "VALIDATION_FAILED",
            message: "记录知识缺口失败：商品标识格式不正确",
            detail: `productId=${input.productId}`,
            retryable: false,
          });
        }

        const { normalizedQuestion, gapKey } = resolveKnowledgeGapIdentity({
          businessId,
          productId: input.productId ?? null,
          question: input.question,
          normalizedQuestion: input.normalizedQuestion,
          gapKey: input.gapKey,
        });

        const rows = await getDb()
          .insert(knowledgeGaps)
          .values({
            businessId,
            productId: input.productId ?? null,
            question: input.question,
            normalizedQuestion,
            gapKey,
            intent: input.intent,
            reason: input.reason,
          })
          .onConflictDoUpdate({
            // 与唯一索引 knowledge_gaps_business_gap_key_unique 完全对应
            target: [knowledgeGaps.businessId, knowledgeGaps.gapKey],
            set: {
              // 列引用自增，而不是「读出来的值 + 1」—— 见文件头
              occurrenceCount: sql`${knowledgeGaps.occurrenceCount} + 1`,
              lastSeenAt: new Date(),
              // 这三项都覆盖为最新一次的判断：只更新一部分会让面板出现
              // 「旧问法配新原因」这种自相矛盾的一行
              question: input.question,
              intent: input.intent,
              reason: input.reason,
              /**
               * 状态流转（与 Mock 实现逐条对应）：
               *
               * - `open`     → 保持 open；
               * - `resolved` → 重新置为 open。补的知识没能解决这个问题是事实，
               *   保持 resolved 会让商家以为补的东西管用了，而消费者还在被转人工；
               * - `ignored`  → 保持 ignored，只累加计数。商家当初判定这个问题
               *   不需要专门补知识，重复出现不构成改变主意的理由；但计数照涨，
               *   「这个问题一直在发生」始终可见。
               *
               * 用 `case` 而不是直接写 `'open'`：ON CONFLICT DO UPDATE 里
               * 不带 `excluded` 前缀的列名指向**已存在的那一行**，正是要判断的对象。
               * 这里必须显式写成枚举类型（`::knowledge_gap_status`），
               * 因为 `case ... end` 的结果类型是 text，而 text 到枚举没有隐式转换。
               */
              status: sql`case when ${knowledgeGaps.status} = 'ignored' then 'ignored'::knowledge_gap_status else 'open'::knowledge_gap_status end`,
              /**
               * 重开时清掉来源文档引用：它的语义是「这条缺口是被哪份文档解决的」，
               * 而现在并没有被解决。留着会让面板显示「已由《某文档》解决」
               * 与同一行的「未解决」状态直接冲突。
               */
              resolvedDocumentId: null,
            },
          })
          .returning();

        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "记录知识缺口失败：数据库未返回记录",
          });
        }
        return mapKnowledgeGapRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "记录知识缺口");
      }
    },

    async updateStatus(
      id: string,
      status: KnowledgeGapStatus,
      resolvedDocumentId?: string | null,
    ): Promise<KnowledgeGapRecord> {
      if (!isUuid(id)) {
        throw notFound(id);
      }
      try {
        const businessId = await resolvePrimaryBusinessId();
        const rows = await getDb()
          .update(knowledgeGaps)
          .set({
            status,
            // 只有 resolved 才保留来源文档；改回 open / ignored 时清掉，避免幽灵引用
            resolvedDocumentId:
              status === "resolved" ? (resolvedDocumentId ?? null) : null,
          })
          .where(
            and(eq(knowledgeGaps.id, id), eq(knowledgeGaps.businessId, businessId)),
          )
          .returning();

        const row = rows[0];
        if (!row) {
          throw notFound(id);
        }
        return mapKnowledgeGapRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新知识缺口");
      }
    },

    async countOpen() {
      try {
        const businessId = await findPrimaryBusinessIdOrNull();
        if (!businessId) {
          return 0;
        }
        const rows = await getDb()
          .select({ total: count() })
          .from(knowledgeGaps)
          .where(
            and(
              eq(knowledgeGaps.businessId, businessId),
              eq(knowledgeGaps.status, "open"),
            ),
          );
        const total = Number(rows[0]?.total ?? 0);
        return Number.isFinite(total) ? total : 0;
      } catch (cause) {
        throw mapDatabaseError(cause, "统计知识缺口");
      }
    },
  };
}

/**
 * 知识缺口仓储 · Mock 实现（S5）
 *
 * 核心是**去重聚合**（任务书第二十二节）：聚合键 `(businessId, gapKey)` 唯一，
 * 重复提问只累加 `occurrenceCount` 并刷新 `lastSeenAt`，不新建行。
 *
 * 为什么聚合责任放在仓储而不是服务层「先查后写」：
 * 两个消费者几乎同时问同一句话时，两次「查」都会得到「不存在」，
 * 于是各插一行 —— 缺口面板立刻出现两条一模一样的问题，且计数各为 1。
 * 唯一约束 + upsert 是唯一正确的做法，`upsertDocument` 那边出于同样的理由。
 *
 * 内存实现没有真正的并发（JS 单线程），但**语义必须与数据库实现逐条对齐**：
 * 数据库那边靠 `ON CONFLICT DO UPDATE` 完成的事，这里就靠「查到则就地替换」，
 * 而不是「查不到才插」之外的任何捷径。任务书第十四节要求的行为一致性
 * （create-or-increment / resolved 重开 / ignored 累计）在两边各写一遍，
 * 所以每处状态流转都在这里写明它对应数据库实现里的哪一句。
 */

import { formatDateTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import { MOCK_BUSINESS } from "@/lib/mock";
import { AppError } from "@/lib/result";
import { resolveKnowledgeGapIdentity } from "@/rag/knowledge-gap";
import type { KnowledgeGapRecord, KnowledgeGapStatus } from "@/types";

import type {
  KnowledgeGapOccurrenceInput,
  KnowledgeGapRepository,
} from "../types";
import {
  findStoredKnowledgeGap,
  listStoredKnowledgeGaps,
  putStoredKnowledgeGap,
  replaceStoredKnowledgeGap,
  type StoredKnowledgeGap,
} from "./store";

function toDomainGap(gap: StoredKnowledgeGap): KnowledgeGapRecord {
  return {
    id: gap.id,
    businessId: gap.businessId,
    productId: gap.productId,
    question: gap.question,
    normalizedQuestion: gap.normalizedQuestion,
    intent: gap.intent,
    reason: gap.reason,
    status: gap.status,
    occurrenceCount: gap.occurrenceCount,
    firstSeenAt: formatDateTime(gap.firstSeenAt),
    lastSeenAt: formatDateTime(gap.lastSeenAt),
    resolvedDocumentId: gap.resolvedDocumentId,
  };
}

/** 单次查询返回的缺口上限，防止面板一次拉出整张表 */
const MAX_GAP_LIMIT = 100;

/**
 * 缺口面板的排序：未解决优先 → 出现次数多优先 → 最近出现优先。
 *
 * 与数据库实现的 `ORDER BY` 一一对应（那边用 `case when status = 'open'` 而不是
 * `ORDER BY status` —— 枚举的声明顺序恰好也是 open 优先，但依赖声明顺序意味着
 * 将来往枚举里插一个值就可能悄悄改变面板顺序，这种关联不值得省那几个字符）。
 */
function compareGaps(left: StoredKnowledgeGap, right: StoredKnowledgeGap): number {
  const leftOpen = left.status === "open" ? 0 : 1;
  const rightOpen = right.status === "open" ? 0 : 1;
  if (leftOpen !== rightOpen) {
    return leftOpen - rightOpen;
  }
  if (left.occurrenceCount !== right.occurrenceCount) {
    return right.occurrenceCount - left.occurrenceCount;
  }
  return right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
}

export function createMockKnowledgeGapRepository(): KnowledgeGapRepository {
  return {
    async list(params) {
      const status = params?.status;
      const limit = Math.min(
        MAX_GAP_LIMIT,
        Math.max(1, Math.trunc(params?.limit ?? MAX_GAP_LIMIT)),
      );

      return listStoredKnowledgeGaps()
        .filter((gap) => (status ? gap.status === status : true))
        .sort(compareGaps)
        .slice(0, limit)
        .map(toDomainGap);
    },

    async getById(id: string) {
      const gap = findStoredKnowledgeGap(id);
      return gap ? toDomainGap(gap) : null;
    },

    async recordOccurrence(input: KnowledgeGapOccurrenceInput) {
      const businessId = input.businessId ?? MOCK_BUSINESS.id;
      const { normalizedQuestion, gapKey } = resolveKnowledgeGapIdentity({
        businessId,
        productId: input.productId ?? null,
        question: input.question,
        normalizedQuestion: input.normalizedQuestion,
        gapKey: input.gapKey,
      });

      const existing = listStoredKnowledgeGaps().find(
        (gap) => gap.businessId === businessId && gap.gapKey === gapKey,
      );

      const now = new Date();

      if (existing) {
        /**
         * 命中已有缺口 → 计数 +1、刷新 lastSeenAt。
         *
         * `occurrenceCount + 1` 在内存里读到的一定是最新值，不存在数据库那种
         * 「读到自增前的旧值」的竞态；数据库实现用列引用自增（
         * `occurrence_count = knowledge_gaps.occurrence_count + 1`）来达到同一结果。
         *
         * `question` / `intent` / `reason` 都覆盖为**最新一次**的判断：
         * 这三项描述的是「最近一次被问到时的情况」，若只更新其中一部分，
         * 面板上就会出现「用旧问法配新原因」这种自相矛盾的一行。
         * `normalizedQuestion` 与 `gapKey` 天然不变（它们就是命中条件）。
         */
        const next: StoredKnowledgeGap = {
          ...existing,
          occurrenceCount: existing.occurrenceCount + 1,
          lastSeenAt: now,
          question: input.question,
          intent: input.intent,
          reason: input.reason,
          /**
           * 状态流转（与数据库实现的 `set.status` 表达式逐一对应）：
           *
           * - `open`     → 保持 open；
           * - `resolved` → **重新置为 open**。逻辑上这不是「撤销商家的操作」，
           *   而是事实：商家补的知识没能解决这个问题。若保持 resolved，
           *   商家会以为自己补的东西管用了，而消费者还在被转人工。
           * - `ignored`  → **保持 ignored**，只累加计数。商家当初选择忽略
           *   （认定这个问题不需要专门补知识），重复出现并不构成改变主意的理由；
           *   但也不能静默吞掉 —— 计数还在涨，商家随时能看到「这个问题一直在发生」。
           *   是否要重新关注，是商家的判断，不该由系统替他决定。
           */
          status: existing.status === "ignored" ? "ignored" : "open",
          /**
           * 重开时清掉来源文档引用：`resolvedDocumentId` 的语义是
           * 「这条缺口是被哪份文档解决的」，而它现在**并没有被解决**。
           * 留着一个非 null 的值会让面板显示「已由《物流说明》解决」，
           * 与同一行上的「未解决」状态直接冲突。历史信息可以从
           * `customer_messages.knowledge_gap_id` 的关联消息里回溯，不必占用这一列。
           */
          resolvedDocumentId: null,
        };
        replaceStoredKnowledgeGap(next);
        return toDomainGap(next);
      }

      const created: StoredKnowledgeGap = {
        id: createLocalId("gap"),
        businessId,
        productId: input.productId ?? null,
        question: input.question,
        normalizedQuestion,
        gapKey,
        intent: input.intent,
        reason: input.reason,
        status: "open",
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedDocumentId: null,
      };
      putStoredKnowledgeGap(created);
      return toDomainGap(created);
    },

    async updateStatus(
      id: string,
      status: KnowledgeGapStatus,
      resolvedDocumentId?: string | null,
    ) {
      const current = findStoredKnowledgeGap(id);
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "知识缺口记录不存在",
          detail: `gapId=${id}`,
        });
      }

      const next: StoredKnowledgeGap = {
        ...current,
        status,
        // 只有 resolved 才保留来源文档；改回 open / ignored 时清掉，避免幽灵引用
        resolvedDocumentId:
          status === "resolved" ? (resolvedDocumentId ?? null) : null,
      };
      replaceStoredKnowledgeGap(next);
      return toDomainGap(next);
    },

    async countOpen() {
      return listStoredKnowledgeGaps().filter((gap) => gap.status === "open").length;
    },
  };
}

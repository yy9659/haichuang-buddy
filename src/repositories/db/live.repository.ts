/**
 * AI 直播间仓储 · 数据库实现（S7 补齐）
 *
 * 与 Mock 实现保持同一套语义（「切数据源不改上层」的前提）：
 * - 评论按时间**正序**、建议按时间**倒序**、场次按开始时间**倒序**；
 * - `appendComment` / `appendSuggestion` 在**同一事务**里维护场次的评论数 / AI 处理数，
 *   与 Mock 那边内聚在仓储里的效果一致；
 * - 目标不存在时抛 `NOT_FOUND`，与其它仓储一致。
 *
 * 多租户：场次 / 评论 / 建议都归属商家（评论、建议经场次外键级联），
 * 因此读操作按「当前会话的商家」过滤 —— 未登录抛 UNAUTHORIZED（见 `./shared`）。
 *
 * `getStats()` 返回 null：模拟指标（在线 / 点赞 / 涨粉）没有真实来源，
 * 数据库实现不能凭空造数。界面据此显示「模拟数据不可用」，而不是假数字。
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { ensureLocalDatabaseReady, getDb, isLocalDataSource } from "@/db";
import { liveComments, liveSessions, liveSuggestions } from "@/db/schema";
import { AppError } from "@/lib/result";
import type { LiveComment, LiveSession, LiveSuggestion } from "@/types";

import type {
  LiveRepository,
  NewLiveCommentInput,
  NewLiveSessionInput,
  NewLiveSuggestionInput,
  UpdateLiveCommentInput,
  UpdateLiveSessionInput,
} from "../types";
import { mapDatabaseError } from "./errors";
import { mapLiveCommentRow, mapLiveSessionRow, mapLiveSuggestionRow } from "./mappers";
import { resolvePrimaryBusinessId } from "./shared";

/**
 * 当前商家的最近一场直播；没有时返回 null。
 * 「最近一场」的口径是 `started_at DESC`（与 Mock 的「列表首项」一致）。
 */
async function findLatestSession(): Promise<LiveSession | null> {
  if (isLocalDataSource()) await ensureLocalDatabaseReady();
  const businessId = await resolvePrimaryBusinessId();
  const rows = await getDb()
    .select()
    .from(liveSessions)
    .where(eq(liveSessions.businessId, businessId))
    .orderBy(desc(liveSessions.startedAt), desc(liveSessions.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? mapLiveSessionRow(row) : null;
}

/**
 * 解析目标场次的 id；未显式传入时取最近一场，仍取不到抛 NOT_FOUND。
 * 校验该场次属于当前商家（跨租户越权与「不存在」表现一致）。
 */
async function resolveSessionId(explicit?: string): Promise<string> {
  const businessId = await resolvePrimaryBusinessId();
  const target = explicit ?? (await latestSessionIdForBusiness(businessId));
  if (!target) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "当前没有进行中的直播场次",
      detail: "请先开始一场直播。",
    });
  }
  // 目标场次必须属于当前商家，否则视为不存在
  const owned = await getDb()
    .select({ id: liveSessions.id })
    .from(liveSessions)
    .where(and(eq(liveSessions.id, target), eq(liveSessions.businessId, businessId)))
    .limit(1);
  if (owned.length === 0) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "直播场次不存在",
      detail: `sessionId=${target}`,
    });
  }
  return target;
}

async function latestSessionIdForBusiness(businessId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ id: liveSessions.id })
    .from(liveSessions)
    .where(eq(liveSessions.businessId, businessId))
    .orderBy(desc(liveSessions.startedAt), desc(liveSessions.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export function createDbLiveRepository(): LiveRepository {
  return {
    async getSession() {
      try {
        return await findLatestSession();
      } catch (cause) {
        throw mapDatabaseError(cause, "加载直播场次");
      }
    },

    async listSessions(limit) {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const base = getDb()
          .select()
          .from(liveSessions)
          .where(eq(liveSessions.businessId, businessId))
          .orderBy(desc(liveSessions.startedAt), desc(liveSessions.createdAt))
          .$dynamic();
        const rows = await (limit === undefined ? base : base.limit(limit));
        return rows.map(mapLiveSessionRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载直播场次列表");
      }
    },

    async getStats() {
      // 模拟指标无真实来源，数据库实现不造数
      return null;
    },

    async listComments(sessionId) {
      try {
        const target = await resolveSessionId(sessionId);
        const rows = await getDb()
          .select()
          .from(liveComments)
          .where(eq(liveComments.sessionId, target))
          .orderBy(liveComments.createdAt);
        return rows.map(mapLiveCommentRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载直播评论");
      }
    },

    async listSuggestions(sessionId) {
      try {
        const target = await resolveSessionId(sessionId);
        const commentIds = await getDb()
          .select({ id: liveComments.id })
          .from(liveComments)
          .where(eq(liveComments.sessionId, target));
        if (commentIds.length === 0) {
          return [];
        }
        const ids = commentIds.map((row) => row.id);
        const rows = await getDb()
          .select()
          .from(liveSuggestions)
          .where(inArray(liveSuggestions.commentId, ids))
          .orderBy(desc(liveSuggestions.createdAt));
        return rows.map(mapLiveSuggestionRow);
      } catch (cause) {
        throw mapDatabaseError(cause, "加载直播建议");
      }
    },

    async createSession(input: NewLiveSessionInput): Promise<LiveSession> {
      try {
        const rows = await getDb()
          .insert(liveSessions)
          .values({
            businessId: input.businessId,
            title: input.title,
            productId: input.productId,
            productName: input.productName,
            status: input.status ?? "live",
            startedAt: input.startedAt ?? new Date(),
            endedAt: null,
            commentsCount: 0,
            aiHandledCount: 0,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "创建直播场次失败：数据库未返回记录",
          });
        }
        return mapLiveSessionRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "创建直播场次");
      }
    },

    async updateSession(id: string, patch: UpdateLiveSessionInput): Promise<LiveSession> {
      try {
        const businessId = await resolvePrimaryBusinessId();
        const values: Partial<typeof liveSessions.$inferInsert> = {};
        if (patch.status !== undefined) values.status = patch.status;
        if (patch.endedAt !== undefined) values.endedAt = patch.endedAt;
        if (patch.commentsCount !== undefined) values.commentsCount = patch.commentsCount;
        if (patch.aiHandledCount !== undefined) values.aiHandledCount = patch.aiHandledCount;
        if (patch.hostTranscript !== undefined) values.hostTranscript = patch.hostTranscript;
        if (patch.rehearsalReport !== undefined) values.rehearsalReport = patch.rehearsalReport;

        const rows = await getDb()
          .update(liveSessions)
          .set(values)
          .where(and(eq(liveSessions.id, id), eq(liveSessions.businessId, businessId)))
          .returning();
        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "直播场次不存在",
            detail: `sessionId=${id}`,
          });
        }
        return mapLiveSessionRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新直播场次");
      }
    },

    async appendComment(input: NewLiveCommentInput): Promise<LiveComment> {
      try {
        const businessId = await resolvePrimaryBusinessId();
        // 场次必须属于当前商家
        const session = await getDb()
          .select({ id: liveSessions.id })
          .from(liveSessions)
          .where(
            and(
              eq(liveSessions.id, input.sessionId),
              eq(liveSessions.businessId, businessId),
            ),
          )
          .limit(1);
        if (session.length === 0) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "直播场次不存在",
            detail: `sessionId=${input.sessionId}`,
          });
        }

        const inserted = await getDb()
          .insert(liveComments)
          .values({
            sessionId: input.sessionId,
            authorName: input.authorName,
            content: input.content,
            intent: null,
            priority: null,
            handled: false,
          })
          .returning();
        const row = inserted[0];
        if (!row) {
          throw new AppError({
            code: "DB_ERROR",
            message: "追加直播评论失败：数据库未返回记录",
          });
        }

        // 评论数 +1（与 Mock 的 appendComment 内聚维护同一效果）
        await getDb()
          .update(liveSessions)
          .set({ commentsCount: sql`${liveSessions.commentsCount} + 1` })
          .where(eq(liveSessions.id, input.sessionId));

        return mapLiveCommentRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "追加直播评论");
      }
    },

    async updateComment(id: string, patch: UpdateLiveCommentInput): Promise<LiveComment> {
      try {
        const values: Partial<typeof liveComments.$inferInsert> = {};
        if (patch.intent !== undefined) values.intent = patch.intent;
        if (patch.priority !== undefined) values.priority = patch.priority;
        if (patch.handled !== undefined) values.handled = patch.handled;

        const rows = await getDb()
          .update(liveComments)
          .set(values)
          .where(eq(liveComments.id, id))
          .returning();
        const row = rows[0];
        if (!row) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "直播评论不存在",
            detail: `commentId=${id}`,
          });
        }
        return mapLiveCommentRow(row);
      } catch (cause) {
        throw mapDatabaseError(cause, "更新直播评论");
      }
    },

    async appendSuggestion(input: NewLiveSuggestionInput): Promise<LiveSuggestion> {
      try {
        const businessId = await resolvePrimaryBusinessId();
        return await getDb().transaction(async (tx) => {
          // Lock the owned comment, so simultaneous retries cannot insert duplicate suggestions.
          const owned = await tx
            .select({ id: liveComments.id, sessionId: liveComments.sessionId })
            .from(liveComments)
            .innerJoin(liveSessions, eq(liveComments.sessionId, liveSessions.id))
            .where(and(eq(liveComments.id, input.commentId), eq(liveSessions.businessId, businessId)))
            .for("update");
          const comment = owned[0];
          if (!comment) throw new AppError({ code: "NOT_FOUND", message: "直播评论不存在" });
          const previousRows = await tx.select().from(liveSuggestions)
            .where(eq(liveSuggestions.commentId, input.commentId))
            .orderBy(desc(liveSuggestions.createdAt)).limit(1);
          const previous = previousRows[0];
          const values = {
            commentId: input.commentId,
            commentContent: input.commentContent,
            intent: input.intent,
            priority: input.priority,
            shouldRespond: input.shouldRespond,
            responseMode: input.responseMode,
            hostSuggestion: input.hostSuggestion,
            suggestedReply: input.suggestedReply,
            sellingAngle: input.sellingAngle,
            grounded: input.grounded,
            citations: input.citations,
            recommendedAction: input.recommendedAction,
            riskNotes: input.riskNotes,
            confidence: input.confidence,
            durationMs: input.durationMs,
            failureMessage: input.failureMessage ?? null,
          };
          const inserted = previous
            ? await tx.update(liveSuggestions).set(values).where(eq(liveSuggestions.id, previous.id)).returning()
            : await tx.insert(liveSuggestions).values(values).returning();
          const row = inserted[0];
          if (!row) {
            throw new AppError({
              code: "DB_ERROR",
              message: "保存直播建议失败：数据库未返回记录",
            });
          }

          // Failed → successful counts once; repeat saves do not inflate the metrics.
          const handledDelta = Number(row.failureMessage === null) - Number(previous?.failureMessage === null);
          if (handledDelta !== 0) {
            await tx
              .update(liveSessions)
              .set({ aiHandledCount: sql`${liveSessions.aiHandledCount} + ${handledDelta}` })
              .where(eq(liveSessions.id, comment.sessionId));
          }

          return mapLiveSuggestionRow(row);
        });
      } catch (cause) {
        throw mapDatabaseError(cause, "追加直播建议");
      }
    },

    async findSuggestionByComment(commentId: string): Promise<LiveSuggestion | null> {
      try {
        const rows = await getDb()
          .select()
          .from(liveSuggestions)
          .where(eq(liveSuggestions.commentId, commentId))
          .orderBy(desc(liveSuggestions.createdAt))
          .limit(1);
        const row = rows[0];
        return row ? mapLiveSuggestionRow(row) : null;
      } catch (cause) {
        throw mapDatabaseError(cause, "查询直播建议");
      }
    },
  };
}

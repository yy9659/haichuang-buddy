/**
 * AI 直播间仓储 · Mock 实现（S6）
 *
 * 与数据库实现保持同一套语义（「切数据源不改上层」的前提）：
 * - 评论按时间**正序**、建议按时间**倒序**（与 DB 的 ORDER BY 同一口径）；
 * - `appendComment` / `appendSuggestion` 同时维护场次的评论数 / AI 处理数，
 *   与 DB 那边由 Service 显式 update 保持一致（这里内聚在仓储里，效果相同）；
 * - 目标不存在时抛 `NOT_FOUND`，与其它仓储一致。
 *
 * 数据只存在于进程内存，重启即清空 —— 这一点与其它 Mock 仓储一致，
 * 绝不让界面产生「已经落库」的错觉。
 */

import { formatDateTime, formatDuration, formatTime } from "@/lib/datetime";
import { createLocalId } from "@/lib/id";
import { AppError } from "@/lib/result";
import type { LiveComment, LiveSession, LiveSuggestion } from "@/types";

import type { LiveRepository } from "../types";
import {
  findLatestStoredLiveSession,
  findStoredLiveComment,
  findStoredLiveSession,
  findStoredLiveSuggestionByComment,
  getStoredLiveStats,
  listStoredLiveComments,
  listStoredLiveSessions,
  listStoredLiveSuggestions,
  putStoredLiveComment,
  putStoredLiveSession,
  putStoredLiveSuggestion,
  replaceStoredLiveComment,
  replaceStoredLiveSession,
  type StoredLiveComment,
  type StoredLiveSession,
  type StoredLiveSuggestion,
} from "./store";

/** 场次时长：直播中算到「现在」，已结束算到结束时间 */
function toDurationText(session: StoredLiveSession, now = Date.now()): string {
  const end = session.endedAt
    ? session.endedAt.getTime()
    : session.status === "live"
      ? now
      : session.startedAt.getTime();
  return formatDuration((end - session.startedAt.getTime()) / 1000);
}

function toDomainSession(session: StoredLiveSession): LiveSession {
  return {
    id: session.id,
    title: session.title,
    productId: session.productId,
    productName: session.productName,
    status: session.status,
    startedAt: formatDateTime(session.startedAt),
    endedAt: session.endedAt ? formatDateTime(session.endedAt) : null,
    durationText: toDurationText(session),
    commentsCount: session.commentsCount,
    aiHandledCount: session.aiHandledCount,
    hostTranscript: session.hostTranscript ?? "",
    rehearsalReport: session.rehearsalReport ?? null,
  };
}

function toDomainComment(comment: StoredLiveComment): LiveComment {
  return {
    id: comment.id,
    sessionId: comment.sessionId,
    authorName: comment.authorName,
    content: comment.content,
    intent: comment.intent,
    priority: comment.priority,
    handled: comment.handled,
    createdAtText: formatTime(comment.createdAt),
  };
}

function toDomainSuggestion(suggestion: StoredLiveSuggestion): LiveSuggestion {
  return {
    id: suggestion.id,
    commentId: suggestion.commentId,
    commentContent: suggestion.commentContent,
    intent: suggestion.intent,
    priority: suggestion.priority,
    shouldRespond: suggestion.shouldRespond,
    responseMode: suggestion.responseMode,
    hostSuggestion: suggestion.hostSuggestion,
    suggestedReply: suggestion.suggestedReply,
    sellingAngle: suggestion.sellingAngle,
    grounded: suggestion.grounded,
    citations: suggestion.citations.map((citation) => ({ ...citation })),
    recommendedAction: suggestion.recommendedAction,
    riskNotes: [...suggestion.riskNotes],
    confidence: suggestion.confidence,
    durationMs: suggestion.durationMs,
    createdAtText: formatTime(suggestion.createdAt),
    failureMessage: suggestion.failureMessage,
  };
}

/** 最近一场的 sessionId；没有场次时抛 NOT_FOUND（调用方应先建场次） */
function requireLatestSessionId(): string {
  const session = findLatestStoredLiveSession();
  if (!session) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "当前没有进行中的直播场次",
      detail: "请先开始一场模拟直播。",
    });
  }
  return session.id;
}

export function createMockLiveRepository(): LiveRepository {
  return {
    async getSession() {
      const session = findLatestStoredLiveSession();
      return session ? toDomainSession(session) : null;
    },

    async listSessions(limit?: number) {
      const all = listStoredLiveSessions();
      const selected = limit === undefined ? all : all.slice(0, Math.max(0, limit));
      return selected.map(toDomainSession);
    },

    async getStats() {
      return { ...getStoredLiveStats() };
    },

    async listComments(sessionId) {
      const target = sessionId ?? requireLatestSessionId();
      return listStoredLiveComments(target).map(toDomainComment);
    },

    async listSuggestions(sessionId) {
      const target = sessionId ?? requireLatestSessionId();
      return listStoredLiveSuggestions(target).map(toDomainSuggestion);
    },

    async createSession(input) {
      const session: StoredLiveSession = {
        id: createLocalId("live"),
        businessId: input.businessId,
        title: input.title,
        productId: input.productId,
        productName: input.productName,
        status: input.status ?? "live",
        startedAt: input.startedAt ?? new Date(),
        endedAt: null,
        commentsCount: 0,
        aiHandledCount: 0,
        hostTranscript: "",
        rehearsalReport: null,
      };
      putStoredLiveSession(session);
      return toDomainSession(session);
    },

    async updateSession(id, patch) {
      const current = findStoredLiveSession(id);
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "直播场次不存在",
          detail: `sessionId=${id}`,
        });
      }
      const next: StoredLiveSession = {
        ...current,
        status: patch.status ?? current.status,
        endedAt:
          patch.endedAt === undefined
            ? current.endedAt
            : patch.endedAt,
        commentsCount: patch.commentsCount ?? current.commentsCount,
        aiHandledCount: patch.aiHandledCount ?? current.aiHandledCount,
        hostTranscript: patch.hostTranscript ?? current.hostTranscript,
        rehearsalReport: patch.rehearsalReport === undefined ? current.rehearsalReport : patch.rehearsalReport,
      };
      replaceStoredLiveSession(next);
      return toDomainSession(next);
    },

    async appendComment(input) {
      const session = findStoredLiveSession(input.sessionId);
      if (!session) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "直播场次不存在",
          detail: `sessionId=${input.sessionId}`,
        });
      }
      const comment: StoredLiveComment = {
        id: createLocalId("lcm"),
        sessionId: input.sessionId,
        authorName: input.authorName,
        content: input.content,
        intent: null,
        priority: null,
        handled: false,
        createdAt: new Date(),
      };
      putStoredLiveComment(comment);
      replaceStoredLiveSession({
        ...session,
        commentsCount: session.commentsCount + 1,
      });
      return toDomainComment(comment);
    },

    async updateComment(id, patch) {
      const current = findStoredLiveComment(id);
      if (!current) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "直播评论不存在",
          detail: `commentId=${id}`,
        });
      }
      const next: StoredLiveComment = {
        ...current,
        intent: patch.intent === undefined ? current.intent : patch.intent,
        priority: patch.priority === undefined ? current.priority : patch.priority,
        handled: patch.handled ?? current.handled,
      };
      replaceStoredLiveComment(next);
      return toDomainComment(next);
    },

    async appendSuggestion(input) {
      const previous = findStoredLiveSuggestionByComment(input.commentId);
      const suggestion: StoredLiveSuggestion = {
        id: previous?.id ?? createLocalId("lsg"),
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
        citations: input.citations.map((citation) => ({ ...citation })),
        recommendedAction: input.recommendedAction,
        riskNotes: [...input.riskNotes],
        confidence: input.confidence,
        durationMs: input.durationMs,
        failureMessage: input.failureMessage ?? null,
        createdAt: previous?.createdAt ?? new Date(),
      };
      putStoredLiveSuggestion(suggestion);

      /** 成功产出建议才算「AI 已处理」；失败的建议不增加处理数 */
      const handledDelta = Number(suggestion.failureMessage === null) - Number(previous?.failureMessage === null);
      if (handledDelta !== 0) {
        const comment = findStoredLiveComment(input.commentId);
        const session = comment
          ? findStoredLiveSession(comment.sessionId)
          : undefined;
        if (session) {
          replaceStoredLiveSession({
            ...session,
            aiHandledCount: session.aiHandledCount + handledDelta,
          });
        }
      }

      return toDomainSuggestion(suggestion);
    },

    async findSuggestionByComment(commentId) {
      const found = findStoredLiveSuggestionByComment(commentId);
      return found ? toDomainSuggestion(found) : null;
    },
  };
}

"use server";

/**
 * AI 直播导演的 Server Actions（S6 · 任务书第三十一 / 三十二 / 三十三节）
 *
 * 为什么直播间必须走 Server Action：一条评论要经**意图预分类 → RAG 检索 →
 * DashScope 结构化生成 → 引用校验**才产出建议。检索逻辑、模型凭证、
 * 「这条建议有没有知识依据」的判定，没有一件能放到浏览器里。
 *
 * 链路固定为：
 *
 *   Client Component → Server Action → Live Service → Live Agent / Retriever → Repository
 *
 * 本文件只做三件事：解析入参 → 调服务 → 失效缓存。
 * **不含任何业务规则** —— 那些在 Service 里，Mock 与 DB 两套数据源共用同一份。
 */

import { revalidatePath } from "next/cache";

import type { Result } from "@/lib/result";
import {
  endLiveSession,
  startDemoLiveSession,
  submitLiveComment,
  retryLiveComment,
  type SubmitLiveCommentResult,
} from "@/services/live-agent.service";
import type { LiveSession } from "@/types";
import type { LiveRehearsalReport } from "@/types";
import {
  generateRehearsalQuestion,
  saveHostTranscript,
  scoreLiveRehearsal,
} from "@/services/live-rehearsal.service";

/**
 * 直播数据出现在哪些页面：改动后统一失效。
 * 驾驶舱的「直播助手」卡片读的是同一份场次与评论，必须一起刷新。
 */
function revalidateLiveSurfaces(): void {
  revalidatePath("/live");
  revalidatePath("/dashboard");
}

/** 开始一场模拟直播（本地演示；不接直播平台） */
export async function startLiveSessionAction(input: {
  productId: string;
}): Promise<Result<LiveSession>> {
  const started = await startDemoLiveSession({ productId: input.productId });
  if (!started.ok) {
    return started;
  }
  revalidateLiveSurfaces();
  return started;
}

/** 结束当前直播 */
export async function endLiveSessionAction(
  sessionId: string,
): Promise<Result<LiveSession>> {
  const ended = await endLiveSession(sessionId);
  if (!ended.ok) {
    return ended;
  }
  revalidateLiveSurfaces();
  return ended;
}

/** 开启 AI 模拟观众后按需调用；默认不会自动扣费或写入问题。 */
export async function generateRehearsalQuestionAction(sessionId: string): Promise<Result<SubmitLiveCommentResult>> {
  const result = await generateRehearsalQuestion(sessionId);
  if (result.ok) revalidateLiveSurfaces();
  return sanitizeLiveAnalysis(result);
}

export async function saveHostTranscriptAction(sessionId: string, transcript: string): Promise<Result<LiveSession>> {
  const result = await saveHostTranscript(sessionId, transcript);
  if (result.ok) revalidatePath("/live");
  return result;
}

export async function scoreLiveRehearsalAction(sessionId: string): Promise<Result<LiveRehearsalReport>> {
  const result = await scoreLiveRehearsal(sessionId);
  if (result.ok) revalidatePath("/live");
  return result;
}

/**
 * 主播（或模拟观众）提交一条评论，取得 AI 直播导演建议。
 *
 * 返回 `ok` 且 `data.failure !== null` 表示「评论已保存，但 AI 这次没答上来」——
 * 界面必须据此显示可重试提示，而**不能**把它当成发送失败（见 service 文件头）。
 *
 * 与客服 Action 同一约定：这里**只对 `failure` 剥掉 `detail`**，其余错误原样返回。
 * 理由是两类 `detail` 的来源不同：
 * - 校验类（评论为空 / 过长、直播已结束）的 detail 是**写给主播的中文解释**，
 *   剥掉它只会让提示变成一句没有下文的「失败」；
 * - 而 `failure` 来自模型层（`MODEL_TIMEOUT` / `SCHEMA_INVALID`），它的 detail 里
 *   可能夹着模型原始输出与提示词片段 —— 那些东西一旦进浏览器，
 *   等于把企业内部知识库的原文交到任何能打开控制台的人手里。
 */
export async function submitLiveCommentAction(input: {
  sessionId: string;
  content: string;
  authorName?: string;
}): Promise<Result<SubmitLiveCommentResult>> {
  const result = await submitLiveComment({
    sessionId: input.sessionId,
    content: input.content,
    ...(input.authorName !== undefined ? { authorName: input.authorName } : {}),
  });
  if (!result.ok) {
    return result;
  }

  /**
   * 无论 AI 有没有答上来都要刷新：
   * 评论已经落库，左栏评论流、右栏建议、热点聚合都可能变了。
   */
  revalidateLiveSurfaces();

  return sanitizeLiveAnalysis(result);
}

/** Reanalyze a saved failure without appending a duplicate question. */
export async function retryLiveCommentAction(commentId: string): Promise<Result<SubmitLiveCommentResult>> {
  const result = await retryLiveComment({ commentId });
  if (result.ok) revalidateLiveSurfaces();
  return sanitizeLiveAnalysis(result);
}

function sanitizeLiveAnalysis(result: Result<SubmitLiveCommentResult>): Result<SubmitLiveCommentResult> {
  if (!result.ok || !result.data.failure) {
    return result;
  }
  const { failure } = result.data;
  return {
    ok: true,
    data: {
      ...result.data,
      failure: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    },
  };
}

/**
 * AI 直播导演服务（S6 · 任务书第十六 / 十七 / 三十三 / 三十四节）
 *
 * 链路固定为：
 *
 *   Client → Server Action → 本服务 → Live Agent（RAG + DashScope）→ Repository
 *
 * 三个必须写清楚的语义：
 *
 * 1. **评论一旦进入评论流就一定保留。** AI 处理失败（模型超时 / 检索异常）时，
 *    评论照常留在流里，建议位置如实显示「AI 导演暂时不可用」——
 *    既不删除评论，也不伪造一条建议（任务书第三十四节）。
 *
 * 2. **Agent Task 只记索引，不记评论原文。** `input` 存 sessionId / productId /
 *    commentHash；完整评论留在 `LiveComment` 里。任务日志是观测数据，
 *    把用户输入整份抄进去既冗余又扩大了敏感信息面（任务书第三十三节）。
 *
 * 3. **失败不污染业务数据。** 与客服同一约定：任务建失败 / 更新失败只是
 *    观测缺一条，不该让主播的评论发送变成错误页。
 */

import { attempt, fail, ok, toAppError, type AppErrorShape, type Result } from "@/lib/result";
import { getRepositories, type Repositories } from "@/repositories";
import type { KnowledgeChunkSearchHit, KnowledgeSearchParams } from "@/repositories/types";
import type { AIProvider } from "@/ai/provider/types";
import { runLiveAgent } from "@/ai/agents/live-agent";
import { buildQuestionHash } from "./customer-service-agent.service";
import { resolveActiveBusinessId } from "./customer-service";
import { getLiveView, type LiveView } from "./live";
import {
  MAX_LIVE_COMMENT_LENGTH,
  type AgentId,
  type LiveComment,
  type LiveSession,
  type LiveSuggestion,
} from "@/types";

/** 写入 `agent_tasks.agent_type` 的值（已在 `AGENT_IDS` 中登记） */
export const LIVE_AGENT_TYPE: AgentId = "live_agent";

/** Agent 任务标题。**刻意不含评论原文** */
const AGENT_TASK_TITLE = "直播评论分析";

/** 模拟观众昵称（用户不填时使用；明确是演示身份，不是真实用户） */
export const DEFAULT_LIVE_AUTHOR = "模拟观众";

/* ------------------------------------------------------------------ */
/* 场次                                                                */
/* ------------------------------------------------------------------ */

export interface StartLiveSessionInput {
  productId: string;
  /** 不传时解析当前商家的档案 */
  businessId?: string;
}

/** 开始一场**模拟**直播（本地演示；不接直播平台） */
export async function startDemoLiveSession(
  input: StartLiveSessionInput,
): Promise<Result<LiveSession>> {
  const businessId = await resolveActiveBusinessId(input.businessId);
  if (!businessId.ok) {
    return businessId;
  }

  const repositories = getRepositories();
  const product = await attempt(
    () => repositories.products.getById(input.productId),
    (cause) => toAppError(cause, "DB_ERROR", "加载直播商品失败"),
  );
  if (!product.ok) {
    return product;
  }
  if (!product.data) {
    return fail("NOT_FOUND", "直播商品不存在", `productId=${input.productId}`);
  }
  /**
   * 先把商品收成本地 const 再进闭包。
   * `product.data` 是嵌套属性访问，TypeScript 不会把它上面的空值判断
   * 带进 `attempt` 的回调里（回调可能稍后执行）。收成本地常量后，
   * 闭包拿到的是已收窄的非空类型，不需要在回调里再写一次断言。
   */
  const liveProduct = product.data;
  const liveBusinessId = businessId.data;

  const owned = await attempt(
    () => repositories.products.belongsToBusiness(liveBusinessId, liveProduct.id),
    (cause) => toAppError(cause, "DB_ERROR", "核对直播商品归属失败"),
  );
  if (!owned.ok) return owned;
  if (!owned.data) return fail("NOT_FOUND", "直播商品不存在");

  const current = await attempt(
    () => repositories.live.getSession(),
    (cause) => toAppError(cause, "DB_ERROR", "加载当前彩排失败"),
  );
  if (!current.ok) {
    return current;
  }
  const activeSession = current.data;
  if (activeSession?.status === "live") {
    const closed = await attempt(
      () => repositories.live.updateSession(activeSession.id, {
        status: "ended",
        endedAt: new Date(),
      }),
      (cause) => toAppError(cause, "DB_ERROR", "结束上一场彩排失败"),
    );
    if (!closed.ok) return closed;
  }

  return attempt(
    () =>
      repositories.live.createSession({
        businessId: liveBusinessId,
        title: `模拟直播 · ${liveProduct.name}`,
        productId: liveProduct.id,
        productName: liveProduct.name,
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建直播场次失败"),
  );
}

/** 结束一场直播 */
export async function endLiveSession(sessionId: string): Promise<Result<LiveSession>> {
  return attempt(
    () =>
      getRepositories().live.updateSession(sessionId, {
        status: "ended",
        endedAt: new Date(),
      }),
    (cause) => toAppError(cause, "DB_ERROR", "结束直播场次失败"),
  );
}

/* ------------------------------------------------------------------ */
/* 提交评论                                                            */
/* ------------------------------------------------------------------ */

export interface SubmitLiveCommentInput {
  sessionId: string;
  content: string;
  /** 观众昵称；不填用「模拟观众」 */
  authorName?: string;
  businessId?: string;
}

/**
 * 可注入的依赖。
 *
 * 与 `SendCustomerMessageOptions` 同一约定：Agent 层已经支持注入 Provider 与检索实现，
 * 服务层把它透传出来，测试才能精确地模拟「模型超时」「检索中断」这两类失败，
 * 而不是靠改环境变量去碰运气。生产调用一律不传，行为不变。
 */
export interface SubmitLiveCommentOptions {
  provider?: AIProvider;
  search?: (params: KnowledgeSearchParams) => Promise<KnowledgeChunkSearchHit[]>;
  /** 由经营大脑触发时关联到对应工作流 */
  workflowId?: string | null;
  signal?: AbortSignal;
}

export interface SubmitLiveCommentResult {
  /** 落库后的评论（含 AI 分类结果） */
  comment: LiveComment;
  /** AI 建议；AI 失败时为 null */
  suggestion: LiveSuggestion | null;
  /**
   * AI 处理失败的原因；成功为 null。
   * 返回 `ok` 时它非 null 表示「评论已保存，但 AI 这次没答上来」——
   * 界面据此显示可重试提示，而不是当成发送失败。
   *
   * 用 `AppErrorShape`（可序列化结构）而非 `AppError`（Error 子类）：
   * 这个值要经 Server Action 送回客户端，Error 实例跨不了 RSC 边界。
   * 与 `SendCustomerMessageResult.failure` 是同一个约定。
   */
  failure: AppErrorShape | null;
  warnings: string[];
}

/** 收口任务记录；写失败不上抛（观测缺一条，不该让主播看到错误页） */
async function closeAgentTask(
  repositories: Repositories,
  taskId: string | null,
  patch: Parameters<Repositories["agentTasks"]["update"]>[1],
): Promise<boolean> {
  if (taskId === null) {
    return false;
  }
  const updated = await attempt(
    () => repositories.agentTasks.update(taskId, patch),
    (cause) => toAppError(cause, "DB_ERROR", "更新直播分析任务失败"),
  );
  return updated.ok;
}

export async function submitLiveComment(
  input: SubmitLiveCommentInput,
  options: SubmitLiveCommentOptions = {},
): Promise<Result<SubmitLiveCommentResult>> {
  const content = input.content?.trim() ?? "";
  if (content.length === 0) {
    return fail("VALIDATION_FAILED", "评论内容不能为空");
  }
  if (content.length > MAX_LIVE_COMMENT_LENGTH) {
    return fail(
      "VALIDATION_FAILED",
      `评论过长，请控制在 ${MAX_LIVE_COMMENT_LENGTH} 字以内`,
      `长度为 ${content.length} 字`,
    );
  }

  const businessId = await resolveActiveBusinessId(input.businessId);
  if (!businessId.ok) {
    return businessId;
  }

  const repositories = getRepositories();
  /** ① 场次必须存在且正在进行 */
  const session = await attempt(
    () => repositories.live.getSession(),
    (cause) => toAppError(cause, "DB_ERROR", "加载直播场次失败"),
  );
  if (!session.ok) {
    return session;
  }
  if (!session.data) {
    return fail("NOT_FOUND", "当前没有直播场次", "请先开始一场模拟直播。");
  }
  if (session.data.status === "ended") {
    return fail(
      "VALIDATION_FAILED",
      "直播已结束，无法继续提交评论",
      "请重新开始一场模拟直播。",
    );
  }
  /**
   * 调用方传的场次必须就是当前场次。
   *
   * 为什么值得拦一下：页面渲染时拿到的是 `live_001`，但主播可能在另一个标签页里
   * 结束了它、甚至重开了一场。这时若"以最新场次为准"静默把评论挂到新场次上，
   * 评论会出现在一个主播没在看的直播里 —— 界面显示发送成功，实际错位。
   * 直接要求刷新，比默默接受更安全。
   */
  if (input.sessionId && input.sessionId !== session.data.id) {
    return fail(
      "VALIDATION_FAILED",
      "直播场次已发生变化",
      `请求的场次 ${input.sessionId} 不是当前场次 ${session.data.id}。请刷新页面后重试。`,
    );
  }
  const liveSession = session.data;

  /** ② 写入评论。成功后无论后面发生什么，它都会留在流里 */
  const savedComment = await attempt(
    () =>
      repositories.live.appendComment({
        sessionId: liveSession.id,
        authorName: input.authorName?.trim() || DEFAULT_LIVE_AUTHOR,
        content,
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存直播评论失败"),
  );
  if (!savedComment.ok) {
    return savedComment;
  }

  return analyzeSavedComment(repositories, liveSession, businessId.data, savedComment.data, options);
}

/** Retry the original saved question, including after the current rehearsal ends. */
export async function retryLiveComment(
  input: { commentId: string; businessId?: string },
  options: SubmitLiveCommentOptions = {},
): Promise<Result<SubmitLiveCommentResult>> {
  if (!input.commentId?.trim()) return fail("VALIDATION_FAILED", "请选择需要重新分析的问题");
  const businessId = await resolveActiveBusinessId(input.businessId);
  if (!businessId.ok) return businessId;
  const repositories = getRepositories();
  const loaded = await attempt(async () => {
    const session = await repositories.live.getSession();
    if (!session) return null;
    const comments = await repositories.live.listComments(session.id);
    const comment = comments.find((item) => item.id === input.commentId);
    return comment ? { session, comment } : null;
  }, (cause) => toAppError(cause, "DB_ERROR", "加载彩排问题失败"));
  if (!loaded.ok) return loaded;
  if (!loaded.data) return fail("NOT_FOUND", "当前彩排中找不到这个问题，请刷新页面");
  return analyzeSavedComment(repositories, loaded.data.session, businessId.data, loaded.data.comment, options);
}

// Coalesce simultaneous clicks in this server process; repository writes are also atomic.
const pendingCommentAnalyses = new Map<string, Promise<Result<SubmitLiveCommentResult>>>();

async function analyzeSavedComment(
  repositories: Repositories,
  session: LiveSession,
  businessId: string,
  comment: LiveComment,
  options: SubmitLiveCommentOptions,
): Promise<Result<SubmitLiveCommentResult>> {
  const key = `${businessId}:${session.id}:${comment.id}`;
  const pending = pendingCommentAnalyses.get(key);
  if (pending) return pending;
  const analysis = attempt(async () => {
    const existing = await repositories.live.findSuggestionByComment(comment.id);
    // Successful questions are reused, not charged and counted again.
    if (existing?.failureMessage === null) {
      return ok({ comment, suggestion: existing, failure: null, warnings: [] });
    }
    return processLiveComment(repositories, session, businessId, comment, options);
  }, (cause) => toAppError(cause, "DB_ERROR", "分析彩排问题失败")).then((result) => result.ok ? result.data : result);
  pendingCommentAnalyses.set(key, analysis);
  try { return await analysis; }
  finally { if (pendingCommentAnalyses.get(key) === analysis) pendingCommentAnalyses.delete(key); }
}

async function processLiveComment(
  repositories: Repositories,
  liveSession: LiveSession,
  businessId: string,
  savedComment: LiveComment,
  options: SubmitLiveCommentOptions,
): Promise<Result<SubmitLiveCommentResult>> {
  const content = savedComment.content;
  const startedAt = Date.now();
  const warnings: string[] = [];

  /**
   * ③ 建任务记录（running）再跑 Agent。
   * 顺序不能反：先跑完再建就只能拍一个假耗时，且失败时拿不到 taskId。
   */
  const createdTask = await attempt(
    () =>
      repositories.agentTasks.create({
        agentType: LIVE_AGENT_TYPE,
        title: AGENT_TASK_TITLE,
        workflowId: options.workflowId ?? null,
        productId: liveSession.productId,
        status: "running",
        progress: 10,
        input: {
          sessionId: liveSession.id,
          productId: liveSession.productId,
          commentHash: buildQuestionHash(content),
        },
      }),
    (cause) => toAppError(cause, "DB_ERROR", "创建直播分析任务失败"),
  );
  if (!createdTask.ok) {
    warnings.push("直播分析任务记录未能创建，请从服务端日志排查。");
  }
  const taskId = createdTask.ok ? createdTask.data.id : null;

  const context = await attempt(() => Promise.all([
      repositories.products.getById(liveSession.productId),
      repositories.productDna.getByProductId(liveSession.productId),
      repositories.brand.getProfile(),
    ]), (cause) => toAppError(cause, "DB_ERROR", "加载彩排商品资料失败"));
  if (!context.ok) {
    await closeAgentTask(repositories, taskId, {
      status: "failed", durationMs: Date.now() - startedAt, errorMessage: context.error.message,
    });
    return context;
  }
  const [product, productDna, brandProfile] = context.data;

  /** 商品被删的极端情况：明确报错，不让检索在缺少商品上下文时继续 */
  if (!product) {
    await closeAgentTask(repositories, taskId, {
      status: "failed",
      durationMs: Date.now() - startedAt,
      errorMessage: "直播绑定的商品已不存在",
    });
    return fail(
      "NOT_FOUND",
      "直播绑定的商品已不存在",
      `productId=${liveSession.productId}。请重新选择商品并开始一场直播。`,
    );
  }

  /** ④ 跑 Live Agent —— 评论原文是唯一可信输入的来源，此处不再做拼接信任 */
  const run = await runLiveAgent(
    {
      comment: content,
      businessId,
      product,
      productDna,
      brandProfile,
    },
    {
      ...(options.provider ? { provider: options.provider } : {}),
      search:
        options.search ??
        ((params) => repositories.knowledgeChunks.searchSimilar(params)),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  const durationMs = Date.now() - startedAt;

  /** ⑤ 失败分支：评论保留，写一条 failure 建议，任务记 failed */
  if (!run.ok) {
    const detail = run.error.detail ? `（${run.error.detail}）` : "";
    await closeAgentTask(repositories, taskId, {
      status: "failed",
      durationMs,
      errorMessage: `${run.error.message}${detail}`,
    });

    const failureSuggestion = await attempt(
      () =>
        repositories.live.appendSuggestion({
          commentId: savedComment.id,
          commentContent: content,
          // 失败建议的枚举字段用最小安全值：它不会被当成有效建议展示
          intent: "other",
          priority: "low",
          shouldRespond: false,
          responseMode: "ignore",
          hostSuggestion: "AI 直播导演暂时不可用，请稍后重试。",
          suggestedReply: "",
          sellingAngle: null,
          grounded: false,
          citations: [],
          recommendedAction: "ignore",
          riskNotes: [],
          confidence: 0,
          durationMs,
          failureMessage: run.error.message,
        }),
      (cause) => toAppError(cause, "DB_ERROR", "保存直播失败记录失败"),
    );

    return ok({
      comment: savedComment,
      suggestion: failureSuggestion.ok ? failureSuggestion.data : null,
      failure: run.error,
      warnings,
    });
  }

  const { result } = run.data;

  /** ⑥ 先持久保存建议，再将评论标为已处理，避免保存失败却显示已完成。 */
  const savedSuggestion = await attempt(
    () =>
      repositories.live.appendSuggestion({
        commentId: savedComment.id,
        commentContent: content,
        intent: result.intent,
        priority: result.priority,
        shouldRespond: result.shouldRespond,
        responseMode: result.responseMode,
        hostSuggestion: result.hostSuggestion,
        suggestedReply: result.suggestedReply,
        sellingAngle: result.sellingAngle,
        grounded: result.grounded,
        citations: result.citations,
        recommendedAction: result.recommendedAction,
        riskNotes: result.riskNotes,
        confidence: result.confidence,
        durationMs,
        failureMessage: null,
      }),
    (cause) => toAppError(cause, "DB_ERROR", "保存直播建议失败"),
  );

  if (!savedSuggestion.ok) {
    await closeAgentTask(repositories, taskId, {
      status: "failed", durationMs, errorMessage: savedSuggestion.error.message,
    });
    return ok({ comment: savedComment, suggestion: null, failure: savedSuggestion.error, warnings });
  }
  const updatedComment = await attempt(
    () => repositories.live.updateComment(savedComment.id, {
      intent: result.intent, priority: result.priority, handled: true,
    }),
    (cause) => toAppError(cause, "DB_ERROR", "更新直播评论失败"),
  );
  if (!updatedComment.ok) warnings.push("回答建议已保存，但问题状态未能更新，请刷新页面核对。");

  await closeAgentTask(repositories, taskId, {
    status: "completed",
    progress: 100,
    durationMs,
    output: {
      intent: result.intent,
      priority: result.priority,
      grounded: result.grounded,
      recommendedAction: result.recommendedAction,
      citationCount: result.citations.length,
      durationMs,
    },
  });

  warnings.push(...run.data.warnings);

  return ok({
    comment: updatedComment.ok ? updatedComment.data : savedComment,
    suggestion: savedSuggestion.data,
    failure: null,
    warnings,
  });
}

/* ------------------------------------------------------------------ */
/* 状态读取                                                            */
/* ------------------------------------------------------------------ */

/**
 * 读取当前直播状态。
 *
 * 与 `getLiveView` 是同一份装配（刻意不写第二套统计口径）——
 * 保留这个入口是为了对齐任务书第十六节的接口命名，
 * 后续若要做「只刷新右栏」的窄接口，也只需在这里收窄。
 */
export async function getLiveSessionState(): Promise<Result<LiveView>> {
  return getLiveView();
}

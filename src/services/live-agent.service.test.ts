/**
 * AI 直播导演 Service 闭环单测（S6 · 任务书第十六 / 十七 / 三十三 / 三十四节）
 *
 * 这组用例的重心不是「能不能拿到一条建议」，而是**出错时留下了什么**：
 *
 * 1. **评论一旦进入评论流就一定保留**（第三十四节）。模型超时属于系统故障，
 *    它的正确表现是「评论还在、建议位置如实写『AI 暂时不可用』、任务记 failed」，
 *    而不是「整次发送失败」或「评论消失」。
 * 2. **失败不污染业务数据**。AI 处理失败不增加 `aiHandledCount`，
 *    评论也不该被标成「AI 已响应」。
 * 3. **Agent Task 只记索引，不记评论原文**（第三十三节）。`input` 里只有哈希。
 *
 * 链路用 Mock Provider，但切片、向量化、检索、引用校验都是**真实执行**的。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider } from "@/ai/provider/types";
import { resetServerEnvCache } from "@/lib/env";
import { MOCK_BUSINESS, MOCK_LIVE_PRODUCT_ID } from "@/lib/mock";
import { AppError, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";
import {
  clearStoredAgentTasks,
  listStoredAgentTasks,
  resetStoredKnowledge,
  resetStoredLive,
} from "@/repositories/mock/store";

import { listKnowledgeDocuments, reindexKnowledgeDocument } from "./knowledge.service";
import {
  DEFAULT_LIVE_AUTHOR,
  endLiveSession,
  startDemoLiveSession,
  submitLiveComment,
  retryLiveComment,
} from "./live-agent.service";

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const BUSINESS_ID = MOCK_BUSINESS.id;
const repositories = getRepositories();

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${JSON.stringify(result.error)}`);
  }
  return result.data;
}

/** 把种子文档跑一遍真实索引流程（切片 → 向量 → 写切片表 → 标记 indexed） */
async function indexAllDocuments(): Promise<void> {
  const listed = await listKnowledgeDocuments();
  if (!listed.ok) {
    throw new Error(`加载种子知识失败：${listed.error.message}`);
  }
  for (const document of listed.data) {
    const reindexed = await reindexKnowledgeDocument(document.id);
    if (!reindexed.ok) {
      throw new Error(
        `索引种子知识「${document.name}」失败：${reindexed.error.code} ${reindexed.error.message}`,
      );
    }
  }
}

/** 直播导演的任务记录（按创建时间正序） */
function liveAgentTasks() {
  return listStoredAgentTasks()
    .filter((task) => task.agentType === "live_agent")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** 一个「生成阶段超时」的 Provider（检索照常，模型调用失败） */
function timeoutProvider(): AIProvider {
  return {
    ...createMockAIProvider(),
    generateText: async () => {
      throw new AppError({
        code: "MODEL_TIMEOUT",
        message: "模型响应超时",
        detail: "请求超过 90s 未返回",
      });
    },
  };
}

/**
 * 当前场次。
 *
 * 注意 `repositories.live.getSession()` 返回的是**领域对象或 null**，
 * 不是 `Result` —— 仓储层已把「没有场次」建模成合法状态，
 * 因此这里只负责把 null 变成「种子数据坏了」的测试错误。
 */
async function currentSession() {
  const session = await repositories.live.getSession();
  if (!session) {
    throw new Error("种子数据应包含一场进行中的直播");
  }
  return session;
}

/** 当前场次 id */
async function currentSessionId(): Promise<string> {
  return (await currentSession()).id;
}

beforeEach(async () => {
  resetStoredKnowledge();
  resetStoredLive();
  clearStoredAgentTasks();
  await indexAllDocuments();
});

describe("retryLiveComment · 原问题重试", () => {
  it("网络恢复后更新原建议，评论与处理数都不重复", async () => {
    const sessionId = await currentSessionId();
    const failed = unwrap(await submitLiveComment(
      { sessionId, content: "这个鲍鱼怎么保存？" }, { provider: timeoutProvider() },
    ));
    const before = await currentSession();
    const retried = unwrap(await retryLiveComment({ commentId: failed.comment.id }));
    expect(retried.failure).toBeNull();
    expect(retried.comment.id).toBe(failed.comment.id);
    expect(retried.comment.handled).toBe(true);
    expect(retried.suggestion?.id).toBe(failed.suggestion?.id);
    expect(retried.suggestion?.grounded).toBe(true);
    expect(retried.suggestion?.citations.length).toBeGreaterThan(0);
    expect((await repositories.live.listSuggestions(sessionId)).filter((item) => item.commentId === failed.comment.id)).toHaveLength(1);
    const after = await currentSession();
    expect(after.commentsCount).toBe(before.commentsCount);
    expect(after.aiHandledCount).toBe(before.aiHandledCount + 1);

    const provider = createMockAIProvider();
    const generateText = vi.fn(provider.generateText.bind(provider));
    const reused = unwrap(await retryLiveComment({ commentId: failed.comment.id }, { provider: { ...provider, generateText } }));
    expect(reused.suggestion?.id).toBe(retried.suggestion?.id);
    expect(generateText).not.toHaveBeenCalled();
    expect((await currentSession()).aiHandledCount).toBe(after.aiHandledCount);
  });

  it("重复失败保留同一条记录，结束后仍能补做分析", async () => {
    const sessionId = await currentSessionId();
    const failed = unwrap(await submitLiveComment(
      { sessionId, content: "这个鲍鱼怎么保存？" }, { provider: timeoutProvider() },
    ));
    unwrap(await endLiveSession(sessionId));
    const again = unwrap(await retryLiveComment({ commentId: failed.comment.id }, { provider: timeoutProvider() }));
    expect(again.failure?.code).toBe("MODEL_TIMEOUT");
    expect(again.suggestion?.id).toBe(failed.suggestion?.id);
    expect((await repositories.live.listSuggestions(sessionId)).filter((item) => item.commentId === failed.comment.id)).toHaveLength(1);
    expect((await currentSession()).aiHandledCount).toBe(0);
    expect(unwrap(await retryLiveComment({ commentId: failed.comment.id })).failure).toBeNull();
  });

  it("同时重试只执行一轮模型分析", async () => {
    const sessionId = await currentSessionId();
    const failed = unwrap(await submitLiveComment(
      { sessionId, content: "这个鲍鱼怎么保存？" }, { provider: timeoutProvider() },
    ));
    const provider = createMockAIProvider();
    const generateText = vi.fn(provider.generateText.bind(provider));
    const options = { provider: { ...provider, generateText } };
    const results = await Promise.all([
      retryLiveComment({ commentId: failed.comment.id }, options),
      retryLiveComment({ commentId: failed.comment.id }, options),
    ]);
    expect(results.every((result) => result.ok && result.data.failure === null)).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect((await currentSession()).aiHandledCount).toBe(1);
  });

  it("拒绝不存在或不属于当前场次的问题", async () => {
    expect((await retryLiveComment({ commentId: "" })).ok).toBe(false);
    const missing = await retryLiveComment({ commentId: "comment_other_merchant" });
    expect(!missing.ok && missing.error.code).toBe("NOT_FOUND");
    const previous = unwrap(await submitLiveComment(
      { sessionId: await currentSessionId(), content: "这个鲍鱼怎么保存？" }, { provider: timeoutProvider() },
    ));
    unwrap(await startDemoLiveSession({ productId: MOCK_LIVE_PRODUCT_ID }));
    const stale = await retryLiveComment({ commentId: previous.comment.id });
    expect(!stale.ok && stale.error.code).toBe("NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ */
/* 场次                                                                */
/* ------------------------------------------------------------------ */

describe("直播场次", () => {
  it("结束直播会把状态置为 ended 并写入结束时间", async () => {
    const sessionId = await currentSessionId();

    const ended = unwrap(await endLiveSession(sessionId));

    expect(ended.status).toBe("ended");
    expect(ended.endedAt).not.toBeNull();
  });

  it("开始模拟直播会绑定商品，并成为当前场次（新场次没有历史评论）", async () => {
    const started = unwrap(
      await startDemoLiveSession({ productId: MOCK_LIVE_PRODUCT_ID }),
    );

    expect(started.status).toBe("live");
    expect(started.productId).toBe(MOCK_LIVE_PRODUCT_ID);
    expect(started.productName).toBe("连江鲜活鲍鱼");

    const current = await currentSession();
    expect(current.id).toBe(started.id);
    // 新场次从零开始：种子评论属于上一场，不该被继承
    expect(await repositories.live.listComments(started.id)).toEqual([]);
    expect(started.commentsCount).toBe(0);
  });

  it("开始直播时商品不存在 -> NOT_FOUND，而不是建一场空场次", async () => {
    const result = await startDemoLiveSession({ productId: "prod_missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 提交评论：正常链路                                                  */
/* ------------------------------------------------------------------ */

describe("submitLiveComment · 正常链路", () => {
  it("评论真的经 Live Agent 分析：带上意图与优先级，建议落库且引用可核查", async () => {
    const sessionId = await currentSessionId();

    const result = unwrap(
      await submitLiveComment({
        sessionId,
        content: "这个鲍鱼怎么保存？能放几天？",
      }),
    );

    expect(result.failure).toBeNull();

    // ① 评论被 AI 真实分类，并标记为已处理
    expect(result.comment.intent).toBe("storage_question");
    expect(result.comment.priority).toBe("high");
    expect(result.comment.handled).toBe(true);
    // 未填昵称时用明确的演示身份，不伪装成真实用户
    expect(result.comment.authorName).toBe(DEFAULT_LIVE_AUTHOR);

    // ② 建议来自知识依据，而不是一段编出来的话术
    expect(result.suggestion).not.toBeNull();
    expect(result.suggestion?.grounded).toBe(true);
    expect(result.suggestion?.failureMessage).toBeNull();
    expect(result.suggestion?.citations.length).toBeGreaterThan(0);
    expect(
      result.suggestion?.citations.map((citation) => citation.title),
    ).toContain("鲜活鲍鱼储存说明");
  });

  it("评论数 +1、AI 处理数 +1，且建议只有一条（不堆叠卡片）", async () => {
    const sessionId = await currentSessionId();
    const before = await currentSession();

    const result = unwrap(
      await submitLiveComment({ sessionId, content: "这个鲍鱼怎么保存？" }),
    );

    const after = await currentSession();
    expect(after.commentsCount).toBe(before.commentsCount + 1);
    expect(after.aiHandledCount).toBe(before.aiHandledCount + 1);

    const comments = await repositories.live.listComments(sessionId);
    expect(comments.some((comment) => comment.id === result.comment.id)).toBe(true);

    const suggestions = await repositories.live.listSuggestions(sessionId);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.commentId).toBe(result.comment.id);
  });

  it("任务记录：agent_type 为 live_agent、记 completed，且**只存哈希不存评论原文**", async () => {
    const sessionId = await currentSessionId();
    const content = "这个鲍鱼怎么保存？能放几天？";

    unwrap(await submitLiveComment({ sessionId, content }));

    const tasks = liveAgentTasks();
    expect(tasks).toHaveLength(1);

    const task = tasks[0]!;
    expect(task.status).toBe("completed");
    expect(task.productId).toBe(MOCK_LIVE_PRODUCT_ID);
    expect(task.durationMs).toBeGreaterThanOrEqual(0);

    // input 只记索引：场次 / 商品 / 评论指纹
    expect(task.input?.sessionId).toBe(sessionId);
    expect(task.input?.productId).toBe(MOCK_LIVE_PRODUCT_ID);
    expect(String(task.input?.commentHash)).toMatch(/^[0-9a-f]{64}$/);
    // 评论原文不得进任务日志
    expect(JSON.stringify(task.input)).not.toContain(content);
    expect(JSON.stringify(task)).not.toContain(content);

    // output 是结构化结论，供观测与排障
    expect(task.output?.intent).toBe("storage_question");
    expect(task.output?.grounded).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 提交评论：失败分支                                                  */
/* ------------------------------------------------------------------ */

describe("submitLiveComment · 失败语义", () => {
  it("模型超时 -> 评论保留、建议如实写失败、任务记 failed、不污染计数", async () => {
    const sessionId = await currentSessionId();
    const content = "今晚下单明天能到吗？";

    const result = unwrap(
      await submitLiveComment({ sessionId, content }, { provider: timeoutProvider() }),
    );

    // ① 这是「已保存但 AI 没答上来」，不是发送失败
    expect(result.failure?.code).toBe("MODEL_TIMEOUT");

    // ② 评论必须还在，且**不得**被标成已处理（AI 并没有处理成功）
    expect(result.comment.content).toBe(content);
    expect(result.comment.intent).toBeNull();
    expect(result.comment.priority).toBeNull();
    expect(result.comment.handled).toBe(false);

    const comments = await repositories.live.listComments(sessionId);
    expect(comments.some((comment) => comment.id === result.comment.id)).toBe(true);

    // ③ 建议位置如实显示失败，而不是伪造一条空建议
    expect(result.suggestion).not.toBeNull();
    expect(result.suggestion?.failureMessage).toContain("模型响应超时");
    expect(result.suggestion?.grounded).toBe(false);
    expect(result.suggestion?.citations).toHaveLength(0);
    expect(result.suggestion?.confidence).toBe(0);

    // ④ 任务记 failed，错误原因可读
    const tasks = liveAgentTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("failed");
    expect(tasks[0]?.errorMessage ?? "").toContain("模型响应超时");

    // ⑤ 失败不增加 AI 处理数；评论数照常 +1（评论确实存下来了）
    const after = await currentSession();
    expect(after.aiHandledCount).toBe(0);
    expect(after.commentsCount).toBe(7);
  });

  it("检索层报错同样只影响 AI 结论，评论不受影响", async () => {
    const sessionId = await currentSessionId();

    const result = unwrap(
      await submitLiveComment(
        { sessionId, content: "这个鲍鱼怎么保存？" },
        {
          search: async () => {
            throw new Error("模拟：向量检索时数据库连接中断");
          },
        },
      ),
    );

    expect(result.failure?.code).toBe("DB_ERROR");
    expect(result.comment.handled).toBe(false);
    expect(result.suggestion?.failureMessage).not.toBeNull();
    expect(liveAgentTasks()[0]?.status).toBe("failed");
  });

  it("直播已结束 -> 拒绝提交，且不留下任何评论", async () => {
    const sessionId = await currentSessionId();
    unwrap(await endLiveSession(sessionId));

    const before = await currentSession();
    const result = await submitLiveComment({ sessionId, content: "还有货吗？" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
    }

    const after = await currentSession();
    expect(after.commentsCount).toBe(before.commentsCount);
    // 拒绝得足够早：连任务记录都不该建
    expect(liveAgentTasks()).toHaveLength(0);
  });

  it("提交的场次不是当前场次 -> 拒绝，避免评论错位到主播没在看的那一场", async () => {
    const result = await submitLiveComment({
      sessionId: "live_stale_999",
      content: "这个鲍鱼怎么保存？",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.message).toContain("场次");
    }
    expect(liveAgentTasks()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 提交评论：输入校验                                                  */
/* ------------------------------------------------------------------ */

describe("submitLiveComment · 输入校验", () => {
  it("空评论 / 超长评论直接拒绝，不浪费一次模型调用", async () => {
    const sessionId = await currentSessionId();

    const empty = await submitLiveComment({ sessionId, content: "   " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("VALIDATION_FAILED");
    }

    const tooLong = await submitLiveComment({
      sessionId,
      content: "鲍".repeat(501),
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.error.code).toBe("VALIDATION_FAILED");
    }

    // 两次都在校验层被拦下，没有产生任何任务记录
    expect(liveAgentTasks()).toHaveLength(0);
  });

  it("可以自定义观众昵称", async () => {
    const sessionId = await currentSessionId();

    const result = unwrap(
      await submitLiveComment({
        sessionId,
        content: "这个鲍鱼怎么保存？",
        authorName: "海味爱好者",
      }),
    );

    expect(result.comment.authorName).toBe("海味爱好者");
  });

  it("指定 businessId 时按该商家检索（与当前商家一致）", async () => {
    const sessionId = await currentSessionId();

    const result = unwrap(
      await submitLiveComment({
        sessionId,
        content: "这个鲍鱼怎么保存？",
        businessId: BUSINESS_ID,
      }),
    );

    expect(result.suggestion?.grounded).toBe(true);
  });
});

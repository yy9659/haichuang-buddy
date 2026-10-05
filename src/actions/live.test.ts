/**
 * AI 直播导演 Server Actions 单测（S6 · 任务书第三十一 / 三十二 / 三十三节）
 *
 * 这一层只有三件事：**收参数 → 调服务 → 失效缓存**。测试因此围绕三条纪律：
 *
 * 1. **模型层的 `detail` 不许进浏览器**。`failure` 来自模型通道，它的 detail
 *    可能夹着模型原始输出与提示词片段，而直播在检索时会把企业内部知识片段
 *    拼进提示词 —— 那些东西一旦进浏览器，控制台就成了知识库导出工具。
 * 2. **评论落库后即使 AI 失败也要刷新**。左栏评论流已经变了，
 *    不刷新会让主播以为评论没发出去。
 * 3. **缓存失效只在真的改了东西之后**。校验失败时库里什么都没变。
 *
 * `next/cache` 用假实现替换：本层不测 Next 的缓存机制，只测「调没调、调了什么」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { resetServerEnvCache } from "@/lib/env";
import { MOCK_LIVE_PRODUCT_ID } from "@/lib/mock";
import { getRepositories } from "@/repositories";
import {
  clearStoredAgentTasks,
  resetStoredKnowledge,
  resetStoredLive,
} from "@/repositories/mock/store";

import {
  endLiveSessionAction,
  startLiveSessionAction,
  submitLiveCommentAction,
  retryLiveCommentAction,
} from "./live";

/**
 * 本文件一律跑在 Mock 数据源 + Mock 模型上。
 *
 * 注意这里**不**保存 / 还原「环境里原本的值」：`vitest.config.mts` 会把 `.env.local`
 * 注入 `process.env`，而本地开发用的正是 `AI_PROVIDER=dashscope`。若 afterEach 把它
 * 还原回去，那么从第二个用例开始就会**真的去连线上模型** —— 测试变慢、并且会因为
 * 模型偶发的结构校验失败而随机翻红。用例自己会按需覆盖（如「未接入的提供方」用例），
 * afterEach 则统一把状态钉回本文件声明的基准。
 */
process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const repositories = getRepositories();

function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.error.code} ${result.error.message}`);
  }
  return result.data;
}

async function currentSessionId(): Promise<string> {
  const session = await repositories.live.getSession();
  if (!session) {
    throw new Error("种子数据应包含一场进行中的直播");
  }
  return session.id;
}

beforeEach(() => {
  resetStoredKnowledge();
  resetStoredLive();
  clearStoredAgentTasks();
  revalidatePathMock.mockClear();
});

afterEach(() => {
  // 回到本文件的基准：Mock 数据源 + 未指定提供方（= Mock 模型）
  process.env.DATA_SOURCE = "mock";
  delete process.env.AI_PROVIDER;
  resetServerEnvCache();
});

/* ------------------------------------------------------------------ */
/* 场次动作                                                            */
/* ------------------------------------------------------------------ */

describe("场次相关 Action", () => {
  it("开始模拟直播后同时失效 /live 与 /dashboard（驾驶舱卡片读同一份数据）", async () => {
    const started = unwrap(
      await startLiveSessionAction({ productId: MOCK_LIVE_PRODUCT_ID }),
    );

    expect(started.status).toBe("live");
    expect(started.productId).toBe(MOCK_LIVE_PRODUCT_ID);
    expect(revalidatePathMock).toHaveBeenCalledWith("/live");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  it("商品不存在时失败，且不失效缓存", async () => {
    revalidatePathMock.mockClear();

    const result = await startLiveSessionAction({ productId: "prod_missing" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("NOT_FOUND");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("结束直播后失效缓存并返回 ended", async () => {
    const sessionId = await currentSessionId();
    revalidatePathMock.mockClear();

    const ended = unwrap(await endLiveSessionAction(sessionId));

    expect(ended.status).toBe("ended");
    expect(ended.endedAt).not.toBeNull();
    expect(revalidatePathMock).toHaveBeenCalledWith("/live");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });
});

/* ------------------------------------------------------------------ */
/* 提交评论动作                                                        */
/* ------------------------------------------------------------------ */

describe("submitLiveCommentAction", () => {
  it("重试失败问题不重复录入，且不向浏览器泄露错误 detail", async () => {
    process.env.AI_PROVIDER = "openai";
    resetServerEnvCache();
    const failed = unwrap(await submitLiveCommentAction({ sessionId: await currentSessionId(), content: "这个鲍鱼怎么保存？" }));
    const retried = unwrap(await retryLiveCommentAction(failed.comment.id));
    expect(retried.comment.id).toBe(failed.comment.id);
    expect(retried.suggestion?.id).toBe(failed.suggestion?.id);
    expect(retried.failure?.detail).toBeUndefined();
    expect(revalidatePathMock).toHaveBeenCalledWith("/live");
    expect((await repositories.live.getSession())?.commentsCount).toBe(7);
  });

  it("成功时返回评论与建议，并失效缓存", async () => {
    const sessionId = await currentSessionId();
    revalidatePathMock.mockClear();

    const result = unwrap(
      await submitLiveCommentAction({
        sessionId,
        content: "这个鲍鱼怎么保存？",
      }),
    );

    expect(result.comment.content).toBe("这个鲍鱼怎么保存？");
    expect(result.suggestion).not.toBeNull();
    expect(result.failure).toBeNull();
    expect(revalidatePathMock).toHaveBeenCalledWith("/live");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
  });

  it("模型不可用：评论已落库 -> 仍然 ok，但 failure 的 detail 必须被剥掉", async () => {
    const sessionId = await currentSessionId();

    /**
     * 用一个**未接入**的提供方强制走失败分支：`getAIProvider()` 会抛带 detail 的
     * AppError，而那份 detail 里写着我们的配置指引（本地开发场景下无伤，
     * 但它证明了「detail 会流出去」这条通道确实存在）。
     * 真实模型通道的 detail 则是模型原始输出 + 提示词片段 —— 那才是要挡住的东西。
     */
    process.env.AI_PROVIDER = "openai";
    resetServerEnvCache();
    revalidatePathMock.mockClear();

    const result = unwrap(
      await submitLiveCommentAction({ sessionId, content: "这个鲍鱼怎么保存？" }),
    );

    // ① 评论确实存下来了，因此这次调用本身是 ok 的
    expect(result.comment.content).toBe("这个鲍鱼怎么保存？");
    expect(revalidatePathMock).toHaveBeenCalledWith("/live");

    // ② failure 存在，但**不含 detail**
    expect(result.failure).not.toBeNull();
    expect(result.failure?.detail).toBeUndefined();
    // 保留可判定的字段：错误码 / 中文提示 / 是否可重试
    expect(result.failure?.code).toBe("NOT_IMPLEMENTED");
    expect(result.failure?.message.length).toBeGreaterThan(0);
    expect(result.failure?.retryable).toBe(false);

    // ③ 建议位置如实记录失败，界面据此显示可重试提示
    expect(result.suggestion?.failureMessage).not.toBeNull();
  });

  it("校验失败（空评论）：不 ok，且不失效缓存", async () => {
    const sessionId = await currentSessionId();
    revalidatePathMock.mockClear();

    const result = await submitLiveCommentAction({ sessionId, content: "   " });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("直播已结束：不 ok，且不失效缓存", async () => {
    const sessionId = await currentSessionId();
    unwrap(await endLiveSessionAction(sessionId));
    revalidatePathMock.mockClear();

    const result = await submitLiveCommentAction({
      sessionId,
      content: "还有货吗？",
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("VALIDATION_FAILED");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

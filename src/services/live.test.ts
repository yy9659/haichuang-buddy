/**
 * AI 直播间视图装配单测（S6 · 任务书第二十四 / 二十五 / 二十八 / 四十二 / 四十三节）
 *
 * 这组用例盯住两件事：
 * 1. **真实指标与模拟指标彻底分开** —— `realMetrics` 全部由本场数据实时算出，
 *    `simulatedStats` 明确是演示数据，两者不共用一套口径；
 * 2. **提词器来自真实数据** —— 商品卖点取自 Product DNA、品牌语气取自 Brand Profile、
 *    最新话术取自真实产出的高优先级建议，而不是一段写死的脚本。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createMockAIProvider } from "@/ai/provider/mock";
import { resetServerEnvCache } from "@/lib/env";
import { getRepositories } from "@/repositories";
import {
  clearStoredBrandProfile,
  resetStoredKnowledge,
  resetStoredLive,
} from "@/repositories/mock/store";
import type { LiveComment, LiveSuggestion } from "@/types";

import { listKnowledgeDocuments, reindexKnowledgeDocument } from "./knowledge.service";
import { submitLiveComment } from "./live-agent.service";
import { computeRealMetrics, getLiveView } from "./live";

process.env.DATA_SOURCE = "mock";
delete process.env.AI_PROVIDER;
resetServerEnvCache();

const repositories = getRepositories();

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${JSON.stringify(result.error)}`);
  }
  return result.data;
}

async function indexAllDocuments(): Promise<void> {
  const listed = await listKnowledgeDocuments();
  if (!listed.ok) {
    throw new Error(`加载种子知识失败：${listed.error.message}`);
  }
  for (const document of listed.data) {
    const reindexed = await reindexKnowledgeDocument(document.id);
    if (!reindexed.ok) {
      throw new Error(`索引「${document.name}」失败：${reindexed.error.message}`);
    }
  }
}

async function currentSessionId(): Promise<string> {
  const session = await repositories.live.getSession();
  if (!session) {
    throw new Error("种子数据应包含一场进行中的直播");
  }
  return session.id;
}

let seq = 0;
function makeComment(overrides: Partial<LiveComment> = {}): LiveComment {
  seq += 1;
  return {
    id: `c_${seq}`,
    sessionId: "live_001",
    authorName: "观众",
    content: "内容",
    intent: null,
    priority: null,
    handled: false,
    createdAtText: "19:30",
    ...overrides,
  };
}

function makeSuggestion(overrides: Partial<LiveSuggestion> = {}): LiveSuggestion {
  seq += 1;
  return {
    id: `s_${seq}`,
    commentId: `c_${seq}`,
    commentContent: "评论原文",
    intent: "other",
    priority: "medium",
    shouldRespond: true,
    responseMode: "answer_now",
    hostSuggestion: "建议主播回应。",
    suggestedReply: "感谢关注。",
    sellingAngle: null,
    grounded: false,
    citations: [],
    recommendedAction: "engage_audience",
    riskNotes: [],
    confidence: 0.5,
    durationMs: 100,
    createdAtText: "19:30",
    failureMessage: null,
    ...overrides,
  };
}

beforeEach(async () => {
  resetStoredKnowledge();
  resetStoredLive();
  clearStoredBrandProfile();
  await indexAllDocuments();
});

/* ------------------------------------------------------------------ */
/* 真实指标（纯函数）                                                  */
/* ------------------------------------------------------------------ */

describe("computeRealMetrics", () => {
  it("空输入全是 0", () => {
    expect(computeRealMetrics([], [])).toEqual({
      commentCount: 0,
      aiHandledCount: 0,
      highPriorityCount: 0,
      groundedCount: 0,
    });
  });

  it("评论数按评论流算，与建议条数无关", () => {
    const metrics = computeRealMetrics(
      [makeComment(), makeComment(), makeComment()],
      [makeSuggestion()],
    );
    expect(metrics.commentCount).toBe(3);
  });

  it("AI 处理失败的建议不计入 AI 处理数 / 高优先级 / 有依据", () => {
    const metrics = computeRealMetrics(
      [makeComment(), makeComment(), makeComment()],
      [
        makeSuggestion({ priority: "high", grounded: true }),
        makeSuggestion({
          priority: "high",
          grounded: false,
          failureMessage: "模型响应超时",
        }),
        makeSuggestion({ priority: "low", grounded: false }),
      ],
    );

    // 只有第一条是成功产出的建议
    expect(metrics.aiHandledCount).toBe(2);
    expect(metrics.highPriorityCount).toBe(1);
    expect(metrics.groundedCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* getLiveView 装配                                                    */
/* ------------------------------------------------------------------ */

describe("getLiveView · 初始状态", () => {
  it("种子状态：有场次、有模拟指标、评论全为「未分析」、没有 AI 建议与热点", async () => {
    const view = unwrap(await getLiveView());

    expect(view.session).not.toBeNull();
    expect(view.session?.status).toBe("live");
    expect(view.simulatedStats).not.toBeNull();

    // 种子评论只有昵称与原文，没有任何 AI 结论
    expect(view.comments).toHaveLength(6);
    for (const comment of view.comments) {
      expect(comment.intent).toBeNull();
      expect(comment.priority).toBeNull();
      expect(comment.handled).toBe(false);
    }

    // 因此右栏是空的 —— 这正是「链路是通的」的可观测证据
    expect(view.suggestions).toHaveLength(0);
    expect(view.hotTopics).toHaveLength(0);

    expect(view.realMetrics).toEqual({
      commentCount: 6,
      aiHandledCount: 0,
      highPriorityCount: 0,
      groundedCount: 0,
    });
  });

  it("提词器如实反映各块依据的有无（缺品牌档案时明确提示，而不是留白）", async () => {
    const view = unwrap(await getLiveView());
    const teleprompter = view.teleprompter;

    expect(teleprompter).not.toBeNull();
    expect(teleprompter?.productName).toBe("连江鲜活鲍鱼");
    // 卖点来自 Product DNA（prod_001 已分析），而不是写死的脚本文案
    expect(teleprompter?.sellingPoints.length).toBeGreaterThan(0);
    expect(teleprompter?.dnaNotice).toBeNull();

    // 品牌档案尚未生成（Mock 不预置假档案）-> 如实提示，而不是假装有语气
    expect(teleprompter?.brandTone).toHaveLength(0);
    expect(teleprompter?.brandNotice).not.toBeNull();

    // 还没有任何建议
    expect(teleprompter?.latestSuggestion).toBeNull();
  });

  it("生成品牌档案后，提词器的品牌语气随之出现（来源确实接的是 Brand Profile）", async () => {
    await repositories.brand.create({
      positioning: "连江本地海产直供",
      brandStory: "从渔港到餐桌。",
      slogan: "把连江的海，端上你的桌。",
      ipConcept: "陈老板的海边日常",
      brandValues: ["真诚"],
      targetAudience: ["年轻家庭"],
      brandPersonality: ["实在", "热情"],
      toneOfVoice: ["口语化", "像邻居介绍一样自然"],
      visualKeywords: ["海雾蓝", "渔港"],
      riskNotes: ["避免绝对化用语"],
      aiVersion: "v1.0",
      confidence: 0.7,
      approved: true,
    });

    const view = unwrap(await getLiveView());
    expect(view.teleprompter?.brandTone).toEqual(["口语化", "像邻居介绍一样自然"]);
    expect(view.teleprompter?.brandNotice).toBeNull();
  });

  it("快捷评论非空，且商品选项把「已分析」的排在前面", async () => {
    const view = unwrap(await getLiveView());

    expect(view.quickComments.length).toBeGreaterThan(0);

    const first = view.products[0];
    expect(first?.hasDna).toBe(true);
    expect(first?.id).toBe("prod_001");
  });
});

describe("getLiveView · 提交评论后", () => {
  it("真实指标、热点、提词器随评论一起更新", async () => {
    const sessionId = await currentSessionId();

    unwrap(
      await submitLiveComment({
        sessionId,
        content: "这个鲍鱼怎么保存？能放几天？",
      }),
    );

    const view = unwrap(await getLiveView());

    // 真实指标：评论 +1、AI 已处理 +1、高优先级 +1、有依据 +1
    expect(view.realMetrics).toEqual({
      commentCount: 7,
      aiHandledCount: 1,
      highPriorityCount: 1,
      groundedCount: 1,
    });

    // 模拟指标不受真实评论影响（它没有真实来源，只是演示数据）
    expect(view.simulatedStats?.comments).toBe(613);

    // 热点：只统计已分析的评论，占比由程序算
    expect(view.hotTopics).toHaveLength(1);
    expect(view.hotTopics[0]?.intent).toBe("storage_question");
    expect(view.hotTopics[0]?.count).toBe(1);
    expect(view.hotTopics[0]?.share).toBe(1);

    // 提词器：当前话术换成最新一条高优先级建议
    expect(view.teleprompter?.latestSuggestion).not.toBeNull();
    expect(view.teleprompter?.latestSuggestion?.grounded).toBe(true);
  });

  it("AI 失败时真实指标记为「未处理」，但评论仍在评论流里", async () => {
    const sessionId = await currentSessionId();

    const result = unwrap(
      await submitLiveComment(
        { sessionId, content: "这个鲍鱼怎么保存？" },
        { provider: createMockAIProvider({ scenario: "unavailable" }) },
      ),
    );

    expect(result.failure).not.toBeNull();
    expect(result.suggestion?.failureMessage).not.toBeNull();

    const view = unwrap(await getLiveView());
    expect(view.realMetrics.commentCount).toBe(7);
    expect(view.realMetrics.aiHandledCount).toBe(0);
    expect(view.comments.some((comment) => comment.id === result.comment.id)).toBe(true);
    // 失败的建议不计入热点统计（它没有可信的 AI 分类）
    expect(view.hotTopics).toHaveLength(0);
  });
});

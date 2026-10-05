import { describe, expect, it } from "vitest";

import type { ContentItem, CustomerConversation, Product } from "@/types";

import {
  BUSINESS_SCORE_BASELINES,
  clamp,
  computeBusinessScore,
  computeEngagementRate,
  computeLiveEngagementRate,
  computeQuestionRatio,
  computeTaskCompletionRate,
  roundTo,
  safeDivide,
  summarizeContents,
  summarizeConversations,
  summarizeProducts,
} from "./metrics";

function makeContent(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "content_x",
    productId: "prod_x",
    productName: "测试商品",
    title: "测试内容",
    hook: "",
    body: "",
    cta: "",
    hashtags: [],
    visualSuggestions: [],
    shotList: [],
    voiceover: "",
    platform: "douyin",
    format: "short-video",
    status: "draft",
    createdAt: "2026-09-25 10:00",
    metrics: { views: 0, likes: 0, comments: 0, shares: 0, engagementRate: 0 },
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod_x",
    name: "测试商品",
    description: "",
    category: "海产品",
    subCategory: "鲍鱼",
    price: 100,
    unit: "500g",
    stock: 100,
    origin: "福建连江",
    specification: "8-10 头 / 500g",
    storageMethod: "0-4℃ 冷藏",
    shelfLife: "2 天",
    imageUrl: null,
    analysisStatus: "pending",
    updatedAt: "2026-09-25 10:00",
    metrics: { views: 0, inquiries: 0, conversions: 0 },
    tags: [],
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<CustomerConversation> = {},
): CustomerConversation {
  return {
    id: "conv_x",
    customerName: "客户",
    customerLabel: "抖音 · 新客",
    channel: "douyin",
    lastMessage: "",
    updatedAtText: "刚刚",
    unreadCount: 0,
    status: "bot",
    tags: [],
    productId: null,
    messageCount: 0,
    ...overrides,
  };
}

describe("safeDivide / clamp / roundTo", () => {
  it("分母为 0 或负数时返回 0，不产生 NaN 或 Infinity", () => {
    expect(safeDivide(10, 0)).toBe(0);
    expect(safeDivide(10, -5)).toBe(0);
    expect(safeDivide(0, 0)).toBe(0);
    expect(safeDivide(Number.NaN, 10)).toBe(0);
  });

  it("正常除法保留原值", () => {
    expect(safeDivide(9, 2)).toBe(4.5);
  });

  it("clamp 对非有限值退化为下界", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 1)).toBe(1);
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
  });

  it("roundTo 按位四舍五入", () => {
    expect(roundTo(0.090476, 4)).toBe(0.0905);
    expect(roundTo(0.174359, 4)).toBe(0.1744);
  });
});

describe("computeEngagementRate 内容互动率 = (赞 + 评 + 转) / 播放", () => {
  it("按文档公式计算", () => {
    expect(
      computeEngagementRate({
        views: 42000,
        likes: 3120,
        comments: 268,
        shares: 412,
      }),
    ).toBe(0.0905);
  });

  it("播放量为 0 时返回 0（未发布内容不应产生 NaN）", () => {
    expect(
      computeEngagementRate({ views: 0, likes: 0, comments: 0, shares: 0 }),
    ).toBe(0);
    expect(computeEngagementRate({ views: 0, likes: 10, comments: 0, shares: 0 })).toBe(0);
  });
});

describe("computeQuestionRatio 问题占比 = 类别数 / 总问题数", () => {
  it("正常占比", () => {
    expect(computeQuestionRatio(468, 2340)).toBe(0.2);
    expect(computeQuestionRatio(386, 2340)).toBe(0.165);
  });

  it("总数为 0 时返回 0", () => {
    expect(computeQuestionRatio(10, 0)).toBe(0);
  });

  it("超出总数时被限制在 1 以内", () => {
    expect(computeQuestionRatio(30, 10)).toBe(1);
  });
});

describe("computeLiveEngagementRate 直播互动率", () => {
  it("按文档公式计算", () => {
    expect(
      computeLiveEngagementRate({
        viewers: 122250,
        comments: 613,
        likes: 8420,
        questions: 148,
      }),
    ).toBe(0.0751);
  });

  it("观看人数为 0 时返回 0", () => {
    expect(
      computeLiveEngagementRate({
        viewers: 0,
        comments: 613,
        likes: 8420,
        questions: 148,
      }),
    ).toBe(0);
  });
});

describe("computeTaskCompletionRate AI 任务完成率", () => {
  it("按文档口径计算（18 个任务 15 个成功）", () => {
    expect(computeTaskCompletionRate({ total: 18, completed: 15 })).toBe(0.8333);
  });

  it("无任务时返回 0", () => {
    expect(computeTaskCompletionRate({ total: 0, completed: 0 })).toBe(0);
  });

  it("completed 异常大于 total 时被限制在 1", () => {
    expect(computeTaskCompletionRate({ total: 10, completed: 99 })).toBe(1);
  });
});

describe("computeBusinessScore 经营评分", () => {
  it("Demo 口径落在 85 分左右", () => {
    const score = computeBusinessScore({
      contentEngagementRate: 0.093,
      conversionRate: 368 / 2340,
      autoResolveRate: 0.82,
    });
    expect(score).toBe(85);
  });

  it("全部为 0 时得 0 分", () => {
    expect(
      computeBusinessScore({
        contentEngagementRate: 0,
        conversionRate: 0,
        autoResolveRate: 0,
      }),
    ).toBe(0);
  });

  it("各项均达到或超过基线时得满分 100", () => {
    expect(
      computeBusinessScore({
        contentEngagementRate: BUSINESS_SCORE_BASELINES.contentEngagementRate,
        conversionRate: BUSINESS_SCORE_BASELINES.conversionRate,
        autoResolveRate: BUSINESS_SCORE_BASELINES.autoResolveRate,
      }),
    ).toBe(100);
  });

  it("超过基线的单项不会把总分推过 100", () => {
    expect(
      computeBusinessScore({
        contentEngagementRate: 0.99,
        conversionRate: 0.99,
        autoResolveRate: 0.99,
      }),
    ).toBe(100);
  });
});

describe("summarizeContents 内容聚合", () => {
  it("统计发布数、失败数、总播放与平均互动率", () => {
    const summary = summarizeContents([
      makeContent({
        id: "a",
        status: "published",
        metrics: { views: 1000, likes: 50, comments: 20, shares: 10, engagementRate: 0.08 },
      }),
      makeContent({
        id: "b",
        status: "failed",
        metrics: { views: 0, likes: 0, comments: 0, shares: 0, engagementRate: 0 },
      }),
      makeContent({
        id: "c",
        status: "published",
        metrics: { views: 3000, likes: 120, comments: 60, shares: 20, engagementRate: 0.1 },
      }),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.published).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.totalViews).toBe(4000);
    // 仅统计有播放量的 2 条，未发布内容的 0 不参与均值
    expect(summary.averageEngagementRate).toBe(0.09);
  });

  it("空列表不产生 NaN", () => {
    expect(summarizeContents([])).toEqual({
      total: 0,
      published: 0,
      failed: 0,
      totalViews: 0,
      averageEngagementRate: 0,
    });
  });
});

describe("summarizeProducts 商品聚合", () => {
  it("统计已分析、待分析、库存预警与售罄", () => {
    const summary = summarizeProducts([
      makeProduct({ id: "p1", analysisStatus: "analyzed", stock: 86 }),
      makeProduct({ id: "p2", analysisStatus: "pending", stock: 320 }),
      makeProduct({ id: "p3", analysisStatus: "analyzing", stock: 10 }),
      makeProduct({ id: "p4", analysisStatus: "failed", stock: 0 }),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.analyzed).toBe(1);
    expect(summary.inProgress).toBe(2);
    expect(summary.lowStock).toBe(2);
    expect(summary.soldOut).toBe(1);
  });

  it("库存阈值可配置", () => {
    expect(summarizeProducts([makeProduct({ stock: 60 })], 100).lowStock).toBe(1);
    expect(summarizeProducts([makeProduct({ stock: 60 })], 50).lowStock).toBe(0);
  });
});

describe("summarizeConversations 会话聚合", () => {
  it("统计待转人工与自动处理数量", () => {
    const summary = summarizeConversations([
      makeConversation({ id: "c1", status: "bot" }),
      makeConversation({ id: "c2", status: "human" }),
      makeConversation({ id: "c3", status: "human" }),
      makeConversation({ id: "c4", status: "closed" }),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.humanNeeded).toBe(2);
    expect(summary.botHandled).toBe(1);
    expect(summary.closed).toBe(1);
  });
});

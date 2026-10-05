/**
 * 经营快照纯函数单测（S6-B · 任务书第六 / 七 / 八 / 二十七 / 二十八节）
 *
 * 这一层是「数字由程序算」的**唯一**实现处，因此测试的重点不是「函数能不能跑」，
 * 而是三条容易被无声破坏的性质：
 *
 * 1. **除零返回 `null`，不返回 0。** 「没有数据」与「0%」是两件事；
 *    一旦某天有人把 `ratioOrNull` 改成返回 0，界面就会在全新库上显示
 *    「客服全线失效」。
 * 2. **只算系统真的做过的事。** 快照里不该出现任何需要真实订单 / 平台后台
 *    才能得到的字段 —— 那些位置必须留空，而不是拿一个像样的数填上。
 * 3. **健康度由阈值派生，`null` 信号不参与判定。** 数据不足不是问题；
 *    把「今天还没有回答」判成 risk，等于每天开局就报一次假警。
 */

import { describe, expect, it } from "vitest";

import type {
  AgentStatus,
  ContentItem,
  LiveComment,
  LiveSession,
  LiveSuggestion,
  Product,
  WorkflowStatus,
} from "@/types";

import {
  ANALYTICS_HEALTH_THRESHOLDS,
  buildAnalyticsSnapshot,
  computeAgentMetrics,
  computeContentMetrics,
  computeCustomerMetrics,
  computeKnowledgeGapBreakdown,
  computeLiveMetrics,
  computeProductMetrics,
  computeWorkflowMetrics,
  deriveHealth,
  deriveHealthSignals,
  findSnapshotProblems,
} from "./snapshot";

const NOW = new Date("2026-09-27T10:00:00");

/* ------------------------------------------------------------------ */
/* 工厂                                                                */
/* ------------------------------------------------------------------ */

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
    updatedAt: "2026-09-27 09:00",
    metrics: { views: 0, inquiries: 0, conversions: 0 },
    tags: [],
    ...overrides,
  };
}

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
    createdAt: "2026-09-27 09:00",
    metrics: { views: 0, likes: 0, comments: 0, shares: 0, engagementRate: 0 },
    ...overrides,
  };
}

function makeSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    id: "live_x",
    title: "测试直播",
    productId: "prod_x",
    productName: "测试商品",
    status: "ended",
    startedAt: "2026-09-27 19:00",
    endedAt: "2026-09-27 21:00",
    durationText: "2h",
    commentsCount: 0,
    aiHandledCount: 0,
    ...overrides,
  };
}

function makeComment(overrides: Partial<LiveComment> = {}): LiveComment {
  return {
    id: "lc_x",
    sessionId: "live_x",
    authorName: "观众",
    content: "这条评论说了点什么",
    intent: null,
    priority: null,
    handled: false,
    createdAtText: "2026-09-27 19:10",
    ...overrides,
  };
}

function makeSuggestion(overrides: Partial<LiveSuggestion> = {}): LiveSuggestion {
  return {
    id: "ls_x",
    commentId: "lc_x",
    commentContent: "这条评论说了点什么",
    intent: "storage_question",
    priority: "medium",
    shouldRespond: true,
    responseMode: "answer_now",
    hostSuggestion: "建议正面回应",
    suggestedReply: "0-4 度冷藏即可。",
    sellingAngle: null,
    grounded: true,
    citations: [],
    recommendedAction: "explain_storage",
    riskNotes: [],
    confidence: 0.8,
    durationMs: 900,
    createdAtText: "2026-09-27 19:11",
    failureMessage: null,
    ...overrides,
  };
}

function task(overrides: {
  agentType?: "product_agent" | "content_agent" | "live_agent";
  status: AgentStatus;
  durationMs?: number | null;
}) {
  return {
    agentType: overrides.agentType ?? "product_agent",
    status: overrides.status,
    durationMs: overrides.durationMs ?? null,
  };
}

function workflow(
  status: WorkflowStatus,
  summary: { executed: number; reused: number } | null = null,
) {
  return { status, summary };
}

function emptyCustomerService() {
  return {
    answeredCount: 0,
    groundedCount: 0,
    needsHumanCount: 0,
    openKnowledgeGapCount: 0,
    openGaps: [] as { intent: string }[],
  };
}

/* ------------------------------------------------------------------ */
/* 各模块指标                                                          */
/* ------------------------------------------------------------------ */

describe("computeProductMetrics", () => {
  it("统计商品总数与 DNA 完成数", () => {
    const metrics = computeProductMetrics([
      makeProduct({ analysisStatus: "analyzed" }),
      makeProduct({ analysisStatus: "pending" }),
      makeProduct({ analysisStatus: "analyzing" }),
      makeProduct({ analysisStatus: "analyzed" }),
    ]);

    expect(metrics).toEqual({
      totalProducts: 4,
      analyzedProducts: 2,
      analysisCompletionRate: 0.5,
    });
  });

  it("没有商品时完成率是 null，不是 0（0% 会读成「一件都没做」）", () => {
    const metrics = computeProductMetrics([]);

    expect(metrics.totalProducts).toBe(0);
    expect(metrics.analyzedProducts).toBe(0);
    expect(metrics.analysisCompletionRate).toBeNull();
  });
});

describe("computeContentMetrics", () => {
  it("今日新增按本地自然日统计，跨日内容不计入", () => {
    const metrics = computeContentMetrics(
      [
        makeContent({ createdAt: "2026-09-27 00:05" }),
        makeContent({ createdAt: "2026-09-27 23:59" }),
        makeContent({ createdAt: "2026-09-26 23:59" }),
      ],
      NOW,
    );

    expect(metrics.totalAssets).toBe(3);
    expect(metrics.generatedToday).toBe(2);
  });

  it("平台分布按数量降序，同数量按平台名稳定排序", () => {
    const metrics = computeContentMetrics(
      [
        makeContent({ platform: "wechat" }),
        makeContent({ platform: "douyin" }),
        makeContent({ platform: "douyin" }),
        makeContent({ platform: "xiaohongshu" }),
      ],
      NOW,
    );

    expect(metrics.platformDistribution).toEqual([
      { platform: "douyin", count: 2 },
      { platform: "wechat", count: 1 },
      { platform: "xiaohongshu", count: 1 },
    ]);
  });

  it("不产出任何效果类指标（本地没有播放 / 曝光数据源）", () => {
    const metrics = computeContentMetrics([makeContent()], NOW);

    expect(Object.keys(metrics).sort()).toEqual([
      "generatedToday",
      "platformDistribution",
      "totalAssets",
    ]);
  });
});

describe("computeWorkflowMetrics", () => {
  it("完成率的分母是全部运行记录（含未启动与运行中）", () => {
    const metrics = computeWorkflowMetrics([
      workflow("completed", { executed: 4, reused: 1 }),
      workflow("idle"),
      workflow("running"),
      workflow("partially_completed", { executed: 2, reused: 0 }),
      workflow("failed", { executed: 1, reused: 0 }),
    ]);

    expect(metrics.totalRuns).toBe(5);
    expect(metrics.completedRuns).toBe(1);
    expect(metrics.partiallyCompletedRuns).toBe(1);
    expect(metrics.failedRuns).toBe(1);
    // 1 / 5 —— 若把 idle / running 排除在分母外会变成 1 / 3，虚高
    expect(metrics.completionRate).toBe(0.2);
  });

  it("复用 / 执行计数只累加有逐步报告的工作流", () => {
    const metrics = computeWorkflowMetrics([
      workflow("completed", { executed: 3, reused: 2 }),
      workflow("completed", null),
      workflow("running"),
    ]);

    expect(metrics.executedTaskCount).toBe(3);
    expect(metrics.reusedTaskCount).toBe(2);
  });

  it("没有运行记录时完成率是 null", () => {
    expect(computeWorkflowMetrics([]).completionRate).toBeNull();
  });
});

describe("computeCustomerMetrics", () => {
  it("Grounded 率的分母是今日 AI 回答数", () => {
    const metrics = computeCustomerMetrics({
      answeredCount: 10,
      groundedCount: 7,
      needsHumanCount: 2,
      openKnowledgeGapCount: 3,
      openGaps: [{ intent: "logistics" }, { intent: "logistics" }],
    });

    expect(metrics.groundedRate).toBe(0.7);
    expect(metrics.openGapByIntent).toEqual([{ intent: "logistics", count: 2 }]);
  });

  it("今日没有 AI 回答时 Grounded 率是 null（不是 0%）", () => {
    const metrics = computeCustomerMetrics(emptyCustomerService());

    expect(metrics.groundedRate).toBeNull();
    expect(metrics.openGapByIntent).toEqual([]);
  });
});

describe("computeKnowledgeGapBreakdown", () => {
  it("按意图计数降序，同数量按意图名稳定排序", () => {
    expect(
      computeKnowledgeGapBreakdown([
        { intent: "storage" },
        { intent: "after_sales" },
        { intent: "storage" },
        { intent: "logistics" },
        { intent: "logistics" },
        { intent: "logistics" },
      ]),
    ).toEqual([
      { intent: "logistics", count: 3 },
      { intent: "storage", count: 2 },
      { intent: "after_sales", count: 1 },
    ]);
  });

  it("空白意图归入 other（历史数据里 intent 可能是空串）", () => {
    expect(computeKnowledgeGapBreakdown([{ intent: "  " }, { intent: "" }])).toEqual([
      { intent: "other", count: 2 },
    ]);
  });
});

describe("computeLiveMetrics", () => {
  it("AI 已处理数只算没有 failureMessage 的建议", () => {
    const metrics = computeLiveMetrics({
      sessions: [makeSession(), makeSession({ id: "live_y" })],
      comments: [
        makeComment({ id: "c1", priority: "high" }),
        makeComment({ id: "c2" }),
      ],
      suggestions: [
        makeSuggestion({ id: "s1", commentId: "c1", grounded: true }),
        makeSuggestion({
          id: "s2",
          commentId: "c2",
          grounded: false,
          failureMessage: "模型超时",
        }),
      ],
    });

    expect(metrics.sessions).toBe(2);
    expect(metrics.commentCount).toBe(2);
    expect(metrics.aiHandledCount).toBe(1);
    expect(metrics.groundedCount).toBe(1);
    expect(metrics.highPriorityCount).toBe(1);
  });

  it("意图占比只算已被 AI 分类的评论（未分类不进分母）", () => {
    const metrics = computeLiveMetrics({
      sessions: [makeSession()],
      comments: [
        makeComment({ id: "c1", intent: "storage_question" }),
        makeComment({ id: "c2", intent: "storage_question" }),
        makeComment({ id: "c3", intent: null }),
      ],
      suggestions: [],
    });

    expect(metrics.topIntents).toEqual([
      { intent: "storage_question", count: 2, share: 1 },
    ]);
  });
});

describe("computeAgentMetrics", () => {
  it("只看走到终态的任务，running / queued / skipped 不进分母", () => {
    const metrics = computeAgentMetrics([
      task({ status: "completed" }),
      task({ status: "completed" }),
      task({ status: "failed" }),
      task({ status: "running" }),
      task({ status: "queued" }),
      task({ status: "skipped" }),
    ]);

    expect(metrics.completedTasks).toBe(2);
    expect(metrics.failedTasks).toBe(1);
    // 1 / 3，而不是 1 / 6
    expect(deriveHealthSignals({
      workflow: computeWorkflowMetrics([]),
      customerService: computeCustomerMetrics(emptyCustomerService()),
      agents: metrics,
    }).failedTaskRate).toBeCloseTo(1 / 3, 4);
  });

  it("按 Agent 分组，失败多的排前面；无终态任务的 Agent 不出现", () => {
    const metrics = computeAgentMetrics([
      task({ agentType: "product_agent", status: "completed", durationMs: 1000 }),
      task({ agentType: "content_agent", status: "failed", durationMs: 2000 }),
      task({ agentType: "content_agent", status: "failed", durationMs: 3000 }),
    ]);

    expect(metrics.byAgent.map((item) => item.agentType)).toEqual([
      "content_agent",
      "product_agent",
    ]);
    expect(metrics.byAgent[0]).toMatchObject({
      completed: 0,
      failed: 2,
      failureRate: 1,
      avgDurationMs: 2500,
    });
    expect(metrics.avgDurationMs).toBe(2000);
  });

  it("没有终态任务时失败率与平均耗时都是 null", () => {
    const metrics = computeAgentMetrics([task({ status: "running" })]);

    expect(metrics.completedTasks).toBe(0);
    expect(metrics.failedTasks).toBe(0);
    expect(metrics.avgDurationMs).toBeNull();
    expect(metrics.byAgent).toEqual([]);
  });

  it("忽略非法耗时（不把 NaN 混进平均）", () => {
    const metrics = computeAgentMetrics([
      task({ status: "completed", durationMs: Number.NaN }),
      task({ status: "completed", durationMs: 1000 }),
    ]);

    expect(metrics.avgDurationMs).toBe(1000);
  });
});

/* ------------------------------------------------------------------ */
/* 健康度                                                              */
/* ------------------------------------------------------------------ */

describe("deriveHealth", () => {
  function signals(overrides: Partial<ReturnType<typeof deriveHealthSignals>>) {
    return {
      openKnowledgeGapCount: 0,
      failedTaskRate: null,
      workflowCompletionRate: null,
      customerGroundedRate: null,
      ...overrides,
    };
  }

  it("所有信号都是 null / 正常 → good，且理由说明「均在阈值内」", () => {
    const verdict = deriveHealth(signals({}));

    expect(verdict.status).toBe("good");
    expect(verdict.reasons).toEqual(["各项信号均在阈值内。"]);
  });

  it("失败率达到风险阈值 → risk", () => {
    const verdict = deriveHealth(
      signals({ failedTaskRate: ANALYTICS_HEALTH_THRESHOLDS.failedTaskRateRisk }),
    );

    expect(verdict.status).toBe("risk");
    expect(verdict.reasons.join()).toContain("失败率");
  });

  it("失败率在关注区间 → attention（不是 risk）", () => {
    const verdict = deriveHealth(signals({ failedTaskRate: 0.15 }));

    expect(verdict.status).toBe("attention");
  });

  it("Grounded 率偏低 → risk；偏低但没那么低 → attention", () => {
    expect(deriveHealth(signals({ customerGroundedRate: 0.4 })).status).toBe("risk");
    expect(deriveHealth(signals({ customerGroundedRate: 0.6 })).status).toBe("attention");
  });

  it("缺口数达到风险阈值 → risk", () => {
    const verdict = deriveHealth(
      signals({ openKnowledgeGapCount: ANALYTICS_HEALTH_THRESHOLDS.openKnowledgeGapRisk }),
    );

    expect(verdict.status).toBe("risk");
  });

  it("风险信号优先于关注信号（两者同时命中时定档 risk）", () => {
    const verdict = deriveHealth(
      signals({ failedTaskRate: 0.5, customerGroundedRate: 0.6 }),
    );

    expect(verdict.status).toBe("risk");
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("null 信号不参与判定 —— 数据不足不该被判成风险", () => {
    const verdict = deriveHealth(
      signals({ customerGroundedRate: null, failedTaskRate: null }),
    );

    expect(verdict.status).toBe("good");
  });
});

describe("deriveHealthSignals", () => {
  it("失败率的分母是终态任务总数", () => {
    const agents = computeAgentMetrics([
      task({ status: "completed" }),
      task({ status: "failed" }),
    ]);
    const signals = deriveHealthSignals({
      workflow: computeWorkflowMetrics([]),
      customerService: computeCustomerMetrics(emptyCustomerService()),
      agents,
    });

    expect(signals.failedTaskRate).toBe(0.5);
    expect(signals.workflowCompletionRate).toBeNull();
    expect(signals.customerGroundedRate).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 组装与结构校验                                                      */
/* ------------------------------------------------------------------ */

describe("buildAnalyticsSnapshot", () => {
  it("组装出完整快照，且不含任何需要真实订单才能得到的字段", () => {
    const snapshot = buildAnalyticsSnapshot({
      now: NOW,
      products: [makeProduct({ analysisStatus: "analyzed" })],
      contents: [makeContent({ createdAt: "2026-09-27 08:00" })],
      workflows: [workflow("completed", { executed: 2, reused: 1 })],
      agentTasks: [task({ status: "completed", durationMs: 1200 })],
      customerService: {
        answeredCount: 4,
        groundedCount: 3,
        needsHumanCount: 1,
        openKnowledgeGapCount: 1,
        openGaps: [{ intent: "logistics" }],
      },
      live: {
        sessions: [makeSession()],
        comments: [makeComment({ id: "c1", intent: "storage_question" })],
        suggestions: [makeSuggestion({ id: "s1", commentId: "c1" })],
      },
    });

    expect(snapshot.generatedAt).toBe(NOW.toISOString());
    expect(snapshot.product).toEqual({
      totalProducts: 1,
      analyzedProducts: 1,
      analysisCompletionRate: 1,
    });
    expect(snapshot.content.generatedToday).toBe(1);
    expect(snapshot.workflow.reusedTaskCount).toBe(1);
    expect(snapshot.customerService.groundedRate).toBe(0.75);
    expect(snapshot.live.aiHandledCount).toBe(1);
    expect(snapshot.agents.completedTasks).toBe(1);
    expect(snapshot.health.status).toBe("good");

    // 快照里不允许出现「销售额 / 订单量 / 转化率」这类本地无数据源的字段
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["revenue", "orders", "conversionRate", "sales"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("全新库（什么都没有）也能算出快照，且比率是 null 而不是 0", () => {
    const snapshot = buildAnalyticsSnapshot({
      now: NOW,
      products: [],
      contents: [],
      workflows: [],
      agentTasks: [],
      customerService: emptyCustomerService(),
      live: { sessions: [], comments: [], suggestions: [] },
    });

    expect(snapshot.product.analysisCompletionRate).toBeNull();
    expect(snapshot.workflow.completionRate).toBeNull();
    expect(snapshot.customerService.groundedRate).toBeNull();
    expect(snapshot.agents.avgDurationMs).toBeNull();
    expect(snapshot.health.status).toBe("good");
    expect(findSnapshotProblems(snapshot)).toEqual([]);
  });

  it("同一份输入两次调用得到完全相同的快照（除 generatedAt 外）", () => {
    const input = {
      now: NOW,
      products: [makeProduct()],
      contents: [makeContent()],
      workflows: [workflow("completed", { executed: 1, reused: 0 })],
      agentTasks: [task({ status: "completed" })],
      customerService: emptyCustomerService(),
      live: { sessions: [], comments: [], suggestions: [] },
    };

    expect(buildAnalyticsSnapshot(input)).toEqual(buildAnalyticsSnapshot(input));
  });
});

describe("findSnapshotProblems", () => {
  const base = buildAnalyticsSnapshot({
    now: NOW,
    products: [makeProduct()],
    contents: [],
    workflows: [],
    agentTasks: [],
    customerService: emptyCustomerService(),
    live: { sessions: [], comments: [], suggestions: [] },
  });

  it("合法快照没有问题", () => {
    expect(findSnapshotProblems(base)).toEqual([]);
  });

  it("generatedAt 不是合法时间 → 报问题", () => {
    expect(
      findSnapshotProblems({ ...base, generatedAt: "不是时间" }),
    ).toEqual([expect.stringContaining("generatedAt")]);
  });

  it("健康度取值非法 → 报问题", () => {
    const problems = findSnapshotProblems({
      ...base,
      health: { ...base.health, status: "great" as never },
    });

    expect(problems.join()).toContain("健康度取值非法");
  });

  it("计数字段为负数或小数 → 报问题", () => {
    const problems = findSnapshotProblems({
      ...base,
      product: { ...base.product, totalProducts: -1 },
      content: { ...base.content, generatedToday: 1.5 },
    });

    expect(problems.join()).toContain("product.totalProducts");
    expect(problems.join()).toContain("content.generatedToday");
  });

  it("比率字段越界 → 报问题；但 null 是合法的", () => {
    const problems = findSnapshotProblems({
      ...base,
      product: { ...base.product, analysisCompletionRate: 1.4 },
    });

    expect(problems.join()).toContain("product.analysisCompletionRate");
  });
});

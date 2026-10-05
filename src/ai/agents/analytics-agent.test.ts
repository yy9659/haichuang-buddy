/**
 * AI 经营分析师 Agent 单测（S6-B · 任务书第十二 / 十三 / 二十七 / 三十一节）
 *
 * 这组用例锁的是**链路纪律**，而不是模型质量：
 *
 * 1. **坏快照必须被挡在模型之前。** 一份结构不合法的快照会变成
 *    「看起来很专业的错报告」，比直接报错危险得多。
 * 2. **档位回落只对「档位不可用」生效。** 限流、配额这类失败换档只会
 *    再失败一次，还白烧一次配额。
 * 3. **结构不合规时先纠错、再报错。** 编造销售额这类幻觉必须在这一层被拦住，
 *    而不是流到界面上。
 */

import { describe, expect, it } from "vitest";

import { runAnalyticsAgent } from "@/ai/agents/analytics-agent";
import { createMockAIProvider } from "@/ai/provider/mock";
import type { AIProvider, GenerateTextInput } from "@/ai/provider/types";
import { ANALYTICS_METRIC_KEYS } from "@/analytics/metric-keys";
import { buildAnalyticsSnapshot } from "@/analytics/snapshot";
import { AppError } from "@/lib/result";
import type { AnalyticsSnapshot } from "@/types";

/* ------------------------------------------------------------------ */
/* 快照                                                                */
/* ------------------------------------------------------------------ */

function makeSnapshot(overrides: {
  openKnowledgeGapCount?: number;
  answeredCount?: number;
  groundedCount?: number;
  failedTasks?: number;
} = {}): AnalyticsSnapshot {
  const openKnowledgeGapCount = overrides.openKnowledgeGapCount ?? 0;
  const failedTasks = overrides.failedTasks ?? 0;

  return buildAnalyticsSnapshot({
    now: new Date("2026-09-27T10:00:00"),
    products: [
      {
        id: "prod_1",
        name: "连江鲜活鲍鱼",
        description: "",
        category: "海产品",
        subCategory: "鲍鱼",
        price: 128,
        unit: "500g",
        stock: 50,
        origin: "福建连江",
        specification: "8-10 头 / 500g",
        storageMethod: "0-4℃ 冷藏",
        shelfLife: "2 天",
        imageUrl: null,
        analysisStatus: "analyzed",
        updatedAt: "2026-09-27 09:00",
        metrics: { views: 0, inquiries: 0, conversions: 0 },
        tags: [],
      },
    ],
    contents: [],
    workflows: [{ status: "completed", summary: { executed: 2, reused: 1 } }],
    agentTasks: [
      { agentType: "product_agent", status: "completed", durationMs: 1200 },
      ...Array.from({ length: failedTasks }, () => ({
        agentType: "content_agent" as const,
        status: "failed" as const,
        durationMs: 800,
      })),
    ],
    customerService: {
      answeredCount: overrides.answeredCount ?? 0,
      groundedCount: overrides.groundedCount ?? 0,
      needsHumanCount: 0,
      openKnowledgeGapCount,
      openGaps: Array.from({ length: openKnowledgeGapCount }, () => ({
        intent: "logistics",
      })),
    },
    live: { sessions: [], comments: [], suggestions: [] },
  });
}

/* ------------------------------------------------------------------ */
/* Provider 桩                                                        */
/* ------------------------------------------------------------------ */

/** 按档位分流：`reasoning` 抛错、`fast` 正常。用于验证档位回落 */
function createTierAwareProvider(error: AppError): {
  provider: AIProvider;
  tiers: string[];
} {
  const seen: string[] = [];
  const fallback = createMockAIProvider();
  const provider: AIProvider = {
    id: "tier-aware",
    async generateText(input: GenerateTextInput): Promise<string> {
      seen.push(String(input.tier));
      if (input.tier === "reasoning") {
        throw error;
      }
      return fallback.generateText(input);
    },
    async generateObject<T>(): Promise<T> {
      throw new Error("本场景不应调用 generateObject");
    },
    async streamText() {
      throw new Error("本场景不应调用 streamText");
    },
    async analyzeImage(): Promise<string> {
      throw new Error("本场景不应调用 analyzeImage");
    },
    embed: (input) => fallback.embed(input),
  };

  return { provider, tiers: seen };
}

/** 返回固定文本的 Provider（用于验证纠错与归一化） */
function createFixedProvider(payload: unknown, raw?: string): {
  provider: AIProvider;
  calls: () => number;
} {
  let calls = 0;
  const fallback = createMockAIProvider();
  const provider: AIProvider = {
    id: "fixed",
    async generateText(): Promise<string> {
      calls += 1;
      return raw ?? JSON.stringify(payload);
    },
    async generateObject<T>(): Promise<T> {
      throw new Error("本场景不应调用 generateObject");
    },
    async streamText() {
      throw new Error("本场景不应调用 streamText");
    },
    async analyzeImage(): Promise<string> {
      throw new Error("本场景不应调用 analyzeImage");
    },
    embed: (input) => fallback.embed(input),
  };

  return { provider, calls: () => calls };
}

/* ------------------------------------------------------------------ */
/* 1. 正常路径（Mock Provider）                                        */
/* ------------------------------------------------------------------ */

describe("runAnalyticsAgent：正常路径", () => {
  it("Mock Provider 产出的日报能通过自己的契约（含白名单与数值守卫）", async () => {
    const result = await runAnalyticsAgent(makeSnapshot(), {
      provider: createMockAIProvider(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const { report } = result.data;
    expect(report.highlights.length).toBeGreaterThan(0);
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.tomorrowFocus.length).toBeGreaterThan(0);
    expect(result.data.tier).toBe("reasoning");
    expect(result.data.tierFallback).toBe(false);
    expect(result.data.warnings).toEqual([]);
  });

  it("报告的 health 与快照的程序定档一致（模型不许自己改档）", async () => {
    const snapshot = makeSnapshot({ openKnowledgeGapCount: 6 });

    const result = await runAnalyticsAgent(snapshot, {
      provider: createMockAIProvider(),
    });

    expect(snapshot.health.status).toBe("risk");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.report.health).toBe(snapshot.health.status);
    // risk 必须至少指出一条问题（契约的一致性约束）
    expect(result.data.report.issues.length).toBeGreaterThan(0);
  });

  it("报告里引用的指标键全部来自白名单", async () => {
    const result = await runAnalyticsAgent(makeSnapshot({ openKnowledgeGapCount: 3 }), {
      provider: createMockAIProvider(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const allowed = new Set(ANALYTICS_METRIC_KEYS);
    for (const item of [
      ...result.data.report.highlights,
      ...result.data.report.issues,
    ]) {
      for (const key of item.metricKeys) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it("行动建议按 priority 升序返回（模型乱序输出也要在 Agent 层归一化）", async () => {
    const result = await runAnalyticsAgent(makeSnapshot({ openKnowledgeGapCount: 3 }), {
      provider: createMockAIProvider(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const priorities = result.data.report.actions.map((action) => action.priority);
    expect(priorities).toEqual([...priorities].sort((left, right) => left - right));
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 坏快照必须被挡在模型之前                                          */
/* ------------------------------------------------------------------ */

describe("runAnalyticsAgent：快照结构校验", () => {
  it("generatedAt 非法的快照 → VALIDATION_FAILED", async () => {
    const bad: AnalyticsSnapshot = {
      ...makeSnapshot(),
      generatedAt: "不是时间",
    };

    const result = await runAnalyticsAgent(bad, {
      provider: createMockAIProvider(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.detail).toContain("generatedAt");
  });

  it("计数字段为负的快照 → VALIDATION_FAILED", async () => {
    const bad: AnalyticsSnapshot = {
      ...makeSnapshot(),
      product: { totalProducts: -1, analyzedProducts: 0, analysisCompletionRate: null },
    };

    const result = await runAnalyticsAgent(bad, {
      provider: createMockAIProvider(),
    });

    expect(result.ok).toBe(false);
  });

  it("快照非法时**不调用模型**（不在一个坏输入上白烧一次调用）", async () => {
    const fixed = createFixedProvider({});
    const bad: AnalyticsSnapshot = { ...makeSnapshot(), generatedAt: "" };

    await runAnalyticsAgent(bad, { provider: fixed.provider });

    expect(fixed.calls()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 档位回落                                                          */
/* ------------------------------------------------------------------ */

describe("runAnalyticsAgent：档位回落（§13）", () => {
  it("推理档不可用 → 回落到快速档，并如实记为 tierFallback", async () => {
    const tierAware = createTierAwareProvider(
      new AppError({
        code: "MODEL_UNAVAILABLE",
        message: "推理档模型不可用",
        detail: "AI_MODEL_REASONING 未配置",
      }),
    );

    const result = await runAnalyticsAgent(makeSnapshot(), {
      provider: tierAware.provider,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(tierAware.tiers).toEqual(["reasoning", "fast"]);
    expect(result.data.tier).toBe("fast");
    expect(result.data.tierFallback).toBe(true);
    expect(result.data.warnings.join()).toContain("回落");
  });

  it("模型名不可用（VALIDATION_FAILED + AI_MODEL_ 详情）同样触发回落", async () => {
    const tierAware = createTierAwareProvider(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "模型名不可用",
        detail: "AI_MODEL_REASONING 在当前 Workspace 下不存在",
      }),
    );

    const result = await runAnalyticsAgent(makeSnapshot(), {
      provider: tierAware.provider,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.tierFallback).toBe(true);
  });

  it("限流 / 配额类失败**不**触发回落（换档只会再失败一次）", async () => {
    const tierAware = createTierAwareProvider(
      new AppError({
        code: "QUOTA_EXCEEDED",
        message: "配额已用尽",
        detail: "本月额度不足",
      }),
    );

    const result = await runAnalyticsAgent(makeSnapshot(), {
      provider: tierAware.provider,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("QUOTA_EXCEEDED");
    // 只试了一次推理档，没有回落
    expect(tierAware.tiers).toEqual(["reasoning"]);
  });

  it("两档都不可用时如实返回错误（不让经营分析整体失效，但也绝不假装成功）", async () => {
    const fallback = createMockAIProvider();
    const provider: AIProvider = {
      id: "always-unavailable",
      async generateText() {
        throw new AppError({
          code: "MODEL_UNAVAILABLE",
          message: "模型服务不可用",
        });
      },
      async generateObject<T>(): Promise<T> {
        throw new Error("不应调用");
      },
      async streamText() {
        throw new Error("不应调用");
      },
      async analyzeImage(): Promise<string> {
        throw new Error("不应调用");
      },
      embed: (input) => fallback.embed(input),
    };

    const result = await runAnalyticsAgent(makeSnapshot(), { provider });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("MODEL_UNAVAILABLE");
  });
});

/* ------------------------------------------------------------------ */
/* 4. 纠错与防幻觉（§31）                                               */
/* ------------------------------------------------------------------ */

describe("runAnalyticsAgent：结构纠错", () => {
  it("第一次输出脏、第二次合法 → repaired=true，attempts=2", async () => {
    let calls = 0;
    const fallback = createMockAIProvider();
    const provider: AIProvider = {
      id: "messy-then-ok",
      async generateText(input) {
        calls += 1;
        if (calls === 1) {
          return "好的，我先给一个初稿：{ \"health\": \"good\" }";
        }
        return fallback.generateText(input);
      },
      async generateObject<T>(): Promise<T> {
        throw new Error("不应调用");
      },
      async streamText() {
        throw new Error("不应调用");
      },
      async analyzeImage(): Promise<string> {
        throw new Error("不应调用");
      },
      embed: (input) => fallback.embed(input),
    };

    const result = await runAnalyticsAgent(makeSnapshot(), { provider });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.attempts).toBe(2);
    expect(result.data.repaired).toBe(true);
  });

  it("§31：编造「销售额下降 20%」的日报被拦住，不会流到界面", async () => {
    const fabricated = {
      executiveSummary: "今天销售额下降了 20%，建议加大投放。",
      health: "good",
      highlights: [
        {
          title: "销售额下滑",
          evidence: "销售额比昨天少了 20%。",
          metricKeys: ["product.totalProducts"],
        },
      ],
      issues: [],
      actions: [
        {
          priority: 1,
          title: "加大投放",
          reason: "销售额下降需要扭转。",
          actionType: "content",
          recommendedAction: "多投一些内容。",
        },
      ],
      tomorrowFocus: ["盯住销售额"],
      confidence: 0.8,
    };

    const fixed = createFixedProvider(fabricated);
    const result = await runAnalyticsAgent(makeSnapshot(), {
      provider: fixed.provider,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SCHEMA_INVALID");
    expect(result.error.detail ?? "").toContain("销售额");
    // 默认纠错预算：首次 + 1 次纠错
    expect(fixed.calls()).toBe(2);
  });

  it("§31：如实说「快照里没有销售额数据」的日报可以正常通过", async () => {
    const honest = {
      executiveSummary:
        "快照中没有销售额数据，因此无法分析销售额变化；今天已生成 0 条内容。",
      health: "good",
      highlights: [
        {
          title: "经营数据开始积累",
          evidence: "当前商品总数为 1 件，系统刚开始沉淀经营数据。",
          metricKeys: ["product.totalProducts"],
        },
      ],
      issues: [],
      actions: [
        {
          priority: 1,
          title: "补齐商品理解",
          reason: "还有商品没有 AI 分析结论。",
          actionType: "product",
          recommendedAction: "在商品中心点「AI 分析」。",
        },
      ],
      tomorrowFocus: ["补一条内容"],
      confidence: 0.4,
    };

    const fixed = createFixedProvider(honest);
    const result = await runAnalyticsAgent(makeSnapshot(), {
      provider: fixed.provider,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.report.health).toBe("good");
    expect(fixed.calls()).toBe(1);
  });

  it("指标键去重（模型把同一个键写两遍）", async () => {
    const duplicated = {
      executiveSummary: "今天商品总数为 1 件。",
      health: "good",
      highlights: [
        {
          title: "商品已就绪",
          evidence: "商品总数为 1 件。",
          metricKeys: ["product.totalProducts", "product.totalProducts"],
        },
      ],
      issues: [],
      actions: [
        {
          priority: 1,
          title: "继续补商品",
          reason: "只有一件商品。",
          actionType: "product",
          recommendedAction: "再加一件商品。",
        },
      ],
      tomorrowFocus: ["加商品"],
      confidence: 0.5,
    };

    const result = await runAnalyticsAgent(makeSnapshot(), {
      provider: createFixedProvider(duplicated).provider,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.report.highlights[0]?.metricKeys).toEqual([
      "product.totalProducts",
    ]);
  });
});
